/**
 * MCP Server Example — a complete, runnable server that registers one guarded
 * tool and serves it over an in-memory JSON-RPC transport (issue #481).
 *
 * `examples/mcp.ts` shows the adapter wrappers in isolation. This file shows
 * the whole server-side shape an MCP author has to assemble:
 *
 *  1. a server object with `registerTool(name, config, handler)` — the v2
 *     `@modelcontextprotocol/server` registration shape (see
 *     `docs/integration-hooks.md` §4);
 *  2. one fund-moving tool registered through `guardMcpToolHandler`, so the
 *     pre-flight verdict is decided before the handler body can run;
 *  3. a transport that carries JSON-RPC 2.0 `tools/list` and `tools/call`
 *     messages — in memory here, so the example needs no network, no stdio
 *     pipe and no credentials;
 *  4. one admissible call (handler runs, normal result) and one blocked call
 *     (handler never runs, `isError: true` result carrying the refusal text).
 *
 * Dependency stance: the MCP SDK stays an optional peer of *your* server. The
 * `MinimalMcpServer` below is a structural stand-in with the same
 * `registerTool` signature; with the real SDK installed, swap it for
 * `new McpServer({ name, version })` and connect a `StdioServerTransport` —
 * the guarded handler is passed to `registerTool` unchanged. Neither
 * `@modelcontextprotocol/sdk` nor `@modelcontextprotocol/server` is a
 * dependency of this package.
 *
 * Run it:
 *   node --import tsx examples/mcp-server.ts
 */
import { Keypair, type rpc } from "@stellar/stellar-sdk";
import {
  PreFlightInterceptor,
  guardMcpToolHandler,
  type GuardBlockedInfo,
  type McpToolHandler,
  type McpToolResult,
} from "../src/index.ts";
import {
  ALLOWED_RECIPIENT,
  BLOCKED_RECIPIENT,
  EXAMPLE_GUARD,
  createMockRpcServer,
  toContractCall,
} from "./mcp.ts";

/** Tool metadata as `tools/list` reports it. */
export interface ToolConfig {
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A JSON-RPC 2.0 request as an MCP client sends it. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** A JSON-RPC 2.0 response. Exactly one of `result` / `error` is set. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * The smallest server that matches the MCP registration shape: tools are
 * registered by name, `tools/list` enumerates them, and `tools/call` invokes
 * the registered handler with the call's arguments and returns its result.
 */
export class MinimalMcpServer {
  private readonly tools = new Map<string, { config: ToolConfig; handler: McpToolHandler }>();

  constructor(readonly info: { name: string; version: string }) {}

  registerTool(name: string, config: ToolConfig, handler: McpToolHandler): void {
    if (this.tools.has(name)) throw new Error(`tool already registered: ${name}`);
    this.tools.set(name, { config, handler });
  }

  /** Handle one JSON-RPC request — what a transport calls per message. */
  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (request.method === "tools/list") {
      const tools = [...this.tools].map(([name, { config }]) => ({ name, ...config }));
      return { jsonrpc: "2.0", id: request.id, result: { tools } };
    }
    if (request.method === "tools/call") {
      const name = request.params?.name;
      const tool = typeof name === "string" ? this.tools.get(name) : undefined;
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: `unknown tool: ${String(name)}` },
        };
      }
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      return { jsonrpc: "2.0", id: request.id, result: await tool.handler(args) };
    }
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `method not found: ${request.method}` },
    };
  }
}

/**
 * An in-memory client transport: each request is serialised and parsed, as it
 * would be on a stdio pipe, so nothing shares object identity across the
 * boundary. Swap for `StdioServerTransport` with the real SDK.
 */
export function connectInMemory(server: MinimalMcpServer) {
  let nextId = 1;
  return async (method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> => {
    const wire = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });
    const response = await server.handle(JSON.parse(wire) as JsonRpcRequest);
    return JSON.parse(JSON.stringify(response)) as JsonRpcResponse;
  };
}

/**
 * Build the server with one guarded tool. `interceptor` is injected so tests
 * (and your own host) can supply a fake or a real `PreFlightInterceptor`.
 */
export function createGuardedMcpServer(options: {
  interceptor: PreFlightInterceptor;
  onBlocked?: (info: GuardBlockedInfo) => void;
}) {
  const server = new MinimalMcpServer({ name: "guarded-wallet", version: "0.1.0" });
  const handlerCalls: Array<Record<string, unknown>> = [];

  server.registerTool(
    "transfer_tokens",
    {
      description: "Transfer SAC tokens from the guarded account",
      inputSchema: {
        type: "object",
        properties: { to: { type: "string" }, amount: { type: "string" } },
        required: ["to", "amount"],
      },
    },
    guardMcpToolHandler(
      "transfer_tokens",
      async (args): Promise<McpToolResult> => {
        // The real tool body would sign and submit the transfer here. It runs
        // only after an `admissible` verdict.
        handlerCalls.push(args);
        return { content: [{ type: "text", text: `transferred ${String(args.amount)}` }] };
      },
      {
        interceptor: options.interceptor,
        toContractCall,
        ...(options.onBlocked ? { onBlocked: options.onBlocked } : {}),
      },
    ),
  );

  return { server, handlerCalls };
}

/** Run one admissible and one blocked `tools/call` through the server. */
export async function runMcpServerExample(interceptorOverride?: PreFlightInterceptor) {
  const interceptor =
    interceptorOverride ??
    new PreFlightInterceptor({
      server: createMockRpcServer() as rpc.Server,
      networkPassphrase: "Test SDF Network ; September 2015",
      guard: EXAMPLE_GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
    });

  const blockedInfos: GuardBlockedInfo[] = [];
  const { server, handlerCalls } = createGuardedMcpServer({
    interceptor,
    onBlocked: (info) => blockedInfos.push(info),
  });
  const request = connectInMemory(server);

  const listed = await request("tools/list");
  const admissible = await request("tools/call", {
    name: "transfer_tokens",
    arguments: { to: ALLOWED_RECIPIENT, amount: "50" },
  });
  const blocked = await request("tools/call", {
    name: "transfer_tokens",
    arguments: { to: BLOCKED_RECIPIENT, amount: "500" },
  });

  return {
    tools: (listed.result as { tools: Array<{ name: string }> }).tools,
    admissible: admissible.result as McpToolResult,
    blocked: blocked.result as McpToolResult,
    handlerCalls,
    blockedInfos,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpServerExample().then((res) => {
    console.log("=== MCP Server Example ===");
    console.log("tools/list:", res.tools.map((t) => t.name).join(", "));
    console.log("[admissible] result:", JSON.stringify(res.admissible));
    console.log("[blocked]    result:", JSON.stringify(res.blocked));
    console.log("handler ran for:", res.handlerCalls.length, "call(s)");
  });
}
