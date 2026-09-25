/**
 * The full invocation pipeline for a guarded account, in the order the Stellar
 * host actually requires:
 *
 *  1. simulate with no authorization  → RPC reports which authorizations the
 *     call needs (and the footprint that call touches);
 *  2. sign each reported authorization — a classic keypair for admin calls, or
 *     an agent-signed `SorobanAuthorizationEntry` for the guard contract;
 *  3. simulate again with the signed entries → this second simulation runs the
 *     *real* `__check_auth` against live ledger state, so a policy violation is
 *     reported here, **before** anything is broadcast;
 *  4. only if step 3 succeeds, assemble the real resources, sign the envelope
 *     and broadcast.
 *
 * Steps 1–3 never mutate the ledger. A blocked action therefore costs nothing,
 * which is the property the pre-flight interceptor is built to expose.
 */
import { Account, Address, Keypair, Operation, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { GUARD_AUTH_RESULTS, decodeAuthDecision } from "./events.ts";
import {
  SIG_EXPIRATION_LEDGERS,
  assembleFromSimulation,
  buildGuardAuthEntry,
  buildInitialEnvelope,
  describeSimulationResources,
  describeSubmissionFailure,
  isStaleLedgerResourceFailure,
  signAccountAuthEntry,
  summarizeDiagnosticEvents,
  submitAndPoll,
  type ContractCall,
  type SubmissionResult,
} from "./tx.ts";

/** How the guard's authorization is produced for a call that needs it. */
export interface GuardAuthorization {
  guard: string;
  agent: Keypair;
}

/**
 * Machine-readable causes attached to non-policy `invoke()` failures.
 *
 * `undetermined` deliberately covers errors for which the guard did not make a
 * decision (a bad input, an RPC/host failure, or an unsupported auth shape).
 * It is the same fail-closed category used by pre-flight decisions; it must not
 * be confused with `blocked`, which means the guard actually refused the call.
 */
export const INVOKE_ERROR_CAUSES = {
  undetermined: "undetermined",
  staleLedgerResourceLimit: "stale_ledger_resource_limit",
} as const;

export type InvokeErrorCause =
  (typeof INVOKE_ERROR_CAUSES)[keyof typeof INVOKE_ERROR_CAUSES];

/** The error arm returned by one invocation attempt. */
export interface InvokeErrorOutcome {
  kind: "error";
  detail: string;
  /** Coarse cause; absent for a dry run because no failure was classified. */
  cause?: InvokeErrorCause;
  /**
   * Set when the failure is a stale-ledger resource declaration that a
   * re-simulation can fix. See `isStaleLedgerResourceFailure` in `tx.ts`.
   */
  retryable?: "stale_ledger_resource_limit";
}

/**
 * Raised/returned when the bounded stale-ledger retry budget is exhausted.
 *
 * `invoke()` returns this object as its `kind: "error"` outcome rather than
 * throwing, preserving the result-oriented API. It is still a real `Error`, so
 * callers can use `instanceof`, retain it for diagnostics, or rethrow it.
 */
export class InvokeRetryError extends Error {
  readonly kind = "error" as const;
  readonly attempts: number;
  override readonly cause: InvokeErrorCause;
  readonly lastCause: InvokeErrorCause;
  readonly detail: string;
  readonly lastOutcome: InvokeErrorOutcome;
  /** An exhausted attempt is no longer itself retryable. */
  readonly retryable?: undefined;

  constructor(params: { attempts: number; lastOutcome: InvokeErrorOutcome }) {
    const lastCause =
      params.lastOutcome.retryable === "stale_ledger_resource_limit"
        ? INVOKE_ERROR_CAUSES.staleLedgerResourceLimit
        : (params.lastOutcome.cause ?? INVOKE_ERROR_CAUSES.undetermined);
    super(
      `stellar-agent-guard invoke retry budget exhausted after ${params.attempts} attempt(s) ` +
        `(last cause: ${lastCause})\n${params.lastOutcome.detail}`,
    );
    this.name = "InvokeRetryError";
    this.attempts = params.attempts;
    this.cause = lastCause;
    this.lastCause = lastCause;
    this.detail = params.lastOutcome.detail;
    this.lastOutcome = params.lastOutcome;
  }
}

export type InvokeOutcome =
  | { kind: "allowed"; submission: SubmissionResult }
  | {
      kind: "blocked";
      /** Reason symbol from the contract's own event/topic vocabulary. */
      reason: string | null;
      detail: string;
      /** Diagnostic events emitted by the contract during enforced simulation. */
      diagnosticEvents: unknown[];
    }
  | InvokeErrorOutcome
  | InvokeRetryError;

/** Defaults for the bounded stale-ledger retry policy. */
export const DEFAULT_INVOKE_RETRY_OPTIONS = {
  /** Total attempts, including the first attempt. */
  maxAttempts: 3,
  /** Upper bound used for the first full-jitter delay. */
  baseDelayMs: 100,
  /** Upper bound for every later full-jitter delay. */
  maxDelayMs: 2_000,
} as const;

export interface InvokeRetryOptions {
  /** Total attempts, including the first attempt. Default: 3. */
  maxAttempts?: number;
  /** Base full-jitter window in milliseconds. Default: 100. */
  baseDelayMs?: number;
  /** Maximum full-jitter window in milliseconds. Default: 2,000. */
  maxDelayMs?: number;
  /** RNG used for full jitter; it must return a value in [0, 1). */
  random?: () => number;
  /** Alias for `random`, useful when describing the jitter strategy. */
  jitter?: () => number;
  /** Sleep implementation, injectable for deterministic tests/custom clocks. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Compatibility alias for `baseDelayMs`. */
  initialDelayMs?: number;
}

export interface InvokePollOptions {
  /** Number of ledger-status polls after a pending broadcast. */
  pollAttempts?: number;
  /** Delay between ledger-status polls. */
  pollIntervalMs?: number;
}

export interface InvokeParams {
  server: rpc.Server;
  /** Classic account that pays the fee and supplies the sequence number. */
  source: Keypair;
  call: ContractCall;
  networkPassphrase: string;
  /** Present when the call requires the smart account's own authorization. */
  guardAuth?: GuardAuthorization | null;
  /** Extra classic-account authorizers available to sign (e.g. an admin). */
  accountSigners?: Keypair[];
  /** Skip broadcast even if the enforced simulation passes (dry run). */
  dryRun?: boolean;
  /** Configure bounded full-jitter retries for stale ledger resource limits. */
  retry?: InvokeRetryOptions;
  /** Configure post-broadcast ledger-status polling. */
  pollOptions?: InvokePollOptions;
}

/** Alias matching the terminology used by the README API reference. */
export type InvokeOptions = InvokeParams;

/**
 * Topic symbols of a contract event, tolerating the several shapes RPC and the
 * SDK use for the same event: decoded `xdr.DiagnosticEvent` instances, bare
 * event objects, or base64 XDR strings in a JSON error payload.
 *
 * Exported because a telemetry consumer needs the same tolerance to read a
 * guard decision out of either stream, and duplicating the shape-handling would
 * mean two places to get it wrong.
 */
export function topicSymbols(raw: unknown): string[] {
  const candidate = raw as {
    event?: { body?: unknown };
    body?: unknown;
  };
  const body = (candidate.event?.body ?? candidate.body) as
    | { v0?: { topics?: unknown[] }; value?: { v0?: { topics?: unknown[] } } }
    | undefined;
  const topics = body?.v0?.topics ?? body?.value?.v0?.topics;
  if (!Array.isArray(topics)) return [];
  return topics.flatMap((topic) => {
    try {
      if (typeof topic === "string") {
        return [String(scValToNative(xdr.ScVal.fromXDR(topic, "base64")))];
      }
      return [String(scValToNative(topic as xdr.ScVal))];
    } catch {
      return [];
    }
  });
}

/**
 * Extract the contract's own block reason from a simulation failure.
 *
 * The RPC error string is not the contract's reason vocabulary, but the
 * diagnostic events bundled with the failure are: the guard publishes
 * `topics = [event_auth_checked, blocked, <reason>]` on every decision,
 * including decisions taken inside an enforced simulation. Note the `event_`
 * prefix — see `events.ts` for why the live topic differs from the docs' name.
 *
 * A *blocked* decision is only ever observed here, as a diagnostic: the guard
 * returns `Err`, which rolls the event back, so it never reaches a ledger.
 */
export function reasonFromDiagnosticEvents(events: unknown[]): string | null {
  for (const event of events) {
    const decision = decodeAuthDecision(topicSymbols(event), "diagnostic");
    if (decision?.result === GUARD_AUTH_RESULTS.blocked && decision.reason) {
      return decision.reason;
    }
  }
  return null;
}

/**
 * Diagnostic events attached to a failed simulation, if the RPC supplied any.
 * Both the top-level `events` field and the nested error payload are checked:
 * which one carries them varies by failure kind.
 */
/**
 * Payload of an address-bound credential, for either arm.
 *
 * The two arms name their payload differently (`address` for legacy, `addressV2`
 * for CAP-71's address-bound form), which mirrors the SDK's own internal
 * `getAddressCredentials` switch.
 */
function addressCredentialsOf(
  credentials: xdr.SorobanCredentials,
): xdr.SorobanAddressCredentials | null {
  if (credentials.type === "sorobanCredentialsAddress") {
    return credentials.address;
  }
  if (credentials.type === "sorobanCredentialsAddressV2") {
    return credentials.addressV2;
  }
  return null;
}

function diagnosticEventsOf(response: unknown): unknown[] {
  const candidate = response as {
    events?: unknown;
    error?: { data?: { events?: unknown } };
  };
  for (const value of [candidate.events, candidate.error?.data?.events]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

interface ResolvedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random: () => number;
  sleep: (delayMs: number) => Promise<void>;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function resolveRetryOptions(options: InvokeRetryOptions | undefined): ResolvedRetryOptions {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_INVOKE_RETRY_OPTIONS.maxAttempts;
  const baseDelayMs =
    options?.baseDelayMs ??
    options?.initialDelayMs ??
    DEFAULT_INVOKE_RETRY_OPTIONS.baseDelayMs;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_INVOKE_RETRY_OPTIONS.maxDelayMs;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`retry.maxAttempts must be an integer >= 1 (received ${maxAttempts})`);
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError(`retry.baseDelayMs must be finite and >= 0 (received ${baseDelayMs})`);
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new RangeError(`retry.maxDelayMs must be finite and >= 0 (received ${maxDelayMs})`);
  }

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    random: options?.random ?? options?.jitter ?? Math.random,
    sleep: options?.sleep ?? defaultSleep,
  };
}

