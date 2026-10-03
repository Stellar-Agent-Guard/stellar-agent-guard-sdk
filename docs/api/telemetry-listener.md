# GuardTelemetryListener API

`GuardTelemetryListener` monitors on-chain events emitted by a guard contract.

## Constructor

```ts
constructor(options: GuardTelemetryListenerOptions)
```

### Options

- `server: rpc.Server` — Soroban RPC server
- `guard: string` — Guard contract address
- `failedTx?: boolean` — opt in to failed-transaction diagnostics as a third event stream; defaults to `false`.
- `buffer?: { max: number }` — opt in to retaining the most recent `max` events for `recent()` snapshots (issue #68). Omitted → no buffer is allocated and `recent()` always returns `[]`.

## Methods

### `recent(filter?): GuardEvent[]`

The retained window of most-recent decoded events, oldest first, empty unless a
`buffer` was configured. `filter` narrows by `stream`, `reason`, `fromLedger`, or
`toLedger`; a ledger-less diagnostic event is excluded from a ledger range rather
than treated as inside it. Non-durable: the window lives in process memory and a
restart empties it. Only events this listener decoded are retained — committed
events via `poll()`/`watch()`, diagnostic events via `watchAll()`, and failed
transaction events via `pollFailedTransactions()` or `watch()` when `failedTx`
is enabled.

### `pollFailedTransactions(params?): Promise<FailedTxPollResult>`

Reads one page from the independent `getTransactions` cursor. Pass the returned
cursor on the next call; omitting it starts at the current RPC head, without
replaying older failures. Only failed transactions with diagnostics emitted by
the configured guard are returned. RPC errors leave a supplied cursor unchanged.

### `watch(params?): AsyncIterable<GuardEventPage>`

Yields pages of decoded guard events (`event_auth_checked`, `event_policy_updated`, etc.).
Set `failedTx: true` in the constructor options to include failed-transaction
diagnostics; this scan maintains its own cursor and does not advance the
committed event cursor.
Parameters include `startLedger`, `cursor`/`resumeLedger`, `pollIntervalMs`, `limit`,
`jitter`, `rng`, `sleep`, `onGap`, and `signal`.

#### Mid-watch failures (`onStreamError`)

When `getEvents` starts failing mid-watch, the default is **bounded retry with
backoff, then a clean end**: the listener retries up to `maxRetries` (default
`5`) times with exponential backoff, then calls `onStreamError(err)` exactly
once with the terminal error and completes the iterator normally. The stream
never dies silently and never leaves an unhandled rejection behind.

Failure-mode matrix:

| Failure | Retried? | `onStreamError` | Iterator |
| --- | --- | --- | --- |
| Transient (recovers within `maxRetries`) | yes | not called | continues |
| Persistent (retries exhausted) | yes, then gives up | called once with final error | ends normally |
| Abort (`signal`) | no | not called | ends immediately |

If no `onStreamError` is configured, retry-then-end still happens; the terminal
error is retrievable via the `lastError` getter for observability.

If the callback itself throws, that throw **propagates** out of the `for await`
loop — the consumer asked for halt-on-first-error semantics by supplying a
throwing callback, so it is not swallowed.

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

## Cursor persistence (`cursorStore`)

A guard monitor that restarts — an agent runtime redeploy, a crash — re-reads
from the default cursor unless its position survives the restart: it either
**re-emits history** or **skips the gap**, silently. `cursorStore` fixes that by
letting the cursor outlive the process:

```ts
interface CursorStore {
  /** The cursor to resume from, or `null` on first run. Consulted once, at start. */
  load(): Promise<string | null>;
  /** Persist the cursor advanced by one poll. Called once per poll. */
  save(cursor: string): Promise<void>;
}
```

- `load()` is consulted once, when `watch()` starts. A stored cursor wins over
  the default head position — resume-after-restart is exactly the case where
  "the default" is wrong.
- `save()` is called once per poll, **before** the page is yielded, so a
  consumer that stops after a page (crash, abort, throw) resumes from that
  page's cursor.
- An explicit `startLedger` passed to `watch()` pins the start and is not
  second-guessed by the store.
- The default store is in-memory (`InMemoryCursorStore`): no `cursorStore`
  means no resume across restarts.

### Durable wiring

The interface is two methods wide on purpose — wire it to anything that
outlives the process. File:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { GuardTelemetryListener, type CursorStore } from "stellar-agent-guard-sdk";

const fileCursorStore: CursorStore = {
  async load() {
    try {
      return await readFile("guard-cursor.txt", "utf8");
    } catch {
      return null; // first run: nothing persisted yet
    }
  },
  async save(cursor) {
    await writeFile("guard-cursor.txt", cursor, "utf8");
  },
};

const listener = new GuardTelemetryListener({
  server,
  guard: GUARD_CONTRACT_ID,
  cursorStore: fileCursorStore,
});
```

Redis is the same shape (`GET`/`SET` on one key), as is a single-row database
table. Whatever the backend, the cursor is one opaque string — store it
verbatim, do not parse it.

### Delivery contract: at-least-once

`watch()` with a `cursorStore` delivers **at-least-once**, not exactly-once:

- Events committed between the last `save()` and a crash are re-fetched and
  re-emitted on resume.
- Because `save()` runs before the page is yielded, a consumer that dies after
  processing but before the next save can see that page again within one
  process too.

**Dedupe guidance:** consumers must deduplicate by a stable event identity.
Every decoded `GuardEvent` already carries one — the non-null `id` described in
[Event identity](#event-identity) — which supersedes the older
`(ledger, transactionHash)` pair fallback. Never assume a cursor in the store
has already been fully drained.
