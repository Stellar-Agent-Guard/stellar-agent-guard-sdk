/**
 * ElizaOS adapter — built on `Action.validate`.
 *
 * `Action.validate` is already a pre-execution gate: the runtime calls it with
 * the same `(runtime, message, state, options)` triple the handler receives and
 * admits the action to the eligible set only when it returns truthy. Composing
 * the guard into `validate` therefore stops the handler from ever running — see
 * `docs/integration-hooks.md` §2 for the source-pinned signatures and the three
 * call sites that enforce it.
 *
 * Wrapping `handler` instead would be weaker: by the time a handler runs, the
 * runtime has already committed to executing the action, and an error thrown
 * there is a failure rather than a refusal.
 *
 * Written structurally, so `@elizaos/core` is not a dependency of this SDK.
 *
 * ### Undetermined handling
 *
 * The guard fails closed. An `undetermined` verdict is not a pass: the
 * validator returns `false` and the action is dropped from the eligible set,
 * exactly as for a `blocked` verdict. The difference between the two is
 * observable through `onDecision` (and `onBlocked`, which is called for both),
 * not through the return value. A mapper that throws or returns a malformed
 * call is the same fail-closed halt (issue #316): the validator returns `false`
 * and `onBlocked` reports an `undetermined` halt. This is the documented
 * contract the shared verdict-fixture harness asserts against.
 * Options are validated at construction time (see `src/adapters/validate.ts`):
 * a misconfigured adapter throws `AdapterConfigError` before any action runs,
 * rather than failing mid-loop on the first tool call.
 */
import { GuardError } from "../errors.ts";
import type {
  PreFlightBatchDecision,
  PreFlightDecision,
  PreFlightInterceptor,
} from "../preflight.ts";
import type { ContractCall } from "../tx.ts";
import {
  throwAdapterConfigError,
  validateBatchInterceptor,
  validateBlockedHookLogger,
  validateContractMapping,
  validateInterceptor,
  validateOptionalCorrelationId,
  validateOptionalFunction,
  validateOptionalSignal,
  validateOptionalTimeout,
  type AdapterConfigIssue,
} from "./validate.ts";
import {
  batchDecisionKindFor,
  blockedInfoFor,
  blockedInfoForBatch,
  checkOptionsFor,
  decisionFromGuardError,
  hookContextFor,
  mappingFailureFor,
  normalizeMappedCall,
  normalizeMappedCalls,
  resolveCorrelationId,
  runBatchDecisionHook,
  runBlockedHook,
  runDecisionHook,
  runMappingErrorHook,
  type BlockedHookLogger,
  type GuardBatchDecisionHook,
  type GuardBlockedHook,
  type GuardHookContext,
  type GuardMappingErrorHook,
  type CorrelationIdOption,
} from "./shared.ts";

/** The subset of ElizaOS's `Validator` signature this adapter implements. */
export type ElizaValidator = (
  runtime: unknown,
  message: unknown,
  state?: unknown,
  options?: unknown,
) => Promise<boolean>;

/** The subset of the `Action` interface this adapter reads. */
export interface ElizaActionLike {
  name: string;
  validate: ElizaValidator;
}

