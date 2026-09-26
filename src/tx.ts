/**
 * Transaction construction for a guarded smart account.
 *
 * ## Why this module exists
 *
 * The `stellar` CLI cannot sign a Soroban authorization entry whose address is
 * a *contract* (the guard): it only signs for the transaction source account
 * and fails with "Missing signing key for account C…". The only way to exercise
 * a custom account's `__check_auth` is to build the `SorobanAuthorizationEntry`
 * for the guard address yourself and sign its payload with the registered
 * agent key — which is what this module does, in TypeScript.
 *
 * ## What is signed
 *
 * The host hands `__check_auth` the SHA-256 digest of
 * `HashIdPreimage::SorobanAuthorization { network_id, nonce,
 * signature_expiration_ledger, invocation }`, and the guard verifies it with
 * `env.crypto().ed25519_verify(registered_agent_pubkey, digest, signature)`.
 * So the signature here is a raw 64-byte Ed25519 signature over that digest,
 * carried as `ScVal::Bytes` inside `SorobanAddressCredentials` — not the
 * `Vec[Map{public_key, signature}]` shape the SDK's `authorizeEntry` helper
 * produces for classic-account credentials.
 *
 * The nonce must never repeat for the guard address: the host records every
 * consumed nonce in ledger state and rejects replays. Strictly-increasing
 * transaction sequence numbers are unique per transaction and never reused, so
 * the sequence doubles as the nonce (same choice as the Phase 1 `agent-tx`
 * tool, which proved this path on-chain).
 *
 * ## Why there is an `AgentSigner` seam
 *
 * v1 registers exactly one Ed25519 agent key, so this module used to take a
 * bare `Keypair` and call `keypair.sign(digest)`. Contracts v2 will change the
 * guard's own `Signature` type to something multi-key (a threshold scheme),
 * and the SDK should absorb that without another breaking change to every
 * caller's config object. `AgentSigner` is the seam that allows it: the SDK
 * depends on "something that signs the authorization digest", not on
 * "something that is a `Keypair`". The single-key `Keypair` remains a valid
 * input everywhere, wrapped by `keypairAgentSigner` / `toAgentSigner` — the
 * current behaviour is unchanged, and multi-key support lands behind the same
 * interface when the contracts decision does. Research, options and the revisit
 * trigger: `docs/concepts/multi-key-agent-signing.md`.
 */
import { createHash } from "node:crypto";
import {
  Account,
  Address,
  Keypair,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

/** Extra ledger validity granted to a guard auth entry when it is signed. */
const SIG_EXPIRATION_LEDGERS = 10_000;
/** Inclusion fee floor, in stroops, for a single-operation transaction. */
const INCLUSION_FEE = "100";

export interface ContractCall {
  /** Contract address (C…) to invoke. */
  contract: string;
  /** Function name as it appears in the contract spec. */
  fn: string;
  args: xdr.ScVal[];
}

/** The guard's own persistent storage keys, as they exist in ledger state. */
export const GUARD_STORAGE_KEYS = [
  "Policy",
  "Window",
  "LastHeartbeat",
  "AdminFrozen",
] as const;

/** Stable identity for a ledger key, for de-duplicating footprint entries. */
function ledgerKeyId(key: xdr.LedgerKey): string {
  return Buffer.from(key.toXDR()).toString("base64");
}

export function addressToScVal(strkey: string): xdr.ScVal {
  return new Address(strkey).toScVal();
}

export function invocationArgs(call: ContractCall): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: new Address(call.contract).toScAddress(),
    functionName: call.fn,
    args: call.args,
  });
}

/**
 * Ledger keys for the guard's own storage. A `contracttype` enum in Rust is a
 * vector of symbols on the wire (`DataKey::Policy` → `[Symbol("Policy")]`), so
 * the keys are built to match real ledger state rather than as bare symbols.
 */
