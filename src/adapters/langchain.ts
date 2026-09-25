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
 *
 * Threat Model & Security Posture (Anti-Prompt-Injection & No-Evasion Guidance):
 * ------------------------------------------------------------------------------
 * When a tool call is blocked by pre-flight policy interception, the agent (LLM)
 * observes the returned ToolMessage. An agent presented with an uninformative or
 * ambiguous refusal may loop endlessly, retry the identical call, or hallucinate
 * unauthorized workarounds (e.g. attempting to vary parameters or cycle recipients).
 *
 * CRITICAL NO-EVASION RULE:
 * Guidance returned in tool error messages must NEVER instruct the agent or model
 * to attempt policy evasion. Specifically, error messages must not advise the model
 * to "try another recipient", "try a different address", "try a smaller amount",
 * or "try splitting the payment".
 *
 * In an anti-prompt-injection threat model, suggestions that invite the model to
 * explore parameter variations create an attack vector where an adversary can probe
 * allowlist boundaries or trick the agent into circumventing safety caps.
 *
 * Therefore:
 * 1. The directive returned to the model is strictly halting:
 *    "halted by spending policy; do not retry — escalate to operator."
 * 2. Remediation guidance is explicitly scoped to the human operator
 *    ("Remediation (operator): ...") to indicate that policy adjustments (such as
 *    updating allowlists or adjusting caps) must be performed out-of-band via the
 *    operator dashboard, never through autonomous model trial-and-error.
 */
import type { PreFlightDecision, PreFlightInterceptor } from "../preflight.ts";
import { explainReason } from "../reasons.ts";
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
}

/** Standard guidance returned to autonomous models when an action is blocked. */
export const AGENT_HALT_GUIDANCE = "halted by spending policy; do not retry — escalate to operator.";

/** High-level reason classes for guard policy block decisions. */
export type GuardReasonClass = "caps" | "allowlist" | "frozen" | "other";

/**
 * Classifies a block reason code or symbol into its high-level policy category.
 */
export function getReasonClass(reason: string): GuardReasonClass {
  switch (reason) {
    case "per_tx_cap_exceeded":
    case "window_cap_exceeded":
    case "invalid_amount":
      return "caps";
    case "recipient_not_allowed":
    case "asset_not_allowed":
    case "protocol_not_allowed":
    case "function_not_allowed":
    case "unknown_contract":
    case "self_function_not_allowed":
    case "create_contract_not_allowed":
      return "allowlist";
    case "admin_frozen":
    case "heartbeat_expired":
    case "paused":
    case "outside_active_window":
    case "no_policy":
    case "not_initialized":
      return "frozen";
    default:
      return "other";
  }
}

/**
 * Returns a one-line remediation targeted at the human operator.
 *
 * Note: Remediation instructions are intended solely for human operators managing
 * the smart account via the dashboard, never as instructions for autonomous agents
 * to attempt evasion.
 */
export function getOperatorRemediation(reason: string): string {
  switch (reason) {
    // allowlist
    case "recipient_not_allowed":
      return "recipient not in policy allowlist — operator must add it via dashboard";
    case "asset_not_allowed":
      return "asset not in policy allowlist — operator must add it via dashboard";
    case "protocol_not_allowed":
      return "protocol not in policy allowlist — operator must add it via dashboard";
    case "function_not_allowed":
      return "function not in policy allowlist — operator must add it via dashboard";
    case "unknown_contract":
      return "target contract not in policy allowlist — operator must add it via dashboard";
    case "self_function_not_allowed":
      return "guard function not permitted for agent — operator must adjust permissions via dashboard";
    case "create_contract_not_allowed":
      return "contract creation not permitted for agent — operator must adjust permissions via dashboard";

    // caps
    case "per_tx_cap_exceeded":
      return "transfer amount exceeds per-transaction cap — operator must raise limit via dashboard";
    case "window_cap_exceeded":
      return "rolling-window spend cap exceeded — operator must increase window limit via dashboard or wait for window reset";
    case "invalid_amount":
      return "transfer amount is zero or negative — operator must verify transaction parameters";

    // frozen / account state
    case "admin_frozen":
      return "account is frozen by admin or grace window lapsed — operator must unfreeze via dashboard";
    case "heartbeat_expired":
      return "dead-man switch expired without heartbeat — operator must unfreeze and ping heartbeat via dashboard";
    case "paused":
      return "policy admin kill switch is engaged — operator must unpause via dashboard";
    case "outside_active_window":
      return "ledger time is outside active window — operator must adjust active window via dashboard";
    case "no_policy":
      return "no policy installed (default-deny) — operator must configure policy via dashboard";
    case "not_initialized":
      return "guard account has no registered agent key — operator must initialize guard via dashboard";

    // other / fallback
    case "unauthorized":
      return "agent signature verification failed — operator must verify registered agent key";
    case "invalid_config":
      return "policy configuration rejected — operator must correct configuration via dashboard";
    case "already_initialized":
      return "guard account is already initialized";
    default:
      return "action blocked by guard policy — operator must review policy via dashboard";
  }
}

export interface BlockedToolMessageParams {
  toolName: string;
  reason: string;
  explanation?: string;
  remediation?: string;
  guidance?: string;
}

/**
 * Formats a structured, model-readable ToolNode error message when a tool call is blocked.
 */
export function formatBlockedToolMessage(params: BlockedToolMessageParams): string {
  const explanation = params.explanation ?? explainReason(params.reason);
  const remediation = params.remediation ?? getOperatorRemediation(params.reason);
  const guidance = params.guidance ?? AGENT_HALT_GUIDANCE;

  return [
    `stellar-agent-guard blocked '${params.toolName}': ${params.reason} — ${explanation}`,
    `Remediation (operator): ${remediation}`,
    `Guidance: ${guidance}`,
    `No transaction was submitted, so nothing was spent and no fee was paid.`,
  ].join("\n");
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

      const decision = await options.interceptor.check(call);
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
    return formatBlockedToolMessage({
      toolName,
      reason: decision.reason,
      explanation: decision.explanation,
    });
  }
  return (
    `stellar-agent-guard could not determine whether '${toolName}' is permitted; ` +
    `it was not executed.\n${decision.detail}`
  );
}
