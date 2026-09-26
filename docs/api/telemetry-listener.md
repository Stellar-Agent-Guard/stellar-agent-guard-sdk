# GuardTelemetryListener API

`GuardTelemetryListener` monitors on-chain events emitted by a guard contract.

## Constructor

```ts
constructor(options: GuardTelemetryListenerOptions)
```

### Options

- `server: rpc.Server` — Soroban RPC server
- `guard: string` — Guard contract address
- `cursorStore?: CursorStore` — Where `watch()` persists its cursor across
  polls and process restarts. Default: `in-memory`, which means **no** resume
  after restart. See [Cursor persistence](#cursor-persistence-cursorstore).

## Methods

### `watch(params?): AsyncIterable<GuardEvent[]>`

Yields pages of decoded guard events (`event_auth_checked`, `event_policy_updated`, etc.).

## Event identity

Every decoded `GuardEvent` carries a stable, non-null `id` on both streams:

- `ledger:<txHash>:<topic>` for a committed event;
- `diag:<sha256>` for a diagnostic (blocked) event, which has no transaction to
  anchor on because it was rolled back before broadcast.

The same event re-parsed yields the same id; two different blocks within one
simulation yield different ids. Format and collision notes:
[`docs/event-schema.md`](../event-schema.md#event-identity--guardeventid).