export function guardStorageLedgerKeys(guard: string): xdr.LedgerKey[] {
  const contract = new Address(guard).toScAddress();
  const keys = GUARD_STORAGE_KEYS.map((name) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract,
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
  keys.push(
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
  return keys;
}

/**
 * The signing capability the guard's authorization needs — the seam that lets
 * N-key (or otherwise non-`Keypair`) agent signing land without a second
 * breaking change (see the module header and
 * `docs/concepts/multi-key-agent-signing.md`).
 *
 * It is deliberately the *digest* that crosses this boundary, not the XDR
 * entry: the host hashes the authorization preimage and hands `__check_auth`
 * the 32-byte digest, so a signer never has to understand Soroban XDR to be
 * usable here. `signDigest` may return synchronously (a local key) or as a
 * promise (a remote/HSM-backed signer); `buildGuardAuthEntry` awaits it.
 */
export interface AgentSigner {
  /** The signer's public identity, for diagnostics and key matching. */
  readonly publicKey: string;
  /** Sign the 32-byte SHA-256 digest `__check_auth` will verify. */
  signDigest(digest: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/**
 * The current single-key signer: a local Ed25519 `Keypair`, exposed through
 * the `AgentSigner` interface. One key, one raw 64-byte signature — exactly the
 * behaviour the SDK has always had.
 */
export function keypairAgentSigner(agent: Keypair): AgentSigner {
  return {
    publicKey: agent.publicKey(),
    signDigest: (digest) => agent.sign(Buffer.from(digest)),
  };
}

/**
 * Accept either a ready-made `AgentSigner` or a plain `Keypair`.
 *
 * The `Keypair` branch is what keeps this refactor non-breaking: every existing
 * caller passing a keypair still works, and only a caller with a genuinely
 * different signing setup has to supply the interface itself.
 */
export function toAgentSigner(signer: AgentSigner | Keypair): AgentSigner {
  if (typeof (signer as AgentSigner).signDigest === "function") {
    return signer as AgentSigner;
  }
  return keypairAgentSigner(signer as Keypair);
}

/**
 * Build and sign the guard's authorization entry for one call.
 *
 * `nonce` and `signatureExpirationLedger` are written into the signed payload,
 * so the returned entry is only valid for that nonce — build a fresh entry per
 * submission rather than reusing one.
 *
 * Async because an `AgentSigner` may be: a remote or threshold signer resolves
 * its signatures as a promise. The single-`Keypair` path still resolves
 * immediately, so this is a source-compatible widening for `await`ing callers
 * and a signature change for callers that used the return value synchronously.
 */
/**
 * Credential kinds the host may demand for this account.
 *
 * Which one arrives is not the caller's choice — the RPC reports what the call
 * requires, and it differs by call shape: an SAC `transfer` authorized by the
 * account comes back as legacy `sorobanCredentialsAddress`, while a self-call
 * such as `heartbeat` comes back as `sorobanCredentialsAddressV2` (CAP-71),
 * whose signed payload additionally binds the account address.
 *
 * The contract itself is indifferent: `__check_auth` verifies the Ed25519
 * signature against whatever digest the host presents, so the SDK's job is to
 * build the preimage that matches the credential type it is answering.
 */
export type GuardCredentialType =
  | "sorobanCredentialsAddress"
  | "sorobanCredentialsAddressV2";

export async function buildGuardAuthEntry(params: {
  guard: string;
  call: ContractCall;
  /**
   * The account's agent signer. A `Keypair` is accepted for the single-key case
   * and wrapped via `toAgentSigner`; supply an `AgentSigner` directly for any
   * other signing setup.
   */
  signer: AgentSigner | Keypair;
  nonce: bigint;
  signatureExpirationLedger: number;
  networkPassphrase: string;
  credentialType?: GuardCredentialType;
}): Promise<xdr.SorobanAuthorizationEntry> {
  const {
    guard,
    call,
    signer: rawSigner,
    nonce,
    signatureExpirationLedger,
    networkPassphrase,
    credentialType = "sorobanCredentialsAddress",
  } = params;
  const signer = toAgentSigner(rawSigner);
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      invocationArgs(call),
    ),
    subInvocations: [],
  });
  const networkId = createHash("sha256").update(networkPassphrase).digest();
  const guardAddress = new Address(guard).toScAddress();

  const preimage =
    credentialType === "sorobanCredentialsAddressV2"
      ? xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
          new xdr.HashIdPreimageSorobanAuthorizationWithAddress({
            networkId,
            nonce,
            invocation: rootInvocation,
            address: guardAddress,
            signatureExpirationLedger,
          }),
        )
      : xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
          new xdr.HashIdPreimageSorobanAuthorization({
            networkId,
            nonce,
            invocation: rootInvocation,
            signatureExpirationLedger,
          }),
        );

  const digest = createHash("sha256").update(preimage.toXDR()).digest();
  const signature = await signer.signDigest(digest);

  const addressCredentials = new xdr.SorobanAddressCredentials({
    address: guardAddress,
    nonce,
    signatureExpirationLedger,
    signature: xdr.ScVal.scvBytes(signature),
  });

  return new xdr.SorobanAuthorizationEntry({
    credentials:
      credentialType === "sorobanCredentialsAddressV2"
        ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials),
    rootInvocation,
  });
}

