# LangChain Middleware Example — Pre-Flight Interception with Fake Tool

This document provides a full runnable example of integrating `stellar-agent-guard-sdk` with LangChain using `createLangChainGuardMiddleware` (`AgentMiddleware.wrap_tool_call`).

The middleware intercepts tool calls before execution:
- **Allowed calls**: continue through to the tool handler, executing signing and submission normally.
- **Blocked calls**: halt immediately without entering the tool handler, returning a structured `ToolMessage` with status `error`, quoting the contract's reason code and explanation. Zero transaction fees are incurred and no state is mutated on-chain.
- **Undetermined calls**: fail closed without execution, preventing unsanctioned state changes.

## Complete Runnable Example

The runnable implementation is maintained and typechecked in CI in [`examples/langchain.ts`](../../examples/langchain.ts):

```typescript
import { Address, Keypair, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import {
  PreFlightInterceptor,
  createLangChainGuardMiddleware,
  type ContractCall,
  type LangChainToolCallRequest,
} from "stellar-agent-guard-sdk";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const ALLOWED_RECIPIENT = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const BLOCKED_RECIPIENT = "GDZOKF3HGA6XSKIEEPJC5ANON3IJ5OGZMCX7GEGJLZN7JFRKOO4N2HXM";

// 1. Map tool call request to Soroban ContractCall
function toContractCall(request: LangChainToolCallRequest): ContractCall | null {
  const { name, args } = request.toolCall;
  if (name !== "transfer_tokens") return null;

  const toolArgs = args as { from?: string; to?: string; amount?: string | number };
  if (!toolArgs.to || toolArgs.amount === undefined) return null;

  return {
    contract: TOKEN,
    fn: "transfer",
    args: [
      new Address(toolArgs.from ?? GUARD).toScVal(),
      new Address(toolArgs.to).toScVal(),
      nativeToScVal(BigInt(toolArgs.amount), { type: "i128" }),
    ],
  };
}

// 2. Initialize interceptor
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const interceptor = new PreFlightInterceptor({
  server,
  networkPassphrase: "Test SDF Network ; September 2015",
  guard: GUARD,
  agent: Keypair.fromSecret(process.env.AGENT_SECRET!),
  source: Keypair.fromSecret(process.env.SOURCE_SECRET!),
});

// 3. Create LangChain guard middleware
const middleware = createLangChainGuardMiddleware({
  interceptor,
  toContractCall,
  onDecision: (req, decision) => {
    console.log(`[guard telemetry] ${req.toolCall.name} => ${decision.kind}`);
  },
});

// 4. Run 1: Allowed Transfer
const allowedResult = await middleware.wrapToolCall(
  {
    toolCall: {
      name: "transfer_tokens",
      id: "call_1",
      args: { from: GUARD, to: ALLOWED_RECIPIENT, amount: "50" },
    },
  },
  async (req) => {
    // Tool body executes
    return { content: `Transferred ${req.toolCall.args["amount"]} tokens successfully` };
  },
);

// 5. Run 2: Blocked Transfer (violates policy allowlist)
const blockedResult = await middleware.wrapToolCall(
  {
    toolCall: {
      name: "transfer_tokens",
      id: "call_2",
      args: { from: GUARD, to: BLOCKED_RECIPIENT, amount: "500" },
    },
  },
  async (_req) => {
    // Tool body is NEVER entered
    throw new Error("This code is unreachable");
  },
);
```

## Expected Output

### Allowed Run
```json
{
  "content": "Transferred 50 tokens successfully"
}
```

### Blocked Run (Quoting Contract Reason + Explanation)
```text
stellar-agent-guard blocked 'transfer_tokens': recipient_not_allowed — The recipient address is not in the policy's allowlist.
No transaction was submitted, so nothing was spent and no fee was paid.
```

The returned object has structure:
```json
{
  "name": "stellar-agent-guard",
  "tool_call_id": "call_2",
  "status": "error",
  "content": "stellar-agent-guard blocked 'transfer_tokens': recipient_not_allowed — The recipient address is not in the policy's allowlist.\nNo transaction was submitted, so nothing was spent and no fee was paid."
}
```

## Fail-Closed Undetermined Path

If the RPC simulation fails due to connectivity loss, simulation error, or undetermined conditions, `PreFlightInterceptor` emits `kind: "undetermined"`. The middleware halts execution and returns an error tool message:

```text
stellar-agent-guard could not determine whether 'transfer_tokens' is permitted; it was not executed.
<detail>
```

This ensures that the agent never executes unverified financial operations in degraded network scenarios.
