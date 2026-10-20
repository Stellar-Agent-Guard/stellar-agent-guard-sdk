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
  ConcurrentTelemetryStreamError,
  GuardTelemetryListener,
  InMemoryCursorStore,
  type CursorStore,
  type GuardEvent,
  type GuardTelemetryHealthSnapshot,
  type GuardTelemetryWatchPage,
  type GuardUnknownTopic,
} from "../../src/telemetry.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

/**
 * A raw ledger event in the shape `getEvents` returns — `ScVal` topics and
 * value — because `poll()` decodes the RPC's shape, not `GuardEvent`s.
 */
function rawLedgerEvent(
  ledger: number,
  txHash: string = `tx-${ledger}`,
  topic = "event_heartbeat",
) {
  return {
    contractId: GUARD,
    type: "contract" as const,
    topic: [xdr.ScVal.scvSymbol(topic)],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("at"), val: xdr.ScVal.scvU64(BigInt(ledger)) }),
    ]),
    ledger,
    ledgerClosedAt: null,
    txHash,
  };
}

/** What `poll()` should decode that raw event into, stable id included. */
function decodedEvent(
  ledger: number,
  txHash: string = `tx-${ledger}`,
  topic = "event_heartbeat",
): GuardEvent {
  return {
    // Format from `guardEventId`: `ledger:<txHash>:<topic>` — the raw event
    // below carries txHash `tx-<ledger>`, so the decoded id is derivable here.
    id: `ledger:${txHash}:${topic}`,
    kind: "heartbeat",
    topic,
    source: "ledger",
    stream: "committed",
    contractId: GUARD,
    ledger,
    ledgerClosedAt: null,
    observedAt: null,
    transactionHash: txHash,
    decision: null,
    data: { at: BigInt(ledger) },
  };
}

type RawLedgerEvent = ReturnType<typeof rawLedgerEvent>;

interface ScriptedPage {
  events: RawLedgerEvent[];
  cursor: string;
  latestLedger?: number;
  oldestLedger?: number | null;
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
      return {
        events: page.events,
        cursor: page.cursor,
        latestLedger: page.latestLedger ?? 500,
        ...(page.oldestLedger !== undefined ? { oldestLedger: page.oldestLedger } : {}),
      };
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

/** Pull `count` pages from the page-oriented watch iterator, then stop. */
async function takeWatchPages(
  listener: GuardTelemetryListener,
  count: number,
  params: { startLedger?: number } = {},
): Promise<GuardTelemetryWatchPage[]> {
  const pages: GuardTelemetryWatchPage[] = [];
  for await (const page of listener.watchPages({
    pollIntervalMs: 1,
    ...(params.startLedger !== undefined ? { startLedger: params.startLedger } : {}),
  })) {
    pages.push(page);
    if (pages.length >= count) break;
  }
  return pages;
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

describe("watchPages page metadata (issue #288)", () => {
  it("yields empty pages with cursor and ledger/retention metadata", async () => {
    const { server, requests } = scriptedServer([
      { events: [], cursor: "empty-page", latestLedger: 520, oldestLedger: 500 },
    ]);
    const store = recordingCursorStore();
    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: store.store });

    const [page] = await takeWatchPages(listener, 1, { startLedger: 500 });

    assert.deepEqual(page?.events, []);
    assert.equal(page?.cursor, "empty-page");
    assert.equal(page?.latestLedger, 520);
    assert.equal(page?.oldestLedger, 500);
    assert.deepEqual(page?.gaps, []);
    assert.equal(requests[0]?.startLedger, 500);
    assert.deepEqual(store.saves, ["empty-page"]);
  });

  it("advances and exposes the cursor on each successive page", async () => {
    const { server, requests } = scriptedServer([
      { events: [rawLedgerEvent(501)], cursor: "page-1", latestLedger: 501 },
      { events: [rawLedgerEvent(502)], cursor: "page-2", latestLedger: 502 },
    ]);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    const pages = await takeWatchPages(listener, 2, { startLedger: 501 });

    assert.deepEqual(pages.map((page) => page.cursor), ["page-1", "page-2"]);
    assert.deepEqual(pages.map((page) => page.events), [[decodedEvent(501)], [decodedEvent(502)]]);
    assert.equal(requests[1]?.cursor, "page-1");
    assert.equal(requests[1]?.startLedger, undefined);
  });

  it("includes retention gaps on the page that detects them", async () => {
    const { server } = scriptedServer([
      { events: [], cursor: "after-gap", latestLedger: 30, oldestLedger: 20 },
    ]);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    const [page] = await takeWatchPages(listener, 1, { startLedger: 10 });

    assert.deepEqual(page?.gaps, [
      {
        fromLedger: 10,
        toLedger: 19,
        reason: "history_pruned",
        retainedFromLedger: 20,
        retainedToLedger: 30,
      },
    ]);
  });

  it("keeps watch() yielding only non-empty event arrays", async () => {
    const { server } = scriptedServer([
      { events: [], cursor: "empty" },
      { events: [rawLedgerEvent(501)], cursor: "with-event" },
    ]);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    assert.deepEqual(await take(listener, 1), [[decodedEvent(501)]]);
  });
});

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

