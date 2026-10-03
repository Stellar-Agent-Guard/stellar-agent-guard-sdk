/**
 * Unit tests for `watch()`'s cursor persistence — the piece that decides what a
 * restarted guard monitor sees.
 *
 * The failure mode this guards against (issue #37): a listener that restarts —
 * an agent runtime redeploy — re-reads from the default cursor and either
 * re-emits history or skips the gap, silently. `cursorStore` exists so the
 * cursor outlives the process. The contract pinned here:
 *
 *   - `load()` is consulted once, when `watch()` starts;
 *   - `save()` is called once per poll, *before* the page is yielded, so a
 *     consumer that stops after this page resumes from it (at-least-once,
 *     never lose-the-tail);
 *   - a restarted listener's first request carries the saved cursor and no
 *     `startLedger` — nothing is re-fetched from the default position.
 *
 * These run against a scripted mock of the two `rpc.Server` methods the
 * listener uses, because the behaviour under test is the listener's own control
 * flow, not the chain's. The RPC's real behaviour is exercised by
 * tests/integration/telemetry.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rpc, xdr } from "@stellar/stellar-sdk";
import {
  GuardTelemetryListener,
  InMemoryCursorStore,
  type CursorStore,
  type GuardEvent,
} from "../../src/telemetry.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

/**
 * A raw ledger event in the shape `getEvents` returns — `ScVal` topics and
 * value — because `poll()` decodes the RPC's shape, not `GuardEvent`s.
 */
function rawLedgerEvent(ledger: number) {
  return {
    contractId: GUARD,
    type: "contract" as const,
    topic: [xdr.ScVal.scvSymbol("event_heartbeat")],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("at"), val: xdr.ScVal.scvU64(BigInt(ledger)) }),
    ]),
    ledger,
    ledgerClosedAt: null,
    txHash: `tx-${ledger}`,
  };
}

/** What `poll()` should decode that raw event into, stable id included. */
function decodedEvent(ledger: number): GuardEvent {
  return {
    // Format from `guardEventId`: `ledger:<txHash>:<topic>` — the raw event
    // below carries txHash `tx-<ledger>`, so the decoded id is derivable here.
    id: `ledger:tx-${ledger}:event_heartbeat`,
    kind: "heartbeat",
    topic: "event_heartbeat",
    source: "ledger",
    contractId: GUARD,
    ledger,
    ledgerClosedAt: null,
    transactionHash: `tx-${ledger}`,
    decision: null,
    data: { at: BigInt(ledger) },
  };
}

type RawLedgerEvent = ReturnType<typeof rawLedgerEvent>;

interface ScriptedPage {
  events: RawLedgerEvent[];
  cursor: string;
}

/**
 * A `getEvents`/`getLatestLedger` mock that serves the scripted pages in order
 * and records every request. A call past the script throws, so a control-flow
 * bug fails the test loudly instead of polling forever.
 */
function scriptedServer(pages: ScriptedPage[]) {
  const requests: rpc.Api.GetEventsRequest[] = [];
  let latestLedgerCalls = 0;
  const server = {
    async getLatestLedger() {
      latestLedgerCalls += 1;
      return { sequence: 500 };
    },
    async getEvents(request: rpc.Api.GetEventsRequest) {
      requests.push(request);
      const page = pages[requests.length - 1];
      if (!page) {
        throw new Error(`getEvents called ${requests.length} times; only ${pages.length} pages scripted`);
      }
      return { events: page.events, cursor: page.cursor, latestLedger: 500 };
    },
  };
  return {
    server: server as unknown as rpc.Server,
    requests,
    latestLedgerCalls: () => latestLedgerCalls,
  };
}

/** A `CursorStore` that records what it is asked, for assertions. */
function recordingCursorStore(initial: string | null = null) {
  let stored: string | null = initial;
  const saves: string[] = [];
  let loads = 0;
  const store: CursorStore = {
    async load() {
      loads += 1;
      return stored;
    },
    async save(cursor) {
      saves.push(cursor);
      stored = cursor;
    },
  };
  return { store, saves, loadCount: () => loads, lastStored: () => stored };
}

/** Pull `count` pages from `watch()`, then stop (the "consumer" of the stream). */
async function take(
  listener: GuardTelemetryListener,
  count: number,
  params: { startLedger?: number } = {},
): Promise<GuardEvent[][]> {
  const pages: GuardEvent[][] = [];
  for await (const events of listener.watch({
    pollIntervalMs: 1,
    ...(params.startLedger !== undefined ? { startLedger: params.startLedger } : {}),
  })) {
    pages.push(events);
    if (pages.length >= count) break;
  }
  return pages;
}

