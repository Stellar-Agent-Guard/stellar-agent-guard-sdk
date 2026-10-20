# GuardTelemetryListener API

`GuardTelemetryListener` monitors on-chain events emitted by a guard contract.

## Constructor

```ts
constructor(options: GuardTelemetryListenerOptions)
```

### Options

- `server: rpc.Server` — soroban RPC server
- `guard: string` — Guard contract address
- `failedTx?: boolean` — opt in to failed-transaction diagnostics as a third event stream; defaults to `false`.
- `failedTxCursorStore?: CursorStore` — a **separate** durable store for the failed-transaction scan (issue #279). Never shares state with `cursorStore`; omitted → the scan's cursor is process-local.
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

**Detached snapshots (issue #344).** What this returns is a snapshot, not a view
into the buffer: the array, the events in it, their decoded `decision` and
`data`, and the opt-in `raw` payload are all copies. Editing a returned event
cannot change what the listener still retains, and the next `recent()` reports
the retained event rather than the edit. The copy keeps the prototype of a
class instance, so an XDR value inside a `raw` payload still behaves like the
XDR value it was. With no `buffer` configured there is nothing to copy: the
call returns `[]` and allocates nothing.

### `pollFailedTransactions(params?): Promise<FailedTxPollResult>`

Reads one page from the independent `getTransactions` cursor. Pass the returned
cursor on the next call; omitting it starts at the current RPC head, without
replaying older failures. Only failed transactions with diagnostics emitted by
the configured guard are returned. RPC errors leave a supplied cursor unchanged
and are reported on the result as `error` (issue #280) rather than thrown, so a
direct caller can tell "no failures this page" from "this page could not be
read".

### `watch(params?): AsyncIterable<GuardEventPage>`

Yields pages of decoded guard events (`event_auth_checked`, `event_policy_updated`, etc.).
Set `failedTx: true` in the constructor options to include failed-transaction
diagnostics; this scan maintains its own cursor and does not advance the
committed event cursor.
Parameters include `startLedger`, `cursor`/`resumeLedger`, `pollIntervalMs`, `limit`,
`jitter`, `rng`, `sleep`, `onGap`, `onUnknownTopics`, `onFailedTxError`, and `signal`.

**Validated at this boundary (issue #283).** `limit`, `startLedger` and
`resumeLedger` must be positive integers, `pollIntervalMs` a non-negative
integer, and `jitter` either `"none"` or `"full"`; passing a `cursor` together
with `startLedger`, or a `resumeLedger` together with `startLedger`, is a
contradiction. Every violation throws a field-specific `TypeError` before any
RPC request is issued or any timer is armed — invalid configuration costs zero
round trips and names its own field instead of surfacing later as a
host-dependent RPC error. `poll()` and `pollFailedTransactions()` validate the
same fields the same way.

#### Unknown topics

Unknown name topics are dropped from `GuardEvent` delivery, but they are no longer
silent. `poll()` returns `unknownTopics: GuardUnknownTopic[]` on each page, and
`watch()`/`watchAll()` accept `onUnknownTopics(unknownTopics)`, called once per
page that contains at least one unrecognised event. Each entry is
`{ topic: string; count: number }`, sorted by topic; only decoded names and counts
are exposed — never raw XDR or the source payload. The callback is isolated like
`onGap`, so a throwing sink cannot stop the stream. See
[`docs/event-schema.md`](../event-schema.md#unknown-event-topics--observability-without-payloads).

#### One active stream per listener

A listener owns shared cursor, failed-transaction de-duplication, counter, and
buffer state, so it supports **one active `watch()`/`watchAll()` stream at a
time**. Starting a second stream while the first is still being pulled throws
`ConcurrentTelemetryStreamError` (`code: "telemetry.concurrent_stream"`) before
it issues an RPC request, saves a cursor, or records an event. The active stream
keeps its own progress; after it ends, a new stream can start from the saved
cursor. Use a separate listener when you need two independent streams.

This is a deliberate fail-fast model, not isolation: rejecting the second stream
is what makes cursor persistence and counters impossible to overwrite or
double-count from two iterators on one listener.

#### Failed-transaction scan failures (`onFailedTxError`)

The `failedTx` scan is optional, and it must never take the committed stream
with it — but a scan that quietly stops delivering is a coverage hole a monitor
cannot see. Each scan failure (a rejected `getTransactions` page, or the head
probe that seeds the scan's cursor) is therefore reported through
`onFailedTxError(err)` (issue #280), *after* the scan has been abandoned:

- committed-event delivery is untouched — the failure is caught, the stream
  continues, and coverage resumes from the **unchanged** failed-tx cursor on the
  next cycle, so no unread failed transaction is stepped over;
- the callback is isolated like `onGap`: one that throws is swallowed and
  cannot stop telemetry;
- omitted, nothing changes except who is told — with a logger configured the
  failure is logged either way, and direct callers of
  `pollFailedTransactions()` read it on `FailedTxPollResult.error`.

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

`windowStart` is on the counter's **monotonic** timeline, not a raw wall-clock
reading. Observations are clamped to a non-decreasing internal time, so a
backward clock step (NTP correction, host move, manual date change) cannot
extend how long an entry is retained; a forward jump expires stale entries
immediately. For an empty window it reports the current monotonic time. Do not
compare it with `Date.now()`; use it as the start of the retained interval.

### `health(): GuardTelemetryHealthSnapshot`

An opt-in, read-only snapshot of the listener's operational state (issue #286),
for dashboards and alerting:

```ts
interface GuardTelemetryHealthSnapshot {
  state: 'idle' | 'running' | 'recovering' | 'stopped' | 'aborted' | 'failed';
  stream: 'watch' | 'watchAll' | null;
  startedAt: string | null;                 // ISO-8601
  lastSuccessfulPollAt: string | null;      // ISO-8601
  lastSuccessfulPollLedger: number | null;  // latestLedger of that poll
  consecutiveFailures: number;
  lastError: { message: string; at: string } | null;
  cursors: { committed: string | null; failedTx: string | null };
  failedTx: {
    enabled: boolean;
    degraded: boolean;
    consecutiveFailures: number;
    lastSuccessfulPollAt: string | null;
    cursor: string | null;
  };
  gaps: GuardTelemetryGap[];                // most recent 100, oldest first
}
```

- `running` → the last committed poll succeeded. `recovering` → a poll failed
  and the bounded retry envelope is in progress. `failed` → the envelope was
  exhausted (`lastError` is set). `aborted` → the caller's `signal` ended the
  stream. `stopped` → the stream ended on its own. `idle` → never started.
- `consecutiveFailures` counts committed-poll attempts since the last success;
  a successful retry resets it to `0`.
- `failedTx.degraded` is `true` while the optional transaction scan is failing.
  It never affects the committed stream's `state`, and it clears on the next
  successful scan.
- `lastError` carries the terminal error's **message**, not the error object;
  use `getLastError()` when you need the live value.
- **Copies:** every returned field, including `cursors`, `failedTx`, and each
  gap entry, is a fresh object. Mutating the snapshot cannot change listener
  state. The snapshot is cheap and may be polled freely; it allocates no state
  when the listener is idle.

### `poll()` dropped-event counts

`poll()` re-checks the emitting `contractId` before decoding rather than
trusting the RPC's contract filter. `PollResult.dropped` reports every rejection
by reason — `unknownTopic`, `foreignContract`, `missingContractId`,
`malformedContractId` — and the same breakdown is logged with the page summary.
Events with missing or malformed identity fail closed. See
[`event-schema.md`](../event-schema.md#emitting-identity-validation-before-decode-issue-322).

## Event identity

Every decoded `GuardEvent` carries a stable, non-null `id` on both streams:

-
  `ledger:<txHash>:<topic>[:<rpcEventId>]` for a committed event — the RPC's own
  per-event id is appended as a fourth segment when the response reports one, so
  two same-topic events in one transaction stay distinct (issue #275);
- `diag:<sha256>` for a diagnostic (blocked) event, which has no transaction to
  anchor on because it was rolled back before broadcast.

The same event re-parsed yields the same id; two different blocks within one
simulation yield different ids; two same-topic events in one transaction yield
different ids. Format and collision notes:
[`docs/event-schema.md`](../event-schema.md#event-identity--guardeventid).

## Strict offline fixture validation

`decodeGuardEventXdr()` is intentionally resilient: it returns `null` for a
malformed or unrecognised payload so live monitoring never crashes on one bad
event. Fixture maintainers and incident tooling need the opposite — every input
accounted for. `validateGuardEventXdr()` is the separate strict entry point:

```ts
import { validateGuardEventXdr } from "stellar-agent-guard-sdk";

const report = validateGuardEventXdr(fixtureXdr, { source: "ledger" });
if (!report.ok) {
  for (const failure of report.failures) {
    console.error(failure.path, failure.stage, failure.code, failure.message);
  }
}
```

The report preserves input order: `events` contains the decoded decisions,
`results` contains one entry per input, and `failures` contains only rejections.
Each failure carries the input `index`, a stable `path` such as
`events[2].topics[0]`, a pipeline `stage`, and a stable `code`:

| Stage | Codes | Meaning |
| --- | --- | --- |
| `input` | `input.not_string`, `input.empty` | The entry is not a non-empty base64 string. |
| `xdr` | `xdr.unparseable` | The value is neither a `DiagnosticEvent` nor a `ContractEvent` XDR. |
| `topics` | `topics.missing` | The event carries no contract-event topic list. |
| `topic` | `topic.undecodable` | One topic is not a decodable `ScVal`; the path names its index. |
| `decision` | `decision.unknown_topic`, `decision.invalid_result` | The topics decoded, but are not an `event_auth_checked` decision with an `allowed`/`blocked` result. |

Resilient live polling and the existing decoder return values are unchanged;
this is an additive offline API.

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
- The failed-transaction scan has its **own** store, `failedTxCursorStore`
  (issue #279). `cursorStore` is never used as its fallback and vice versa:
  the two cursors come from different RPC methods and mixing them would skip
  or replay events. Each stream resumes from its own last saved page, and one
  stream failing does not move the other's cursor.
- With no `failedTxCursorStore`, the tx scan starts at the RPC head after a
  restart; failures observed during downtime are not replayed. Retention and
  replay details: [`event-schema.md`](../event-schema.md#retention-and-replay-when-no-store-is-present).

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
