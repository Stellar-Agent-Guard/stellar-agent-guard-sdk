# ElizaOS Action Validator Example — Pre-Flight Interception with Action Wiring

This document provides a full runnable example of integrating `stellar-agent-guard-sdk` with the ElizaOS runtime using `createGuardValidator` and `guardAction` (`Action.validate`).

## Version-Pinning & Verification Context

The ElizaOS adapter is built against the confirmed pre-execution blocking hook documented in [`docs/integration-hooks.md`](../integration-hooks.md) §2:
- **Repository:** `elizaOS/eliza`, `develop`
- **Pinned References:** `packages/core/src/types/components.ts` (blob `5f604e593854`) and `packages/core/src/runtime.ts` (blob `eb3f3fc98cef`)
- **Semantics:** The ElizaOS runtime executes `Action.validate(runtime, message, state, options)` before admitting an action to candidate execution. Returning `false` prevents the action from being selected or executed.

## Complete Runnable Example

The runnable implementation is maintained and typechecked in CI in [`examples/elizaos.ts`](../../examples/elizaos.ts):

```typescript
import { Address, Keypair, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import {
  PreFlightInterceptor,
  createGuardValidator,
  guardAction,
  type ContractCall,
  type ElizaActionLike,
} from "stellar-agent-guard-sdk";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const ALLOWED_RECIPIENT = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const BLOCKED_RECIPIENT = "GDZOKF3HGA6XSKIEEPJC5ANON3IJ5OGZMCX7GEGJLZN7JFRKOO4N2HXM";

// 1. Map ElizaOS message / state to Soroban ContractCall
function toContractCall(_message: unknown, state: unknown): ContractCall | null {
  const s = (state ?? {}) as { to?: string; amount?: string | number };
  if (!s.to || s.amount === undefined) return null;

  return {
    contract: TOKEN,
    fn: "transfer",
    args: [
      new Address(GUARD).toScVal(),
      new Address(s.to).toScVal(),
      nativeToScVal(BigInt(s.amount), { type: "i128" }),
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

// 3. Define and wrap base ElizaOS action
const baseAction: ElizaActionLike = {
  name: "TRANSFER_FUNDS",
  validate: async (_runtime, _message, state) => {
    const s = (state ?? {}) as { to?: string; amount?: string | number };
    return Boolean(s.to && Number(s.amount) > 0);
  },
};

const action = guardAction(baseAction, {
  interceptor,
  toContractCall,
  onBlocked: (decision) => {
    if (decision.kind === "blocked") {
      console.warn(`[guard refusal] ${decision.reason}: ${decision.explanation}`);
    }
  },
});

// 4. Run 1: Allowed Action (returns true -> admitted to candidate pool)
const allowedVerdict = await action.validate(
  {},
  {},
  { to: ALLOWED_RECIPIENT, amount: "25" },
);
// allowedVerdict === true

// 5. Run 2: Blocked Action (returns false -> dropped by runtime)
const blockedVerdict = await action.validate(
  {},
  {},
  { to: BLOCKED_RECIPIENT, amount: "1500" },
);
// blockedVerdict === false
```

## Expected Output

### Allowed Run
```text
validate() => true (action admitted to execution set)
```

### Blocked Run (Captured via `onBlocked`)
```text
[guard refusal] per_tx_cap_exceeded: The transfer amount exceeds the per-transaction spend limit configured for this account.
validate() => false (action excluded from candidate pool)
```

## Fail-Closed Undetermined Path

If pre-flight simulation encounters an RPC error, connection failure, or undetermined status, `createGuardValidator` fails closed by returning `false`. The action is filtered out of the execution set, guaranteeing that unverified transactions are never executed.
