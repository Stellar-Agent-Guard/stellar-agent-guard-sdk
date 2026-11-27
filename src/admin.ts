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
import { DEFAULT_RPC_TIMEOUT_MS, invoke, type InvokeOutcome } from "./invoke.ts";
import { InvalidInputError, type PolicyEncodingFailure } from "./errors.ts";
import { systemClock, type Clock } from "./clock.ts";
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
  /**
   * Optional local bound on each `AgentSigner.signDigest()` call inside the
   * underlying `invoke()`, in milliseconds. `0` keeps the signer unbounded.
   * A fired bound produces a typed `SignerTimeoutError` and is never retried.
   */
  signerTimeoutMs?: number | undefined;
}

export interface SetPolicyParams extends AdminOpParams {
  policy: ReadonlyPolicyConfig;
}

export interface RotateAgentKeyParams extends AdminOpParams {
  newAgent: string | Uint8Array | Keypair;
}

/** The admin operation an outcome came from. */
export type AdminOperation = "set_policy" | "freeze" | "unfreeze" | "rotate_agent_key";
/** Backward-compatible alias for the admin operation name. */
export type AdminOpName = AdminOperation;

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

/** Identity of the admin operation that produced an {@link AdminOpOutcome}. */
export interface AdminOpMetadata {
  readonly op: AdminOpName;
  readonly guard: ContractAddress;
  /**
   * The hash the network assigned, or `null` when the operation never reached a
   * trackable broadcast (dry run, pre-broadcast failure, ambiguous response).
   */
  readonly transactionHash: string | null;
}

declare const adminOpBrand: unique symbol;
/**
 * An `invoke()` outcome returned by one of this module's submit helpers.
 *
 * The brand is type-only: `isAdminOpOutcome()` checks the runtime association,
 * so a plain `InvokeOutcome` cannot be passed to `waitForAdminOp()` by accident.
 */
export type AdminOpOutcome = AdminInvokeOutcome & { readonly [adminOpBrand]: AdminOpMetadata };

const ADMIN_OP_OUTCOMES = new WeakMap<object, AdminOpMetadata>();

/** Attach metadata without spreading: outcomes can carry Error prototypes and getters. */
function withAdminMetadata(
  outcome: InvokeOutcome,
  admin: AdminOutcomeMetadata,
): AdminInvokeOutcome {
  return Object.assign(outcome, { admin });
}

function brandAdminOutcome(outcome: AdminInvokeOutcome, adminOp: AdminOpMetadata): AdminOpOutcome {
  ADMIN_OP_OUTCOMES.set(outcome, adminOp);
  return outcome as AdminOpOutcome;
}

/** True only for an outcome produced by one of this module's submit helpers. */
export function isAdminOpOutcome(value: unknown): value is AdminOpOutcome {
  return typeof value === "object" && value !== null && ADMIN_OP_OUTCOMES.has(value);
}

