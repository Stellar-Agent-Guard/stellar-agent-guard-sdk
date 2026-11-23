/**
 * Framework-neutral adapter core. This is the single path from an action to a
 * guarded decision: validate options, map calls, ask the interceptor, dispatch
 * observers, then return a normalized allow/pass-through/halt result.
 */
import { GuardBlockedError } from "../reasons.ts";
import { PreFlightUndeterminedError, type PreFlightDecision, type PreFlightInterceptor } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";
import {
  blockedInfoFor,
  blockedInfoForBatch,
  checkOptionsFor,
  mapContractCalls,
  mappingFailureFor,
  runBlockedHook,
  runDecisionHook,
  type BlockedHookLogger,
  type GuardAdapterName,
  type GuardBlockedHook,
  type GuardCallMapper,
} from "./shared.ts";
import {
  throwAdapterConfigError,
  validateBatchInterceptor,
  validateBlockedHookLogger,
  validateContractMapping,
  validateInterceptor,
  validateOptionalFunction,
  validateOptionalSignal,
  validateOptionalTimeout,
  type AdapterConfigIssue,
} from "./validate.ts";

export interface AdapterCoreOptions<TAction> extends GuardCallMapper<TAction> {
  adapter: GuardAdapterName;
  interceptor: PreFlightInterceptor;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  onStep?: ((step: import("../invoke.ts").InvokeStepEvent) => void) | undefined;
  onDecision?: ((action: TAction, decision: PreFlightDecision) => unknown) | undefined;
  onBlocked?: GuardBlockedHook | undefined;
  blockedHookLogger?: BlockedHookLogger | undefined;
}

export type ActionEvaluation<TAction> =
  | { kind: "pass-through"; action: TAction }
  | { kind: "allowed"; action: TAction; calls: readonly ContractCall[]; verdicts: readonly PreFlightDecision[] }
  | {
      kind: "halt";
      action: TAction;
      verdict: PreFlightDecision & { allowed: false };
      /** Alias for verdict, supplied for callers that name the result decision. */
      decision: PreFlightDecision & { allowed: false };
      call?: ContractCall;
      calls?: readonly ContractCall[];
      verdicts?: readonly PreFlightDecision[];
    };

/** Run the common map → check → observer path. Mapper errors become a halt. */
export async function evaluateAction<TAction>(
  action: TAction,
  options: AdapterCoreOptions<TAction>,
  hostSignal?: AbortSignal | undefined,
): Promise<ActionEvaluation<TAction>> {
  let calls: ContractCall[];
  try {
    calls = mapContractCalls(action, options);
  } catch (error) {
    const failure = mappingFailureFor(options.adapter, error);
    runBlockedHook(options.onBlocked, failure.info, options.blockedHookLogger);
    return {
      kind: "halt",
      action,
      verdict: failure.decision,
      decision: failure.decision,
    };
  }
  if (calls.length === 0) return { kind: "pass-through", action };

  const checkOptions = checkOptionsFor(options, hostSignal);
  const canCheckOne = typeof options.interceptor.check === "function";
  const verdicts = calls.length === 1 && canCheckOne
    ? [await options.interceptor.check(calls[0]!, checkOptions)]
    : (await options.interceptor.checkBatch(calls, checkOptions)).verdicts;
  for (const verdict of verdicts) {
    if (options.onDecision) {
      runDecisionHook((decision) => options.onDecision!(action, decision), [verdict], options.adapter, options.blockedHookLogger);
    }
  }
  const index = verdicts.findIndex((verdict) => !verdict.allowed);
  if (index === -1) return { kind: "allowed", action, calls, verdicts };

  const verdict = verdicts[index]! as PreFlightDecision & { allowed: false };
  const info = calls.length === 1
    ? blockedInfoFor(options.adapter, calls[0]!, verdict)
    : blockedInfoForBatch(options.adapter, calls, verdicts);
  runBlockedHook(options.onBlocked, info, options.blockedHookLogger);
  return {
    kind: "halt",
    action,
    verdict,
    decision: verdict,
    call: calls[index]!,
    ...(calls.length > 1 ? { calls, verdicts } : {}),
  };
}

