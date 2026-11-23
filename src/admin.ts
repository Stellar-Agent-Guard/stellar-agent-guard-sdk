/**
 * Admin operations helpers for stellar-agent-guard smart accounts.
 *
 * Provides typed transaction submission and call construction helpers for
 * operator actions:
 *  - `submitSetPolicy` (updates spend caps, rolling windows, allowlists)
 *  - `submitFreeze` (emergency panic-button freeze)
 *  - `submitUnfreeze` (unfreezes account and re-arms heartbeat)
 *  - `submitRotateAgentKey` (re-binds the agent's Ed25519 public key)
 *
 * Policy encoding strictly reuses canonical `policyToScVal` from `src/policy.ts`
 * to guarantee identical field mapping, validation, and sorted ScMap serialization
 * with zero duplicated encoder logic.
 */
import { Keypair, StrKey, rpc, xdr } from "@stellar/stellar-sdk";
import { invoke, type InvokeOutcome } from "./invoke.ts";
import { InvalidInputError, type PolicyEncodingFailure } from "./errors.ts";
import { hexToBytes } from "./hash.ts";
import { policyDiff, type PolicyChange } from "./policy-diff.ts";
import { policyHash } from "./policy-json.ts";
import { validatePolicyOnChain } from "./policy-preflight.ts";
import {
  fetchGuardPolicyAndWindow,
  policyToScVal,
  validateGuardPolicy,
  validatePolicyForEncoding,
  type ContractAddress,
  type PolicyConfig,
  type PolicyFailure,
  type ReadonlyPolicyConfig,
} from "./policy.ts";
import type { AdminSigner, ContractCall } from "./tx.ts";

export const DEFAULT_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

const AGENT_PUBLIC_KEY_FORMAT =
  "expected a valid G... Ed25519 public key, a 32-byte Uint8Array, a 64-character hex string, or a Keypair";

/** Resolve every supported agent-key input to its 32 raw public-key bytes. */
function agentPublicKeyBytes(newAgent: string | Uint8Array | Keypair): Uint8Array {
  let publicKey: Uint8Array;
  if (
    typeof newAgent === "object" &&
    newAgent !== null &&
    "rawPublicKey" in newAgent &&
    typeof (newAgent as Keypair).rawPublicKey === "function"
  ) {
    publicKey = (newAgent as Keypair).rawPublicKey();
  } else if (newAgent instanceof Uint8Array) {
    publicKey = newAgent;
  } else if (typeof newAgent === "string") {
    if (newAgent.startsWith("G") && StrKey.isValidEd25519PublicKey(newAgent)) {
      publicKey = StrKey.decodeEd25519PublicKey(newAgent);
    } else if (/^[0-9a-fA-F]{64}$/.test(newAgent)) {
      publicKey = hexToBytes(newAgent);
    } else {
      throw new InvalidInputError("newAgent", "agent_public_key_format", AGENT_PUBLIC_KEY_FORMAT);
    }
  } else {
    throw new InvalidInputError("newAgent", "agent_public_key_format", AGENT_PUBLIC_KEY_FORMAT);
  }

  if (publicKey.length !== 32) {
    throw new InvalidInputError("newAgent", "agent_public_key_length", AGENT_PUBLIC_KEY_FORMAT);
  }
  return publicKey;
}

/** Convert a keypair, StrKey ('G...'), raw Uint8Array, or hex string to Soroban BytesN<32> ScVal. */
export function agentPubkeyToScVal(newAgent: string | Uint8Array | Keypair): xdr.ScVal {
  return xdr.ScVal.scvBytes(Uint8Array.from(agentPublicKeyBytes(newAgent)));
}

/** Public-only rendering of a rotated agent key, safe to attach to an outcome. */
function agentPublicKey(newAgent: string | Uint8Array | Keypair): string {
  return StrKey.encodeEd25519PublicKey(Uint8Array.from(agentPublicKeyBytes(newAgent)));
}

/** Build a contract call for set_policy, reusing canonical policyToScVal. */
export function buildSetPolicyCall(
  guard: ContractAddress,
  policy: ReadonlyPolicyConfig,
): ContractCall {
  return {
    contract: guard,
    fn: "set_policy",
    args: [policyToScVal(policy)],
  };
}

/** Build a contract call for freeze. */
export function buildFreezeCall(guard: ContractAddress): ContractCall {
  return {
    contract: guard,
    fn: "freeze",
    args: [],
  };
}

/** Build a contract call for unfreeze. */
export function buildUnfreezeCall(guard: ContractAddress): ContractCall {
  return {
    contract: guard,
    fn: "unfreeze",
    args: [],
  };
}

/** Build a contract call for rotate_agent_key. */
export function buildRotateAgentKeyCall(
  guard: ContractAddress,
  newAgent: string | Uint8Array | Keypair,
): ContractCall {
  return {
    contract: guard,
    fn: "rotate_agent_key",
    args: [agentPubkeyToScVal(newAgent)],
  };
}

