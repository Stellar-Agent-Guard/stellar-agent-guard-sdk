# GuardTelemetryListener API

`GuardTelemetryListener` monitors on-chain events emitted by a guard contract.

## Constructor

```ts
constructor(options: GuardTelemetryListenerOptions)
```

### Options

- `server: rpc.Server` — soroban RPC server
- `guard: string` — Guard contract address
- `counters?: { windowEvents?: number; windowMs?: number }` — opt-in sliding-window counters (default off)

## Methods

### `watch(params?): AsyncIterable<GuardEventPage>

Yields pages of decoded guard events (`event_auth_checked`, `event_policy_updated`, etc.).
Parameters include `startLedger`, `cursor`/`resumeLedger`, `pollIntervalM`, `limit`,
`jitter`, `rng`, `sleep`, `onGap`, and `signal`.

#### Aborting (`signal`)

Aborting ends the stream as a normal exit, never a throw:

- an abort before the first pull issues no RPC call at all — not even the
  `getLatestLedger` probe that resolves a default `startLedger;
-
  an abort between pages prevents the next poll and does not serve out the
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

### `stats(): CounterSnapshot | null`

When `counters` is configured, returns a snapshot of the sliding-window counters:

```ts
interface CounterSnapshot {
  allowed: number;
  blocked: number;
  byReason: Record<string, number>;
  windowStart: number;
  windowEvents?: number;
}
```

Counts are maintained over the configured window (`windowEvents` events or
`windowMs` milliseconds) and updated on every event from the unified stream.
The returned object is a deep snapshot: mutating it never affects the listener's
state. When `counters` is not set, `stats()` returns `null` and no counter
structures are allocated.

## Event identity

Every decoded `GuardEvent` carries a stable, non-null `id` on both streams:

-
  `ledger:<txHash>:<topic>` for a committed event;
- `diag:<sha256>` for a diagnostic (blocked) event, which has no transaction to
  anchor on because it was rolled back before broadcast.

The same event re-parsed yields the same id; two different blocks within one
simulation yield different ids. Format and collision notes:
[`docs/event-schema.md`](../event-schema.md#event-identity--guardeventid).
