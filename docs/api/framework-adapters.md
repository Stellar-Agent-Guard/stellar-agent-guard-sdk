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

When the interceptor returns an `undetermined` verdict, the LangChain middleware returns an error `ToolMessage` (as it does for `blocked`) whose content carries the verdict's `detail`, and the tool body is never entered. It never throws for a guard verdict.

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
When the interceptor returns an `undetermined` verdict, the ElizaOS validator returns `false` (fail-closed) and emits the verdict's `cause` through the validator's context so the runtime can surface it.

## Verdict handling parity

Both adapters consume the same interceptor verdicts but map them to different return shapes. The shared test harness in `tests/integration/adapters.test.ts` drives a single verdict-fixture table through both adapters and asserts the documented behavior below.

| Verdict                         | LangChain middleware                                                                           | ElizaOS validator                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `admissible`                      | Calls `handler(request)` and returns its result (pass).                                                  | Returns `true` and the action proceeds to execution (pass).                                                  |
| `blocked(reason)`                 | Returns without calling `handler(request)`; the block message carries the verdict's `reason` (halt-with-message). | Returns `false`; the action is filtered out and the validator context carries the verdict's `reason` (halt-with-message).  |
| `undetermined(cause)`              | Returns an error `ToolMessage` carrying the verdict's `detail`; the tool body never runs (halt-with-message).            | Returns `false` (fail-closed); `onBlocked` surfaces `undetermined` (halt-with-message). |

Adapter-specific mapping errors (e.g. `toContractCall` returning `null` or a malformed call) are covered by the same test file and follow the documented behavior for each adapter: a `null` call means the action moves no funds, so it is passed through untouched.

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