/**
 * Sign a classic-account authorization entry (used for admin calls such as
 * `initialize` / `set_policy`, where the authorizer is a normal keypair rather
 * than the smart account).
 */
export async function signAccountAuthEntry(params: {
  entry: xdr.SorobanAuthorizationEntry;
  signer: Keypair;
  signatureExpirationLedger: number;
  networkPassphrase: string;
}): Promise<xdr.SorobanAuthorizationEntry> {
  const { authorizeEntry } = await import("@stellar/stellar-sdk");
  return authorizeEntry(
    params.entry,
    params.signer,
    params.signatureExpirationLedger,
    params.networkPassphrase,
  );
}

export interface SimulationOutcome {
  /** Raw simulation response, for callers that need events or cost data. */
  raw: rpc.Api.SimulateTransactionResponse;
  blocked: { code?: string; message: string } | null;
}

/**
 * Simulate a call whose authorization has already been signed.
 *
 * When the auth entry carries a valid agent signature, the RPC runs the *real*
 * `__check_auth` during simulation. A policy violation therefore surfaces here,
 * before broadcast, as a simulation error naming the reason symbol — this is
 * the interception point the SDK's pre-flight gate is built on.
 */
export async function simulateSigned(
  server: rpc.Server,
  transaction: Transaction,
): Promise<SimulationOutcome> {
  const raw = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(raw)) {
    const error = raw as rpc.Api.SimulateTransactionErrorResponse;
    return {
      raw,
      blocked: {
        ...(typeof error.error === "string" ? { code: error.error } : {}),
        message: error.error ?? "simulation failed",
      },
    };
  }
  return { raw, blocked: null };
}

export interface AssembleResult {
  transaction: Transaction;
  /** Resource fee actually charged for the assembled transaction. */
  resourceFee: bigint;
  footprintKeys: number;
}

/**
 * Assemble a submittable transaction from a successful simulation, merging the
 * guard's own storage keys into the footprint.
 *
 * RPC preflight prices what the *called* contract touches. A custom account's
 * `__check_auth` additionally reads and writes the account's own policy, window
 * and freeze state, so those keys must be present in the declared footprint and
 * the declared resource fee must cover them — otherwise core rejects the
 * transaction with `insufficient_refundable_fee`. Keys are merged, never
 * dropped, so a simulation that already priced them is unaffected.
 */