describe("committed-page ordering (issue #289)", () => {
  /** A deliberately shuffled page: ledgers out of order, and two per ledger. */
  const shuffled = [
    rawLedgerEvent(502, "tx-z"),
    rawLedgerEvent(500, "tx-b"),
    rawLedgerEvent(502, "tx-c"),
    rawLedgerEvent(500, "tx-a"),
  ];
  const expected = [
    [500, "tx-a"],
    [500, "tx-b"],
    [502, "tx-c"],
    [502, "tx-z"],
  ];

  it("poll() orders by ledger, then by a stable same-ledger tie-breaker", async () => {
    const { server } = scriptedServer([{ events: shuffled, cursor: "cursor-1" }]);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    const page = await listener.poll({ startLedger: 500 });

    assert.deepEqual(
      page.events.map((event) => [event.ledger, event.transactionHash]),
      expected,
    );
  });

  it("watch() exposes the same committed order as poll()", async () => {
    const { server } = scriptedServer([{ events: shuffled, cursor: "cursor-1" }]);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    const [page] = await take(listener, 1, { startLedger: 500 });

    assert.deepEqual(
      page?.map((event) => [event.ledger, event.transactionHash]),
      expected,
    );
  });

  it("watchAll() exposes the same committed order as poll()", async () => {
    const { server } = scriptedServer([{ events: shuffled, cursor: "cursor-1" }]);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    const controller = new AbortController();
    const seen: GuardEvent[] = [];

    for await (const event of listener.watchAll({
      startLedger: 500,
      pollIntervalMs: 1,
      signal: controller.signal,
      sleep: async () => controller.abort(),
    })) {
      seen.push(event);
    }

    assert.deepEqual(
      seen.map((event) => [event.ledger, event.transactionHash]),
      expected,
    );
  });
});

describe("unknown event topics (issue #287)", () => {
  it("poll() reports unknown names and counts without exposing payloads", async () => {
    const rawEvents = [
      rawLedgerEvent(503, "tx-future-1", "event_future"),
      rawLedgerEvent(501, "tx-known"),
      rawLedgerEvent(502, "tx-future-2", "event_future"),
      rawLedgerEvent(504, "tx-other", "event_other"),
    ];
    const { server } = scriptedServer([{ events: rawEvents, cursor: "cursor-1" }]);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    const page = await listener.poll({ startLedger: 500 });

    assert.deepEqual(
      page.unknownTopics,
      [
        { topic: "event_future", count: 2 },
        { topic: "event_other", count: 1 },
      ],
      "names are sorted and counted per page",
    );
    assert.deepEqual(
      page.events.map((event) => event.id),
      ["ledger:tx-known:event_heartbeat"],
      "unknown topics stay out of GuardEvent",
    );
    assert.equal("raw" in page.events[0]!, false, "the default path retains no raw event");
    assert.deepEqual(
      page.unknownTopics.map((entry) => Object.keys(entry).sort()),
      [
        ["count", "topic"],
        ["count", "topic"],
      ],
      "the summary carries only decoded names and counts",
    );
    assert.equal(
      JSON.stringify(page.unknownTopics).includes("tx-future"),
      false,
      "no transaction hash or source payload leaks through the summary",
    );
  });

  it("keeps an unknown event out of the buffer even when raw retention is on", async () => {
    const unknown = rawLedgerEvent(501, "tx-future", "event_future");
    const { server } = scriptedServer([{ events: [unknown], cursor: "cursor-1" }]);
    const listener = new GuardTelemetryListener({
      server,
      guard: GUARD,
      buffer: { max: 10 },
      includeRaw: true,
    });

    const page = await listener.poll({ startLedger: 500 });

    assert.deepEqual(page.events, []);
    assert.deepEqual(listener.recent(), []);
    assert.deepEqual(page.unknownTopics, [{ topic: "event_future", count: 1 }]);
  });

  it("watch() surfaces a new topic through the callback and keeps polling", async () => {
    const pages: ScriptedPage[] = [
      {
        events: [
          rawLedgerEvent(501, "tx-future", "event_future"),
          rawLedgerEvent(502, "tx-known"),
        ],
        cursor: "cursor-1",
      },
      { events: [rawLedgerEvent(503, "tx-known-2")], cursor: "cursor-2" },
    ];
    const { server } = scriptedServer(pages);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    const reports: GuardUnknownTopic[][] = [];
    const delivered: GuardEvent[][] = [];

    for await (const page of listener.watch({
      pollIntervalMs: 1,
      onUnknownTopics: (unknownTopics) => reports.push([...unknownTopics]),
    })) {
      delivered.push(page);
      if (delivered.length === 2) break;
    }

    assert.deepEqual(reports, [[{ topic: "event_future", count: 1 }]]);
    assert.deepEqual(
      delivered.map((page) => page.map((event) => event.ledger)),
      [[502], [503]],
      "the unknown topic neither crashes the stream nor stops the next page",
    );
  });
});

