/**
 * Public retry vocabulary shared by `invoke()` outcomes and `BroadcastError`.
 *
 * Kept in its own module so `errors.ts` can describe the metadata attached to a
 * failed broadcast without importing `invoke.ts` (which imports `errors.ts`).
 * Nothing here is runtime state: the metadata is deliberately a small, serialisable
 * record of attempt numbers, retryable classes and delays. It never carries
 * secrets, signed payloads, diagnostic events or transaction XDR.
 */

/** Failures the invocation pipeline knows how to retry. */
export type RetryableInvokeFailure =
  | "stale_ledger_resource_limit"
  | "sequence_number_collision"
  | "min_fee";

/**
 * Machine-readable causes attached to non-policy `invoke()` failures.
 *
 * `undetermined` deliberately covers errors for which the guard did not make a
 * decision (a bad input, an RPC/host failure, or an unsupported auth shape). It
 * is the same fail-closed category used by pre-flight decisions; it must not be
 * confused with `blocked`, which means the guard actually refused the call.
 */
export type InvokeErrorCause =
  | "undetermined"
  | "stale_ledger_resource_limit"
  | "sequence_number_collision";

/** One retryable failure that led to another pipeline attempt. */
export interface InvokeRetryAttempt {
  /** 1-based attempt number that failed. */
  attempt: number;
  /** Retryable class observed on that attempt. */
  failure: RetryableInvokeFailure;
  /** Coarse cause exposed on the corresponding error outcome. */
  cause: InvokeErrorCause;
  /**
   * Backoff actually applied before the next attempt, in milliseconds.
   * Fee-bump retries re-prepare immediately, so their delay is `0`.
   */
  delayMs: number;
}

/**
 * Structured retry-attempt metadata for a terminal `invoke()` outcome.
 *
 * Present on every terminal outcome (allowed, blocked, error) and on
 * `InvokeRetryError` / a fee-bump-exhausted `BroadcastError`. It answers the
 * operator questions a bare outcome cannot: how many attempts ran, which
 * retryable classes were recovered from, how long the backoff waited, and
 * whether the terminal attempt ran out of budget.
 *
 * The shape is safe to log: it contains no secrets, signed payloads, full
 * transaction XDR, diagnostic payloads or transaction hashes.
 */
export interface InvokeRetryMetadata {
  /** Total pipeline attempts started, including the first attempt. */
  attempts: number;
  /**
   * The retry budget that applied to the terminal failure class: the general
   * stale-ledger/sequence budget, or the fee-bump budget for `min_fee`.
   */
  maxAttempts: number;
  /** True when at least one retry followed a retryable failure. */
  retried: boolean;
  /** True when the terminal attempt exhausted its retry budget. */
  exhausted: boolean;
  /** Total backoff applied across all retries, in milliseconds. */
  totalDelayMs: number;
  /** Retryable failures that led to another attempt, oldest first. */
  retries: InvokeRetryAttempt[];
  /** Retryable class on the terminal attempt, or null when it ended cleanly. */
  terminalFailure: RetryableInvokeFailure | null;
  /** Coarse cause on the terminal attempt, or null when it ended cleanly. */
  terminalCause: InvokeErrorCause | null;
  /** How the pipeline ended. */
  outcome: "allowed" | "blocked" | "pending" | "error";
}