function nonEmptyHash(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Read the recovery hash from every outcome arm that can carry one. */
function transactionHashOf(outcome: InvokeOutcome): string | null {
  const record = outcome as {
    transactionHash?: unknown;
    submission?: { hash?: unknown } | null;
    error?: { transactionHash?: unknown; error?: { transactionHash?: unknown } } | null;
  };
  return (
    nonEmptyHash(record.transactionHash) ??
    nonEmptyHash(record.submission?.hash) ??
    nonEmptyHash(record.error?.transactionHash) ??
    nonEmptyHash(record.error?.error?.transactionHash) ??
    null
  );
}

/** Default bound for {@link waitForAdminOp}; a timeout is reported as `pending`. */
export const DEFAULT_ADMIN_OP_WAIT_TIMEOUT_MS = DEFAULT_RPC_TIMEOUT_MS;
const DEFAULT_ADMIN_OP_POLL_INTERVAL_MS = 1_000;

/** Terminal state of an admin operation's confirmation wait. */
export type AdminOpWaitStatus = "confirmed" | "failed" | "pending" | "undetermined";

/** What {@link waitForAdminOp} reports, with the submitting operation attached. */
export interface AdminOpWaitResult {
  readonly status: AdminOpWaitStatus;
  readonly transactionHash: string;
  readonly admin: AdminOpMetadata;
  /** One-line operator summary; never a substitute for `status`. */
  readonly detail: string;
  /** Ledger that included the transaction, when the RPC reported one. */
  readonly ledger: number | null;
}

export interface WaitForAdminOpOptions {
  /** RPC used only for `getTransaction(hash)`; no submission is ever made. */
  server: rpc.Server;
  /**
   * Overall wait budget in milliseconds. Defaults to
   * `DEFAULT_ADMIN_OP_WAIT_TIMEOUT_MS` (30s). A fired bound returns `pending`:
   * the transaction may still land. `0` waits without a time bound.
   */
  timeoutMs?: number | undefined;
  /** Caller cancellation. An abort returns `pending`; it never rebroadcasts. */
  signal?: AbortSignal | undefined;
  /** Delay between `getTransaction` polls. Defaults to 1,000ms. */
  pollIntervalMs?: number | undefined;
  /** Time source for the budget and poll delays. Defaults to `systemClock`. */
  clock?: Clock | undefined;
}

function assertWaitForAdminOpOptions(options: WaitForAdminOpOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new InvalidInputError("options", "object", "waitForAdminOp requires options");
  }
  const server = options.server as { getTransaction?: unknown } | null | undefined;
  if (!server || typeof server.getTransaction !== "function") {
    throw new InvalidInputError("server", "rpc_server_with_getTransaction");
  }
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      throw new InvalidInputError(
        "timeoutMs",
        "finite_non_negative_number",
        String(options.timeoutMs),
      );
    }
  }
  if (options.pollIntervalMs !== undefined) {
    if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 0) {
      throw new InvalidInputError(
        "pollIntervalMs",
        "finite_non_negative_number",
        String(options.pollIntervalMs),
      );
    }
  }
  const signal = options.signal as
    | { aborted?: unknown; addEventListener?: unknown; removeEventListener?: unknown }
    | null
    | undefined;
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    throw new InvalidInputError("signal", "abort_signal");
  }
  const clock = options.clock as unknown;
  if (
    clock !== undefined &&
    (typeof clock !== "object" ||
      clock === null ||
      typeof (clock as Clock).now !== "function" ||
      typeof (clock as Clock).sleep !== "function")
  ) {
    throw new InvalidInputError("clock", "object_with_now_and_sleep");
  }
}