describe("single active stream (issue #291)", () => {
  it("rejects a concurrent watch() before it issues an RPC request", async () => {
    const pages: ScriptedPage[] = [
      { events: [rawLedgerEvent(501)], cursor: "cursor-1" },
      { events: [rawLedgerEvent(502)], cursor: "cursor-2" },
      { events: [rawLedgerEvent(503)], cursor: "cursor-3" },
    ];
    const { server, requests } = scriptedServer(pages);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    const first = listener.watch({ pollIntervalMs: 1 });
    const firstPage = await first.next();
    assert.deepEqual(firstPage.value?.map((event) => event.ledger), [501]);

    const second = listener.watch({ pollIntervalMs: 1 });
    await assert.rejects(
      second.next(),
      (error: unknown) => error instanceof ConcurrentTelemetryStreamError,
      "the second stream is rejected deterministically",
    );
    assert.equal(requests.length, 1, "the rejected stream must not touch the RPC");

    const secondPage = await first.next();
    assert.deepEqual(
      secondPage.value?.map((event) => event.ledger),
      [502],
      "the active stream keeps its own progress",
    );
    await first.return?.();

    const third = listener.watch({ pollIntervalMs: 1 });
    const thirdPage = await third.next();
    assert.deepEqual(
      thirdPage.value?.map((event) => event.ledger),
      [503],
      "after the first stream ends, a new stream starts from the saved cursor",
    );
    await third.return?.();
  });

  it("rejects a concurrent watchAll() and does not double-count counters", async () => {
    const allowed = {
      ...rawLedgerEvent(501),
      topic: ["event_auth_checked", "allowed", ""].map((topic) => xdr.ScVal.scvSymbol(topic)),
    };
    const { server } = scriptedServer([
      { events: [allowed], cursor: "cursor-1" },
      { events: [allowed], cursor: "cursor-2" },
    ]);
    const listener = new GuardTelemetryListener({
      server,
      guard: GUARD,
      counters: { windowEvents: 10 },
    });

    const first = listener.watchAll({ pollIntervalMs: 1 });
    const firstEvent = await first.next();
    assert.equal(firstEvent.value?.decision?.result, "allowed");

    const second = listener.watchAll({ pollIntervalMs: 1 });
    await assert.rejects(
      second.next(),
      (error: unknown) => error instanceof ConcurrentTelemetryStreamError,
    );

    assert.equal(listener.stats()?.allowed, 1, "only the active stream records a decision");
    assert.equal(listener.stats()?.blocked, 0);
    await first.return?.();
  });
});

