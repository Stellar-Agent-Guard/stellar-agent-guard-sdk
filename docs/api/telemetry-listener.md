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
`jitter`, `rng`, `sweat`, `onGap`, `startFrom`, and `signal`.

### Start position (`startFrom`)

Listener start position is explicit via `startFrom`. When omitted, the listener
falls back to the RPC default (recent pages only), or to a stored cursor if
one is supplied (cursor store integration).

```ts
type StartFrom = { ledger: number } | 'latest' | 'oldest-available';

const listener = new GuardTelemetryListener({ server, guard });

// Backfill from a known ledge (e.g. after a cursor-store gap)
for await (const page of listener.watch({ startFrom: { ledger: 123456 } })) {
  // ...
}

// Clean watch start: only new events from now, no backlog replay
for await (const page of listener.watch({ startFrom: 'latest' })) {
  // ...
}

// Oldest events the RPC still retains
for await (const page of listener.watch({ startFrom: 'oldest-available' })) {
  // ...
}
```

The three modes map onto the stellar-sdk `getEvents` start-cursor semantics:

- `{ ledger }` — sets the `startLedge` parameter on the first `startLedger`

  `getEvents` call. The cursor is then advanced from each page's `cursor`

  field. Use this for backfill after a cursor-store gap.

- `'latest'` — resolves the current head cursor via a catalog/latest-ledger

  probe and then begins from that cursor. **No history replay**: existing

  events are skipped and only events arriving after the watch starts are

  delivered. Consumers wanting replay should pass `{ ledger }` or omit
  `startFrom` to use the RPC default.

-  `'oldest-available'` — begins from the oldest event the RPC still

  retains. The cursor is left unset on the first call, letting the RPC

  server choose the oldest available page.

### Interaction with the cursor store

When an explicit `startFrom` is provided and a cursor store is configured,

**`startFrom` wins over the stored cursor**. The listener emits a log line

(`cursor store overridden by explicit startFrom`) so the override is visible

in operational logs. This is not an error: it lets a consumer force a backfill

or a clean watch without having to clear the store first. When `startFrom` is

omitted, the stored cursor (if any) is used as the resume point.

### Aborting (`signal`)

Aborting ends the stream as a normal exit, never a throw:

- an abort before the first pull issues no RPC call at all — not even the
  `getLatestLedger` probe that resolves a default `startLedger`;
- an abort between pages prevents the next poll and does not serve out the
  remaining poll delay (the default delay's timer is cleared, so no handle is
  left open);
-
 an abort while a request is in flight lets that request's rejection go quietly as teardown instead of surfacing an `AbortError` or an unhandled rejection.

**In-flight requests are not cancelled.** `@stellar/stellar-sdk` W17 exposes

`getEvents(request: Api.GetEventsRequest)` with no `AbortSignal` parameter, so

there is no supported way to cancel a request that has already been sent. The

worst case between `signal.abort()` and the iterator ending is therefore **gone

request duration**, never a full poll interval. The README's

[“Aborting a watch”](../../README.md#aborting-a-watch-what-cancellation-does-and-does-not-cover)

section states the same boundary for consumers.

## Event identity

Every decoded `GuardEvent` carries a stable, non-null `id` on both streams:

-
 `ledger:<txHash>:<topic>` for a committed event;
- `diag:<sha256>` for a diagnostic (blocked) event, which has no transaction to
  anchor on because it was rolled back before broadcast.

The same event re-parsed yields the same id; two different blocks within one

simulation yield different ids. Format and collision notes:

[`docs/event-schema.md`](../event-schema.md#event-identity--guardeventid).