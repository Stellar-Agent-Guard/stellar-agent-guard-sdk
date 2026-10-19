/**
 * Vercel AI SDK adapter — built on wrapping tool `execute` functions.
 *
 * The Vercel AI SDK's language-model middleware (`wrapLanguageModel`) transforms
 * *model streams*, which already contain tool-call arguments the model has
 * emitted — intercepting there is post-decision, not pre-execution. The earliest
 * hook the SDK owns where nothing has run yet is the tool's own `execute`
 * function: a tool with `execute: undefined` never runs, so wrapping the
 * function body is the same pre-execution guarantee the LangChain continuation
 * hook gives. The AI SDK itself documents exactly this pattern (`ai` ≥ 4.1 /
 * 5.x tool wrapping, tested against the structural `Tool` shape below): pass
 * `wrapTool`-style helpers a tool and return a copy whose `execute` is
 * `guard(toolImpl)`.
 *
 * Verdict → halt semantics, shared with the other adapters:
 *
 * | verdict        | behaviour                                                       |
 * |----------------|-----------------------------------------------------------------|
 * | `admissible`   | the wrapped `execute` runs and its result is returned untouched |
 * | `blocked`      | throws `GuardBlockedError` before `execute` is entered          |
 * | `undetermined` | throws `PreFlightUndeterminedError` before `execute` is entered |
 *
 * Throwing (rather than returning a marker like the LangChain `ToolMessage`) is
 * the harness's documented contract for this adapter: the AI SDK renders a
 * thrown tool error into the model's error stream, and a blocked call must not
 * produce a tool *result* the model can read as success.
 *
 * Written structurally against the `Tool` shape, so `ai` is not a dependency of
 * this package.
 */
import { GuardBlockedError } from "../reasons.ts";
import { PreFlightUndeterminedError } from "../preflight.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";

/**
 * The subset of the Vercel AI SDK's `Tool` interface this adapter reads.
 *
 * `input` is the framework's typed tool input (`ToolCallOptions.input` in
 * `ai` ≥ 5); it is structurally opaque here because turning it into a guarded
 * `ContractCall` is application knowledge, supplied as `toContractCall`.
 */
export interface VercelAIToolLike {
  /** The tool's own `execute`; may be absent, in which case there is nothing to guard. */
  execute?: ((input: never, options: unknown) => Promise<unknown>) | undefined;
}

/** The subset of an AI SDK tool call this adapter can describe. */
export interface VercelAIToolCallInput {
  toolName: string;
  input: unknown;
}

export interface VercelAIGuardOptions {
  interceptor: PreFlightInterceptor;
  /**
   * Turn a tool call into the guarded contract call it would make, or `null`
   * when this tool moves no funds and should not be intercepted at all.
   */
  toContractCall: (call: VercelAIToolCallInput) => ContractCall | null;
  /** Observe every decision — the place to wire telemetry. */
  onDecision?: (call: VercelAIToolCallInput, decision: PreFlightDecision) => void;
}

/**
 * Wrap a tool definition so its `execute` asks the guard before it runs.
 *
 * A tool without `execute` is returned untouched: a tool that cannot execute
 * cannot move funds, and inventing a verdict for it would be the guard ruling
 * on something it has no opinion about.
 */
export function wrapToolWithGuard<T extends VercelAIToolLike>(
  tool: T,
  options: VercelAIGuardOptions,
  call: VercelAIToolCallInput,
): T {
  if (typeof tool.execute !== "function") return tool;
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(input: never, toolOptions: unknown): Promise<unknown> {
      const contractCall = options.toContractCall({ toolName: call.toolName, input });
      if (!contractCall) return execute(input, toolOptions);

      const decision = await options.interceptor.check(contractCall);
      options.onDecision?.({ toolName: call.toolName, input }, decision);
      if (decision.allowed) return execute(input, toolOptions);

      if (decision.kind === "blocked") {
        throw new GuardBlockedError({
          reason: decision.reason,
          stage: "preflight",
          detail: decision.detail,
          call: contractCall,
          rawEvent: decision.diagnosticEvents?.[0],
        });
      }
      throw new PreFlightUndeterminedError(decision.detail, { cause: decision.error });
    },
  };
}

/**
 * Build a guard wrapper in the same options shape as the other adapters.
 *
 * The returned function is a drop-in for the AI SDK's documented
 * "wrap the tool function itself" pattern — use it wherever the SDK hands you a
 * tool before execution: `wrapLanguageModel`'s `wrapTool` middleware hook, a
 * `dynamicTool` factory, or plain tool construction.
 */
export function createVercelAIGuard(options: VercelAIGuardOptions) {
  return function guard<T extends VercelAIToolLike>(toolName: string, tool: T): T {
    return wrapToolWithGuard(tool, options, { toolName, input: undefined });
  };
}
