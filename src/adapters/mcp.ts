/**
 * MCP adapter — guard a Model Context Protocol tool call at the boundary.
 *
 * Model Context Protocol tool calls (Claude Desktop and other MCP hosts) are
 * another surface where agent-driven contract actions originate. The spike for
 * this adapter (issue #45) checked the two published generations of the
 * TypeScript SDK and found a genuine **pre-execution** point in both:
 *
 * - v2 (`@modelcontextprotocol/server`, spec `2026-07-28`) registers a tool with
 *   `server.registerTool(name, config, handler)`; the handler is `async (args,
 *   extra) => CallToolResult` and runs only after the host sends `tools/call`.
 * - v1 (`@modelcontextprotocol/sdk` 1.30.x) exposes the same handler shape via
 *   `server.tool(name, schema, handler)` and, at the low level, via
 *   `server.setRequestHandler(CallToolRequestSchema, handler)`.
 *
 * There is no "post-hoc only" problem to document here: returning a refusal
 * **without invoking the wrapped handler** means the tool body — the code that
 * signs and broadcasts a transaction — never runs. `guardMcpToolHandler` wraps
 * that handler. `guardMcpCallTool` covers the other side of the same boundary,
 * a client wrapping its own `callTool` before the request leaves the process.
 *
 * Written structurally, so neither `@modelcontextprotocol/sdk` nor
 * `@modelcontextprotocol/server` becomes a dependency of this package. The
 * pinned revisions and the hook search are recorded in
 * `docs/integration-hooks.md` §4.
 */
