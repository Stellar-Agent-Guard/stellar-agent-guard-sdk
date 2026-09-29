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
import { feeBreakdown, type FeeBreakdown } from "./cost.ts";
import {
  BroadcastError,
  ContractResponseError,
  GuardError,
  SigningError,
  SimulationError,
} from "./errors.ts";
import { GUARD_AUTH_RESULTS, decodeAuthDecision } from "./events.ts";
import type { TraceStepName, TraceStepStatus } from "./trace.ts";
import {
  BroadcastError,
  INCLUSION_FEE,
  SIG_EXPIRATION_LEDGERS,
  assembleFromSimulation,
  buildGuardAuthEntry,
  buildInitialEnvelope,
  describeSimulationResources,
  describeSubmissionFailure,
  isMinimumFeeBroadcastFailure,
  isStaleLedgerResourceFailure,
  parseSimulationResourceFee,
  signAccountAuthEntry,
  summarizeDiagnosticEvents,
  submitAndPoll,
  type AdminSigner,
  type AgentSigner,
  type ContractCall,
  type SubmissionResult,
} from "./tx.ts";

/** How the guard's authorization is produced for a call that needs it. */
export interface GuardAuthorization {
  guard: string;
  /**
   * The account's registered agent signer: an `AgentSigner` for any signing
   * setup, or a plain Ed25519 `Keypair` for the single-key default. The
   * multi-key shape (contracts v2) arrives behind the same interface — see
   * `docs/concepts/multi-key-agent-signing.md`.
   */
  agent: AgentSigner | Keypair;
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
  sequenceNumberCollision: "sequence_number_collision",
} as const;

export type InvokeErrorCause =
  (typeof INVOKE_ERROR_CAUSES)[keyof typeof INVOKE_ERROR_CAUSES];

/**
 * Failures that a fresh invocation pipeline can fix: a stale-ledger resource
 * declaration (see `isStaleLedgerResourceFailure`) or a sequence-number
 * collision (see `isSequenceNumberFailure`) in `tx.ts`. Both share the single
 * bounded retry policy in `invoke`.
 */
export type RetryableInvokeFailure =
  | "stale_ledger_resource_limit"
  | "sequence_number_collision";

/** The coarse cause each retryable failure reports once the budget is spent. */
const RETRYABLE_CAUSES = {
  stale_ledger_resource_limit: INVOKE_ERROR_CAUSES.staleLedgerResourceLimit,
  sequence_number_collision: INVOKE_ERROR_CAUSES.sequenceNumberCollision,
} as const satisfies Record<RetryableInvokeFailure, InvokeErrorCause>;

/** The error arm returned by one invocation attempt. */
export interface InvokeErrorOutcome {
  kind: "error";
  detail: string;
  /** Machine-readable failure; branch on this with `instanceof`. */
  error: GuardError;
  /** Diagnostic events the host bundled with the failure, if any. */
  diagnosticEvents: unknown[];
  /** Coarse cause; absent for a dry run because no failure was classified. */
  cause?: InvokeErrorCause;
  /** Set when a re-simulation against fresh state can fix the failure. */
  retryable?: RetryableInvokeFailure;
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
  /**
   * The last attempt's typed failure. Present so that narrowing an
   * `InvokeOutcome` to `kind: "error"` always yields an `error` to branch on
   * with `instanceof`, whatever exhausted the retry budget.
   */
  readonly error: GuardError;
  /** Diagnostic events from the last attempt, if any. */
  readonly diagnosticEvents: unknown[];
  /** An exhausted attempt is no longer itself retryable. */
  readonly retryable?: undefined;

  constructor(params: { attempts: number; lastOutcome: InvokeErrorOutcome }) {
    const lastCause =
      params.lastOutcome.retryable === undefined
        ? (params.lastOutcome.cause ?? INVOKE_ERROR_CAUSES.undetermined)
        : RETRYABLE_CAUSES[params.lastOutcome.retryable];
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
    this.error = params.lastOutcome.error;
    this.diagnosticEvents = params.lastOutcome.diagnosticEvents;
  }
}

export type InvokeDryRunVerdict = "admissible" | "blocked" | "undetermined";

