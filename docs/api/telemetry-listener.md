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

Yields pages of decoded guard events (`event_auth_checked`, `event_heartbeat`,
`event_policy_set`, …) until `params.signal` is aborted. Parameters:
`{ startLedger?, pollIntervalMs?, limit?, signal? }`.

### `poll(params?): Promise<PollResult>`

One page of committed guard events, from an explicit `startLedger`/`cursor` or
the current head. `watch()` is a poll loop over this.

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