/** Option fields inspected during construction-time validation. */
export interface AdapterValidationOptions {
  interceptor?: unknown;
  toContractCall?: unknown;
  toContractCalls?: unknown;
  blockedHookLogger?: unknown;
  onDecision?: unknown;
  onBlocked?: unknown;
  onStep?: unknown;
  signal?: unknown;
  timeoutMs?: unknown;
}

/** Shared construction-time validation; adapter-specific issues are appended. */
export function validateAdapterOptions(
  adapter: GuardAdapterName,
  options: AdapterValidationOptions,
  additionalIssues: readonly AdapterConfigIssue[] = [],
  allowBatchOnlyInterceptor = false,
): void {
  const issues: AdapterConfigIssue[] = [...additionalIssues];
  const mappingIssues = validateContractMapping(options);
  issues.push(...mappingIssues);
  const batchOnly =
    allowBatchOnlyInterceptor &&
    typeof options.toContractCalls === "function" &&
    typeof options.toContractCall !== "function";
  if (batchOnly) {
    const batchIssue = validateBatchInterceptor(options.interceptor);
    if (batchIssue) issues.push(batchIssue);
  } else {
    const interceptorIssue = validateInterceptor(options.interceptor);
    if (interceptorIssue) issues.push(interceptorIssue);
    if (options.toContractCalls) {
      const batchIssue = validateBatchInterceptor(options.interceptor);
      if (batchIssue) issues.push(batchIssue);
    }
  }
  const loggerIssue = validateBlockedHookLogger(options.blockedHookLogger);
  if (loggerIssue) issues.push(loggerIssue);
  for (const [field, value] of [["onDecision", options.onDecision], ["onBlocked", options.onBlocked], ["onStep", options.onStep]] as const) {
    const issue = validateOptionalFunction(field, value);
    if (issue) issues.push(issue);
  }
  const signalIssue = validateOptionalSignal(options.signal);
  if (signalIssue) issues.push(signalIssue);
  const timeoutIssue = validateOptionalTimeout(options.timeoutMs);
  if (timeoutIssue) issues.push(timeoutIssue);
  throwAdapterConfigError(adapter, issues);
}

export type HaltStyle =
  | { kind: "message"; toolName: string }
  | { kind: "boolean" }
  | { kind: "throw"; call?: ContractCall };

/** Render the same normalized halt in each framework's public return style. */
export function renderHalt(verdict: PreFlightDecision & { allowed: false }, style: { kind: "message"; toolName: string }): string;
export function renderHalt(verdict: PreFlightDecision & { allowed: false }, style: { kind: "boolean" }): false;
export function renderHalt(verdict: PreFlightDecision & { allowed: false }, style: { kind: "throw"; call?: ContractCall }): never;
export function renderHalt(
  verdict: PreFlightDecision & { allowed: false },
  style: HaltStyle,
): string | false | never {
  if (style.kind === "boolean") return false;
  if (style.kind === "message") {
    if (verdict.kind === "blocked") {
      return (
        `stellar-agent-guard blocked '${style.toolName}': ${verdict.reason} — ${verdict.explanation}\\n` +
        `No transaction was submitted, so nothing was spent and no fee was paid.`
      );
    }
    return (
      `stellar-agent-guard could not determine whether '${style.toolName}' is permitted; ` +
      `it was not executed.\\n${verdict.detail}`
    );
  }
  if (verdict.kind === "blocked") {
    throw new GuardBlockedError({
      reason: verdict.reason,
      stage: "preflight",
      detail: verdict.detail,
      call: style.call!,
      ...(verdict.diagnosticEvents?.[0] ? { rawEvent: verdict.diagnosticEvents[0] } : {}),
    });
  }
  throw new PreFlightUndeterminedError(verdict.detail, { cause: verdict.error });
}
