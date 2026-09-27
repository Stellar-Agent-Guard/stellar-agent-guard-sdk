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

## Event identity

Every decoded `GuardEvent` carries a stable, non-null `id` on both streams:

- `ledger:<txHash>:<topic>` for a committed event;
- `diag:<sha256>` for a diagnostic (blocked) event, which has no transaction to
  anchor on because it was rolled back before broadcast.

The same event re-parsed yields the same id; two different blocks within one
simulation yield different ids. Format and collision notes:
[`docs/event-schema.md`](../event-schema.md#event-identity--guardeventid).