function abortableSleep(
  clock: Clock,
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return clock.sleep(delayMs);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void clock.sleep(Math.max(0, delayMs)).then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * Wait for an admin submission's transaction to be included.
 *
 * This is a read-only confirmation wrapper: it calls `getTransaction(hash)`
 * only, and returns a `pending` status (never a failure, never a rebroadcast)
 * when the budget or cancellation stops the wait. An RPC error is reported as
 * `undetermined` so the caller can reconcile the hash out of band.
 */
export async function waitForAdminOp(
  outcome: AdminOpOutcome,
  options: WaitForAdminOpOptions,
): Promise<AdminOpWaitResult> {
  assertWaitForAdminOpOptions(options);
  if (!isAdminOpOutcome(outcome)) {
    throw new InvalidInputError(
      "outcome",
      "admin_outcome",
      "pass the result of submitSetPolicy, submitFreeze, submitUnfreeze or submitRotateAgentKey",
    );
  }
  const adminOp = ADMIN_OP_OUTCOMES.get(outcome);
  const transactionHash = adminOp?.transactionHash;
  if (adminOp === undefined || transactionHash === null || transactionHash === undefined) {
    throw new InvalidInputError(
      "outcome",
      "admin_outcome_transaction_hash",
      "the operation has no trackable transaction hash",
    );
  }

  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADMIN_OP_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_ADMIN_OP_POLL_INTERVAL_MS;
  const startedAt = clock.now();
  const result = (
    status: AdminOpWaitStatus,
    detail: string,
    ledger: number | null = null,
  ): AdminOpWaitResult => ({ status, transactionHash, admin: adminOp, detail, ledger });

  if (options.signal?.aborted) {
    return result("pending", `wait for transaction ${transactionHash} was aborted`);
  }

  for (;;) {
    const remainingMs = timeoutMs === 0 ? Infinity : timeoutMs - (clock.now() - startedAt);
    if (remainingMs <= 0) {
      return result(
        "pending",
        `transaction ${transactionHash} was not confirmed within ${timeoutMs}ms`,
      );
    }
    if (options.signal?.aborted) {
      return result("pending", `wait for transaction ${transactionHash} was aborted`);
    }

    let response: unknown;
    try {
      response = await options.server.getTransaction(transactionHash);
    } catch (error) {
      return result(
        "undetermined",
        `could not read transaction ${transactionHash}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (options.signal?.aborted) {
      return result("pending", `wait for transaction ${transactionHash} was aborted`);
    }

    const statusValue = (response as { status?: unknown } | null)?.status;
    const ledgerValue = (response as { ledger?: unknown } | null)?.ledger;
    const ledger = typeof ledgerValue === "number" ? ledgerValue : null;
    if (statusValue === rpc.Api.GetTransactionStatus.SUCCESS) {
      return result("confirmed", `transaction ${transactionHash} was included`, ledger);
    }
    if (statusValue === rpc.Api.GetTransactionStatus.FAILED) {
      return result("failed", `transaction ${transactionHash} failed on the network`, ledger);
    }
    if (statusValue !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return result(
        "undetermined",
        `transaction ${transactionHash} returned an unrecognized status: ${String(statusValue)}`,
      );
    }

    const waitMs = timeoutMs === 0 ? pollIntervalMs : Math.min(pollIntervalMs, remainingMs);
    await abortableSleep(clock, waitMs, options.signal);
  }
}

async function submitAdminOp(
  op: AdminOpName,
  params: AdminOpParams,
  call: ContractCall,
  admin: AdminOutcomeMetadata = { op, guard: params.guard },
): Promise<AdminOpOutcome> {
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
    signerTimeoutMs: params.signerTimeoutMs,
  });
  const enriched = withAdminMetadata(outcome, admin);
  return brandAdminOutcome(enriched, {
    op,
    guard: params.guard,
    transactionHash: transactionHashOf(enriched),
  });
}

/**
 * Submit set_policy to the guard contract with an admin signer.
 * Reuses canonical policyToScVal without duplicating encoding logic.
 */
export function submitSetPolicy(params: SetPolicyParams): Promise<AdminOpOutcome> {
  return submitAdminOp("set_policy", params, buildSetPolicyCall(params.guard, params.policy), {
    op: "set_policy",
    guard: params.guard,
    policyHash: policyHash(params.policy),
  });
}

/**
 * Submit freeze to the guard contract with an admin signer.
 */
export function submitFreeze(params: AdminOpParams): Promise<AdminOpOutcome> {
  return submitAdminOp("freeze", params, buildFreezeCall(params.guard));
}

/**
 * Submit unfreeze to the guard contract with an admin signer.
 */
export function submitUnfreeze(params: AdminOpParams): Promise<AdminOpOutcome> {
  return submitAdminOp("unfreeze", params, buildUnfreezeCall(params.guard));
}

/**
 * Submit rotate_agent_key to the guard contract with an admin signer.
 */
export function submitRotateAgentKey(params: RotateAgentKeyParams): Promise<AdminOpOutcome> {
  return submitAdminOp(
    "rotate_agent_key",
    params,
    buildRotateAgentKeyCall(params.guard, params.newAgent),
    { op: "rotate_agent_key", guard: params.guard, newAgent: agentPublicKey(params.newAgent) },
  );
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
