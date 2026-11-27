/**
 * The adapter primitive shared by every framework adapter.
 *
 * A block is not only an agent-facing halt. When middleware refuses an action,
 * the agent's own transcript shows a refusal — but the human watching a
 * dashboard, a log, or an alert channel usually learns nothing (the telemetry
 * tail is a separate opt-in). `onBlocked` is the operator-facing half of a
 * refusal, and `runBlockedHook` is the one place that fires it, so the
 * LangChain, ElizaOS and MCP adapters call the same code instead of carrying
 * three copies of the same try/catch. The issue that introduced this explicitly
 * requires no copy-paste between adapters.
 *
 * The hook is advisory by construction: it is called *after* the adapter has
 * already decided to halt, and a throwing hook is swallowed and logged. A
 * failure in an alerting sink must never turn a clean refusal into a thrown
 * error, and must never turn a halt into an executed action.
 *
 * Hooks are never awaited (issue #313). `onBlocked` and `onDecision` are
 * declared as void-returning, but nothing stops a host from handing over an
 * `async` function; the returned thenable is therefore isolated as well, so a
 * rejected observer never becomes an unhandled rejection and never resumes a
 * halted action.
 *
 * Call mapping failures fail closed (issue #316): a mapper that throws or
 * returns a malformed call is treated as `undetermined` — the adapter halts,
 * the handler never runs, and the failure is reported through `onBlocked` with
 * `reason: null` and no `call` (there is no mapped call to name). A mapper
 * returning `null` is still "not fund-moving" and passes through untouched.
 *
 * Mapping failures also have their own hook (issue #453). `onBlocked` still
 * fires for compatibility — the halt is real — but `onMappingError` fires
 * first, so an operator can tell an integration bug apart from a policy
 * refusal instead of reading both as `kind: "undetermined"`. Its payload names
 * the adapter, the tool and the error class, and deliberately omits the raw
 * request (and therefore the tool arguments) unless the host opts in.
 */
import { AdapterMappingError, GuardError, GuardUndeterminedError } from "../errors.ts";
import { GuardBlockedError } from "../reasons.ts";
import { DEFAULT_RPC_TIMEOUT_MS, type InvokeStepEvent } from "../invoke.ts";
import type { PreFlightCheckOptions, PreFlightDecision } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";

/**
 * The default bound, in milliseconds, every framework adapter applies to each
 * RPC call its pre-flight check makes (issue #455).
 *
 * It aliases the pre-flight pipeline's own `DEFAULT_RPC_TIMEOUT_MS` rather than
 * restating `30_000`, so the two can never drift; it is exported so a wrapper
 * or documentation can reference the same number instead of hard-coding it.
 * `timeoutMs: 0` opts out of the timeout entirely and leaves cancellation to
 * `signal`.
 */
export const DEFAULT_ADAPTER_TIMEOUT_MS = DEFAULT_RPC_TIMEOUT_MS;

/**
 * Which adapter observed the halt. This is the payload's `adapter` field, so an
 * operator sink that receives blocks from several frameworks can tell them
 * apart without inspecting the call.
 */
export type GuardAdapterName = "langchain" | "elizaos" | "mcp" | "vercelai";

/**
 * Optional caller correlation id for one action (issue #459).
 *
 * Either a fixed string or a callback that reads the id out of the framework's
 * own request. The callback is the only way the adapters map a request id: the
 * SDK never guesses one from addresses, tool arguments or timestamps, because a
 * wrong correlation id is worse than no id at all.
 */
export type CorrelationIdOption<TArgs extends readonly unknown[] = readonly unknown[]> =
  | string
  | ((...args: TArgs) => string | undefined);

/**
 * Extra context handed to `onDecision` alongside the verdict (issue #459).
 *
 * `correlationId` is present only when the host supplied one; an absent id is
 * omitted rather than sent as an empty string.
 */
export interface GuardHookContext {
  /** Caller-supplied id tying every hook for one action together. */
  correlationId?: string;
}

/**
 * Normalize a host-supplied correlation id.
 *
 * A non-string, an empty string and a whitespace-only string all mean "no id"
 * and stay `undefined`, so a consumer never has to treat a blank value as an
 * identifier. The original string is returned unchanged when it is non-blank.
 */