describe("watch(signal) cursor persistence", () => {
  it("consults load() once at start and resumes from the stored cursor", async () => {
    const page = { events: [rawLedgerEvent(501)], cursor: "cursor-43" };
    const { server, requests } = scriptedServer([page, page]);
    const rec = recordingCursorStore("cursor-42");
    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });

    const pages = await take(listener, 1);

    assert.deepEqual(pages, [[decodedEvent(501)]], "the resumed page's events are decoded and delivered");
    assert.equal(
      pages[0]?.[0]?.id,
      "ledger:tx-501:event_heartbeat",
      "each delivered event carries its stable id, so resume consumers can dedupe",
    );
    assert.equal(rec.loadCount(), 1, "load is consulted once, when watch starts");
    assert.equal(requests[0]?.cursor, "cursor-42", "the first poll resumes from the stored cursor");
    assert.equal(requests[0]?.startLedger, undefined, "a cursor poll must not also send a ledger range");
  });

  it("saves once per poll, before the page is delivered", async () => {
    const pages: ScriptedPage[] = [
      { events: [rawLedgerEvent(501)], cursor: "cursor-2" },
      { events: [rawLedgerEvent(502)], cursor: "cursor-3" },
    ];
    const { server } = scriptedServer([...pages, pages[pages.length - 1]!]);
    const rec = recordingCursorStore(null);
    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });

    const seen: GuardEvent[][] = [];
    let savedBeforeFirstPage = false;
    for await (const events of listener.watch({ pollIntervalMs: 1 })) {
      if (seen.length === 0) {
        savedBeforeFirstPage = rec.saves.length === 1 && rec.saves[0] === "cursor-2";
      }
      seen.push(events);
      if (seen.length >= 2) break;
    }

    assert.deepEqual(seen, [[decodedEvent(501)], [decodedEvent(502)]]);
    assert.ok(savedBeforeFirstPage, "page 1's cursor is persisted before the page is yielded");
    assert.deepEqual(rec.saves, ["cursor-2", "cursor-3"], "exactly one save per poll");
  });

  it("a restarted listener resumes from the saved cursor without re-fetching history", async () => {
    const pages: ScriptedPage[] = [
      { events: [rawLedgerEvent(501)], cursor: "cursor-2" },
      { events: [rawLedgerEvent(502)], cursor: "cursor-3" },
      { events: [rawLedgerEvent(503)], cursor: "cursor-4" },
    ];
    const { server, requests } = scriptedServer(pages);
    const rec = recordingCursorStore(null);

    // First process: consumes two pages, then "crashes" (iteration stops).
    const first = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });
    await take(first, 2);
    assert.equal(rec.lastStored(), "cursor-3", "the restart point is the last saved cursor");

    // Second process: fresh listener, same store.
    const second = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });
    const resumed = await take(second, 1);
    const resumedRequest = requests[2];

    assert.deepEqual(resumed, [[decodedEvent(503)]], "the first page after restart is the next one, not history");
    assert.equal(resumedRequest?.cursor, "cursor-3", "the restart poll continues from the saved cursor");
    assert.equal(resumedRequest?.startLedger, undefined, "no re-fetch from a ledger range after restart");
  });

  it("without a cursorStore the first run starts at the default head position", async () => {
    const page = { events: [rawLedgerEvent(501)], cursor: "cursor-2" };
    const { server, requests, latestLedgerCalls } = scriptedServer([page, page]);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    assert.ok(listener.activeCursorStore instanceof InMemoryCursorStore, "the default store is in-memory");

    await take(listener, 1);

    assert.equal(latestLedgerCalls(), 1, "with nothing persisted, the default head position is used");
    assert.equal(requests[0]?.startLedger, 499);
    assert.equal(requests[0]?.cursor, undefined);
  });

  it("re-invoking watch() on the same listener resumes instead of re-reading from the head", async () => {
    const pages: ScriptedPage[] = [
      { events: [rawLedgerEvent(501)], cursor: "cursor-2" },
      { events: [rawLedgerEvent(502)], cursor: "cursor-3" },
    ];
    const { server, requests } = scriptedServer(pages);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    await take(listener, 1);
    await take(listener, 1); // the "restart": watch() invoked again on the same listener
    const secondRunRequest = requests[1];

    assert.equal(secondRunRequest?.cursor, "cursor-2", "the second watch continues where the first stopped");
    assert.equal(secondRunRequest?.startLedger, undefined, "it does not fall back to the default head");
  });

  it("an explicit startLedger pins the start and overrides any stored cursor", async () => {
    const page = { events: [rawLedgerEvent(501)], cursor: "cursor-2" };
    const { server, requests } = scriptedServer([page, page]);
    const rec = recordingCursorStore("cursor-42");
    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });

    await take(listener, 1, { startLedger: 100 });

    assert.equal(rec.loadCount(), 0, "a caller-pinned position is not second-guessed by the store");
    assert.equal(requests[0]?.startLedger, 100);
    assert.equal(requests[0]?.cursor, undefined);
  });
});

describe("InMemoryCursorStore", () => {
  it("starts empty and round-trips a cursor", async () => {
    const store = new InMemoryCursorStore();
    assert.equal(await store.load(), null);
    await store.save("cursor-7");
    assert.equal(await store.load(), "cursor-7");
  });

  it("keeps only the most recent cursor", async () => {
    const store = new InMemoryCursorStore();
    await store.save("cursor-1");
    await store.save("cursor-2");
    assert.equal(await store.load(), "cursor-2");
  });
});