import { GuardError } from "../errors.ts";
import type { InvokeStepEvent } from "../invoke.ts";
import type {
  PreFlightBatchDecision,
  PreFlightDecision,
  PreFlightInterceptor,
} from "../preflight.ts";
import type { ContractCall } from "../tx.ts";
import {
  batchDecisionKindFor,
  blockedInfoFor,
  blockedInfoForBatch,
  checkOptionsFor,
  decisionFromGuardError,
  hostAbortSignal,
  mapContractCalls,
  mappingFailureFor,
  runBatchDecisionHook,
  runBlockedHook,
  runDecisionHook,
  runMappingErrorHook,
  type BlockedHookLogger,
  type GuardBatchDecisionHook,
  type GuardBlockedHook,
  type GuardMappingErrorHook,
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

/** The one field of a tool call this adapter reads. */
export interface McpToolCallRequest {
  /** The tool name the model asked for. */
  name: string;
  /** The tool's arguments, as the host delivered them. */
  arguments: Record<string, unknown>;
}

/**
 * The subset of MCP's `CallToolResult` this adapter produces. Kept loose so a
 * host's own richer result type (structured content, image blocks) still
 * satisfies it without this package depending on the SDK's types.
 */
export interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** A registered MCP tool handler: `(args, extra) => CallToolResult`. */
export type McpToolHandler<T extends McpToolResult = McpToolResult> = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<T>;

/** A client's `callTool`: `(request) => CallToolResult`. */
export type McpCallTool<T extends McpToolResult = McpToolResult> = (
  request: McpToolCallRequest,
) => Promise<T>;

export interface McpGuardOptions {
  interceptor: PreFlightInterceptor;
  /**
   * Turn a tool call into the guarded contract call it would make, or `null` if
   * this tool moves no funds and should not be intercepted at all.
   */
  toContractCall?: (request: McpToolCallRequest) => ContractCall | null;
  /**
   * Additive batch mapping (issue #318): the ordered calls this tool performs.
   * Takes precedence over `toContractCall`; the whole batch is checked before
   * the handler runs (all-or-nothing). `null` or an empty array means the tool
   * is not fund-moving.
   */
  toContractCalls?: (request: McpToolCallRequest) => readonly ContractCall[] | null;
  /** Observe every decision — the place to wire telemetry. */
  onDecision?: (request: McpToolCallRequest, decision: PreFlightDecision) => void;
  /**
   * Action-level batch decision summary hook (issue #498).
   *
   * Called once per batch check with `{ adapter: "mcp", kind, verdicts, calls, correlationId? }`
   * after all calls have been checked, before the handler runs or the refusal is returned.
   */
  onBatchDecision?: GuardBatchDecisionHook | undefined;
  /**
   * Operator alerting on every halt, on the same shared payload as the other
   * adapters (`{ adapter: "mcp", kind, reason, call, explanation }`). A throwing
   * callback is logged and swallowed; omit it for the pre-existing behavior.
   */
  onBlocked?: GuardBlockedHook;
  /**
   * Integration-bug alerting (issue #453): called once when
   * `toContractCall`/`toContractCalls` throws or returns a malformed call,
   * immediately before the fail-closed `isError` result. A guard refusal never
   * fires it. `onBlocked` still fires for compatibility. Raw tool arguments are
   * omitted unless `includeMappingErrorRequest` is set.
   */
  onMappingError?: GuardMappingErrorHook;
  /**
   * Include the raw `{ name, arguments }` request on `onMappingError` payloads.
   * Off by default: MCP tool arguments commonly carry credentials or user data.
   */
  includeMappingErrorRequest?: boolean;
  /**
   * Explicit sink for a swallowed `onBlocked` failure. Omitted (the default),
   * a throwing hook is silent (issue #314).
   */
  blockedHookLogger?: BlockedHookLogger;
  /**
   * Optional per-call observability, forwarded to the interceptor's `check()`:
   * one event per enforcement-stage attempt (probe → sign → simulate). The
   * adapter never broadcasts, so no `broadcast` events can appear here.
   */
  onStep?: (step: InvokeStepEvent) => void;
  /**
   * Caller-owned cancellation, forwarded to every pre-flight `check()`
   * (issue #315). For `guardMcpToolHandler` the host's invocation signal
   * (`extra.signal`) takes precedence when the SDK provides one.
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
 * The v2 MCP server's registration surface, structurally typed (issue #456).
 *
 * Only `registerTool(name, config, handler)` is required: that is the
 * pre-execution point where a server installs the handler a host will later
 * invoke. `unregisterTool(name)` is optional and is used only by `close()`;
 * a host without it can still register guarded tools, it just cannot tear the
 * registrations down through this helper.
 *
 * No MCP package is imported — a server that happens to satisfy this shape is
 * accepted whether it came from `@modelcontextprotocol/server`, a test double,
 * or the server author's own wrapper.
 */
export interface McpToolRegistrar {
  registerTool(name: string, config: unknown, handler: McpToolHandler): unknown;
  unregisterTool?: ((name: string) => unknown) | undefined;
}

/** One tool to register through `guardMcpServer`. */
export interface McpServerToolDefinition {
  /** The name the host will send in `tools/call`. */
  name: string;
  /** The original, unguarded tool body. */
  handler: McpToolHandler;
  /** Tool config/schema handed to `registerTool` unchanged; defaults to `{}`. */
  config?: unknown;
}

/**
 * Tools passed to `guardMcpServer`: either a `{ name: handler }` record or an
 * ordered list of definitions when a tool also needs a config/schema.
 */
export type McpServerTools =
  | Readonly<Record<string, McpToolHandler>>
  | readonly McpServerToolDefinition[];

export interface GuardMcpServerOptions extends McpGuardOptions {
  /** A server exposing a structural `registerTool`-like method. */
  server: McpToolRegistrar;
  /** Tools to register; each one is wrapped with the same guard options. */
  tools: McpServerTools;
}

/** What `guardMcpServer` handed to `registerTool` for one tool. */
export interface GuardedMcpToolDescriptor {
  name: string;
  /** The guarded handler actually installed on the server. */
  handler: McpToolHandler<McpToolResult>;
  /** The handler supplied by the caller; kept for diagnostics and teardown. */
  originalHandler: McpToolHandler;
  /** The config passed as the second `registerTool` argument. */
  config: unknown;
  /** The exact value `registerTool` returned, for hosts that need it. */
  registration: unknown;
}

/** The registrations installed by `guardMcpServer`. */
export interface GuardedMcpServer {
  /** One descriptor per registered tool, in the order given. */
  tools: GuardedMcpToolDescriptor[];
  /**
   * Unregister every tool when the server supports `unregisterTool`. Idempotent:
   * a second call is a no-op. A server without that method needs its own
   * teardown; `close()` still resolves so cleanup code has one call to make.
   */
  close(): Promise<void>;
}

/**
 * The shared decision path for both boundaries: ask the guard once, hand an
 * allowed call to `proceed`, and turn any halt into an MCP error result.
 *
 * Failing closed on `undetermined` matters here more than anywhere: an MCP host
 * surfaces a returned `isError: true` result to the model, so a guardrail that
 * let an undetermined call through would let the model believe the action ran.
 */
async function guardMcpRequest<T extends McpToolResult>(
  request: McpToolCallRequest,
  proceed: () => Promise<T>,
  options: McpGuardOptions,
  hostSignal?: AbortSignal | undefined,
): Promise<T | McpToolResult> {
  let calls: ContractCall[];
  try {
    calls = mapContractCalls(request, options);
  } catch (error) {
    // Fail closed on a mapper failure (issue #316): the tool body never runs and
    // the halt is reported as undetermined, without a mapped `call`.
    const failure = mappingFailureFor(
      "mcp",
      error,
      request.name,
      options.includeMappingErrorRequest ? request : undefined,
    );
    runMappingErrorHook(options.onMappingError, failure.mapping, options.blockedHookLogger);
    runBlockedHook(options.onBlocked, failure.info, options.blockedHookLogger);
    return {
      content: [{ type: "text", text: describeMcpRefusal(failure.decision, request.name) }],
      isError: true,
    };
  }
  if (calls.length === 0) return proceed();

  const checkOptions = checkOptionsFor(options, hostSignal);

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
    runDecisionHook(options.onDecision, [request, decision], "mcp", options.blockedHookLogger);
    if (decision.allowed) return proceed();

    runBlockedHook(
      options.onBlocked,
      blockedInfoFor("mcp", calls[0]!, decision),
      options.blockedHookLogger,
    );
    return {
      content: [{ type: "text", text: describeMcpRefusal(decision, request.name) }],
      isError: true,
    };
  }

  // Batch mapping: report every per-call verdict, and refuse the whole action if
  // any call is blocked or undetermined (all-or-nothing).
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
    runDecisionHook(options.onDecision, [request, verdict], "mcp", options.blockedHookLogger);
  }
  runBatchDecisionHook(
    options.onBatchDecision,
    {
      adapter: "mcp",
      kind: batchDecisionKindFor(batch.verdicts),
      verdicts: batch.verdicts,
      calls,
      correlationId: (request as { id?: string }).id,
    },
    options.blockedHookLogger,
  );
  if (batch.admissible) return proceed();

  runBlockedHook(
    options.onBlocked,
    blockedInfoForBatch("mcp", calls, batch.verdicts),
    options.blockedHookLogger,
  );
  const refusal = batch.verdicts.find((verdict) => !verdict.allowed)!;
  return {
    content: [{ type: "text", text: describeMcpRefusal(refusal, request.name) }],
    isError: true,
  };
}