export function normalizeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().length > 0 ? value : undefined;
}

/**
 * Resolve the correlation id for one action exactly once.
 *
 * Resolution is deliberately total: an option that is not a string or function,
 * or a callback that throws, yields `undefined`. A correlation id is
 * observability metadata, not enforcement input — a broken id source must never
 * change a verdict, halt an action, or become an unhandled rejection.
 */
export function resolveCorrelationId<TArgs extends readonly unknown[]>(
  option: CorrelationIdOption<TArgs> | undefined,
  ...args: TArgs
): string | undefined {
  if (option === undefined) return undefined;
  if (typeof option === "function") {
    try {
      return normalizeCorrelationId(option(...args));
    } catch {
      return undefined;
    }
  }
  return normalizeCorrelationId(option);
}

/** Build the `onDecision` context, omitting an absent id entirely. */
export function hookContextFor(correlationId: string | undefined): GuardHookContext {
  return correlationId === undefined ? {} : { correlationId };
}

/**
 * The structured payload handed to `onBlocked`.
 *
 * `reason` and `explanation` mirror the guard's own `blocked` verdict. Failing
 * closed also covers the third verdict: when enforcement cannot reach a
 * decision (`undetermined` — a contract trap, a missing trustline, an invalid
 * resource fee), the adapter still halts, so the hook still fires. `kind`
 * distinguishes the two arms and `reason` is `null` on the undetermined one,
 * while `explanation` carries the failure detail, so a consumer never has to
 * guess whether the guard actually refused the call.
 */
export interface GuardBlockedInfo {
  /** The adapter that halted the action. */
  adapter: GuardAdapterName;
  /** `blocked` = the guard refused; `undetermined` = the guard never ruled. */
  kind: "blocked" | "undetermined";
  /** The guard's reason symbol for a `blocked` verdict; `null` otherwise. */
  reason: string | null;
  /**
   * The contract call the guard ruled on (or could not rule on). Absent when
   * the adapter's call mapper itself failed, since no call was ever mapped
   * (issue #316).
   */
  call?: ContractCall;
  /** Human-readable one-line meaning; the failure detail when undetermined. */
  explanation: string;
  /**
   * Caller-supplied id tying this halt to the agent run/request that produced
   * it (issue #459). Absent — never an empty string — when the host supplied
   * none. It is never derived from addresses, tool arguments or timestamps.
   */
  correlationId?: string;
  /**
   * Every call in the mapped batch, in the order the adapter checked them.
   * Present only when the halt came from a batch mapping (`toContractCalls`),
   * so a single-call payload is unchanged (additive, issue #318).
   */
  calls?: readonly ContractCall[];
  /**
   * Per-call verdicts aligned with `calls`, in the same order. Present only for
   * a batch halt; `call`/`kind`/`reason` describe the first non-admissible
   * verdict (additive, issue #318).
   */
  verdicts?: readonly PreFlightDecision[];
}

/**
 * Operator alerting hook. Intended for webhook/log/alert wiring by the
 * integrator; see `runBlockedHook` for the isolation guarantee.
 */
export type GuardBlockedHook = (info: GuardBlockedInfo) => void;

/**
 * Summary of a batch pre-flight check handed to `onBatchDecision` (issue #498).
 */
export interface GuardBatchDecisionInfo {
  /** The adapter that executed the batch check. */
  adapter: GuardAdapterName;
  /** Overall batch outcome: "admissible" if all calls passed, otherwise the first refusal kind. */
  kind: "admissible" | "blocked" | "undetermined";
  /** Per-call verdicts in the order the adapter checked them. */
  verdicts: readonly PreFlightDecision[];
  /** Every contract call in the checked batch, in order. */
  calls: readonly ContractCall[];
  /** Optional correlation identifier (e.g. toolCall id). */
  correlationId?: string | undefined;
}

/**
 * Action-level batch decision hook. Called once after checking an entire batch of calls.
 */
export type GuardBatchDecisionHook = (info: GuardBatchDecisionInfo) => void;

