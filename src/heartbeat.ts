/**
 * `startHeartbeat()` — keep a guard's dead-man switch alive.
 *
 * Every long-running agent must send a `heartbeat()` inside the policy's grace
 * window or the account self-freezes. Doing that with an ad-hoc
 * `setTimeout` loop gets the failure modes wrong: an event-loop stall silently
 * skips a beat, a transient RPC failure becomes an unhandled rejection, and
 * nothing reports that a beat was late until the account freezes.
 *
 * This module is the SDK-side primitive: a drift-aware scheduler that fires a
 * heartbeat on an interval, reports lateness instead of swallowing it, routes
 * every rejection to a callback, and stops cleanly (including mid-flight).
 *
 * ## Scope
 *
 * The client-side skip is a courtesy, not the guarantee: the contract also
 * deduplicates heartbeats within a ledger/grace rule. This scheduler skips a
 * beat that falls in the same wall-clock second as the previous accepted beat,
 * which saves a redundant round trip; it never claims to be the enforcement.
 */
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { DEFAULT_NETWORK_PASSPHRASE } from "./admin.ts";
import { invoke, type InvokeOutcome } from "./invoke.ts";
import { unsafeContractAddress, type PolicyConfig } from "./policy.ts";
import type { AgentSigner, AdminSigner } from "./tx.ts";

/** What one heartbeat submission reports back to the scheduler. */
export interface HeartbeatSubmission {
  /** Ledger the heartbeat committed to, when the submission knows it. */
  ledger?: number;
  /** The full invoke outcome, for callers that want it. */
  outcome?: InvokeOutcome;
}

/** One fired beat, as handed to `onBeat`. */
export interface HeartbeatBeat {
  /** Epoch milliseconds the beat fired. */
  at: number;
  /**
   * How late the beat fired past its scheduled deadline (>= 0). Agents alert on
   * lateness — a beat that lands after the next slot has effectively been
   * missed even though the transaction still succeeded.
   */
  lateMs: number;
  /** Ledger the heartbeat committed to, when the submission reported one. */
  ledger?: number;
}

/** The running scheduler, returned by `startHeartbeat`. */
export interface HeartbeatHandle {
  /**
   * Stop the scheduler. Idempotent, and resolves once an in-flight beat has
   * settled — so after `await stop()` no further submission can occur and none
   * is in progress. No beat is scheduled or sent after the call.
   */
  stop(): Promise<void>;
  /** Epoch ms of the last successfully submitted beat, or `null`. */
  readonly lastBeatAt: number | null;
  /** Beats that fired later than `maxSkewMs`. */
  readonly missedBeats: number;
  /** True once stopped (by `stop()` or by the abort signal). */
  readonly stopped: boolean;
}

/**
 * Thrown before the first beat when the requested interval is unsafe for the
 * account's dead-man grace window: beating less often than once per
 * `grace / 3` leaves room for a single missed beat to freeze the account.
 */
export class HeartbeatIntervalError extends Error {
  readonly intervalMs: number;
  readonly graceSecs: bigint;
  readonly maxIntervalMs: number;

  constructor(intervalMs: number, graceSecs: bigint, maxIntervalMs: number) {
    super(
      `heartbeat interval ${intervalMs}ms exceeds one third of the dead-man grace window ` +
        `(${graceSecs}s → at most ${maxIntervalMs}ms); a single missed beat could freeze the account`,
    );
    this.name = "HeartbeatIntervalError";
    this.intervalMs = intervalMs;
    this.graceSecs = graceSecs;
    this.maxIntervalMs = maxIntervalMs;
  }
}

/** Parameters to the default submission, `submitHeartbeat()`. */
export interface SubmitHeartbeatParams {
  server: rpc.Server;
  /** The guard smart account to heartbeat. */
  guard: string;
  /** The account's registered agent signer (Keypair or `AgentSigner`). */
  signer: AgentSigner | Keypair;
  /**
   * Classic account that pays the fee and supplies the sequence number.
   * Defaults to `signer` when it is a `Keypair`; required otherwise, since an
   * `AgentSigner` is a signing capability, not a fee-paying account.
   */
  source?: Keypair | AdminSigner;
  networkPassphrase?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
}

