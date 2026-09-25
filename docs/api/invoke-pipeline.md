# Invoke Pipeline API

## `invoke(options: InvokeOptions): Promise<InvokeResult>`

Executes an end-to-end transaction through the guard:
1. Runs probe simulation to collect required authorization entries.
2. Signs authorization entries with the agent key.
3. Runs enforced simulation through `__check_auth`.
4. Assembles transaction envelope and submits to Soroban RPC.
5. Handles transient `scecExceededLimit` ledger resource errors with bounded retry.
6. Handles minimum-fee broadcast rejections (`tx_insufficient_fee` / "tx too cheap") with bounded fee-bump retry.

Returns discriminated union: `{ kind: "allowed", submission, ... }`, `{ kind: "blocked", reason, ... }`, or `{ kind: "error", detail, ... }` (or throws/returns `BroadcastError` on retry exhaustion).

### Fee-Bump Configuration (`feeBump`)

When network fee conditions change between prepare-time and broadcast, core may reject a transaction with a minimum-fee failure. The pipeline can automatically retry with an increased fee:

```typescript
const outcome = await invoke({
  server,
  source,
  call,
  networkPassphrase,
  feeBump: {
    maxAttempts: 3,        // Maximum attempts before returning BroadcastError (default: 3)
    feeMultiplier: 2,      // Multiplier applied to inclusion fee per retry (default: 2)
    initialInclusionFee: 100n, // Base inclusion fee in stroops (default: 100 stroops)
  },
});
```

* **What it controls**: Controls bounded fee-increase retries when broadcast fails due to minimum-fee / "tx too cheap" rejections (`tx_insufficient_fee`).
* **Default behavior**: Enabled by default with up to 3 attempts, a 2x fee multiplier, and base inclusion fee of 100 stroops.
* **How attempts are bounded**: Configured via `maxAttempts` (default: 3) or overall `maxRetries`. When exhausted, returns a typed `BroadcastError` containing attempt count and the last attempted fee.
* **How the fee multiplier works**: On each retry, the inclusion fee is scaled by `feeMultiplier` (e.g. 100 stroops → 200 stroops → 400 stroops) and re-added to the simulated resource fee.
* **Guard and Simulation Invariant**: **Every fee-bump attempt is re-prepared, re-simulated, and re-evaluated by the guard policy.** A fee bump NEVER bypasses simulation or guard enforcement. If re-simulation causes a policy block, the policy block is immediately surfaced and the transaction is never broadcast.
