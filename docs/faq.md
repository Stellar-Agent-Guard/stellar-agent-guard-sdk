# Frequently Asked Questions (FAQ)

### Does pre-flight interception incur network transaction fees?
No. Pre-flight interception uses Soroban RPC simulation. Blocked transactions are rejected client-side before broadcast and incur zero transaction fees.

### What happens if the dead-man switch triggers>
If the agent fails to send a heartbeat within the configured grace period, the contract transitions to frozen status. The account can be restored via `unfreeze()` signed by the admin or a valid `heartbeat()` from the agent key.

### Can the guard intercept arbitrary DeFi calls?
Yes, for contract/function allowlists and active window gating. Full per-call amount enforcement is currently native to SAC token transfers due to Soroban auth context introspection boundaries.