/**
 * Wrap a registered MCP tool handler so the guard decides before its body runs.
 *
 * The tool name is passed explicitly because MCP invokes a handler with the
 * tool's *arguments*, not with the `{ name, arguments }` request the low-level
 * handler sees; without it `toContractCall` would have no way to tell which
 * tool the model called when one handler serves several names.
 */
export function guardMcpToolHandler<T extends McpToolResult>(
  toolName: string,
  handler: McpToolHandler<T>,
  options: McpGuardOptions,
): McpToolHandler<T | McpToolResult> {
  return (args, extra) =>
    guardMcpRequest(
      { name: toolName, arguments: args },
      () => handler(args, extra),
      options,
      // The MCP SDK passes the invocation's AbortSignal through `extra`.
      hostAbortSignal((extra as { signal?: unknown } | undefined)?.signal),
    );
}

/**
 * Normalize the two `tools` spellings into one list of definitions, collecting
 * every problem so a misconfigured server fails once, before registering any
 * tool (the same fail-fast doctrine as the other adapter factories).
 */
function normalizeServerTools(
  tools: McpServerTools | null | undefined,
  issues: AdapterConfigIssue[],
): McpServerToolDefinition[] {
  if (tools === null || typeof tools !== "object") {
    issues.push({
      field: "tools",
      expected: "a name-to-handler record or an array of tool definitions",
      message:
        "`tools` is required and must be a record of tool names to handlers, " +
        "or an array of `{ name, handler, config? }` definitions.",
    });
    return [];
  }

  if (Array.isArray(tools)) {
    if (tools.length === 0) {
      issues.push({
        field: "tools",
        expected: "at least one tool definition",
        message: "`tools` must contain at least one tool definition.",
      });
    }
    const definitions: McpServerToolDefinition[] = [];
    for (const [index, entry] of tools.entries()) {
      const candidate = entry as { name?: unknown; handler?: unknown; config?: unknown } | null;
      if (typeof candidate?.name !== "string" || candidate.name.length === 0) {
        issues.push({
          field: `tools[${index}].name`,
          expected: "a non-empty tool name",
          message: `\`tools[${index}].name\` must be a non-empty string.`,
        });
      } else if (typeof candidate.handler !== "function") {
        issues.push({
          field: `tools[${index}].handler`,
          expected: "a tool handler function",
          message: `\`tools[${index}].handler\` must be a function.`,
        });
      } else {
        definitions.push({
          name: candidate.name,
          handler: candidate.handler as McpToolHandler,
          ...(candidate.config !== undefined ? { config: candidate.config } : { config: {} }),
        });
      }
    }
    return definitions;
  }

  const entries = Object.entries(tools as Record<string, unknown>);
  if (entries.length === 0) {
    issues.push({
      field: "tools",
      expected: "at least one named tool handler",
      message: "`tools` must name at least one tool handler.",
    });
  }
  const definitions: McpServerToolDefinition[] = [];
  for (const [name, handler] of entries) {
    if (name.length === 0) {
      issues.push({
        field: "tools",
        expected: "non-empty tool names",
        message: "`tools` contains an empty tool name.",
      });
    } else if (typeof handler !== "function") {
      issues.push({
        field: `tools.${name}`,
        expected: "a tool handler function",
        message: `\`tools.${name}\` must be a function.`,
      });
    } else {
      definitions.push({ name, handler: handler as McpToolHandler, config: {} });
    }
  }
  return definitions;
}

