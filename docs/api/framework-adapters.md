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

When the interceptor returns an `undetermined` verdict, the LangChain middleware throws a `GuardUndeterminedError` carrying the verdict's `cause`, so the caller must handle the fail-closed signal explicitly.

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
| `undetermined(cause)`              | Throws a `GuardUndeterminedError` carrying the verdict's `cause` (throw).                                                | Returns `false` (fail-closed) and surfaces the verdict's `cause` through the validator context (halt-with-message). |

Adapter-specific mapping errors (e.g. `toContractCall` returning `null` or a malformed call) are covered by the same harness and follow the documented behavior for each adapter.