describe("listener health snapshot (issue #286)", () => {
  it("reports a healthy stream and hands out copies", async () => {
    const page = { events: [rawLedgerEvent(501)], cursor: "cursor-1" };
    const { server } = scriptedServer([page, page]);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    let during: GuardTelemetryHealthSnapshot | null = null;
    for await (const events of listener.watch({ pollIntervalMs: 1, startLedger: 500 })) {
      assert.equal(events.length, 1);
      during = listener.health();
      break;
    }

    assert.ok(during);
    assert.equal(during.state, "running");
    assert.equal(during.stream, "watch");
    assert.ok(during.startedAt);
    assert.ok(during.lastSuccessfulPollAt);
    assert.equal(during.lastSuccessfulPollLedger, 500);
    assert.equal(during.consecutiveFailures, 0);
    assert.equal(during.lastError, null);
    assert.deepEqual(during.cursors, { committed: "cursor-1", failedTx: null });
    assert.deepEqual(during.failedTx, {
      enabled: false,
      degraded: false,
      consecutiveFailures: 0,
      lastSuccessfulPollAt: null,
      cursor: null,
    });
    assert.equal(during.gaps.length, 0);

    // The snapshot is detached: editing it cannot reach listener state.
    during.cursors.committed = "tampered";
    during.failedTx.degraded = true;
    during.gaps.push({ fromLedger: 1, toLedger: 2, reason: "history_pruned", retainedFromLedger: 3, retainedToLedger: 4 });
    const after = listener.health();
    assert.equal(after.cursors.committed, "cursor-1");
    assert.equal(after.failedTx.degraded, false);
    assert.deepEqual(after.gaps, []);
  });

  it("reports recovering while the retry envelope is in progress, then healthy", async () => {
    let calls = 0;
    const server = {
      async getLatestLedger() {
        return { sequence: 500 };
      },
      async getEvents() {
        calls += 1;
        if (calls === 1) throw new Error("rpc unavailable");
        return { events: [rawLedgerEvent(501)], cursor: "cursor-1", latestLedger: 500 };
      },
    } as unknown as rpc.Server;
    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    const snapshots: GuardTelemetryHealthSnapshot[] = [];

    for await (const events of listener.watch({
      pollIntervalMs: 1,
      startLedger: 500,
      sleep: async () => {
        // Recovery waits between attempts; inspect the state from there.
        snapshots.push(listener.health());
      },
    })) {
      assert.equal(events.length, 1);
      break;
    }

    const recovering = snapshots.find((snapshot) => snapshot.state === "recovering");
    assert.ok(recovering, "the retry envelope must be visible as recovering");
    assert.equal(recovering.consecutiveFailures, 1);
    assert.equal(recovering.lastSuccessfulPollAt, null);

    const settled = listener.health();
    assert.equal(settled.state, "stopped");
    assert.equal(settled.consecutiveFailures, 0, "a successful retry resets the failure count");
    assert.ok(settled.lastSuccessfulPollAt);
    assert.equal(settled.cursors.committed, "cursor-1");
  });

  it("reports aborted when the caller's signal ends the stream", async () => {
    const page = { events: [rawLedgerEvent(501)], cursor: "cursor-1" };
    const { server } = scriptedServer([page, page]);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    const controller = new AbortController();

    for await (const _events of listener.watch({
      pollIntervalMs: 1,
      startLedger: 500,
      signal: controller.signal,
    })) {
      controller.abort();
    }

    const health = listener.health();
    assert.equal(health.state, "aborted");
    assert.ok(health.startedAt);
    assert.equal(health.lastError, null);
  });

  it("reports a terminal failure with the error and failure count", async () => {
    const server = {
      async getLatestLedger() {
        return { sequence: 500 };
      },
      async getEvents(): Promise<never> {
        throw new Error("rpc unavailable");
      },
    } as unknown as rpc.Server;
    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    let streamError: unknown = null;

    for await (const _events of listener.watch({
      pollIntervalMs: 1,
      startLedger: 500,
      sleep: async () => {},
      onStreamError: (error) => {
        streamError = error;
      },
    })) {
      assert.fail("a terminal stream must not yield");
    }

    const health = listener.health();
    assert.equal(health.state, "failed");
    assert.equal(health.consecutiveFailures, 6, "one initial attempt plus five retries");
    assert.equal(health.lastSuccessfulPollAt, null);
    assert.equal(health.cursors.committed, null);
    assert.ok(streamError instanceof Error);
    assert.equal(health.lastError?.message, "rpc unavailable");
    assert.ok(health.lastError?.at);
  });

  it("records provable coverage gaps without exposing mutable internals", async () => {
    const server = {
      async getLatestLedger() {
        return { sequence: 500 };
      },
      async getEvents() {
        return { events: [], cursor: "cursor-1", latestLedger: 700, oldestLedger: 600 };
      },
    } as unknown as rpc.Server;
    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    const gaps: unknown[] = [];
    const controller = new AbortController();

    for await (const _events of listener.watch({
      pollIntervalMs: 1,
      startLedger: 100,
      signal: controller.signal,
      // The page is empty, so nothing is yielded; stop from the notice itself.
      onGap: (gap) => {
        gaps.push(gap);
        controller.abort();
      },
      sleep: async () => {},
    })) {
      // No events expected: gap detection does not fabricate any.
    }

    assert.equal(gaps.length, 1);
    const health = listener.health();
    assert.deepEqual(health.gaps, [gaps[0]]);
    health.gaps[0]!.fromLedger = 999;
    assert.notEqual(listener.health().gaps[0]!.fromLedger, 999);
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