/**
 * Register several MCP tools with the guard installed at each one's
 * pre-execution boundary (issue #456).
 *
 * Each tool goes through `guardMcpToolHandler`, so an admissible call reaches
 * the original body with its exact `args`/`extra`, a blocked or undetermined
 * call returns the same `isError: true` result, and a mapper that returns
 * `null` leaves the body untouched. The helper only adds registration
 * ergonomics; it never imports an MCP SDK and never changes a verdict.
 *
 * Misconfiguration (no `registerTool`, no tools, a malformed tool entry) throws
 * `AdapterConfigError` synchronously, before the first tool is registered.
 */
export function guardMcpServer(options: GuardMcpServerOptions): GuardedMcpServer {
  const issues: AdapterConfigIssue[] = [];
  const server = options.server as McpToolRegistrar | null | undefined;
  if (!server || typeof server.registerTool !== "function") {
    issues.push({
      field: "server",
      expected: "an object exposing registerTool(name, config, handler)",
      message:
        "`server` is required and must expose a `registerTool(name, config, handler)` method.",
    });
  } else if (server.unregisterTool !== undefined && typeof server.unregisterTool !== "function") {
    issues.push({
      field: "server.unregisterTool",
      expected: "a function when provided",
      message: "`server.unregisterTool` must be a function when provided.",
    });
  }

  const definitions = normalizeServerTools(options.tools, issues);
  issues.push(...validateContractMapping(options));
  const interceptorIssue = validateInterceptor(options.interceptor);
  if (interceptorIssue) issues.push(interceptorIssue);
  if (options.toContractCalls) {
    const batchIssue = validateBatchInterceptor(options.interceptor);
    if (batchIssue) issues.push(batchIssue);
  }
  const loggerIssue = validateBlockedHookLogger(options.blockedHookLogger);
  if (loggerIssue) issues.push(loggerIssue);
  for (const hook of [
    "onDecision",
    "onBatchDecision",
    "onBlocked",
    "onMappingError",
    "onStep",
  ] as const) {
    const issue = validateOptionalFunction(hook, options[hook]);
    if (issue) issues.push(issue);
  }
  const signalIssue = validateOptionalSignal(options.signal);
  if (signalIssue) issues.push(signalIssue);
  const timeoutIssue = validateOptionalTimeout(options.timeoutMs);
  if (timeoutIssue) issues.push(timeoutIssue);
  throwAdapterConfigError("mcp", issues);

  // `throwAdapterConfigError` guarantees a usable server and tools from here.
  const registrar = server as McpToolRegistrar;
  const descriptors: GuardedMcpToolDescriptor[] = definitions.map((definition) => {
    const handler = guardMcpToolHandler(definition.name, definition.handler, options);
    const registration = registrar.registerTool(definition.name, definition.config, handler);
    return {
      name: definition.name,
      handler,
      originalHandler: definition.handler,
      config: definition.config,
      registration,
    };
  });

  let closed = false;
  return {
    tools: descriptors,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const unregister = registrar.unregisterTool;
      if (typeof unregister !== "function") return;
      for (const descriptor of descriptors) await unregister.call(registrar, descriptor.name);
    },
  };
}

/**
 * Wrap a client's `callTool` so the guard decides before the request is sent.
 *
 * This is the same boundary read from the other side: an MCP client that owns
 * the tool-call egress can refuse locally and never put the request on the
 * wire. A non-fund-moving tool passes straight through.
 */
export function guardMcpCallTool<T extends McpToolResult>(
  callTool: McpCallTool<T>,
  options: McpGuardOptions,
): McpCallTool<T | McpToolResult> {
  return (request) => guardMcpRequest(request, () => callTool(request), options);
}

/**
 * Human- and model-readable refusal text. MCP results are model-visible, so the
 * wording mirrors the other adapters': name the tool, quote the contract reason
 * and its explanation, and state that nothing was submitted.
 */
function describeMcpRefusal(
  decision: PreFlightDecision & { allowed: false },
  toolName: string,
): string {
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