export function assembleFromSimulation(params: {
  simulation: rpc.Api.SimulateTransactionSuccessResponse;
  source: Account;
  operation: xdr.Operation;
  networkPassphrase: string;
  guard: string | null;
  extraResourceFee?: bigint;
}): AssembleResult {
  const { simulation, source, operation, networkPassphrase, guard } = params;
  // v17 hands back a builder already; older shapes hand back the data itself.
  const data =
    simulation.transactionData instanceof SorobanDataBuilder
      ? simulation.transactionData
      : new SorobanDataBuilder(simulation.transactionData);
  let footprintKeys = 0;

  if (guard) {
    const merged = [...data.getReadWrite()];
    // De-duplicate against BOTH footprint lists. A key appearing in read_only and
    // read_write at once is an invalid footprint and the network rejects the
    // transaction with `tx_soroban_invalid` — and RPC preflight commonly places
    // the guard's own storage keys in read_only, so merging blindly into
    // read_write would duplicate every one of them.
    const seen = new Set([
      ...data.getReadOnly().map((key) => ledgerKeyId(key)),
      ...merged.map((key) => ledgerKeyId(key)),
    ]);
    for (const key of guardStorageLedgerKeys(guard)) {
      const id = ledgerKeyId(key);
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(key);
      }
    }
    data.setReadWrite(merged);
    footprintKeys = merged.length;
  }

  const minResourceFee = BigInt(simulation.minResourceFee);
  const extra = params.extraResourceFee ?? 0n;
  data.setResourceFee(minResourceFee + extra);

  // `TransactionBuilder` folds the resource fee declared in `sorobanData` into
  // the transaction fee on build(), so `fee` here is the inclusion fee only.
  const transaction = new TransactionBuilder(source, {
    fee: INCLUSION_FEE,
    networkPassphrase,
    sorobanData: data.build(),
  })
    .addOperation(operation)
    .setTimeout(0)
    .build();

  return { transaction, resourceFee: minResourceFee + extra, footprintKeys };
}

/**
 * Human-readable dump of a simulation's declared resources and footprint.
 *
 * A `scecExceededLimit` rejection *after* inclusion means the ledger charged
 * more of a resource than the transaction declared — a mismatch that only shows
 * up as two bare numbers in an error payload. This makes the declaration
 * legible next to the charge, which is the only way to tell an under-declaration
 * from a genuine limit.
 */
export function describeSimulationResources(
  simulation: unknown,
  guard: string | null,
): string {
  const candidate = simulation as {
    transactionData?: unknown;
    minResourceFee?: string | number;
    error?: unknown;
  };
  if (candidate.transactionData === undefined) {
    return `  (simulation error, no resources declared)\n  error: ${JSON.stringify(candidate.error)}`;
  }
  const data =
    candidate.transactionData instanceof SorobanDataBuilder
      ? candidate.transactionData
      : new SorobanDataBuilder(candidate.transactionData as never);
  const built = data.build();
  // The SDK's XDR classes expose camelCase properties (`writeBytes`,
  // `footprint.readWrite`); only their serialised JSON form uses the wire's
  // snake_case names. Reading the JSON shape here would silently yield
  // `undefined` for every field.
  const resources = (built as unknown as {
    resources: {
      instructions: number;
      diskReadBytes: number;
      writeBytes: number;
      footprint: { readOnly: unknown[]; readWrite: unknown[] };
    };
  }).resources;
  const declared = new Set(resources.footprint.readWrite.map((key) => ledgerKeyId(key as xdr.LedgerKey)));
  const own = guard
    ? guardStorageLedgerKeys(guard).map((key, index) => {
        const name = GUARD_STORAGE_KEYS[index] ?? `#${index}`;
        return declared.has(ledgerKeyId(key))
          ? `${name}: declared read_write`
          : `${name}: NOT in the footprint`;
      })
    : [];
  return [
    `  instructions: ${resources.instructions}`,
    `  disk_read_bytes: ${resources.diskReadBytes}`,
    `  write_bytes: ${resources.writeBytes}`,
    `  footprint: ${resources.footprint.readOnly.length} read-only, ${resources.footprint.readWrite.length} read-write`,
    `  minResourceFee: ${candidate.minResourceFee}`,
    ...own.map((line) => `  guard key ${line}`),
  ].join("\n");
}

/**
 * `resultXdr` arrives either as a base64 string or as a decoded value that
 * knows how to serialise itself, depending on SDK internals — normalise to a
 * string so failure reports are always copy-pasteable evidence.
 */
function resultXdrToString(result: unknown): string | null {
  const value = (result as { resultXdr?: unknown }).resultXdr;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  const serialisable = value as { toXDR?: (format: string) => string };
  if (typeof serialisable.toXDR === "function") return serialisable.toXDR("base64");
  return String(value);
}