export interface ElizaGuardOptions {
  interceptor: PreFlightInterceptor;
  /**
   * Turn the action's intent into the guarded contract call it would make, or
   * `null` when this action moves no funds.
   */
  toContractCall?: (message: unknown, state: unknown) => ContractCall | null;
  /**
   * Additive batch mapping (issue #318): the ordered calls this action performs.
   * Takes precedence over `toContractCall`; every call is checked before the
   * action is admitted (all-or-nothing). `null` or an empty array means the
   * action moves no funds.
   */
  toContractCalls?: (message: unknown, state: unknown) => readonly ContractCall[] | null;
  /** The action's own validation, composed in front of the guard's. */
  baseValidate?: ElizaValidator;
  /**
   * The action name reported by `onMappingError` (issue #453); `guardAction`
   * fills it from the wrapped action automatically. Defaults to `"unknown"`
   * when `createGuardValidator` is used directly without a name.
   */
  name?: string;
  /** Observe every decision — the place to wire telemetry. */
  onDecision?: (decision: PreFlightDecision, context: GuardHookContext) => void;
  /**
   * Caller correlation id for this action (issue #459), either fixed or mapped
   * from the message/state. It is added to every hook payload for the action.
   * Omitted — or blank — stays absent; the SDK never derives one from
   * addresses, action arguments or timestamps. Treat it as operator metadata:
   * it may identify a user or run, so do not log it with secrets.
   */
  correlationId?: CorrelationIdOption<[message: unknown, state: unknown]>;
  /**
   * Action-level batch decision summary hook (issue #498).
   *
   * Called once per batch check with `{ adapter: "elizaos", kind, verdicts, calls }`
   * after all calls have been checked, before returning the boolean validation outcome.
   */
  onBatchDecision?: GuardBatchDecisionHook | undefined;
  /**
   * Operator alerting: called once per halt with the same structured payload
   * every adapter uses (`{ adapter, kind, reason, call, explanation }`). A
   * `false` verdict is silent by design — the runtime simply drops the action —
   * so without this a blocked action leaves no trace anywhere. Fires for a
   * `blocked` verdict and for a fail-closed `undetermined` one; a throwing
   * callback is logged and swallowed rather than breaking the halt. See
   * `src/adapters/shared.ts`.
   */
  onBlocked?: GuardBlockedHook;
  /**
   * Integration-bug alerting (issue #453): called once when
   * `toContractCall`/`toContractCalls` throws or returns a malformed call,
   * immediately before the fail-closed `false` return. Never fires for a guard
   * refusal or an undetermined enforcement run, so a broken mapper no longer
   * looks like a policy event. Isolated like `onBlocked`: a throwing hook cannot
   * resume the action.
   */
  onMappingError?: GuardMappingErrorHook;
  /**
   * Include the raw `(message, state)` mapping inputs on `onMappingError`
   * payloads as `{ message, state }`. Off by default because they can contain
   * agent/PII data.
   */
  includeMappingErrorRequest?: boolean;
  /**
   * Explicit sink for a swallowed `onBlocked` failure. Omitted (the default),
   * a throwing hook is silent (issue #314).
   */
  blockedHookLogger?: BlockedHookLogger;
  /**
   * Caller-owned cancellation, forwarded to every pre-flight `check()`
   * (issue #315). ElizaOS's validator hook exposes no invocation signal, so
   * this is the only cancellation channel; aborting yields `undetermined`,
   * which the validator fails closed on.
   */
  signal?: AbortSignal | undefined;
  /**
   * Bound on each RPC call made by the pre-flight check, in milliseconds
   * (issue #315); `0` disables it. A fired timeout yields the same fail-closed
   * `undetermined` verdict as an abort.
   */
  timeoutMs?: number | undefined;
}

/**
 * Build a `validate` that returns `true` only when the action is both valid and
 * permitted by the guard.
 *
 * Fails closed: a refusal and an undetermined enforcement run both return
 * `false`, so the action never executes either way.
 */
