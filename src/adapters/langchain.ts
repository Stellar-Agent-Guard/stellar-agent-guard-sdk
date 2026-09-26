/**
 * LangChain adapter — built on `AgentMiddleware.wrapToolCall`.
 *
 * The hook is the *continuation* form: `wrapToolCall(request, handler)` is handed
 * the tool execution as a callback, so a middleware that returns without calling
 * `handler(request)` means the tool body never runs. That is what makes this a
 * genuine pre-execution block rather than observability. See
 * `docs/integration-hooks.md` §1 for the source-pinned signatures.
 *
 * Do **not** use the older callback system (`on_tool_start` / `onToolStart`):
 * those observe a call that has already been dispatched and cannot stop it.
 *
 * The adapter deliberately does not import `@langchain/core`. It is written
 * structurally against the hook's shape so that installing this SDK does not drag
 * a framework in, and so it keeps working across minor framework versions. The
 * one thing it does need from the host is how to turn a tool call into a guarded
 * contract call — which is application knowledge, supplied as `toContractCall`.
 */
import type { InvokeStepEvent } from "../invoke.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";

/** The subset of LangChain's `ToolCallRequest` this adapter reads. */
export interface LangChainToolCallRequest {
  toolCall: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
}

/** The shape this adapter returns in place of the tool's own result. */
export interface LangChainToolMessage {
  content: string;
  name: string;
  tool_call_id: string;
  /** Marker so a host can tell a refusal from a tool's own output. */
  status: "error";
}

export interface LangChainGuardOptions {
  interceptor: PreFlightInterceptor;
  /**
   * Turn a tool call into the guarded contract call it would make, or `null` if
   * this tool does not move funds and should not be intercepted at all.
   */
  toContractCall: (request: LangChainToolCallRequest) => ContractCall | null;
  /** Middleware name; also the returned message's `name`. */
  name?: string;
  /** Observe every decision — the place to wire telemetry. */
  onDecision?: (request: LangChainToolCallRequest, decision: PreFlightDecision) => void;
  /**
   * Optional per-call observability, forwarded to the interceptor's
   * `check()`: one event per enforcement-stage attempt (probe → sign →
   * simulate) with timing, on the same shared step vocabulary and event shape
   * as `invoke()`'s `onStep`. The adapter never broadcasts, so no `broadcast`
   * events can appear here. Omitting it changes nothing.
   */
  onStep?: (step: InvokeStepEvent) => void;
}

/**
 * A middleware whose `wrapToolCall` asks the guard before the tool runs.
 *
 * Register it first: LangChain composes middleware with *"first defined =
 * outermost"*, so ordering it ahead of other tool middleware means the guard
 * decides before anything else touches the call.
 */
export function createLangChainGuardMiddleware(options: LangChainGuardOptions) {
  const name = options.name ?? "stellar-agent-guard";

  return {
    name,
    async wrapToolCall<T>(
      request: LangChainToolCallRequest,
      handler: (request: LangChainToolCallRequest) => Promise<T>,
    ): Promise<T | LangChainToolMessage> {
      const call = options.toContractCall(request);
      if (!call) {
        // Not a fund-moving tool. Pass through untouched rather than inventing a
        // verdict for something the guard has no opinion about.
        return handler(request);
      }

      const decision = await options.interceptor.check(call, {
        ...(options.onStep ? { onStep: options.onStep } : {}),
      });
      options.onDecision?.(request, decision);
      if (decision.allowed) return handler(request);

      // The tool is never entered: no signing, no broadcast, no fee.
      return {
        content: describeRefusal(decision, request.toolCall.name),
        name,
        tool_call_id: request.toolCall.id ?? "",
        status: "error",
      };
    },
  };
}

/** Human- and model-readable refusal text, sourced from the contract's reason. */
function describeRefusal(decision: PreFlightDecision & { allowed: false }, toolName: string): string {
  if (decision.kind === "blocked") {
    return (
      `stellar-agent-guard blocked '${toolName}': ${decision.reason} — ${decision.explanation}\n` +
      `No transaction was submitted, so nothing was spent and no fee was paid.`
    );
  }
  return (
    `stellar-agent-guard could not determine whether '${toolName}' is permitted; ` +
    `it was not executed.\n${decision.detail}`
  );
}
