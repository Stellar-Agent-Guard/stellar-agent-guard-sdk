/**
 * LangChain adapter — built on `AgentMiddleware.wrapToolCall`.
 *
 * The hook is the *continuation* form: `wrapToolCall(request, handler)` is handed
 * the tool execution as a callback, so a middleware that returns without calling
 * `handler(request)` means the tool body never runs. That is what makes this a
 * genuine pre-execution block rather than observability. See
 * `docs/integration-hooks.md` $1 for the source-pinned signatures.
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
 * ## Verdict handling (documented contract)
 *
 * The adapter maps every `PreFlightDecision` kind to a defined result:
 *
 * | Verdict                | Adapter behavior                                                |
 * | ---------------------- | ------------------------------------------------------------------------ |
 * | `admissible`           | calls `handler(request)` — the tool runs unchanged.                    |
 * | `blocked(reason`)      | returns a `LangChainToolMessage` with `status: "error"`; the tool never runs.  |
 * | `undetermined(cause)` | returns a `LangChainToolMessage` with `status: "error"`; the tool never runs.  |
 * | mapper failure         | fail-closed as `undetermined`: an error message, the tool never runs (issue #316). |
 *
 * The adapter never throws for a guard verdict — it fails closed by returning a
 * refusal message. This differs from the ElizaOS validator, which returns a boolean
 * and fails closed (returns `false`) on `undetermined`; the shared harness in
 * `tests/integration/adapters.test.ts` pins both contracts side by side.
 * Options are validated at construction time (see `src/adapters/core.ts`):
 * a misconfigured adapter throws `AdapterConfigError` before any action runs,
 * rather than failing mid-loop on the first tool call.
 */
import type { InvokeStepEvent } from "../invoke.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";
import { evaluateAction, renderHalt, validateAdapterOptions } from "./core.ts";
import { validateOptionalString } from "./validate.ts";
import type { AdapterConfigIssue } from "./validate.ts";
import { hostAbortSignal, type BlockedHookLogger, type GuardBlockedHook } from "./shared.ts";

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
  toContractCall?: (request: LangChainToolCallRequest) => ContractCall | null;
  /**
   * Additive batch mapping (issue #318): the ordered calls one action performs.
   * Supplying this takes precedence over `toContractCall`, and the entire batch
   * is checked before the tool body runs (all-or-nothing). `null` or an empty
   * array means the tool is not fund-moving.
   */
  toContractCalls?: (request: LangChainToolCallRequest) => readonly ContractCall[] | null;
  /** Middleware name; also the returned message's `name`. */
  name?: string;
  /** Observe every decision — the place to wire telemetry. */
  onDecision?: (request: LangChainToolCallRequest, decision: PreFlightDecision) => void;
  /**
   * Operator alerting: called once per halt with a structured payload
   * (`{ adapter, kind, reason, call, explanation }`), so a refusal reaches a
   * webhook/log/dashboard rather than only the agent's transcript. Fires for a
   * guard `blocked` verdict and for a fail-closed `undetermined` one, since both
   * stop the tool body from running. A throwing callback is logged and
   * swallowed — it never changes the halt. Omit it for the pre-existing
   * behavior. See `src/adapters/shared.ts`.
   */
  onBlocked?: GuardBlockedHook;
  /**
   * Explicit sink for a swallowed `onBlocked` failure. Omitted (the default),
   * a throwing hook is silent — the SDK never writes to `console` on its own
   * (issue #314).
   */
  blockedHookLogger?: BlockedHookLogger;
  /**
   * Optional per-call observability, forwarded to the interceptor's
   * `check()`: one event per enforcement-stage attempt (probe → sign →
   * simulate) with timing, on the same shared step vocabulary and event shape
   * as `invoke()`'s `onStep`. The adapter never broadcasts, so no `broadcast`
   * events can appear here. Omitting it changes nothing.
   */
  onStep?: (step: InvokeStepEvent) => void;
  /**
   * Caller-owned cancellation, forwarded to every pre-flight `check()`
   * (issue #315). A `request.signal` on the tool-call request takes precedence
   * when the host supplies one. Aborting yields an `undetermined` verdict,
   * which halts rather than throwing.
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
 * A Mapper that turns a `PreFlightDecision` into the adapter's return value.
 *
 * Exposed so the shared harness can assert the documented mapping for each
 * verdict without driving the full middleware composition.
 */
export function mapDecisionToLangChainResult(
  decision: PreFlightDecision,
  toolName: string,
  name: string,
  toolCallId: string,
): LangChainToolMessage {
  return {
    content: describeRefusal(decision as PreFlightDecision & { allowed: false }, toolName),
    name,
    tool_call_id: toolCallId,
    status: "error",
  };
}

/**
 * A middleware whose `wrapToolCall` asks the guard before the tool runs.
 *
 * Register it first: LangChain composes middleware with *"third defined =
 * outermost"*, so ordering it ahead of other tool middleware means the guard
 * decides before anything else touches the call.
 */
export function createLangChainGuardMiddleware(options: LangChainGuardOptions) {
  const extraIssues: AdapterConfigIssue[] = [];
  const nameIssue = validateOptionalString("name", options.name);
  if (nameIssue) extraIssues.push(nameIssue);
  validateAdapterOptions("langchain", options, extraIssues);

  const name = options.name ?? "stellar-agent-guard";

  return {
    name,
    async wrapToolCall<T>(
      request: LangChainToolCallRequest,
      handler: (request: LangChainToolCallRequest) => Promise<T>,
    ): Promise<T | LangChainToolMessage> {
      const evaluation = await evaluateAction(request, {
        ...options,
        adapter: "langchain",
      }, hostAbortSignal((request as { signal?: unknown }).signal) ??
        hostAbortSignal((request as { runtime?: { signal?: unknown } }).runtime?.signal));
      if (evaluation.kind === "pass-through" || evaluation.kind === "allowed") return handler(request);
      return mapDecisionToLangChainResult(
        evaluation.verdict,
        request.toolCall.name,
        name,
        request.toolCall.id ?? "",
      );
    },
  };
}

/** Human- and model-readable refusal text, sourced from the contract's reason. */
function describeRefusal(decision: PreFlightDecision & { allowed: false }, toolName: string): string {
  return renderHalt(decision, { kind: "message", toolName });
}