/**
 * The structured payload handed to `onMappingError` (issue #453).
 *
 * A mapping failure means the integration's own `toContractCall`/
 * `toContractCalls` threw or returned a malformed value — never that the guard
 * refused anything. `tool` and `errorClass` are always present and safe to
 * alert on; the raw `request` (and therefore the tool arguments, which may
 * carry secrets) is included only when the adapter was constructed with
 * `includeMappingErrorRequest: true`.
 */
export interface GuardMappingErrorInfo {
  /** The adapter whose mapper failed. */
  adapter: GuardAdapterName;
  /** The tool/action name whose mapping failed; never its arguments. */
  tool: string;
  /**
   * Caller-supplied id tying this integration failure to the agent run/request
   * that produced it (issue #459). Absent — never an empty string — when the
   * host supplied none. It is never derived from addresses, tool arguments or
   * timestamps.
   */
  correlationId?: string;
  /** The error's class name (`AdapterMappingError`), so a sink can group failures. */
  errorClass: string;
  /** The typed mapping error; its message names the mapper and the failure. */
  error: AdapterMappingError;
  /**
   * The request the mapper failed on, present only when the host opted in via
   * `includeMappingErrorRequest`. Absent by default: tool arguments can contain
   * secrets and a mapping-error sink is often a remote webhook.
   */
  request?: unknown;
}

/**
 * Integration-bug hook: fired once, immediately before a mapping failure's
 * fail-closed halt, and isolated exactly like `onBlocked`.
 */
export type GuardMappingErrorHook = (info: GuardMappingErrorInfo) => void;

/**
 * Where a swallowed hook failure is reported, when the host opts in.
 *
 * There is deliberately no `console` default: the SDK stays silent unless the
 * host supplies a sink (design-principles §6, issue #314).
 */
export interface BlockedHookLogger {
  error(message: string, ...rest: unknown[]): void;
}

/**
 * Map one agent action to the ordered contract calls it would make.
 *
 * `toContractCalls` is the additive batch form (issue #318): when supplied it
 * takes precedence over `toContractCall`, and the adapter checks the complete
 * batch before the handler runs. Returning `null` or an empty array means the
 * action is not fund-moving and passes through untouched.
 */
export interface GuardCallMapper<T> {
  /** Single-call mapping (the pre-existing form). */
  toContractCall?: (request: T) => ContractCall | null;
  /** Ordered batch mapping; takes precedence over `toContractCall`. */
  toContractCalls?: (request: T) => readonly ContractCall[] | null;
}

const MALFORMED_CALL =
  "expected { contract, fn, args } with a non-empty contract and fn and an args array";

/**
 * A returned value that is not a contract call is a mapping failure, not an
 * empty result: mapping `undefined`/`nan`/a partial object to "not fund-moving"
 * would let a broken integration silently bypass enforcement.
 */
function isContractCall(value: unknown): value is ContractCall {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ContractCall>;
  return (
    typeof candidate.contract === "string" &&
    candidate.contract.length > 0 &&
    typeof candidate.fn === "string" &&
    candidate.fn.length > 0 &&
    Array.isArray(candidate.args)
  );
}

/** Normalize one single-call mapping result, rejecting a malformed return. */
export function normalizeMappedCall(
  value: ContractCall | null | undefined,
  field: "toContractCall" | "toContractCalls",
): ContractCall[] {
  if (value === null || value === undefined) return [];
  if (!isContractCall(value)) {
    throw new AdapterMappingError(
      `\`${field}\` returned a malformed contract call: ${MALFORMED_CALL}.`,
      {
        field,
      },
    );
  }
  return [value];
}

/** Normalize one batched mapping result, rejecting a malformed batch entry. */
export function normalizeMappedCalls(
  value: readonly ContractCall[] | null | undefined,
  field: "toContractCall" | "toContractCalls",
): ContractCall[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AdapterMappingError(
      `\`${field}\` returned a malformed batch: expected an array of contract calls.`,
      { field },
    );
  }
  return value.map((call, index) => {
    if (!isContractCall(call)) {
      throw new AdapterMappingError(
        `\`${field}\` returned a malformed contract call at index ${index}: ${MALFORMED_CALL}.`,
        { field },
      );
    }
    return call;
  });
}