/**
 * Full-jitter delay for the retry after `attempt` has failed.
 *
 * The exponential value is only the window: multiplying it by an independent
 * random sample spreads agents that observed the same ledger pressure instead
 * of releasing them in a synchronized thundering herd.
 */
function fullJitterDelay(attempt: number, options: ResolvedRetryOptions): number {
  const window = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const sample = options.random();
  // A custom RNG should return [0, 1), but clamp a bad edge value rather than
  // allowing a production retry policy to be disabled by an out-of-range sample.
  const normalized = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  return Math.floor(window * normalized);
}

/**
 * Run one contract call through simulate → sign → enforce, submitting only on a
 * pass. Returns a discriminated result rather than throwing, so callers can
 * decide whether a block is an expected outcome (agents hitting a guardrail) or
 * a failure worth surfacing.
 *
 * Stale ledger resource failures are retried with bounded full-jitter backoff.
 * Every attempt starts a fresh invocation pipeline, including discovery and
 * enforced simulation, so the resource declaration is always priced against
 * current ledger state. Non-retryable outcomes return immediately and never
 * sleep. When the budget is exhausted, the returned `InvokeRetryError` carries
 * the attempt count and the last retry cause.
 */
export async function invoke(params: InvokeParams): Promise<InvokeOutcome> {
  const retry = resolveRetryOptions(params.retry);
  let attempts = 0;

  while (true) {
    attempts += 1;
    const outcome = await invokePipeline(params);

    if (outcome.kind !== "error" || outcome.retryable !== "stale_ledger_resource_limit") {
      return outcome;
    }
    if (params.dryRun) return outcome;
    if (attempts >= retry.maxAttempts) {
      return new InvokeRetryError({ attempts, lastOutcome: outcome });
    }

    await retry.sleep(fullJitterDelay(attempts, retry));
  }
}