/**
 * Stage names a dry-run trace reports.
 *
 * The first three come from the shared trace vocabulary so a dry run and an
 * `onStep` trace can never name the same stage differently; `verdict` and
 * `fees` are the two stages a dry run adds, which a real invocation has no
 * equivalent of. `broadcast` is excluded on purpose: a dry run must be
 * structurally incapable of reporting it.
 */
export type InvokeDryRunStepName = Exclude<TraceStepName, "broadcast"> | "verdict" | "fees";

/** One completed stage in a dry run. `ok` describes the stage, not policy approval. */
export interface InvokePipelineStep {
  name: InvokeDryRunStepName;
  durationMs: number;
  ok: boolean;
}

/**
 * Full pre-broadcast result from `invoke({ dryRun: true })`.
 *
 * There is intentionally no submission/hash field: dry-run execution cannot
 * enter assembly or `sendTransaction`, so exposing a transaction hash would be
 * false evidence. `fees` is the network estimate when admissible and an
 * explicit zero breakdown when no admissible execution was priced.
 */
export interface InvokeDryRunResult {
  kind: "dry_run";
  admissible: boolean;
  verdict: InvokeDryRunVerdict;
  reason: string | null;
  detail: string | null;
  /** Typed failure for an undetermined verdict; null for admissible/blocked. */
  error: GuardError | null;
  fees: FeeBreakdown;
  diagnostics: unknown[];
  steps: InvokePipelineStep[];
}

export type PipelineOutcome =
  | { kind: "allowed"; submission: SubmissionResult }
  | {
      kind: "blocked";
      /** Reason symbol from the contract's own event/topic vocabulary. */
      reason: string | null;
      detail: string;
      /** Diagnostic events emitted by the contract during enforced simulation. */
      diagnosticEvents: unknown[];
      /** Present only when policy/account state changed and blocked after inclusion. */
      transactionHash?: string;
      /** True only for a post-broadcast refusal; absent for free preflight blocks. */
      charged?: boolean;
    }
  | {
      kind: "error";
      detail: string;
      /**
       * Set when the failure is a stale-ledger resource declaration that a
       * re-simulation can fix. See `isStaleLedgerResourceFailure` in `tx.ts`.
       */
      retryable?: "stale_ledger_resource_limit" | "min_fee" | undefined;
      error?: BroadcastError | undefined;
      lastFee?: bigint | undefined;
      attempts?: number | undefined;
      submission?: SubmissionResult | undefined;
    };

export type InvokeOutcome = PipelineOutcome | BroadcastError;

/** Configuration for bounded fee bumping when broadcast fails due to minimum fee. */
export interface FeeBumpConfig {
  /**
   * Maximum total broadcast attempts permitted (initial attempt + retries).
   * Default: 3 attempts.
   */
  maxAttempts?: number | undefined;
  /**
   * Multiplier applied to the inclusion fee on each fee-bump retry.
   * Default: 2 (doubles the inclusion fee per attempt).
   */
  feeMultiplier?: number | undefined;
  /**
   * Initial inclusion fee in stroops to use on the first attempt.
   * Default: 100 stroops (`INCLUSION_FEE`).
   */
  initialInclusionFee?: bigint | undefined;
}

export interface InvokeParams {
  server: rpc.Server;
  /** Classic account that pays the fee and supplies the sequence number. */
  source: Keypair | AdminSigner;
  call: ContractCall;
  networkPassphrase: string;
  /** Present when the call requires the smart account's own authorization. */
  guardAuth?: GuardAuthorization | null | undefined;
  /** Extra classic-account authorizers available to sign (e.g. an admin). */
  accountSigners?: Keypair[] | undefined;
  /** Skip broadcast even if the enforced simulation passes (dry run). */
  dryRun?: boolean | undefined;
  /**
   * Optional configuration for fee-bump retry when broadcast hits min-fee.
   * If omitted, defaults to 3 attempts with a 2x fee multiplier.
   */
  feeBump?: FeeBumpConfig | undefined;
  /**
   * Overall maximum retries across retryable classes. If specified, bounds the
   * total attempts across all triggers.
   */
  maxRetries?: number | undefined;
  /** Options controlling polling interval and attempts after submission. */
  pollOptions?: { pollAttempts?: number; pollIntervalMs?: number } | undefined;
}