/**
 * Resolve the ordered calls an adapter should check for one action.
 *
 * An empty result means "not fund-moving", never "allowed": the adapter must
 * pass the action through without inventing a verdict, exactly as the
 * single-call `null` return already did. A thrown mapper or a malformed return
 * throws `AdapterMappingError`, which every adapter turns into a fail-closed
 * halt (`mappingFailureFor`).
 */
export function mapContractCalls<T>(request: T, mapper: GuardCallMapper<T>): ContractCall[] {
  if (mapper.toContractCalls) {
    return normalizeMappedCalls(mapper.toContractCalls(request), "toContractCalls");
  }
  return normalizeMappedCall(mapper.toContractCall?.(request), "toContractCall");
}

/**
 * Turn a mapper failure into the fail-closed halt every adapter documents
 * (issue #316).
 *
 * The verdict is `undetermined` — the guard never ruled, so the action must not
 * run — and the payload omits `call` because the mapping failed before any
 * call existed. A mapper's own error is wrapped in `AdapterMappingError` so the
 * cause stays machine-readable (`instanceof`) without echoing arbitrary values.
 *
 * The returned `mapping` payload feeds `onMappingError` (issue #453). `request`
 * is attached only when the caller supplies it, which the adapters do only for
 * hosts that opted into `includeMappingErrorRequest`.
 */