export interface HeartbeatOptions {
  /** The guard smart account to keep alive. */
  guard: string;
  /** The account's registered agent signer (Keypair or `AgentSigner`). */
  signer: AgentSigner | Keypair;
  /**
   * How often to beat, in ms. The first beat fires immediately on start, then
   * every `intervalMs`. Must be positive.
   */
  intervalMs: number;
  /**
   * Lateness tolerated before a beat counts as missed. Defaults to `0`
   * (strict): set it to your scheduler's tolerable drift (e.g. `2_000` for a
   * 30s interval) if timer jitter should not be reported as lateness.
   */
  maxSkewMs?: number;
  onBeat?: (beat: HeartbeatBeat) => void;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;

  /** Required for the default submission (unless `submit` is supplied). */
  server?: rpc.Server;
  /** Classic fee/sequence account; defaults to `signer` when it is a Keypair. */
  source?: Keypair | AdminSigner;
  networkPassphrase?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;

  /**
   * Optional read of the live policy, used to validate the interval against
   * `dms_grace_secs` before the first beat. If it resolves to a policy with a
   * window, an unsafe interval throws `HeartbeatIntervalError`; if it resolves
   * to `null` or rejects, the check is skipped with an `onWarning`. Providing
   * `graceSecs` directly avoids the read.
   */
  readPolicy?: () => Promise<PolicyConfig | null>;
  /** A known grace window, in seconds, for the pre-start interval check. */
  graceSecs?: number | bigint;
  /** Warning channel. The SDK carries no logger; this keeps it that way. */
  onWarning?: (message: string) => void;