export interface SubmissionResult {
  hash: string;
  status: string;
  ledger: number | null;
  /** Present when the network rejected the transaction after broadcast. */
  failure: {
    resultXdr: string | null;
    /** Contract-level arm derived from the result, e.g. `invokeHostFunctionResult=trap`. */
    resultCode: string | null;
    message: string;
    diagnosticEvents: unknown[];
  } | null;
  events: unknown[];
}

/** Recursively convert SDK XDR values into plain, inspectable objects. */
function toPlain(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 8) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  if (typeof value !== "object") return value;
  const withXdr = value as { toXdrObject?: () => unknown };
  if (typeof withXdr.toXdrObject === "function") {
    return toPlain(withXdr.toXdrObject(), depth + 1);
  }
  if (Array.isArray(value)) return value.map((item) => toPlain(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = toPlain(item, depth + 1);
  }
  return out;
}

/**
 * Name the arm that caused a rejected transaction. A trap (`trap`) means the
 * contract itself panicked — the most useful thing to surface, since the guard
 * panics with a typed `Error` rather than a bare failure.
 */
export function describeTransactionResult(result: unknown): string | null {
  const plain = toPlain(result) as
    | { result?: { type?: string; results?: Array<{ tr?: Record<string, unknown> }> } }
    | null;
  const arm = plain?.result?.results?.[0]?.tr?.["invokeHostFunctionResult"] as
    | { type?: string }
    | undefined;
  if (arm?.type) return `invokeHostFunctionResult=${arm.type}`;
  if (plain?.result?.type) return `result=${plain.result.type}`;
  return null;
}

/** Render a diagnostic event's topics and data in the contract's vocabulary. */
function describeEvent(raw: unknown): string {
  const event = raw as {
    event?: { body?: { v0?: { topics?: xdr.ScVal[]; data?: xdr.ScVal } } };
  };
  const v0 = event?.event?.body?.v0;
  if (!v0) return "(unrecognised diagnostic event shape)";
  const render = (value: unknown): string => {
    if (value === undefined) return "()";
    try {
      return JSON.stringify(scValToNative(value as xdr.ScVal), (_k, v: unknown) =>
        typeof v === "bigint" ? v.toString() : v,
      );
    } catch {
      return "(undecodable)";
    }
  };
  const topics = (v0.topics ?? []).map(render).join(", ");
  return `topics=[${topics}] data=${render(v0.data)}`;
}

/**
 * Human-readable summary of the diagnostic events attached to a failure.
 * These are the host's and the contract's own words (`fn_call`, `error`, `log`),
 * which is what makes a trap diagnosable rather than opaque.
 */
export function summarizeDiagnosticEvents(events: unknown[]): string[] {
  return events.map(describeEvent);
}

/**
 * Was this post-inclusion failure a *stale-ledger resource declaration*?
 *
 * Diagnosed the hard way: the enforced simulation reports the write size for the
 * window state it observed, and when the RPC serves a ledger snapshot that
 * predates the write this SDK just made, the declared `writeBytes` is short by
 * exactly one rolling-window entry (72 bytes on this contract). The transaction
 * is then included and rejected by core with `scecExceededLimit` — a failure
 * that is not the caller's fault and not a policy decision.
 *
 * It is safe to re-simulate and retry: a transaction rejected for exceeding a
 * resource limit applies **nothing** (state is rolled back), and the very fact
 * of inclusion proves the ledger has since advanced past the stale snapshot.
 * Contract-level `Auth` failures are deliberately *not* matched here — those are
 * the guard doing its job and must surface as a block, not be retried.
 */
export function isStaleLedgerResourceFailure(
  failure: NonNullable<SubmissionResult["failure"]>,
): boolean {
  const haystack = [
    failure.message,
    failure.resultCode ?? "",
    ...failure.diagnosticEvents.map((event) => JSON.stringify(event)),
  ].join("\n");
  // The host names this `insufficient_refundable_fee` as an error code and
  // "insufficient refundable fee" in prose; match either spelling.
  return /scecExceededLimit|exceeds amount specified|insufficient[_ ]refundable[_ ]fee/i.test(
    haystack,
  );
}