export function mappingFailureFor(
  adapter: GuardAdapterName,
  error: unknown,
  tool = "unknown",
  request?: unknown,
  correlationId?: string | undefined,
): {
  decision: Extract<PreFlightDecision, { kind: "undetermined" }>;
  info: GuardBlockedInfo;
  mapping: GuardMappingErrorInfo;
} {
  const mappingError =
    error instanceof AdapterMappingError
      ? error
      : new AdapterMappingError(
          `the ${adapter} adapter's call mapper threw: ${
            error instanceof Error ? error.message : "a non-Error value"
          }`,
          { field: "toContractCall", cause: error },
        );
  const detail = `call mapping failed before enforcement: ${mappingError.message}`;
  return {
    decision: { allowed: false, kind: "undetermined", detail, error: mappingError },
    info: {
      adapter,
      kind: "undetermined",
      reason: null,
      explanation: detail,
      ...(correlationId !== undefined ? { correlationId } : {}),
    },
    mapping: {
      adapter,
      tool,
      errorClass: mappingError.name,
      error: mappingError,
      ...(request !== undefined ? { request } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    },
  };
}

/**
 * Convert a thrown GuardError (e.g. from assertAllowed or an interceptor check)
 * into a structured PreFlightDecision & { allowed: false }.
 */
export function decisionFromGuardError(error: GuardError): PreFlightDecision & { allowed: false } {
  if (error instanceof GuardBlockedError) {
    return {
      allowed: false,
      kind: "blocked",
      reason: error.reason,
      explanation: error.explanation,
      detail: error.detail ?? error.message,
      diagnosticEvents: error.rawEvent ? [error.rawEvent] : [],
    };
  }
  const detail =
    error instanceof GuardUndeterminedError && error.detail ? error.detail : error.message;
  return {
    allowed: false,
    kind: "undetermined",
    detail,
    error,
  };
}

/**
 * Build the operator payload from a non-allowed decision.
 *
 * Shared so the field list (and the undetermined mapping) cannot drift between
 * adapters: a new field added here reaches every framework at once.
 */
export function blockedInfoFor(
  adapter: GuardAdapterName,
  call: ContractCall,
  decision: PreFlightDecision & { allowed: false },
  correlationId?: string | undefined,
): GuardBlockedInfo {
  const correlation = correlationId !== undefined ? { correlationId } : {};
  if (decision.kind === "blocked") {
    return {
      adapter,
      kind: "blocked",
      reason: decision.reason,
      call,
      explanation: decision.explanation,
      ...correlation,
    };
  }
  return {
    adapter,
    kind: "undetermined",
    reason: null,
    call,
    explanation: decision.detail,
    ...correlation,
  };
}

/**
 * Build the operator payload for a batch halt.
 *
 * `call`, `kind`, `reason` and `explanation` are those of the first
 * non-admissible verdict, so an existing single-call consumer keeps a usable
 * payload; `calls` and `verdicts` carry the full ordered batch for a consumer
 * that needs per-call detail (issue #318).
 */
export function blockedInfoForBatch(
  adapter: GuardAdapterName,
  calls: readonly ContractCall[],
  verdicts: readonly PreFlightDecision[],
  correlationId?: string | undefined,
): GuardBlockedInfo {
  const index = verdicts.findIndex((verdict) => !verdict.allowed);
  const decision = verdicts[index] ?? verdicts[0];
  const call = calls[index] ?? calls[0];
  if (!decision || decision.allowed || !call) {
    throw new Error("blockedInfoForBatch requires an ordered batch with a refusal");
  }
  return {
    ...blockedInfoFor(adapter, call, decision, correlationId),
    calls: [...calls],
    verdicts: [...verdicts],
  };
}

/**
 * Build the `check()`/`checkBatch()` options an adapter forwards (issue #315).
 *
 * A host-supplied signal (an MCP invocation's `extra.signal`, a LangChain
 * request's `signal`) takes precedence over the adapter-level default, because
 * it describes the request currently being guarded. An aborted signal and a
 * fired `timeoutMs` both surface as the interceptor's `undetermined` verdict,
 * which the adapters already fail closed on.
 *
 * `timeoutMs` always resolves to the shared `DEFAULT_ADAPTER_TIMEOUT_MS` when
 * the host did not supply one (issue #455), so every adapter applies the same
 * bound and a test can assert it. `timeoutMs: 0` is forwarded unchanged: it is
 * a real opt-out, not an omission.
 */
export function checkOptionsFor(
  control: {
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
    onStep?: ((step: InvokeStepEvent) => void) | undefined;
  },
  hostSignal?: AbortSignal | undefined,
): PreFlightCheckOptions {
  const signal = hostSignal ?? control.signal;
  return {
    ...(control.onStep ? { onStep: control.onStep } : {}),
    ...(signal ? { signal } : {}),
    timeoutMs: control.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS,
  };
}

/**
 * Combine two cancellation signals into one that aborts when either does
 * (issue #454).
 *
 * `AbortSignal.any()` is the exact primitive for this and is used when the
 * runtime provides it (Node 20+/modern browsers). The fallback links a small
 * controller from the same `abort` events, so an older polyfilled environment
 * still honours both signals. An already-aborted input yields an immediately
 * aborted result, whether through `any()` or the fallback, so a cancelled
 * framework signal can never let an RPC start.
 */
export function mergeAbortSignals(
  first?: AbortSignal | undefined,
  second?: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) return second;
  if (!second || first === second) return first;

  const anySignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal })
    .any;
  if (typeof anySignal === "function") {
    try {
      return anySignal.call(AbortSignal, [first, second]);
    } catch {
      // A host polyfill may expose `any` with different semantics; fall through
      // to the explicit link rather than risking a silently unsound signal.
    }
  }

  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => () => {
    controller.abort((signal as { reason?: unknown }).reason);
  };
  if (first.aborted) {
    controller.abort((first as { reason?: unknown }).reason);
  } else if (second.aborted) {
    controller.abort((second as { reason?: unknown }).reason);
  } else {
    first.addEventListener("abort", abortFrom(first), { once: true });
    second.addEventListener("abort", abortFrom(second), { once: true });
  }
  return controller.signal;
}

/**
 * Read an `AbortSignal` out of a host-provided value (a request or hook extra)
 * without importing the host framework. Anything else is ignored.
 */
export function hostAbortSignal(value: unknown): AbortSignal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { aborted?: unknown; addEventListener?: unknown };
  if (typeof candidate.aborted !== "boolean") return undefined;
  if (typeof candidate.addEventListener !== "function") return undefined;
  return candidate as AbortSignal;
}

/**
 * Run an observer hook and isolate it completely: a synchronous throw and a
 * rejected returned thenable are both swallowed (and logged when the host
 * supplied a sink). The hook is never awaited, so a slow sink cannot delay —
 * or resume — the halt path (issue #313).
 */