/**
 * One pipeline-stage attempt, as reported to `onStep`.
 *
 * `name` comes from the shared trace vocabulary (`TraceStepName`), the same
 * names a dry-run trace uses, so the two can never drift apart. `attempt` is
 * the retry index, 0-based, and is always present: `0` for the first (and
 * usually only) pass over the pipeline, `1` for the built-in stale-ledger
 * re-run — so a consumer never has to special-case its absence.
 */
export interface InvokeStepEvent {
  name: TraceStepName;
  status: TraceStepStatus;
  /**
   * Elapsed wall-clock time of *this* stage attempt, in milliseconds. On
   * `start` it is always `0` — nothing has been timed yet.
   */
  durationMs: number;
  /** 0-based retry index: `0` normally, `1` on the stale-ledger re-run. */
  attempt: number;
}

/**
 * Emit one step event to the caller's `onStep` callback.
 *
 * The callback is the caller's, and this SDK stays logger-agnostic — there is
 * deliberately no logger dependency to fall back on — so a throwing callback
 * is swallowed and the pipeline carries on: observability must never decide
 * whether a transaction runs. Two cases matter. A callback throw on the happy
 * path must not turn a successful stage into a failed one. And when the stage
 * itself failed, the original error must survive untouched: swallowing here
 * means the callback's error simply vanishes, and `invoke()` rethrows the real
 * pipeline error — never a callback error wearing its clothes.
 */
function emitStep(
  hook: ((step: InvokeStepEvent) => void) | undefined,
  event: InvokeStepEvent,
): void {
  if (!hook) return;
  try {
    hook(event);
  } catch {
    /* logger-agnostic policy: a broken consumer must not break the pipeline */
  }
}

/**
 * Time one stage attempt, emitting `start` before it runs and `ok` or `fail`
 * with the attempt's own elapsed time after it settles. `ok` means the stage
 * passed; `fail` covers both a thrown error and — via the optional `failed`
 * classifier — a response the pipeline treats as that stage failing (a
 * simulation-error response, a submission that never made it into a ledger).
 * Returns the stage's value and rethrows its error untouched; the `fail`
 * callback throwing only loses the callback's error, never the stage's. With
 * no hook, the stage runs directly — no timers, no events, no work added to
 * the default path.
 */
async function withStepTiming<T>(
  hook: ((step: InvokeStepEvent) => void) | undefined,
  params: { name: TraceStepName; attempt: number },
  run: () => Promise<T>,
  failed?: (value: T) => boolean,
): Promise<T> {
  if (!hook) return run();
  emitStep(hook, { name: params.name, status: "start", durationMs: 0, attempt: params.attempt });
  const startedAt = performance.now();
  try {
    const value = await run();
    emitStep(hook, {
      name: params.name,
      status: failed?.(value) ? "fail" : "ok",
      durationMs: performance.now() - startedAt,
      attempt: params.attempt,
    });
    return value;
  } catch (error) {
    emitStep(hook, {
      name: params.name,
      status: "fail",
      durationMs: performance.now() - startedAt,
      attempt: params.attempt,
    });
    throw error;
  }
}

/**
 * Internal signal that the signing stage refused an authorization shape.
 *
 * Carries the exact detail text the pipeline has always reported plus the
 * typed failure the caller should branch on. `enforceCall` converts it back to
 * an `error` outcome so a shape refusal stays a result, while still giving the
 * `sign` stage a real `fail` event on the way through.
 */
class SigningStageError extends Error {
  readonly detail: string;
  readonly guardError: GuardError;

