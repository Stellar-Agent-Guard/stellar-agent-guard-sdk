# Invoke Pipeline API

## `invoke(options: InvokeOptions): Promise<InvokeResult>`

Executes an end-to-end transaction through the guard:
1. Runs probe simulation to collect required authorization entries.
2. Signs authorization entries with the agent signer (`GuardAuthorization.agent`:
   an `AgentSigner`, or a plain Ed25519 `Keypair` for the single-key default).
3. Runs enforced simulation through `__check_auth`.
4. Assembles transaction envelope and submits to Soroban RPC.
5. Handles transient `scecExceededLimit` ledger resource errors with bounded retry.

Returns discriminated union: `{ status: "SUCCESS", txHash, ... }` or `{ status: "BLOCKED", reason }`.
