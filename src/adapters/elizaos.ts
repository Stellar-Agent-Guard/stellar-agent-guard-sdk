/**
 * ElizaOS adapter — built on \Action.validate\.
 *
 * \Action.validate\ is already a pre-execution gate: the runtime calls it with
 * the same \(runtime, message, state, options)\ triple the handler receives and
 * admits the action to the eligible set only when it returns truthy. Composing
 * the guard into \alidate\ therefore stops the handler from ever running — see
 * \docs/integration-hooks.md\ A 2 for the source-pinned signatures and the three
 * call sites that enforce it.
 *
 * Wrapping \handler\ instead would be weaker: by the time a handler runs, the
 * runtime has already committed to executing the action, and an error thrown
 * there is a failure rather than a refusal.
 *
 * Written structurally, so \@elizaos/core\ is not a dependency of this SDK.
 */
import type { PreFlightDecision, PreFlightInterceptor } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";

/** The subset of ElizaOS's \Validator\ signature this adapter implements. */
export type ElizaValidator = (
  runtime: unknown,
  message: unknown,
  state?: unknown,
  options?: unknown,
) => Promise<boolean>;

export type GuardedElizaValidator = ElizaValidator & {
  /**
   * Clears the memoized verdicts for this validator. Call this when the
   * underlying action intent mutates to force a fresh simulation.
   */
  clearVerdictCache: () => void;
};

/** The subset of the \Action\ interface this adapter reads. */
export interface ElizaActionLike {
  name: string;
  validate: ElizaValidator;
}

export interface ElizaGuardOptions {
  interceptor: PreFlightInterceptor;
  /**
   * Turn the action's intent into the guarded contract call it would make, or
   * \
ull\ when this action moves no funds.
   */
  toContractCall: (message: unknown, state: unknown) => ContractCall | null;
  /** The action's own validation, composed in front of the guard's. */
  baseValidate?: ElizaValidator;
  /** Observe every decision — the place to wire telemetry. */
  onDecision?: (decision: PreFlightDecision) => void;
  /**
   * Called with the refusal, because a \alse\ verdict is silent by design: the
   * runtime simply drops the action. Without this, a blocked action leaves no
   * trace anywhere.
   */
  onBlocked?: (decision: PreFlightDecision & { allowed: false }) => void;
  /**
   * ElizaOS may invoke the validator multiple times for the same action during
   * one decision cycle (revalidation after state tweaks) — each call re-simulates.
   * Turn this on to cache verdicts per action shape.
   * Default: false.
   */
  cacheVerdicts?: boolean;
}

function canonicalizeCall(call: ContractCall): string {
  return JSON.stringify({
    c: call.contract,
    f: call.fn,
    a: call.args.map((a) => a.toXDR("base64")),
  });
}

/**
 * Build a \alidate\ that returns \	rue\ only when the action is both valid and
 * permitted by the guard.
 *
 * Fails closed: a refusal and an undetermined enforcement run both return
 * \alse\, so the action never executes either way.
 */
export function createGuardValidator(options: ElizaGuardOptions): GuardedElizaValidator {
  const cache = new Map<string, boolean>();

  const validator = async (
    runtime: unknown,
    message: unknown,
    state?: unknown,
    handlerOptions?: unknown,
  ) => {
    if (options.baseValidate) {
      const baseOk = await options.baseValidate(runtime, message, state, handlerOptions);
      if (!baseOk) return false; // the action was not applicable in the first place
    }

    const call = options.toContractCall(message, state);
    if (!call) return true; // not a fund-moving action; nothing for the guard to say

    let cacheKey: string | null = null;
    if (options.cacheVerdicts) {
      cacheKey = canonicalizeCall(call);
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const decision = await options.interceptor.check(call);
    options.onDecision?.(decision);
    
    if (decision.allowed) {
      if (options.cacheVerdicts && cacheKey) cache.set(cacheKey, true);
      return true;
    }

    options.onBlocked?.(decision);
    if (options.cacheVerdicts && cacheKey) cache.set(cacheKey, false);
    return false;
  };

  validator.clearVerdictCache = () => {
    cache.clear();
  };

  return validator;
}

/**
 * Wrap an existing action, returning a copy whose \alidate\ composes the guard.
 *
 * The returned \alidate\ is deliberately typed as the full \ElizaValidator\, not
 * as the wrapped action's own (possibly narrower) signature. An action authored
 * with \alidate: async () => boolean\ is assignable to \ElizaValidator\ — extra
 * parameters are allowed to be ignored — but the *wrapped* validator genuinely
 * accepts all four arguments and forwards them to the base, so reporting the
 * narrower type would both misdescribe it and prevent a caller from invoking the
 * action the way the runtime does.
 */
export function guardAction<T extends ElizaActionLike>(
  action: T,
  options: Omit<ElizaGuardOptions, "baseValidate">,
): Omit<T, "validate"> & { validate: GuardedElizaValidator } {
  return {
    ...action,
    validate: createGuardValidator({ ...options, baseValidate: action.validate }),
  };
}