export function createGuardValidator(options: ElizaGuardOptions): ElizaValidator {
  const issues: AdapterConfigIssue[] = [];
  const interceptorIssue = validateInterceptor(options.interceptor);
  if (interceptorIssue) issues.push(interceptorIssue);
  issues.push(...validateContractMapping(options));
  if (options.toContractCalls) {
    const batchIssue = validateBatchInterceptor(options.interceptor);
    if (batchIssue) issues.push(batchIssue);
  }
  const blockedLoggerIssue = validateBlockedHookLogger(options.blockedHookLogger);
  if (blockedLoggerIssue) issues.push(blockedLoggerIssue);
  const correlationIdIssue = validateOptionalCorrelationId(options.correlationId);
  if (correlationIdIssue) issues.push(correlationIdIssue);
  const baseValidateIssue = validateOptionalFunction("baseValidate", options.baseValidate);
  if (baseValidateIssue) issues.push(baseValidateIssue);
  const onDecisionIssue = validateOptionalFunction("onDecision", options.onDecision);
  if (onDecisionIssue) issues.push(onDecisionIssue);
  const onBatchDecisionIssue = validateOptionalFunction("onBatchDecision", options.onBatchDecision);
  if (onBatchDecisionIssue) issues.push(onBatchDecisionIssue);
  const onBlockedIssue = validateOptionalFunction("onBlocked", options.onBlocked);
  if (onBlockedIssue) issues.push(onBlockedIssue);
  const onMappingErrorIssue = validateOptionalFunction("onMappingError", options.onMappingError);
  if (onMappingErrorIssue) issues.push(onMappingErrorIssue);
  const signalIssue = validateOptionalSignal(options.signal);
  if (signalIssue) issues.push(signalIssue);
  const timeoutIssue = validateOptionalTimeout(options.timeoutMs);
  if (timeoutIssue) issues.push(timeoutIssue);
  throwAdapterConfigError("elizaos", issues);

  return async (runtime, message, state, handlerOptions) => {
    // Resolve the id once, before the mapper, so every hook for this action —
    // including a mapping failure — carries the same value.
    const correlationId = resolveCorrelationId(options.correlationId, message, state);
    if (options.baseValidate) {
      const baseOk = await options.baseValidate(runtime, message, state, handlerOptions);
      if (!baseOk) return false; // the action was not applicable in the first place
    }

    let calls: ContractCall[];
    try {
      calls = options.toContractCalls
        ? normalizeMappedCalls(options.toContractCalls(message, state), "toContractCalls")
        : normalizeMappedCall(options.toContractCall?.(message, state), "toContractCall");
    } catch (error) {
      // A mapper failure is a fail-closed halt, not an "applicable" action
      // (issue #316): the runtime drops the action before its handler runs.
      const failure = mappingFailureFor(
        "elizaos",
        error,
        options.name ?? "unknown",
        options.includeMappingErrorRequest ? { message, state } : undefined,
        correlationId,
      );
      runMappingErrorHook(options.onMappingError, failure.mapping, options.blockedHookLogger);
      runBlockedHook(options.onBlocked, failure.info, options.blockedHookLogger);
      return false;
    }
    if (calls.length === 0) return true; // not fund-moving; nothing for the guard to say

    const checkOptions = checkOptionsFor(options);

    if (calls.length === 1) {
      let decision: PreFlightDecision;
      try {
        decision = await options.interceptor.check(calls[0]!, checkOptions);
      } catch (error) {
        if (error instanceof GuardError) {
          decision = decisionFromGuardError(error);
        } else {
          throw error;
        }
      }
      runDecisionHook(
        options.onDecision,
        [decision, hookContextFor(correlationId)],
        "elizaos",
        options.blockedHookLogger,
      );
      if (decision.allowed) return true;

      runBlockedHook(
        options.onBlocked,
        blockedInfoFor("elizaos", calls[0]!, decision, correlationId),
        options.blockedHookLogger,
      );
      return false;
    }

    // Batch mapping: a single refusal drops the whole action before its handler
    // runs; every per-call verdict is reported through `onDecision`.
    let batch: PreFlightBatchDecision;
    try {
      batch = await options.interceptor.checkBatch(calls, checkOptions);
    } catch (error) {
      if (error instanceof GuardError) {
        const dec = decisionFromGuardError(error);
        batch = {
          admissible: false,
          overallAdmissible: false,
          kind: dec.kind,
          detail: dec.detail,
          verdicts: calls.map(() => dec),
          calls: calls.map(() => dec),
          totalEstimatedResourceFee: 0n,
        };
      } else {
        throw error;
      }
    }
    for (const verdict of batch.verdicts) {
      runDecisionHook(
        options.onDecision,
        [verdict, hookContextFor(correlationId)],
        "elizaos",
        options.blockedHookLogger,
      );
    }
    runBatchDecisionHook(
      options.onBatchDecision,
      {
        adapter: "elizaos",
        kind: batchDecisionKindFor(batch.verdicts),
        verdicts: batch.verdicts,
        calls,
      },
      options.blockedHookLogger,
    );
    if (batch.admissible) return true;

    runBlockedHook(
      options.onBlocked,
      blockedInfoForBatch("elizaos", calls, batch.verdicts, correlationId),
      options.blockedHookLogger,
    );
    return false;
  };
}

/**
 * Wrap an existing action, returning a copy whose `validate` composes the guard.
 *
 * The returned `validate` is deliberately typed as the full `ElizaValidator`, not
 * as the wrapped action's own (possibly narrower) signature. An action authored
 * with `validate: async () => boolean` is assignable to `ElizaValidator` — extra
 * parameters are allowed to be ignored — but the *wrapped* validator genuinely accepts all four arguments and forwards them to the base, so reporting the
 * narrower type would both misdescribe it and prevent a caller from invoking
 * the action the way the runtime does.
 */
export function guardAction<T extends ElizaActionLike>(
  action: T,
  options: Omit<ElizaGuardOptions, "baseValidate">,
): Omit<T, "validate"> & { validate: ElizaValidator } {
  return {
    ...action,
    validate: createGuardValidator({
      ...options,
      baseValidate: action.validate,
      name: options.name ?? action.name,
    }),
  };
}