  /**
   * Replace the submission step (testing seam, or a custom transport). Receives
   * the beat and returns what committed. Defaults to `submitHeartbeat()`.
   */
  submit?: (beat: HeartbeatBeat) => Promise<HeartbeatSubmission | void>;
  /** Clock seam (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Wait seam. Defaults to an abortable `setTimeout`. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The default poll delay: a `setTimeout` an abort cancels outright. */
function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAgentSigner(signer: AgentSigner | Keypair): signer is AgentSigner {
  return typeof (signer as AgentSigner).signDigest === "function";
}

/**
 * Submit a single `heartbeat()` to the guard with the agent's authorization.
 *
 * The heartbeat is a guard call like any other, so it goes through `invoke()`
 * with the agent's `guardAuth` (the custom account's own authorization) and a
 * classic `source` that pays the fee.
 */
export async function submitHeartbeat(params: SubmitHeartbeatParams): Promise<HeartbeatSubmission> {
  const source = params.source ?? (isAgentSigner(params.signer) ? undefined : params.signer);
  if (!source) {
    throw new Error(
      "submitHeartbeat requires `source`: an AgentSigner is a signing capability, not a fee-paying classic account",
    );
  }
  const outcome = await invoke({
    server: params.server,
    source,
    call: { contract: unsafeContractAddress(params.guard), fn: "heartbeat", args: [] },
    networkPassphrase: params.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE,
    guardAuth: { guard: unsafeContractAddress(params.guard), agent: params.signer },
    ...(params.pollAttempts !== undefined ? { pollAttempts: params.pollAttempts } : {}),
    ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
  });
  const ledger = outcome.kind === "allowed" ? outcome.submission.ledger : null;
  return {
    outcome,
    ...(ledger !== null && ledger !== undefined ? { ledger } : {}),
  };
}

async function resolveGrace(
  options: HeartbeatOptions,
): Promise<{ grace: bigint | null; readable: boolean }> {
  if (options.graceSecs !== undefined) {
    const grace =
      typeof options.graceSecs === "bigint" ? options.graceSecs : BigInt(options.graceSecs);
    return { grace, readable: true };
  }
  if (options.readPolicy) {
    try {
      const policy = await options.readPolicy();
      if (policy) return { grace: policy.dms_grace_secs, readable: true };
      return { grace: null, readable: false };
    } catch {
      return { grace: null, readable: false };
    }
  }
  return { grace: null, readable: false };
}

function defaultSubmit(
  options: HeartbeatOptions,
): (beat: HeartbeatBeat) => Promise<HeartbeatSubmission> {
  return async () => {
    if (!options.server) {
      throw new Error("startHeartbeat needs `server` (or an explicit `submit`) to send heartbeats");
    }
    return submitHeartbeat({
      server: options.server,
      guard: options.guard,
      signer: options.signer,
      ...(options.source !== undefined ? { source: options.source } : {}),
      ...(options.networkPassphrase !== undefined
        ? { networkPassphrase: options.networkPassphrase }
        : {}),
      ...(options.pollAttempts !== undefined ? { pollAttempts: options.pollAttempts } : {}),
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    });
  };
}

/**
 * Start beating. Resolves once any pre-start grace validation has run (which is
 * why it is async), and returns a handle to the running scheduler.
 *
 * ## Scheduling
 *
 * Beats are scheduled on a **fixed cadence from the start**, not "interval
 * after the previous beat finished", so a slow beat does not push every later
 * one; instead it shows up as lateness on the next. The first beat fires
 * immediately, so a freshly started agent registers without waiting a full
 * interval.
 *
 * ## Lateness and failures
 *
 * A beat that fires more than `maxSkewMs` past its deadline increments
 * `missedBeats` and is reported through `onBeat`'s `lateMs`. A submission
 * failure goes to `onError` and never escapes as an unhandled rejection.
 */
export async function startHeartbeat(options: HeartbeatOptions): Promise<HeartbeatHandle> {
  const { intervalMs } = options;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`heartbeat intervalMs must be a positive number, received ${intervalMs}`);
  }
  const maxSkewMs = options.maxSkewMs ?? 0;
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? defaultWait;

  const { grace, readable } = await resolveGrace(options);
  if (grace !== null && grace > 0n) {
    const maxIntervalMs = Number((grace * 1000n) / 3n);
    if (intervalMs > maxIntervalMs) {
      throw new HeartbeatIntervalError(intervalMs, grace, maxIntervalMs);
    }
  } else if (!readable) {
    options.onWarning?.(
      "dead-man grace window unavailable; skipping the interval <= grace/3 check. " +
        "Pass `graceSecs` or a `readPolicy` to enforce it before the first beat.",
    );
  }

  let stopped = false;
  let lastBeatAt: number | null = null;
  let missedBeats = 0;
  let lastBeatSecond: number | null = null;
  const controller = new AbortController();

  const external = options.signal;
  const onExternalAbort = () => {
    void stop();
  };

  const submit = options.submit ?? defaultSubmit(options);

  // Settles when the loop has fully exited, so `stop()` can await teardown
  // (including an in-flight beat) rather than returning early.
  let resolveLoopDone: () => void = () => {};
  const loopDone = new Promise<void>((resolve) => {
    resolveLoopDone = resolve;
  });

  async function stop(): Promise<void> {
    if (!stopped) {
      stopped = true;
      controller.abort();
      external?.removeEventListener("abort", onExternalAbort);
    }
    await loopDone;
  }

  async function run(): Promise<void> {
    let deadline = now();
    while (!stopped) {
      await wait(Math.max(0, deadline - now()), controller.signal);
      if (stopped) break;

      const at = now();
      const lateMs = Math.max(0, at - deadline);
      deadline += intervalMs;

      const second = Math.floor(at / 1000);
      if (lastBeatSecond !== null && second === lastBeatSecond) {
        // Same wall-clock second as the last accepted beat: skip the redundant
        // submission. The contract also dedupes; this only saves the round trip.
        continue;
      }

      if (lateMs > maxSkewMs) missedBeats += 1;

      try {
        const result = (await submit({ at, lateMs })) ?? {};
        if (stopped) break;
        lastBeatAt = at;
        lastBeatSecond = second;
        try {
          options.onBeat?.(
            result.ledger !== undefined ? { at, lateMs, ledger: result.ledger } : { at, lateMs },
          );
        } catch {
          // The consumer's callback is theirs to get wrong; it must not stop the
          // dead-man switch from being kept alive.
        }
      } catch (error) {
        if (stopped) break;
        try {
          options.onError?.(error);
        } catch {
          /* ditto: a broken error handler must not kill the scheduler */
        }
      }
    }
  }

  if (external?.aborted) {
    stopped = true;
    return {
      stop: async () => {},
      get lastBeatAt() {
        return null;
      },
      get missedBeats() {
        return 0;
      },
      get stopped() {
        return true;
      },
    };
  }
  external?.addEventListener("abort", onExternalAbort, { once: true });

  void run().then(resolveLoopDone, resolveLoopDone);

  return {
    stop,
    get lastBeatAt() {
      return lastBeatAt;
    },
    get missedBeats() {
      return missedBeats;
    },
    get stopped() {
      return stopped;
    },
  };
}