/**
 * Was a submission rejected because the source account sequence was stale?
 *
 * `tx_bad_seq` is the canonical code, but RPC error payloads are not perfectly
 * consistent across SDK and server versions. Keep the matching deliberately
 * narrow so ordinary transaction failures are never retried with a new sequence.
 */
export function isSequenceNumberFailure(
  failure: NonNullable<SubmissionResult["failure"]>,
): boolean {
  const haystack = [
    failure.message,
    failure.resultCode ?? "",
    ...failure.diagnosticEvents.map((event) => JSON.stringify(event)),
  ].join("\n");
  return /tx_bad_seq|bad[_ ]seq|sequence (?:number )?(?:is )?(?:too (?:low|high|small|large)|mismatch|does not match|already (?:been )?(?:used|spent))/i.test(
    haystack,
  );
}

/** Full, copy-pasteable rendering of a failed submission, for evidence. */
export function describeSubmissionFailure(failure: NonNullable<SubmissionResult["failure"]>): string {
  const lines = [`resultCode: ${failure.resultCode ?? "unknown"}`, `message: ${failure.message}`];
  if (failure.resultXdr) lines.push(`resultXdr: ${failure.resultXdr}`);
  for (const summary of summarizeDiagnosticEvents(failure.diagnosticEvents)) {
    lines.push(`diagnostic: ${summary}`);
  }
  return lines.join("\n");
}

/** Submit a signed transaction and poll until it is included in a ledger. */
export async function submitAndPoll(
  server: rpc.Server,
  transaction: Transaction,
  signers: Keypair[],
  options: { pollAttempts?: number; pollIntervalMs?: number } = {},
): Promise<SubmissionResult> {
  transaction.sign(...signers);

  const sent = await server.sendTransaction(transaction);
  if (sent.status === "ERROR") {
    return {
      hash: sent.hash,
      status: sent.status,
      ledger: null,
      failure: {
        resultXdr: null,
        resultCode: describeTransactionResult(sent.errorResult),
        message: JSON.stringify(sent.errorResult ?? sent),
        diagnosticEvents: [],
      },
      events: [],
    };
  }

  const attempts = options.pollAttempts ?? 20;
  const interval = options.pollIntervalMs ?? 3_000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const result = await server.getTransaction(sent.hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        hash: sent.hash,
        status: result.status,
        ledger: result.ledger ?? null,
        failure: null,
        events: (result as { events?: { contractEventsXdr?: unknown[] } }).events
          ?.contractEventsXdr ?? [],
      };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      const failed = result as unknown as {
        resultXdr?: unknown;
        diagnosticEventsXdr?: unknown[];
      };
      return {
        hash: sent.hash,
        status: result.status,
        ledger: result.ledger ?? null,
        failure: {
          resultXdr: resultXdrToString(result),
          resultCode: describeTransactionResult(failed.resultXdr),
          message: "transaction failed after inclusion",
          diagnosticEvents: failed.diagnosticEventsXdr ?? [],
        },
        events: [],
      };
    }
  }
  return {
    hash: sent.hash,
    status: "TIMEOUT",
    ledger: null,
    failure: {
      resultXdr: null,
      resultCode: null,
      message: "timed out waiting for ledger inclusion",
      diagnosticEvents: [],
    },
    events: [],
  };
}

/** Convenience wrapper: build the initial (footprint-declaring) envelope. */
export function buildInitialEnvelope(params: {
  source: Account;
  operation: xdr.Operation;
  networkPassphrase: string;
  guard: string | null;
}): Transaction {
  const builder = new TransactionBuilder(params.source, {
    fee: INCLUSION_FEE,
    networkPassphrase: params.networkPassphrase,
    ...(params.guard
      ? {
          sorobanData: new SorobanDataBuilder()
            .setReadWrite(guardStorageLedgerKeys(params.guard))
            .build(),
        }
      : {}),
  })
    .addOperation(params.operation)
    .setTimeout(0);
  return builder.build();
}

export { SIG_EXPIRATION_LEDGERS, INCLUSION_FEE };