  constructor(detail: string, guardError: GuardError) {
    super(detail);
    this.name = "SigningStageError";
    this.detail = detail;
    this.guardError = guardError;
  }
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

/**
 * The authorization entries a recording-mode probe asked for, read strictly.
 *
 * RPC hands these back as decoded objects, but the same payload can arrive from
 * a proxy, a fixture, or a host that reports a different JSON shape. Every
 * downstream step assumes a well-formed entry, so a malformed one is rejected
 * here with a typed `ContractResponseError` naming the exact field rather than
 * surfacing later as a `TypeError` that says nothing about which response was
 * bad. An absent `auth` is legitimate and means "nothing to sign".
 */
function requiredAuthorizationEntries(
  response: unknown,
): xdr.SorobanAuthorizationEntry[] {
  const result = (response as { result?: unknown }).result;
  if (result !== undefined && (result === null || typeof result !== "object")) {
    throw new ContractResponseError("simulation result is not an object", {
      field: "result",
    });
  }
  const auth = (result as { auth?: unknown } | undefined)?.auth;
  if (auth === undefined) return [];
  if (!Array.isArray(auth)) {
    throw new ContractResponseError("simulation result.auth is not an array", {
      field: "result.auth",
    });
  }
  return auth.map((entry, index) => {
    const credentials = (entry as { credentials?: unknown } | null)?.credentials;
    if (
      entry === null ||
      typeof entry !== "object" ||
      credentials === null ||
      typeof credentials !== "object" ||
      typeof (credentials as { type?: unknown }).type !== "string"
    ) {
      throw new ContractResponseError(
        `simulation result.auth[${index}] has no credential payload`,
        { field: `result.auth[${index}].credentials` },
      );
    }
    return entry as xdr.SorobanAuthorizationEntry;
  });
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
 * ## Bounded Retries
 *
 * Two specific, measurable network failure modes are handled with bounded retry:
 *
 * 1. **Stale ledger resource limits (`scecExceededLimit`)**: If simulation prices
 *    gas against a ledger snapshot one write behind, the declared write budget
 *    may fall short. Safe to re-simulate against the advanced ledger (one retry).
 *
 * 2. **Minimum-fee / tx too cheap (`tx_insufficient_fee`)**: If fee-market conditions
 *    change between prepare-time and broadcast, core rejects the transaction.
 *    The SDK re-prepares with an increased inclusion fee (multiplied by `feeMultiplier`),
 *    **re-simulates**, **re-checks guard/policy**, and attempts broadcast again.
 *    Every attempt runs full simulation and policy enforcement — a policy block
 *    is never bypassed.
 *
 * Retries share a unified bounded budget (`maxAttempts`, default: 3). If fee bump
 * retries are exhausted without success, a typed `BroadcastError` is returned
 * containing the attempt count and last attempted fee.
 */
export async function invoke(params: InvokeParams): Promise<InvokeOutcome> {
  const configuredMax =
    params.feeBump?.maxAttempts ??
    (params.maxRetries !== undefined ? params.maxRetries + 1 : 3);
  const maxAttempts = Math.max(1, configuredMax);
  const feeMultiplier = params.feeBump?.feeMultiplier ?? 2;
  let currentInclusionFee = params.feeBump?.initialInclusionFee ?? BigInt(INCLUSION_FEE);
  let attempt = 0;
  let staleLedgerRetried = false;

  while (attempt < maxAttempts) {
    attempt++;
    const outcome = await invokePipeline(params, { inclusionFee: currentInclusionFee });

    // Success, policy block, or dry-run -> return immediately!
    if (outcome.kind !== "error" || params.dryRun) {
      return outcome;
    }

    // Trigger class 1: stale ledger resource limit
    if (outcome.retryable === "stale_ledger_resource_limit") {
      if (!staleLedgerRetried && attempt < maxAttempts) {
        staleLedgerRetried = true;
        continue;
      }
      return {
        ...outcome,
        detail: `retried after a stale-ledger resource rejection; still failed\n${outcome.detail}`,
      };
    }

    // Trigger class 2: minimum fee / tx too cheap
    if (outcome.retryable === "min_fee") {
      if (attempt < maxAttempts) {
        // Increase fee and retry
        const bumped = BigInt(Math.ceil(Number(currentInclusionFee) * feeMultiplier));
        currentInclusionFee = bumped > currentInclusionFee ? bumped : currentInclusionFee + 100n;
        continue;
      }

      // Retry budget exhausted -> return typed BroadcastError
      const broadcastError = new BroadcastError({
        attempts: attempt,
        lastFee: outcome.lastFee ?? currentInclusionFee,
        failure: outcome.submission?.failure ?? {
          resultXdr: null,
          resultCode: "result=txInsufficientFee",
          message: outcome.detail,
          diagnosticEvents: [],
        },
        detail: outcome.detail,
      });
      return broadcastError;
    }

    // Unrelated error (e.g. sequence, auth, contract trap) -> do not retry
    return outcome;
  }

  return {
    kind: "error",
    detail: `retry budget exhausted after ${attempt} attempts`,
  };
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
  | {
      kind: "error";
      detail: string;
      error: GuardError;
      diagnosticEvents: unknown[];
    };

/** One attempt: simulate → sign → enforce → submit. No retry logic lives here. */
async function invokePipeline(
  params: InvokeParams,
  options?: { inclusionFee?: bigint | undefined },
): Promise<PipelineOutcome> {
  const { server } = params;
  const enforced = await enforceCall({
    ...params,
    ...(options?.inclusionFee !== undefined ? { fee: options.inclusionFee } : {}),
  });
  if (enforced.kind !== "admissible") return enforced;

  // ── Step 4: assemble real resources, sign the envelope, broadcast ─────
  const sourcePubKey = await params.source.publicKey();
  let assembled: ReturnType<typeof assembleFromSimulation>;
  try {
    assembled = assembleFromSimulation({
      simulation: enforced.simulation,
      // A fresh `Account` per build: `TransactionBuilder` advances the sequence of
      // the instance it is handed, so sharing one across builds silently produces
      // `tx_bad_seq`.
      source: new Account(sourcePubKey, enforced.nextSeq),
      operation: enforced.operation,
      networkPassphrase: params.networkPassphrase,
      guard: params.guardAuth?.guard ?? null,
    });
  } catch (cause) {
    // The enforced simulation passed, so a failure to turn its result into a
    // transaction is a defect in construction — never a guardrail deciding.
    const detail = `transaction assembly failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    return {
      kind: "error",
      detail,
      error: new SimulationError("could not assemble transaction from enforced simulation", {
        stage: "simulate",
        cause,
      }),
      diagnosticEvents: [],
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
    ...(options?.inclusionFee !== undefined ? { inclusionFee: options.inclusionFee } : {}),
  });

  const submission = await submitAndPoll(
    server,
    assembled.transaction,
    [params.source],
    params.pollOptions,
  );
  if (submission.failure) {
    const isMinFee = isMinimumFeeBroadcastFailure(submission.failure);
    const isStaleLedger = isStaleLedgerResourceFailure(submission.failure);
    // A post-broadcast rejection is a hard error, not a policy block: the
    // enforced simulation already passed, so anything here is a defect in
    // construction (sequence, fee, footprint) or a contract trap — never a
    // guardrail doing its job.
    const detail = `tx ${submission.hash} ${describeSubmissionFailure(submission.failure)}`;
    const events = submission.failure.diagnosticEvents;
    // One exception, and it is a real one: the guard can refuse *after*
    // inclusion, when policy or account state has already moved. That is
    // still the guard refusing, so it stays a `blocked` outcome — carrying the
    // real hash and `charged`, because the caller did pay for the attempt.
    const reason = reasonFromDiagnosticEvents(events);
    if (reason !== null) {
      return {
        kind: "blocked",
        reason,
        detail,
        diagnosticEvents: events,
        transactionHash: submission.hash,
        charged: true,
      };
    }
    const staleLedger = isStaleLedgerResourceFailure(submission.failure);
    // A sequence collision is only expected when something outside this queue
    // broadcasts for the same account; inside the queue it means the RPC
    // snapshot lagged further than the per-account reservation assumed.
    const sequenceCollision = !staleLedger && isSequenceNumberFailure(submission.failure);
    return {
      kind: "error",
      detail: `tx ${submission.hash} ${describeSubmissionFailure(submission.failure)}`,
      ...(isStaleLedger ? { retryable: "stale_ledger_resource_limit" as const } : {}),
      ...(isMinFee ? { retryable: "min_fee" as const } : {}),
      lastFee: BigInt(assembled.transaction.fee),
      submission,
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
export async function enforceCall(
  params: InvokeParams & { fee?: bigint | string | undefined },
): Promise<EnforcementOutcome> {
  const { server, source, call, networkPassphrase } = params;

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
    ...(params.fee !== undefined ? { fee: params.fee } : {}),
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
      error: new SimulationError("authorization probe simulation failed", {
        stage: "probe",
        diagnosticEvents: events,
      }),
      diagnosticEvents: events,
    };
  }
  const success = first as rpc.Api.SimulateTransactionSuccessResponse;

  // ── Step 2: sign every authorization the call requires ────────────────
  // One `sign` stage per attempt, spanning every entry the discovery probe
  // reported: a caller tracing the pipeline cares that signing happened and
  // how long it took, not how the loop over entries is shaped inside. A shape
  // this SDK cannot sign raises the internal `SigningStageError` so the stage
  // reports a real `fail`; `enforceCall` converts it straight back into the
  // error outcome the pipeline has always returned, detail text unchanged.
  const signRequiredAuth = async (): Promise<xdr.SorobanAuthorizationEntry[]> => {
    let requiredAuth: xdr.SorobanAuthorizationEntry[];
    try {
      requiredAuth = requiredAuthorizationEntries(success);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new SigningStageError(
        detail,
        cause instanceof ContractResponseError
          ? cause
          : new SimulationError("could not read required authorization entries", {
              stage: "probe",
              cause,
            }),
      );
    }

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
        const detail = `unsupported credential type in required authorization: ${creds.type}`;
        throw new SigningStageError(detail, new SigningError(detail));
      }
      const addressCredentials = addressCredentialsOf(creds);
      if (!addressCredentials) {
        const detail = `credential kind has no address payload: ${creds.type}`;
        throw new SigningStageError(detail, new SigningError(detail));
      }
      // Works for both account (G…) and contract (C…) authorizers; the guard's
      // address is a contract, which is exactly why the agent key — not the
      // transaction source — has to produce this signature.
      let address: string;
      try {
        address = Address.fromScAddress(addressCredentials.address).toString();
      } catch (cause) {
        const detail = `required authorization has an invalid address payload: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
        throw new SigningStageError(detail, new SigningError(detail, { cause }));
      }

      if (params.guardAuth && address === params.guardAuth.guard) {
        // The smart account authorizes: sign with the registered agent key over
        // the guard's own preimage (fresh nonce per transaction).
        try {
          signedAuth.push(
            await buildGuardAuthEntry({
              guard: params.guardAuth.guard,
              call,
              signer: params.guardAuth.agent,
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
        } catch (error) {
          const detail = `could not sign guard authorization for ${address}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          throw new SigningStageError(
            detail,
            new SigningError(detail, { address, cause: error }),
          );
        }
        continue;
      }

      let signer: Keypair | AdminSigner | undefined;
      const suppliedPubkeys: string[] = [];
      for (const s of params.accountSigners ?? []) {
        const pubkey = await s.publicKey();
        suppliedPubkeys.push(pubkey);
        if (pubkey === address) {
          signer = s;
        }
      }
      if (!signer) {
        const detail =
          `call requires authorization from ${address}, but no matching key was provided ` +
          `(supplied: ${suppliedPubkeys.join(", ") || "none"})`;
        throw new SigningStageError(detail, new SigningError(detail, { address }));
      }
      try {
        signedAuth.push(
          await signAccountAuthEntry({
            entry,
            signer,
            signatureExpirationLedger: expiration,
            networkPassphrase,
          }),
        );
      } catch (error) {
        const detail = `could not sign authorization for ${address}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        throw new SigningStageError(detail, new SigningError(detail, { address, cause: error }));
      }
    }
    return signedAuth;
  };

  let signedAuth: xdr.SorobanAuthorizationEntry[];
  try {
    signedAuth = await withStepTiming(params.onStep, { name: "sign", attempt }, signRequiredAuth);
  } catch (error) {
    // A signing-stage shape refusal is a result, not an exception: keep
    // reporting it exactly as the pipeline always has, word for word, with the
    // typed failure attached so a caller never has to match on the text.
    if (error instanceof SigningStageError) {
      return {
        kind: "error",
        detail: error.detail,
        error: error.guardError,
        diagnosticEvents: [],
      };
    }
    throw error;
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
    ...(params.fee !== undefined ? { fee: params.fee } : {}),
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
        error: new SimulationError("enforced simulation failed without a guard verdict", {
          stage: "simulate",
          diagnosticEvents: events,
        }),
        diagnosticEvents: events,
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
