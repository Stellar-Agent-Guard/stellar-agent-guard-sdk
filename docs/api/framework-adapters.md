# Framework Adapters API

The SDK provides plug-and-play middleware for AI agent orchestration frameworks.

## LangChain

```ts
import { createLangChainGuardMiddleware } from "stellar-agent-guard-sdk";

const middleware = createLangChainGuardMiddleware({
  interceptor,
  toContractCall: (request) => ({
    contractId: request.args.contractId,
    method: request.args.method,
    args: request.args.args,
  }),
});
```

Halts execution by returning without calling `handler(request)` if the interceptor blocks the planned action.

## ElizaOS

```ts
import { createGuardValidator } from "stellar-agent-guard-sdk";

const validate = createGuardValidator({
  interceptor,
  toContractCall: (message) => ({
    contractId: message.content.contractId,
    method: message.content.method,
    args: message.content.args,
  }),
});
```

Returns `false` from the action validator if the interceptor refuses the call, filtering the action out before execution.

## Vercel AI SDK

The AI SDK's language-model middleware sees tool calls only after the model has
already emitted them, so this adapter guards at the earliest pre-execution point
the SDK owns: the tool's own `execute` function (`ai` ≥ 4.1 / 5.x document
exactly this "wrap the tool function" pattern; tested against that structural
`Tool` shape).

```ts
import { createVercelAIGuard } from "stellar-agent-guard-sdk";

const guard = createVercelAIGuard({
  interceptor,
  toContractCall: ({ toolName, input }) =>
    toolName === "send_payment" ? toTransferCall(input) : null,
});

const sendPayment = guard("send_payment", {
  description: "Send SAC tokens from the guarded account",
  execute: async (input) => /* submit and return a result */ { ... },
});

// Pass `sendPayment` to generateText / streamText tools, or wrap it inside
// wrapLanguageModel's tool-wrapping hook — the guard verdict is decided before
// execute ever runs, in both placements.
```

Verdict → halt semantics, shared across all three adapters:

| Verdict | LangChain | ElizaOS | Vercel AI SDK |
|---|---|---|---|
| `admissible` | tool runs | validate returns `true` | tool `execute` runs |
| `blocked` | error `ToolMessage`, tool never entered | validate returns `false` | throws `GuardBlockedError` before `execute` |
| `undetermined` | error `ToolMessage`, tool never entered | validate returns `false` (fails closed) | throws `PreFlightUndeterminedError` before `execute` |

Throwing on refusal is deliberate here: the AI SDK renders a thrown tool error
into its error stream, and a blocked call must not produce a tool *result* the
model could read as success. `ai` is an optional peer capability — the adapter
is written structurally, so the SDK takes no dependency on the `ai` package.
