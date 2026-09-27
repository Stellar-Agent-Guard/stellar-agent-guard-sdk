# GuardTelemetryListener API

`GuardTelemetryListener` monitors on-chain events emitted by a guard contract.

## Constructor

```ts
constructor(options: GuardTelemetryListenerOptions)
```

### Options

- `server: rpc.Server` — Soroban RPC server
- `guard: string` — Guard contract address
- `failedTx?: boolean` — opt-in: also surface diagnostics from transactions that were broadcast, included in a ledger, and then failed on-chain, as GuardEvents with `stream: "failed_tx"` (default off). The scan follows its own `getTransactions` cursor and cannot skip or advance the committed `getEvents` cursor; see `docs/event-schema.md` for the spike evidence and semantics.

## Methods

### `watch(signal?: AbortSignal): AsyncIterable<GuardEventPage>`

Yields pages of decoded guard events (`event_auth_checked`, `event_policy_updated`, etc.).