export interface AdminOpParams {
  server: rpc.Server;
  guard: ContractAddress;
  admin: Keypair | AdminSigner;
  source?: Keypair | AdminSigner | undefined;
  networkPassphrase?: string | undefined;
  dryRun?: boolean | undefined;
  pollAttempts?: number | undefined;
  pollIntervalMs?: number | undefined;
  /**
   * Caller-owned cancellation, forwarded to `invoke()` unchanged.
   *
   * An already-aborted signal short-circuits before any RPC call and produces
   * the same documented typed outcome an aborted `invoke()` produces: the
   * `error` arm carrying an `RpcTimeoutError` with `aborted: true`. A
   * mid-flight abort stops the operation at the next RPC boundary.
   *
   * Cancellation never relaxes the guard: it can only stop the SDK from
   * waiting, never turn a refusal into an approval.
   */
  signal?: AbortSignal | undefined;
  /**
   * Bound on each individual RPC call, in milliseconds, forwarded to
   * `invoke()` unchanged. Defaults to `DEFAULT_RPC_TIMEOUT_MS` (30s); pass
   * `0` to disable the bound and rely solely on `signal`.
   */
  timeoutMs?: number | undefined;
}

export interface SetPolicyParams extends AdminOpParams {
  policy: ReadonlyPolicyConfig;
}

export interface RotateAgentKeyParams extends AdminOpParams {
  newAgent: string | Uint8Array | Keypair;
}

/** The admin operation an outcome came from. */
export type AdminOperation = "set_policy" | "freeze" | "unfreeze" | "rotate_agent_key";

/**
 * Public, additive audit metadata attached to every admin outcome.
 *
 * It never contains an admin secret, signature or private key: `newAgent` is a
 * public `G...` StrKey, and `policyHash` is the canonical content fingerprint
 * of the policy submitted with `set_policy`.
 */
export interface AdminOutcomeMetadata {
  op: AdminOperation;
  guard: ContractAddress;
  policyHash?: string;
  newAgent?: string;
}

/** An `InvokeOutcome` that also carries admin audit metadata. */
export type AdminInvokeOutcome = InvokeOutcome & { admin: AdminOutcomeMetadata };

/** Attach metadata without spreading: outcomes can carry Error prototypes and getters. */
function withAdminMetadata(
  outcome: InvokeOutcome,
  admin: AdminOutcomeMetadata,
): AdminInvokeOutcome {
  return Object.assign(outcome, { admin });
}

/**
 * Submit set_policy to the guard contract with an admin signer.
 * Reuses canonical policyToScVal without duplicating encoding logic.
 */
