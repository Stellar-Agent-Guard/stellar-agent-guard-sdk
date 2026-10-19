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
 */
import type { PreFlightDecision } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";

/**
 * Which adapter observed the halt. This is the payload's `adapter` field, so an
 * operator sink that receives blocks from several frameworks can tell them
 * apart without inspecting the call.
 */
export type GuardAdapterName = "langchain" | "elizaos" | "mcp";

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
  /** The contract call the guard ruled on (or could not rule on). */
  call: ContractCall;
  /** Human-readable one-line meaning; the failure detail when undetermined. */
  explanation: string;
}

/**
 * Operator alerting hook. Intended for webhook/log/alert wiring by the
 * integrator; see `runBlockedHook` for the isolation guarantee.
 */
export type GuardBlockedHook = (info: GuardBlockedInfo) => void;

/** Where a swallowed hook failure is reported. Injectable so tests are quiet. */
export interface BlockedHookLogger {
  error(message: string, ...rest: unknown[]): void;
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
): GuardBlockedInfo {
  if (decision.kind === "blocked") {
    return {
      adapter,
      kind: "blocked",
      reason: decision.reason,
      call,
      explanation: decision.explanation,
    };
  }
  return {
    adapter,
    kind: "undetermined",
    reason: null,
    call,
    explanation: decision.detail,
  };
}

/**
 * Fire the operator hook exactly once, isolating it from the halt path.
 *
 * Absent hook → nothing happens, which is precisely the adapter's behavior
 * before this option existed. A throwing hook is swallowed and logged rather
 * than propagated: the refusal has already been decided, and an alerting sink
 * that is down must not change what the agent is allowed to do. The log line
 * names the adapter so a failing webhook can be traced without the payload.
 */
export function runBlockedHook(
  hook: GuardBlockedHook | undefined,
  info: GuardBlockedInfo,
  logger: BlockedHookLogger = console,
): void {
  if (!hook) return;
  try {
    hook(info);
  } catch (error) {
    logger.error(
      `stellar-agent-guard: the ${info.adapter} adapter's onBlocked callback threw; the halt stands and the action was not executed.`,
      error,
    );
  }
}