/**
 * The outcome of steps 1–3: the guard has been asked, and answered.
 *
 * `admissible` means the enforced simulation ran the real `__check_auth` against
 * live ledger state and it passed. It is separated from submission so the
 * pre-flight interceptor can ask the same question without broadcasting
 * anything — one implementation of the enforcement question, two callers.
 */
export type EnforcementOutcome =
  | {
      kind: "admissible";
      /** The successful enforced simulation, carrying real resource pricing. */
      simulation: rpc.Api.SimulateTransactionSuccessResponse;
      /** The operation with signed authorizations attached, ready to assemble. */
      operation: xdr.Operation;
      /** Base sequence number for building the submitting envelope. */
      nextSeq: string;
    }
  | {
      kind: "blocked";
      reason: string;
      detail: string;
      diagnosticEvents: unknown[];
    }
  | { kind: "error"; detail: string };

/** One attempt: simulate → sign → enforce → submit. No retry logic lives here. */
async function invokePipeline(params: InvokeParams): Promise<InvokeOutcome> {
  const { server } = params;
  const enforced = await enforceCall(params);
  if (enforced.kind === "error") {
    return {
      ...enforced,
      cause: INVOKE_ERROR_CAUSES.undetermined,
    };
  }
  if (enforced.kind !== "admissible") return enforced;

  if (params.dryRun) {
    return {
      kind: "error",
      detail: "dry run: enforced simulation passed; submission skipped as requested",
    };
  }

  // ── Step 4: assemble real resources, sign the envelope, broadcast ─────
  const assembled = assembleFromSimulation({
    simulation: enforced.simulation,
    // A fresh `Account` per build: `TransactionBuilder` advances the sequence of
    // the instance it is handed, so sharing one across builds silently produces
    // `tx_bad_seq`.
    source: new Account(params.source.publicKey(), enforced.nextSeq),
    operation: enforced.operation,
    networkPassphrase: params.networkPassphrase,
    guard: params.guardAuth?.guard ?? null,
  });

  const submission = await submitAndPoll(
    server,
    assembled.transaction,
    [params.source],
    params.pollOptions,
  );
  if (submission.failure) {
    // A post-broadcast rejection is a hard error, not a policy block: the
    // enforced simulation already passed, so anything here is a defect in
    // construction (sequence, fee, footprint) or a contract trap — never a
    // guardrail doing its job.
    const staleLedger = isStaleLedgerResourceFailure(submission.failure);
    return {
      kind: "error",
      detail: `tx ${submission.hash} ${describeSubmissionFailure(submission.failure)}`,
      cause: staleLedger
        ? INVOKE_ERROR_CAUSES.staleLedgerResourceLimit
        : INVOKE_ERROR_CAUSES.undetermined,
      ...(staleLedger ? { retryable: "stale_ledger_resource_limit" as const } : {}),
    };
  }
  return { kind: "allowed", submission };
}

