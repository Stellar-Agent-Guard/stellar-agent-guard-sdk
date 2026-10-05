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
 */
import type { PreFlightDecision, PreFlightInterceptor } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";
import { blockedInfoFor, runBlockedHook, type GuardBlockedHook } from "./shared.ts";

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
  toContractCall: (message: unknown, state: unknown) => ContractCall | null;
  /** The action's own validation, composed in front of the guard's. */
  baseValidate?: ElizaValidator;
  /** Observe every decision — the place to wire telemetry. */
  onDecision?: (decision: PreFlightDecision) => void;
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
}

/**
 * Build a `validate` that returns `true` only when the action is both valid and
 * permitted by the guard.
 *
 * Fails closed: a refusal and an undetermined enforcement run both return
 * `false`, so the action never executes either way.
 */
export function createGuardValidator(options: ElizaGuardOptions): ElizaValidator {
  return async (runtime, message, state, handlerOptions) => {
    if (options.baseValidate) {
      const baseOk = await options.baseValidate(runtime, message, state, handlerOptions);
      if (!baseOk) return false; // the action was not applicable in the first place
    }

    const call = options.toContractCall(message, state);
    if (!call) return true; // not a fund-moving action; nothing for the guard to say

    const decision = await options.interceptor.check(call);
    options.onDecision?.(decision);
    if (decision.allowed) return true;

    runBlockedHook(options.onBlocked, blockedInfoFor("elizaos", call, decision));
    return false;
  };
}

/**
 * Wrap an existing action, returning a copy whose `validate` composes the guard.
 *
 * The returned `validate` is deliberately typed as the full `ElizaValidator`, not
 * as the wrapped action's own (possibly narrower) signature. An action authored
 * with `validate: async () => boolean` is assignable to `ElizaValidator` — extra
 * parameters are allowed to be ignored — but the *wrapped* validator genuinely
 * accepts all four arguments and forwards them to the base, so reporting the
 * narrower type would both misdescribe it and prevent a caller from invoking the
 * action the way the runtime does.
 */
export function guardAction<T extends ElizaActionLike>(
  action: T,
  options: Omit<ElizaGuardOptions, "baseValidate">,
): Omit<T, "validate"> & { validate: ElizaValidator } {
  return {
    ...action,
    validate: createGuardValidator({ ...options, baseValidate: action.validate }),
  };
}