function isolateHookRun(run: () => unknown, describe: string, logger?: BlockedHookLogger): void {
  let result: unknown;
  try {
    result = run();
  } catch (error) {
    logger?.error(describe, error);
    return;
  }
  if (
    result === null ||
    (typeof result !== "object" && typeof result !== "function") ||
    typeof (result as { then?: unknown }).then !== "function"
  ) {
    return;
  }
  // The hook opted into asynchronous work; keep the rejection from escaping.
  Promise.resolve(result as PromiseLike<unknown>).catch((error: unknown) => {
    logger?.error(describe, error);
  });
}

/**
 * Determine the overall outcome kind for a batch of decisions.
 */
export function batchDecisionKindFor(
  verdicts: readonly PreFlightDecision[],
): "admissible" | "blocked" | "undetermined" {
  const refusal = verdicts.find((v) => !v.allowed);
  if (!refusal) return "admissible";
  return refusal.kind;
}

/**
 * Fire an action-level batch decision hook (`onBatchDecision`) without letting it affect the verdict.
 *
 * Isolated and never awaited, mirroring `runDecisionHook` and `runBlockedHook`.
 */
export function runBatchDecisionHook(
  hook: GuardBatchDecisionHook | undefined,
  info: GuardBatchDecisionInfo,
  logger?: BlockedHookLogger,
): void {
  if (!hook) return;
  isolateHookRun(
    () => hook(info),
    `stellar-agent-guard: the ${info.adapter} adapter's onBatchDecision callback threw (or rejected); the guard's verdict stands.`,
    logger,
  );
}

/**
 * Fire an observer hook (`onDecision`) without letting it affect the verdict.
 *
 * A throwing or rejecting observer must not change what the agent is allowed to
 * do, and must not become an unhandled rejection in a long-lived process.
 */
export function runDecisionHook<TArgs extends readonly unknown[]>(
  hook: ((...args: TArgs) => unknown) | undefined,
  args: TArgs,
  adapter: string,
  logger?: BlockedHookLogger,
): void {
  if (!hook) return;
  isolateHookRun(
    () => hook(...args),
    `stellar-agent-guard: the ${adapter} adapter's onDecision callback threw (or rejected); the guard's verdict stands.`,
    logger,
  );
}

/**
 * Fire the mapping-error hook exactly once, isolating it from the halt path.
 *
 * Called immediately before the fail-closed halt, so a host sees the integration
 * bug before `onBlocked` reports the same halt for compatibility. Isolation is
 * identical to `runBlockedHook`: a throwing or rejecting sink is swallowed (and
 * logged when a sink is configured) and can never resume the action.
 */
export function runMappingErrorHook(
  hook: GuardMappingErrorHook | undefined,
  info: GuardMappingErrorInfo,
  logger?: BlockedHookLogger,
): void {
  if (!hook) return;
  isolateHookRun(
    () => hook(info),
    `stellar-agent-guard: the ${info.adapter} adapter's onMappingError callback threw (or rejected); the halt stands and the action was not executed.`,
    logger,
  );
}

/**
 * Fire the operator hook exactly once, isolating it from the halt path.
 *
 * Absent hook → nothing happens, which is precisely the adapter's behavior
 * before this option existed. A throwing hook is swallowed rather than
 * propagated: the refusal has already been decided, and an alerting sink that
 * is down must not change what the agent is allowed to do.
 *
 * Absent `logger` → the failure is swallowed silently. That is deliberate:
 * SDK output is opt-in only, so there is no `console` fallback (issue #314). A
 * host that wants the diagnostic passes an explicit sink, and the log line
 * names the adapter so a failing webhook can be traced without the payload.
 */
export function runBlockedHook(
  hook: GuardBlockedHook | undefined,
  info: GuardBlockedInfo,
  logger?: BlockedHookLogger,
): void {
  if (!hook) return;
  isolateHookRun(
    () => hook(info),
    `stellar-agent-guard: the ${info.adapter} adapter's onBlocked callback threw (or rejected); the halt stands and the action was not executed.`,
    logger,
  );
}
