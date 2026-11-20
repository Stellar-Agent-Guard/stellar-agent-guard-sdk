/**
 * Drift guard for `examples/mcp-server.ts` (issue #481).
 *
 * Importing the example compiles it (tsx), and `npm run typecheck` covers it
 * through `examples/**`. The tests below exercise the registered handler with
 * a fake interceptor — so the server wiring, the JSON-RPC envelope and the
 * `isError` refusal shape cannot drift from the adapter — and then run the
 * full example against its mock RPC server.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PreFlightDecision, PreFlightInterceptor } from "../../src/index.ts";
import {
  connectInMemory,
  createGuardedMcpServer,
  runMcpServerExample,
} from "../../examples/mcp-server.ts";
import { ALLOWED_RECIPIENT } from "../../examples/mcp.ts";

function fakeInterceptor(decision: PreFlightDecision): PreFlightInterceptor {
  return { check: async () => decision } as unknown as PreFlightInterceptor;
}

const ADMISSIBLE: PreFlightDecision = {
  allowed: true,
  kind: "admissible",
  estimatedResourceFee: 150n,
  footprintKeys: 2,
};

const BLOCKED: PreFlightDecision = {
  allowed: false,
  kind: "blocked",
  reason: "per_tx_cap_exceeded",
  explanation: "the amount exceeds the policy's per-transaction cap",
  detail: "simulation returned the blocked diagnostic",
  diagnosticEvents: [],
};

const callArgs = { name: "transfer_tokens", arguments: { to: ALLOWED_RECIPIENT, amount: "50" } };

describe("MCP server example (issue #481)", () => {
  it("lists the guarded tool with its input schema", async () => {
    const { server } = createGuardedMcpServer({ interceptor: fakeInterceptor(ADMISSIBLE) });
    const res = await connectInMemory(server)("tools/list");
    const tools = (res.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "transfer_tokens");
    assert.ok(tools[0]!.inputSchema);
  });

  it("runs the handler on an admissible verdict", async () => {
    const { server, handlerCalls } = createGuardedMcpServer({
      interceptor: fakeInterceptor(ADMISSIBLE),
    });
    const res = await connectInMemory(server)("tools/call", callArgs);
    assert.equal(res.error, undefined);
    assert.deepEqual(res.result, { content: [{ type: "text", text: "transferred 50" }] });
    assert.equal(handlerCalls.length, 1);
  });

  it("returns an isError result and never enters the handler on a blocked verdict", async () => {
    const blocked: string[] = [];
    const { server, handlerCalls } = createGuardedMcpServer({
      interceptor: fakeInterceptor(BLOCKED),
      onBlocked: (info) => blocked.push(info.reason ?? info.kind),
    });
    const res = await connectInMemory(server)("tools/call", callArgs);
    const result = res.result as { isError?: boolean; content: Array<{ text?: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /per_tx_cap_exceeded/);
    assert.equal(handlerCalls.length, 0);
    // onBlocked is fire-and-forget; let it settle.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(blocked, ["per_tx_cap_exceeded"]);
  });

  it("answers unknown tools and methods with JSON-RPC errors", async () => {
    const { server } = createGuardedMcpServer({ interceptor: fakeInterceptor(ADMISSIBLE) });
    const request = connectInMemory(server);
    assert.equal((await request("tools/call", { name: "nope" })).error?.code, -32602);
    assert.equal((await request("resources/list")).error?.code, -32601);
  });

  it("runs end to end against the example's mock RPC server", async () => {
    const res = await runMcpServerExample();
    assert.deepEqual(
      res.tools.map((t) => t.name),
      ["transfer_tokens"],
    );
    assert.equal(res.admissible.isError, undefined);
    assert.equal(res.admissible.content[0]?.text, "transferred 50");
    assert.equal(res.blocked.isError, true);
    assert.match(res.blocked.content[0]?.text ?? "", /recipient_not_allowed/);
    assert.equal(res.handlerCalls.length, 1, "only the admissible call reaches the handler");
  });
});
