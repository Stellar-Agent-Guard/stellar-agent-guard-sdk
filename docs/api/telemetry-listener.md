# GuardTelemetryListener API

`GuardTelemetryListener` monitors on-chain events emitted by a guard contract.

## Constructor

```ts
constructor(options: GuardTelemetryListenerOptions)
```

### Options

- `server: rpc.Server` — Soroban RPC server
- `guard: string` — Guard contract address
- `buffer?: { max: number }` — opt in to retaining the most recent `max` events for `recent()` snapshots (issue #68). Omitted → no buffer is allocated and `recent()` always returns `[]`.

## Methods

### `recent(filter?): GuardEvent[]`

The retained window of most-recent decoded events, oldest first, empty unless a
`buffer` was configured. `filter` narrows by `stream`, `reason`, `fromLedger`, or
`toLedger`; a ledger-less diagnostic event is excluded from a ledger range rather
than treated as inside it. Non-durable: the window lives in process memory and a
restart empties it. Only events this listener decoded are retained — committed
events via `poll()`/`watch()`, and diagnostic events via `watchAll()`.

### `watch(params?): AsyncIterable<GuardEventPage>`

Yields pages of decoded guard events (`event_auth_checked`, `event_policy_updated`, etc.).
Parameters include `startLedger`, `cursor`/`resumeLedger`, `pollIntervalMs`, `limit`,
`jitter`, `rng`, `sleep`, `onGap`, and `signal`.

#### Aborting (`signal`)

Aborting ends the stream as a normal exit, never a throw:

- an abort before the first pull issues no RPC call at all — not even the
  `getLatestLedger` probe that resolves a default `startLedger`;
- an abort between pages prevents the next poll and does not serve out the
  remaining poll delay (the default delay's timer is cleared, so no handle is
  left open);
- an abort while a request is in flight lets that request's rejection go
  quietly as teardown instead of surfacing an `AbortError` or an unhandled
  rejection.

**In-flight requests are not cancelled.** `@stellar/stellar-sdk` ^17 exposes
`getEvents(request: Api.GetEventsRequest)` with no `AbortSignal` parameter, so
there is no supported way to cancel a request that has already been sent. The
worst case between `signal.abort()` and the iterator ending is therefore **one
request duration**, never a full poll interval. The README's
[“Aborting a watch”](../../README.md#aborting-a-watch-what-cancellation-does-and-does-not-cover)
section states the same boundary for consumers.

## Event identity

Every decoded `GuardEvent` carries a stable, non-null `id` on both streams:

- `ledger:<txHash>:<topic>` for a committed event;
- `diag:<sha256>` for a diagnostic (blocked) event, which has no transaction to
  anchor on because it was rolled back before broadcast.

The same event re-parsed yields the same id; two different blocks within one
simulation yield different ids. Format and collision notes:
[`docs/event-schema.md`](../event-schema.md#event-identity--guardeventid).
