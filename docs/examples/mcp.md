# MCP Adapter Example — Guarding a Model Context Protocol Tool Call

This document shows how to integrate `stellar-agent-guard-sdk` with a Model
Context Protocol server (or client), so a fund-moving tool is checked **before**
its handler runs.

## Version-Pinning & Verification Context

The adapter is built against the pre-execution hooks confirmed in
[`docs/integration-hooks.md`](../integration-hooks.md) §4. Both published
generations of the TypeScript SDK were reviewed:

- **v2** (`@modelcontextprotocol/server`, spec `2026-07-28`): `server.registerTool(name, config, handler)`
  — `modelcontextprotocol/typescript-sdk` `main`, `README.md` blob `6d5e2328efd2fc4493731b4e4cfd2e117ad1e28d`.
- **v1** (legacy; `@modelcontextprotocol/sdk` 1.30.1): `server.tool(name, schema, handler)` and
  `server.setRequestHandler(CallToolRequestSchema, handler)` —
  `modelcontextprotocol/typescript-sdk` `v1.x`, `README.md` blob `2d2f19ae376bee6081437c4d6f8e251bf3fd3ce5`.

In both, the registered handler is invoked only after a client sends `tools/call`,
and the handler's return value is the tool result. Returning a refusal **without
calling the handler** means the tool body never runs. `Client.callTool({ name,
arguments })` is the matching pre-egress point on the client side.

The SDK is written structurally against these shapes, so neither package is a
dependency of this SDK.

## Complete Runnable Example

The runnable implementation is maintained and typechecked in CI in
[`examples/mcp.ts`](../../examples/mcp.ts):

```typescript
import { Address, Keypair, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import {
  PreFlightInterceptor,
  guardMcpCallTool,
  guardMcpToolHandler,
  type ContractCall,
  type McpToolCallRequest,
} from "stellar-agent-guard-sdk";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";

// 1. Map the tool call to the guarded contract call it would make.
function toContractCall(request: McpToolCallRequest): ContractCall | null {
  if (request.name !== "transfer_tokens") return null;
  const args = request.arguments as { to?: string; amount?: string | number };
  if (!args.to || args.amount === undefined) return null;

  return {
    contract: TOKEN,
    fn: "transfer",
    args: [
      new Address(GUARD).toScVal(),
      new Address(args.to).toScVal(),
      nativeToScVal(BigInt(args.amount), { type: "i128" }),
    ],
  };
}

// 2. Initialize the interceptor.
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const interceptor = new PreFlightInterceptor({
  server,
  networkPassphrase: "Test SDF Network ; September 2015",
  guard: GUARD,
  agent: Keypair.fromSecret(process.env.AGENT_SECRET!),
  source: Keypair.fromSecret(process.env.SOURCE_SECRET!),
});

// 3. Server side: wrap the registered tool handler.
const guardedTransfer = guardMcpToolHandler(
  "transfer_tokens",
  async (args) => {
    // The real tool body: sign and broadcast the transfer.
    return { content: [{ type: "text", text: `transferred ${args.amount}` }] };
  },
  {
    interceptor,
    toContractCall,
    // Operator alerting; a throwing callback is logged, never fatal.
    onBlocked: ({ adapter, kind, reason, explanation }) => {
      console.warn(`[${adapter}] ${kind}: ${reason ?? "undetermined"} — ${explanation}`);
    },
  },
);

// 4. Client side (optional): refuse before the request leaves the process.
const callTool = guardMcpCallTool(myClient.callTool.bind(myClient), {
  interceptor,
  toContractCall,
});
```

## Blocked Result

A refusal is returned in MCP's own error-result form, so the model sees it as a
tool failure rather than a silent success or a crash:

```json
{
  "content": [
    {
      "type": "text",
      "text": "stellar-agent-guard blocked 'transfer_tokens': recipient_not_allowed — The transfer recipient is not in the policy's recipients allowlist.\nNo transaction was submitted, so nothing was spent and no fee was paid."
    }
  ],
  "isError": true
}
```

## Fail-Closed Undetermined Path

If enforcement cannot reach a decision (RPC failure, simulation error), the
adapter still refuses: the result is `isError: true` with the failure detail, and
the tool body never runs. Use `onBlocked` to tell the two apart — `kind` is
`"blocked"` when the guard refused and `"undetermined"` when it could not rule.