export async function submitSetPolicy(params: SetPolicyParams): Promise<AdminInvokeOutcome> {
  const call = buildSetPolicyCall(params.guard, params.policy);
  const outcome = await invoke({
    server: params.server,
    source: params.source ?? params.admin,
    call,
    networkPassphrase: params.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE,
    accountSigners: [params.admin],
    dryRun: params.dryRun,
    pollAttempts: params.pollAttempts,
    pollIntervalMs: params.pollIntervalMs,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  return withAdminMetadata(outcome, {
    op: "set_policy",
    guard: params.guard,
    policyHash: policyHash(params.policy),
  });
}

/**
 * Submit freeze to the guard contract with an admin signer.
 */
export async function submitFreeze(params: AdminOpParams): Promise<AdminInvokeOutcome> {
  const call = buildFreezeCall(params.guard);
  const outcome = await invoke({
    server: params.server,
    source: params.source ?? params.admin,
    call,
    networkPassphrase: params.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE,
    accountSigners: [params.admin],
    dryRun: params.dryRun,
    pollAttempts: params.pollAttempts,
    pollIntervalMs: params.pollIntervalMs,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  return withAdminMetadata(outcome, { op: "freeze", guard: params.guard });
}

/**
 * Submit unfreeze to the guard contract with an admin signer.
 */
export async function submitUnfreeze(params: AdminOpParams): Promise<AdminInvokeOutcome> {
  const call = buildUnfreezeCall(params.guard);
  const outcome = await invoke({
    server: params.server,
    source: params.source ?? params.admin,
    call,
    networkPassphrase: params.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE,
    accountSigners: [params.admin],
    dryRun: params.dryRun,
    pollAttempts: params.pollAttempts,
    pollIntervalMs: params.pollIntervalMs,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  return withAdminMetadata(outcome, { op: "unfreeze", guard: params.guard });
}

/**
 * Submit rotate_agent_key to the guard contract with an admin signer.
 */
export async function submitRotateAgentKey(
  params: RotateAgentKeyParams,
): Promise<AdminInvokeOutcome> {
  const call = buildRotateAgentKeyCall(params.guard, params.newAgent);
  const outcome = await invoke({
    server: params.server,
    source: params.source ?? params.admin,
    call,
    networkPassphrase: params.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE,
    accountSigners: [params.admin],
    dryRun: params.dryRun,
    pollAttempts: params.pollAttempts,
    pollIntervalMs: params.pollIntervalMs,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  return withAdminMetadata(outcome, {
    op: "rotate_agent_key",
    guard: params.guard,
    newAgent: agentPublicKey(params.newAgent),
  });
}

/** Parameters for {@link previewSetPolicy}. */
export interface PreviewSetPolicyParams {
  server: rpc.Server;
  guard: ContractAddress;
  /** Candidate policy. Preview never encodes, signs or submits it. */
  policy: ReadonlyPolicyConfig;
  /**
   * Optional simulation source for the contract's read-only `validate_policy`
   * entrypoint. Nothing is signed or broadcast; without a source, preview uses
   * the SDK validators only.
   */
  admin?: Keypair | AdminSigner;
  networkPassphrase?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/** Where a preview failure came from, so a caller can explain it to an operator. */
export type PolicyPreviewFailureSource = "sdk" | "encoding" | "contract" | "preview";

/** One field-level reason a previewed policy would not be safe to submit. */
export interface PolicyPreviewFailure {
  path: string;
  rule: string;
  message: string;
  source: PolicyPreviewFailureSource;
}

/** The read-only result of {@link previewSetPolicy}. */
export interface PolicyPreview {
  valid: boolean;
  failures: PolicyPreviewFailure[];
  diff: PolicyChange[];
  policyHash: string;
  current: PolicyConfig | null;
}

/** Baseline used when a guard has no installed policy: every default, nothing allowed. */
const EMPTY_POLICY: ReadonlyPolicyConfig = Object.freeze({
  per_tx_cap: 0n,
  window_secs: 0n,
  window_cap: 0n,
  assets: Object.freeze([]),
  protocols: Object.freeze([]),
  recipients: Object.freeze([]),
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 0n,
  recipient_window_caps: Object.freeze([]),
  blocked_recipients: Object.freeze([]),
  protocol_calls_per_window: 0,
});

/**
 * Read, validate and diff a proposed policy without changing chain state.
 *
 * This is the required first step before `submitSetPolicy()`: it reads the
 * installed policy, checks the candidate with the SDK rules (and the contract's
 * read-only validator when `admin` is supplied), computes the canonical policy
 * hash, and returns a structured diff. It performs no transaction assembly for
 * submission, no signing and no broadcast. An unreadable current policy or an
 * invalid draft is reported in `failures`; nothing is thrown for either.
 */
export async function previewSetPolicy(params: PreviewSetPolicyParams): Promise<PolicyPreview> {
  const failures: PolicyPreviewFailure[] = [];
  let current: PolicyConfig | null = null;

  try {
    current = (await fetchGuardPolicyAndWindow(params.server, params.guard)).policy;
  } catch (error) {
    failures.push(previewFailure("preview", "current_policy_unreadable", "policy", error));
  }

  let hash = "";
  try {
    hash = policyHash(params.policy);
  } catch (error) {
    failures.push(previewFailure("preview", "policy_not_hashable", "policy", error));
  }

  const sdkFailures = validateGuardPolicy(params.policy, { guardAddress: params.guard });
  const encodingFailures = validatePolicyForEncoding(params.policy);
  failures.push(...sdkFailures.map((failure) => normalizeFailure("sdk", failure)));
  failures.push(...encodingFailures.map((failure) => normalizeFailure("encoding", failure)));

  if (params.admin && encodingFailures.length === 0) {
    try {
      const result = await validatePolicyOnChain({
        server: params.server,
        guard: params.guard,
        source: params.admin,
        policy: params.policy,
        ...(params.networkPassphrase !== undefined
          ? { networkPassphrase: params.networkPassphrase }
          : {}),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      });
      if (!result.valid) {
        failures.push({
          path: "policy",
          rule: result.rule ?? "contract_rejected",
          message: result.message ?? "the guard contract rejected the policy",
          source: "contract",
        });
      }
    } catch {
      // An older contract may not expose validate_policy, and an RPC outage is
      // not a policy failure. The SDK validators above remain authoritative for
      // this preview; submitSetPolicy still re-validates on chain.
    }
  }

  let diff: PolicyChange[] = [];
  try {
    diff = policyDiff(current ?? EMPTY_POLICY, params.policy);
  } catch (error) {
    failures.push(previewFailure("preview", "policy_not_diffable", "policy", error));
  }

  return {
    valid: failures.length === 0,
    failures: dedupeFailures(failures),
    diff,
    policyHash: hash,
    current,
  };
}

function normalizeFailure(
  source: PolicyPreviewFailureSource,
  failure: PolicyFailure | PolicyEncodingFailure,
): PolicyPreviewFailure {
  return { source, path: failure.path, rule: failure.rule, message: failure.message };
}

function previewFailure(
  source: PolicyPreviewFailureSource,
  rule: string,
  path: string,
  error: unknown,
): PolicyPreviewFailure {
  return {
    source,
    path,
    rule,
    message: error instanceof Error ? error.message : String(error),
  };
}

function dedupeFailures(failures: readonly PolicyPreviewFailure[]): PolicyPreviewFailure[] {
  const seen = new Set<string>();
  const unique: PolicyPreviewFailure[] = [];
  for (const failure of failures) {
    const key = `${failure.path}\u0000${failure.rule}\u0000${failure.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(failure);
  }
  return unique;
}