/**
 * Steps 1–3 of the pipeline, with no submission: discover what the call needs,
 * sign it, then run the *enforced* simulation that actually exercises the
 * guard's `__check_auth` against live ledger state.
 *
 * Nothing here mutates the ledger, which is what makes a refusal free.
 */
export async function enforceCall(params: InvokeParams): Promise<EnforcementOutcome> {
  const { server, source, call, networkPassphrase } = params;
  const operation = Operation.invokeContractFunction({
    contract: call.contract,
    function: call.fn,
    args: call.args,
  });

  const sourceAccount = await server.getAccount(source.publicKey());
  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + SIG_EXPIRATION_LEDGERS;
  // `TransactionBuilder` advances the sequence of the `Account` it is handed,
  // so every build in this function gets its own instance built from the same
  // base sequence. Sharing one would silently build the second transaction on
  // sequence N+2 and the network would reject it with `tx_bad_seq`.
  const nextSeq = sourceAccount.sequenceNumber();
  const freshAccount = () => new Account(source.publicKey(), nextSeq);

  // ── Step 1: discover required authorizations ──────────────────────────
  const probe = buildInitialEnvelope({
    source: freshAccount(),
    operation,
    networkPassphrase,
    guard: params.guardAuth?.guard ?? null,
  });
  const first = await server.simulateTransaction(probe);
  if (rpc.Api.isSimulationError(first)) {
    // The discovery simulation runs in recording mode, so it can fail for
    // reasons that have nothing to do with policy (a contract trap, a missing
    // trustline). Report it as an error with the host's own diagnostics rather
    // than pretending the guard made a decision.
    const error = first as rpc.Api.SimulateTransactionErrorResponse;
    const events = diagnosticEventsOf(error);
    return {
      kind: "error",
      detail: [
        typeof error.error === "string" ? error.error : JSON.stringify(error.error),
        ...summarizeDiagnosticEvents(events),
      ].join("\n  "),
    };
  }
  const success = first as rpc.Api.SimulateTransactionSuccessResponse;
  const requiredAuth: xdr.SorobanAuthorizationEntry[] = success.result?.auth ?? [];

  // ── Step 2: sign every authorization the call requires ────────────────
  const signedAuth: xdr.SorobanAuthorizationEntry[] = [];
  for (const entry of requiredAuth) {
    const creds = entry.credentials;
    if (creds.type === "sorobanCredentialsSourceAccount") {
      // Nothing to sign: the transaction source's authorization is carried by
      // the envelope signature. The entry itself is NOT droppable, though — an
      // operation whose auth list is empty is treated as a recording-mode
      // request by the RPC (so `__check_auth` never runs and policy is never
      // enforced), and core then rejects the submitted transaction because no
      // authorization was actually provided.
      signedAuth.push(entry);
      continue;
    }
    if (
      creds.type !== "sorobanCredentialsAddress" &&
      creds.type !== "sorobanCredentialsAddressV2"
    ) {
      // ADDRESS_WITH_DELEGATES (CAP-71 delegation) is out of v1 scope; the
      // contract's SPEC records the same boundary.
      return {
        kind: "error",
        detail: `unsupported credential type in required authorization: ${creds.type}`,
      };
    }
    const addressCredentials = addressCredentialsOf(creds);
    if (!addressCredentials) {
      return {
        kind: "error",
        detail: `credential kind has no address payload: ${creds.type}`,
      };
    }
    // Works for both account (G…) and contract (C…) authorizers; the guard's
    // address is a contract, which is exactly why the agent key — not the
    // transaction source — has to produce this signature.
    const address = Address.fromScAddress(addressCredentials.address).toString();

    if (params.guardAuth && address === params.guardAuth.guard) {
      // The smart account authorizes: sign with the registered agent key over
      // the guard's own preimage (fresh nonce per transaction).
      signedAuth.push(
        buildGuardAuthEntry({
          guard: params.guardAuth.guard,
          call,
          agent: params.guardAuth.agent,
          // The transaction's own sequence number doubles as the nonce: unique
          // per transaction and never reused, so the host can never see a
          // replay for this guard address.
          nonce: BigInt(nextSeq),
          signatureExpirationLedger: expiration,
          networkPassphrase,
          // Answer in the same credential kind the host asked for: the signed
          // preimage differs between legacy ADDRESS and ADDRESS_V2, so using
          // the wrong one produces a signature the account cannot verify.
          credentialType: creds.type,
        }),
      );
      continue;
    }

    const signer = (params.accountSigners ?? []).find((kp) => kp.publicKey() === address);
    if (!signer) {
      return {
        kind: "error",
        detail:
          `call requires authorization from ${address}, but no matching key was provided ` +
          `(supplied: ${(params.accountSigners ?? []).map((kp) => kp.publicKey()).join(", ") || "none"})`,
      };
    }
    signedAuth.push(
      await signAccountAuthEntry({
        entry,
        signer,
        signatureExpirationLedger: expiration,
        networkPassphrase,
      }),
    );
  }

  // ── Step 3: enforced simulation — this is where policy is applied ─────
  const signedOperation = Operation.invokeContractFunction({
    contract: call.contract,
    function: call.fn,
    args: call.args,
    auth: signedAuth,
  });
  const enforcingTx = buildInitialEnvelope({
    source: freshAccount(),
    operation: signedOperation,
    networkPassphrase,
    guard: params.guardAuth?.guard ?? null,
  });
  const enforced = await server.simulateTransaction(enforcingTx);
  if (process.env["SAG_DEBUG_RESOURCES"] === "1") {
    console.log(`[debug] enforced simulation:\n${describeSimulationResources(enforced, params.guardAuth?.guard ?? null)}`);
  }
  if (rpc.Api.isSimulationError(enforced)) {
    // NOTE: a simulation failure here is not automatically a block — see the
    // discriminator below. Returning `error` rather than `blocked` in that case
    // is deliberate: an adapter must be able to tell "the guard refused this"
    // from "we could not determine".
    const error = enforced as rpc.Api.SimulateTransactionErrorResponse;
    const events = diagnosticEventsOf(error);
    const reason = reasonFromDiagnosticEvents(events);
    // A guard decision is identifiable: the contract publishes its own
    // `event_auth_checked/blocked/<reason>` event. Any other simulation failure
    // — a contract trap, an absent trustline, a host misuse — is an error, not
    // a block, and must not be reported as the guard refusing anything.
    if (reason === null) {
      return {
        kind: "error",
        detail: [
          typeof error.error === "string" ? error.error : JSON.stringify(error.error),
          ...summarizeDiagnosticEvents(events),
        ].join("\n  "),
      };
    }
    return {
      kind: "blocked",
      reason,
      detail: typeof error.error === "string" ? error.error : JSON.stringify(error.error),
      diagnosticEvents: events,
    };
  }

  return {
    kind: "admissible",
    simulation: enforced as rpc.Api.SimulateTransactionSuccessResponse,
    operation: signedOperation,
    nextSeq,
  };
}
