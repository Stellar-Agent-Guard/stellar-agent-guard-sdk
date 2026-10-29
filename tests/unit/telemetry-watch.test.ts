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
  DEFAULT_MAX_BUFFERED_PAGES,
  DEFAULT_TELEMETRY_RETRY_OPTIONS,
  GuardTelemetryListener,
  InMemoryCursorStore,
  type CursorStore,
  type GuardEvent,
  type GuardTelemetryHealthSnapshot,
  type GuardUnknownTopic,
  type TelemetryRetryOptions,
} from "../../src/telemetry.ts";

/** Pull up to `count` pages from a watch stream, then stop. */
async function takeFrom(
  stream: AsyncIterable<GuardEvent[]>,
  count: number,
): Promise<GuardEvent[][]> {
  const pages: GuardEvent[][] = [];
  for await (const events of stream) {
    pages.push(events);
    if (pages.length >= count) break;
  }
  return pages;
}

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
        throw new Error(
          `getEvents called ${requests.length} times; only ${pages.length} pages scripted`,
        );
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
  params: { startLedger?: number; maxBufferedPages?: number } = {},
): Promise<GuardEvent[][]> {
  const pages: GuardEvent[][] = [];
  for await (const events of listener.watch({
    pollIntervalMs: 1,
    ...(params.startLedger !== undefined ? { startLedger: params.startLedger } : {}),
    ...(params.maxBufferedPages !== undefined ? { maxBufferedPages: params.maxBufferedPages } : {}),
  })) {
    pages.push(events);
    if (pages.length >= count) break;
  }
  return pages;
}

/** Let pending timers, grace macrotasks, and speculative pulls run to quiescence. */
function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A promise whose settlement the test controls: an RPC request that stays in
 * flight until the test resolves or rejects it.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("watch(signal) cursor persistence", () => {
  it("consults load() once at start and resumes from the stored cursor", async () => {
    const page = { events: [rawLedgerEvent(501)], cursor: "cursor-43" };
    const { server, requests } = scriptedServer([page, page]);
    const rec = recordingCursorStore("cursor-42");
    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });

    const pages = await take(listener, 1);

    assert.deepEqual(
      pages,
      [[decodedEvent(501)]],
      "the resumed page's events are decoded and delivered",
    );
    assert.equal(
      pages[0]?.[0]?.id,
      "ledger:tx-501:event_heartbeat",
      "each delivered event carries its stable id, so resume consumers can dedupe",
    );
    assert.equal(rec.loadCount(), 1, "load is consulted once, when watch starts");
    assert.equal(requests[0]?.cursor, "cursor-42", "the first poll resumes from the stored cursor");
    assert.equal(
      requests[0]?.startLedger,
      undefined,
      "a cursor poll must not also send a ledger range",
    );
  });

  it("saves once per poll, after the consumer resumes past yield (issue #274)", async () => {
    const pages: ScriptedPage[] = [
      { events: [rawLedgerEvent(501)], cursor: "cursor-2" },
      { events: [rawLedgerEvent(502)], cursor: "cursor-3" },
    ];
    const { server } = scriptedServer([...pages, pages[pages.length - 1]!]);
    const rec = recordingCursorStore(null);
    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });

    const seen: GuardEvent[][] = [];
    let savedDuringFirstPageYield = false;
    const gen = listener.watch({ pollIntervalMs: 1 });
    const res1 = await gen.next();
    if (!res1.done && res1.value) {
      savedDuringFirstPageYield = rec.saves.length > 0;
      seen.push(res1.value);
    }
    const res2 = await gen.next(); // resumes past yield of page 1, saving cursor-2
    if (!res2.done && res2.value) {
      seen.push(res2.value);
    }
    await gen.next(); // resumes past yield of page 2, saving cursor-3
    await gen.return();

    assert.deepEqual(seen, [[decodedEvent(501)], [decodedEvent(502)]]);
    assert.equal(
      savedDuringFirstPageYield,
      false,
      "page 1's cursor is acknowledged only after consumer advances past yield",
    );
    assert.deepEqual(rec.saves, ["cursor-2", "cursor-3"], "exactly one save per poll after yield");
  });

  it("a restarted listener resumes from the saved cursor without re-fetching history", async () => {
    const page1 = { events: [rawLedgerEvent(501)], cursor: "cursor-2" };
    const page2 = { events: [rawLedgerEvent(502)], cursor: "cursor-3" };
    const page3 = { events: [rawLedgerEvent(503)], cursor: "cursor-4" };

    const server1 = scriptedServer([page1, page2]).server;
    const { server: server2, requests: resumedRequests } = scriptedServer([page3]);

    const rec = recordingCursorStore(null);

    // First process: consumes two pages. To save cursor-3 (page2's cursor), consumer takes 2 pages
    // and then triggers the next iteration step.
    const first = new GuardTelemetryListener({
      server: server1,
      guard: GUARD,
      cursorStore: rec.store,
    });
    const gen = first.watch({ pollIntervalMs: 1 });
    await gen.next(); // receives page 1 (501)
    await gen.next(); // advances past page 1's yield (saves cursor-2), receives page 2 (502)
    await gen.next(); // advances past page 2's yield (saves cursor-3)
    await gen.return();

    assert.equal(rec.lastStored(), "cursor-3", "the restart point is the last saved cursor");

    // Second process: fresh listener, same store.
    const second = new GuardTelemetryListener({
      server: server2,
      guard: GUARD,
      cursorStore: rec.store,
    });
    const resumed = await take(second, 1);
    const resumedRequest = resumedRequests[0];

    assert.deepEqual(
      resumed,
      [[decodedEvent(503)]],
      "the first page after restart is the next one, not history",
    );
    assert.equal(
      resumedRequest?.cursor,
      "cursor-3",
      "the restart poll continues from the saved cursor",
    );
    assert.equal(
      resumedRequest?.startLedger,
      undefined,
      "no re-fetch from a ledger range after restart",
    );
  });

  it("without a cursorStore the first run starts at the default head position", async () => {
    const page = { events: [rawLedgerEvent(501)], cursor: "cursor-2" };
    const { server, requests, latestLedgerCalls } = scriptedServer([page, page]);
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    assert.ok(
      listener.activeCursorStore instanceof InMemoryCursorStore,
      "the default store is in-memory",
    );

    await take(listener, 1);

    assert.equal(
      latestLedgerCalls(),
      1,
      "with nothing persisted, the default head position is used",
    );
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

    const gen1 = listener.watch({ pollIntervalMs: 1 });
    await gen1.next(); // receives page 1
    await gen1.next(); // resumes past yield of page 1 (saving cursor-2)
    await gen1.return();

    await take(listener, 1); // the "restart": watch() invoked again on the same listener
    const secondRunRequest = requests[1];

    assert.equal(
      secondRunRequest?.cursor,
      "cursor-2",
      "the second watch continues where the first stopped",
    );
    assert.equal(
      secondRunRequest?.startLedger,
      undefined,
      "it does not fall back to the default head",
    );
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
        events: [rawLedgerEvent(501, "tx-future", "event_future"), rawLedgerEvent(502, "tx-known")],
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
    assert.deepEqual(
      firstPage.value?.map((event) => event.ledger),
      [501],
    );

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
    during.gaps.push({
      fromLedger: 1,
      toLedger: 2,
      reason: "history_pruned",
      retainedFromLedger: 3,
      retainedToLedger: 4,
    });
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

  it("scopes records to network/guard/stream so slots never collide (issue #282)", async () => {
    const store = new InMemoryCursorStore();
    const base = { network: "soroban-testnet.stellar.org", guard: GUARD };
    await store.save("events-cursor", { ...base, stream: "events" });
    await store.save("failed-tx-cursor", { ...base, stream: "failed_tx" });

    assert.equal(await store.load({ ...base, stream: "events" }), "events-cursor");
    assert.equal(await store.load({ ...base, stream: "failed_tx" }), "failed-tx-cursor");
    // Another guard on the same network, and the same guard on another
    // network, see neither cursor.
    assert.equal(
      await store.load({
        network: "soroban-testnet.stellar.org",
        guard: "C".padEnd(56, "B"),
        stream: "events",
      }),
      null,
    );
    assert.equal(
      await store.load({ network: "mainnet.example.com", guard: GUARD, stream: "events" }),
      null,
    );
  });

  it("keeps unscoped calls on their own slot, as before issue #282", async () => {
    const store = new InMemoryCursorStore();
    await store.save("legacy");
    await store.save("scoped", { network: "n", guard: GUARD, stream: "events" });
    assert.equal(await store.load(), "legacy", "the unscoped slot is unchanged by a scoped save");
    assert.equal(
      await store.load({ network: "n", guard: GUARD, stream: "events" }),
      "scoped",
      "and a scoped save does not disturb the unscoped slot",
    );
  });
});

describe("durable cursor scoping (issue #282)", () => {
  const OTHER_GUARD = "CAJJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4LNU";

  /** A `CursorStore` recording both cursors and the scopes it was given. */
  function scopedRecordingStore() {
    const records = new Map<string, string>();
    const scopes: Array<{ network: string; guard: string; stream: string } | undefined> = [];
    const key = (scope?: { network: string; guard: string; stream: string }) =>
      scope === undefined ? "<unscoped>" : `${scope.network}|${scope.guard}|${scope.stream}`;
    const store: CursorStore = {
      async load(scope) {
        scopes.push(scope);
        return records.get(key(scope)) ?? null;
      },
      async save(cursor, scope) {
        scopes.push(scope);
        records.set(key(scope), cursor);
      },
    };
    return { store, records, scopes };
  }

  it("the listener keys every load/save to its network, guard and stream", async () => {
    const page = { events: [rawLedgerEvent(501)], cursor: "cursor-2" };
    const { server } = scriptedServer([page, page]);
    const rec = scopedRecordingStore();
    const listener = new GuardTelemetryListener({
      server,
      guard: GUARD,
      rpcUrl: "https://soroban-testnet.stellar.org:443",
      cursorStore: rec.store,
    });

    await take(listener, 2);

    const expected = {
      network: "soroban-testnet.stellar.org",
      guard: GUARD,
      stream: "events",
    };
    assert.deepEqual(rec.scopes, [expected, expected], "one scoped load, one scoped save");
    assert.equal(rec.records.get("soroban-testnet.stellar.org|" + GUARD + "|events"), "cursor-2");
  });

  it("two listeners with different guards sharing one store cannot load each other's cursor", async () => {
    const firstPage = { events: [rawLedgerEvent(501)], cursor: "cursor-a" };
    const { server, requests } = scriptedServer([
      firstPage,
      { events: [rawLedgerEvent(502)], cursor: "cursor-trigger" },
      { events: [], cursor: "cursor-b" },
    ]);
    const shared = new InMemoryCursorStore();

    // Listener A persists its cursor into the shared store…
    const a = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: shared });
    await take(a, 2, { maxBufferedPages: 0 });
    assert.equal(
      await shared.load({ network: "unknown-network", guard: GUARD, stream: "events" }),
      "cursor-a",
    );

    // …and listener B, following a different guard, must not resume from it.
    const b = new GuardTelemetryListener({ server, guard: OTHER_GUARD, cursorStore: shared });
    await take(b, 1, { maxBufferedPages: 0 });
    const bFirstRequest = requests[2];
    assert.equal(bFirstRequest?.cursor, undefined, "B never sees A's cursor");
    assert.equal(bFirstRequest?.startLedger, 499, "B starts at the default head position instead");
  });

  it("the same guard on two networks cannot load the other network's cursor", async () => {
    const firstPage = { events: [rawLedgerEvent(501)], cursor: "cursor-mainnet" };
    const { server, requests } = scriptedServer([
      firstPage,
      { events: [rawLedgerEvent(502)], cursor: "cursor-trigger" },
      { events: [], cursor: "cursor-testnet" },
    ]);
    const shared = new InMemoryCursorStore();

    const mainnet = new GuardTelemetryListener({
      server,
      guard: GUARD,
      rpcUrl: "https://rpc.mainnet.example.com",
      cursorStore: shared,
    });
    await take(mainnet, 2, { maxBufferedPages: 0 });

    const testnet = new GuardTelemetryListener({
      server,
      guard: GUARD,
      rpcUrl: "https://soroban-testnet.stellar.org",
      cursorStore: shared,
    });
    await take(testnet, 1, { maxBufferedPages: 0 });

    const testnetFirstRequest = requests[2];
    assert.equal(
      testnetFirstRequest?.cursor,
      undefined,
      "the mainnet cursor does not leak into testnet",
    );
    assert.equal(testnetFirstRequest?.startLedger, 499);
  });

  it("a restart on the same guard and network still resumes from the scoped cursor", async () => {
    const pages: ScriptedPage[] = [
      { events: [rawLedgerEvent(501)], cursor: "cursor-2" },
      { events: [rawLedgerEvent(502)], cursor: "cursor-3" },
    ];
    const { server, requests } = scriptedServer(pages);
    const shared = new InMemoryCursorStore();
    const config = {
      server,
      guard: GUARD,
      rpcUrl: "https://soroban-testnet.stellar.org",
      cursorStore: shared,
    };

    await take(new GuardTelemetryListener(config), 2);
    await take(new GuardTelemetryListener(config), 1);

    assert.equal(requests[2]?.cursor, "cursor-2", "the scoped cursor still outlives the listener");
    assert.equal(requests[1]?.startLedger, undefined);
  });

  it("a pre-#282 two-method store keeps working unchanged", async () => {
    const page = { events: [rawLedgerEvent(501)], cursor: "cursor-9" };
    const { server, requests } = scriptedServer([page, page]);
    // Exactly the old contract: no scope parameter anywhere.
    let stored: string | null = "cursor-8";
    const legacyStore: CursorStore = {
      async load() {
        return stored;
      },
      async save(cursor) {
        stored = cursor;
      },
    };

    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: legacyStore });
    await take(listener, 2);

    assert.equal(requests[0]?.cursor, "cursor-8", "the legacy store still resumes the stream");
    assert.equal(stored, "cursor-9", "and still receives the advanced cursor");
  });
});

describe("configurable bounded poll retry (issue #285)", () => {
  /** A `getEvents` mock that throws `failures` times, then serves `page`. */
  function flakyServer(failures: number, page: ScriptedPage) {
    let calls = 0;
    const server = {
      async getLatestLedger() {
        return { sequence: 500 };
      },
      async getEvents() {
        calls += 1;
        if (calls <= failures) throw new Error("rpc unavailable");
        return { events: page.events, cursor: page.cursor, latestLedger: 500 };
      },
    };
    return { server: server as unknown as rpc.Server, calls: () => calls };
  }

  /** A `getEvents` mock that always fails. */
  function deadServer() {
    let calls = 0;
    const server = {
      async getLatestLedger() {
        return { sequence: 500 };
      },
      async getEvents() {
        calls += 1;
        throw new Error("rpc unavailable");
      },
    };
    return { server: server as unknown as rpc.Server, calls: () => calls };
  }

  it("exposes the historical defaults without a retry option", () => {
    assert.deepEqual(DEFAULT_TELEMETRY_RETRY_OPTIONS, { maxRetries: 5, baseDelayMs: 100 });
  });

  it("recovers immediately on the first retry, with the documented backoff", async () => {
    const page = { events: [rawLedgerEvent(501)], cursor: "cursor-2" };
    const { server, calls } = flakyServer(1, page);
    const delays: number[] = [];
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    const pages = await takeFrom(
      listener.watch({
        pollIntervalMs: 1,
        startLedger: 500,
        sleep: async (ms) => {
          delays.push(ms);
        },
        retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      }),
      1,
    );

    assert.deepEqual(pages, [[decodedEvent(501)]], "the recovered page is delivered");
    assert.equal(calls(), 2, "one failure, one successful retry");
    assert.deepEqual(delays.slice(0, 1), [100], "first retry waits exactly the base delay");
    const health = listener.health();
    assert.equal(
      health.lastSuccessfulPollLedger,
      500,
      "the recovered poll is recorded as the last healthy one",
    );
    assert.equal(health.consecutiveFailures, 0, "a recovery clears the failure streak");
  });

  it("applies deterministic exponential backoff capped at maxDelayMs", async () => {
    const { server, calls } = flakyServer(3, { events: [rawLedgerEvent(501)], cursor: "cursor-2" });
    const delays: number[] = [];
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    await takeFrom(
      listener.watch({
        pollIntervalMs: 1,
        startLedger: 500,
        sleep: async (ms) => {
          delays.push(ms);
        },
        retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 250 },
      }),
      1,
    );

    assert.deepEqual(delays, [100, 200, 250], "base doubling, then the explicit cap");
    assert.equal(calls(), 4, "one initial attempt plus three retries");
  });

  it("defaults the backoff cap to the poll interval", async () => {
    const { server } = flakyServer(3, { events: [rawLedgerEvent(501)], cursor: "cursor-2" });
    const delays: number[] = [];
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    await takeFrom(
      listener.watch({
        pollIntervalMs: 300,
        startLedger: 500,
        sleep: async (ms) => {
          delays.push(ms);
        },
        retry: { maxRetries: 3, baseDelayMs: 100 },
      }),
      1,
    );

    assert.deepEqual(delays, [100, 200, 300], "the poll interval remains the implicit cap");
  });

  it("ends fail-visibly once the configured budget is exhausted", async () => {
    const { server, calls } = deadServer();
    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    const delays: number[] = [];
    let streamErrors = 0;
    let streamError: unknown = null;

    for await (const _events of listener.watch({
      pollIntervalMs: 1,
      startLedger: 500,
      sleep: async (ms) => {
        delays.push(ms);
      },
      retry: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100 },
      onStreamError: (error) => {
        streamErrors += 1;
        streamError = error;
      },
    })) {
      assert.fail("a terminal stream must not yield");
    }

    assert.deepEqual(delays, [10, 20], "exactly maxAttempts backoff delays, then stop");
    assert.equal(calls(), 3, "one initial attempt plus the two configured retries");
    assert.equal(streamErrors, 1, "onStreamError fires exactly once, at exhaustion");
    assert.ok(streamError instanceof Error);
    const health = listener.health();
    assert.equal(health.state, "failed");
    assert.equal(health.consecutiveFailures, 3);
  });

  it("maxRetries: 0 makes the first failure terminal — no retry at all", async () => {
    const { server, calls } = deadServer();
    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    const delays: number[] = [];

    for await (const _events of listener.watch({
      pollIntervalMs: 1,
      startLedger: 500,
      sleep: async (ms) => {
        delays.push(ms);
      },
      retry: { maxRetries: 0 },
    })) {
      assert.fail("a terminal stream must not yield");
    }

    assert.deepEqual(delays, [], "no delay is ever taken without a retry budget");
    assert.equal(calls(), 1);
    assert.equal(listener.health().state, "failed");
  });

  it("an abort during a retry backoff ends the stream promptly", async () => {
    const { server, calls } = deadServer();
    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    const controller = new AbortController();
    let streamErrors = 0;

    for await (const _events of listener.watch({
      pollIntervalMs: 1,
      startLedger: 500,
      signal: controller.signal,
      // Simulates the caller aborting while the first backoff delay is pending.
      sleep: async () => {
        controller.abort();
      },
      retry: { maxRetries: 5, baseDelayMs: 100 },
      onStreamError: () => {
        streamErrors += 1;
      },
    })) {
      assert.fail("a terminal stream must not yield");
    }

    assert.equal(calls(), 1, "the abort interrupts the backoff before any further poll");
    assert.equal(streamErrors, 0, "an aborted stream is teardown, not a failure");
  });

  it("rejects an unusable retry policy before issuing any RPC", async () => {
    for (const retry of [
      { maxRetries: -1 },
      { maxRetries: 2.5 },
      { baseDelayMs: -1 },
      { baseDelayMs: Number.POSITIVE_INFINITY },
      { maxDelayMs: -1 },
      { maxDelayMs: Number.NaN },
      "aggressive",
    ] as unknown as TelemetryRetryOptions[]) {
      const { server, calls } = deadServer();
      const listener = new GuardTelemetryListener({ server, guard: GUARD });
      await assert.rejects(
        async () => {
          for await (const _events of listener.watch({
            pollIntervalMs: 1,
            startLedger: 500,
            sleep: async () => {},
            retry,
          })) {
            // no pages expected: validation fails first
          }
        },
        TypeError,
        `must reject ${JSON.stringify(retry)}`,
      );
      assert.equal(calls(), 0, "validation happens before the first poll");
    }
  });
});

describe("bounded look-ahead pump (issue #36)", () => {
  /** `count` scripted pages with distinct ledgers and cursors. */
  function scriptedLedgerPages(count: number): ScriptedPage[] {
    return Array.from({ length: count }, (_, index) => ({
      events: [rawLedgerEvent(501 + index)],
      cursor: `cursor-${index + 2}`,
    }));
  }

  it("exposes the documented default bound", () => {
    assert.equal(DEFAULT_MAX_BUFFERED_PAGES, 2);
  });

  it("rejects an unusable bound before issuing any RPC, without leaking the stream lease", async () => {
    for (const maxBufferedPages of [
      -1,
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "2",
    ] as unknown as number[]) {
      const { server, requests } = scriptedServer(scriptedLedgerPages(1));
      const listener = new GuardTelemetryListener({ server, guard: GUARD });
      await assert.rejects(
        async () => {
          for await (const _events of listener.watch({ pollIntervalMs: 1, maxBufferedPages })) {
            // no pages expected: validation fails first
          }
        },
        TypeError,
        `must reject ${JSON.stringify(maxBufferedPages)}`,
      );
      assert.equal(requests.length, 0, "validation happens before the first poll");
    }

    // A rejected validation must not hold the stream lease: a valid stream
    // on the same listener still starts.
    const { server, requests } = scriptedServer(scriptedLedgerPages(1));
    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    await assert.rejects(async () => {
      for await (const _events of listener.watch({ pollIntervalMs: 1, maxBufferedPages: -1 })) {
        // rejected above
      }
    }, TypeError);
    const [page] = await take(listener, 1);
    assert.deepEqual(
      page?.map((event) => event.ledger),
      [501],
      "the listener is reusable after a rejected option",
    );
    assert.equal(requests.length, 1, "and the valid stream polls exactly once");
  });

  it("delivers the same pages in the same order with and without look-ahead", async () => {
    const pages = scriptedLedgerPages(3);
    const withLookahead = await take(
      new GuardTelemetryListener({
        server: scriptedServer([...pages, pages[2]!]).server,
        guard: GUARD,
      }),
      3,
    );
    const strict = await take(
      new GuardTelemetryListener({
        server: scriptedServer([...pages, pages[2]!]).server,
        guard: GUARD,
      }),
      3,
      { maxBufferedPages: 0 },
    );

    const shape = (batches: GuardEvent[][]) =>
      batches.map((batch) => batch.map((event) => event.ledger));
    assert.deepEqual(shape(withLookahead), [[501], [502], [503]]);
    assert.deepEqual(
      shape(strict),
      shape(withLookahead),
      "the bound changes pacing, never the delivered sequence",
    );
  });

  it("maxBufferedPages: 0 restores strict consumer-paced polling", async () => {
    const pages = scriptedLedgerPages(2);
    const { server, requests } = scriptedServer([...pages, pages[1]!]);
    const rec = recordingCursorStore(null);
    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });
    const stream = listener.watch({ pollIntervalMs: 1, maxBufferedPages: 0 });

    const first = await stream.next();
    assert.deepEqual(
      first.value?.map((event) => event.ledger),
      [501],
      "one pull delivers exactly one page",
    );
    assert.equal(requests.length, 1, "one fetch per pull — nothing runs ahead");
    assert.deepEqual(rec.saves, [], "no cursor is saved until the consumer resumes past the yield");

    await settle();
    assert.equal(requests.length, 1, "an idle consumer keeps the loop idle: no look-ahead");

    const second = await stream.next();
    assert.deepEqual(
      second.value?.map((event) => event.ledger),
      [502],
    );
    assert.equal(requests.length, 2, "the next pull performs the next fetch, and only it");
    assert.deepEqual(
      rec.saves,
      ["cursor-2"],
      "resuming past the first yield persists that page's cursor",
    );
    await stream.return?.();
  });

  it("bounds look-ahead to maxBufferedPages and stops fetching when the consumer stops", async () => {
    const { server, requests } = scriptedServer(scriptedLedgerPages(8));
    const rec = recordingCursorStore(null);
    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });
    const stream = listener.watch({ pollIntervalMs: 1, maxBufferedPages: 2 });

    // A slow consumer: between pulls it "works", and the pump may run ahead
    // — but never past its bound of buffered + one in-flight pages.
    for (let pulled = 1; pulled <= 2; pulled += 1) {
      const page = await stream.next();
      assert.deepEqual(
        page.value?.map((event) => event.ledger),
        [500 + pulled],
      );
      assert.ok(
        requests.length - pulled <= 2,
        `after delivery ${pulled}: fetched (${requests.length}) minus delivered (${pulled}) must stay within the bound`,
      );
      await settle(20);
      assert.equal(
        requests.length - pulled,
        2,
        `the pump fills its look-ahead exactly to the bound while the consumer works (pull ${pulled})`,
      );
    }
    assert.deepEqual(
      rec.saves,
      ["cursor-2"],
      "only a page the consumer has resumed past advances the stored cursor; buffered pages stay unsaved",
    );
    assert.equal(
      rec.lastStored(),
      "cursor-2",
      "the stored cursor never leads the consumer's confirmed position",
    );

    // The consumer stops. Teardown must drop the buffered pages and issue no
    // further request — a stopped consumer stops the poll loop.
    const requestsAtStop = requests.length;
    await stream.return?.();
    await settle();
    assert.equal(requests.length, requestsAtStop, "no zombie fetch after teardown");

    // A restart resumes from the last *delivered* cursor, re-reading the
    // dropped pages — at-least-once, never lose-the-tail.
    const restarted = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });
    const resumeRequestIndex = requests.length;
    await take(restarted, 1);
    assert.equal(
      requests[resumeRequestIndex]?.cursor,
      "cursor-2",
      "the restart re-reads from the consumer's confirmed position",
    );
  });

  it("a consumer that stops after one page drags no extra fetch past its own stop", async () => {
    const { server, requests } = scriptedServer(scriptedLedgerPages(4));
    const listener = new GuardTelemetryListener({ server, guard: GUARD });

    await take(listener, 1);
    await settle();

    assert.equal(
      requests.length,
      1,
      "the break lands before the pump's speculative pull: one demanded fetch, no more",
    );
  });

  it("the same clean stop holds when the stream runs under an AbortSignal", async () => {
    // With a signal present, the consumer's wake travels the race's extra
    // microtask hop, so the pump must clear its demand flag at notification
    // time — otherwise it misclassifies its next pull as demanded, skips the
    // grace, and races the inter-poll sleep past the consumer's own stop.
    const { server, requests } = scriptedServer(scriptedLedgerPages(4));
    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    const controller = new AbortController();
    const stream = listener.watch({ pollIntervalMs: 1, signal: controller.signal });

    const first = await stream.next();
    assert.deepEqual(
      first.value?.map((event) => event.ledger),
      [501],
      "the first demanded pull delivers the first page",
    );
    await stream.return?.(); // the consumer stops after this one page
    await settle();

    assert.equal(
      requests.length,
      1,
      "no fetch may be dragged past the consumer's stop, signal or not",
    );
  });

  it("delivers a page fetched before an abort, then ends", async () => {
    const { server, requests } = scriptedServer(scriptedLedgerPages(4));
    const rec = recordingCursorStore(null);
    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });
    const controller = new AbortController();
    const seen: GuardEvent[][] = [];

    for await (const events of listener.watch({
      pollIntervalMs: 1,
      signal: controller.signal,
      // The caller aborts during the first inter-poll delay — after the first
      // page was fetched, as in the pre-pump stream.
      sleep: async () => {
        controller.abort();
      },
    })) {
      seen.push(events);
    }

    assert.deepEqual(
      seen.map((batch) => batch.map((event) => event.ledger)),
      [[501]],
      "a page fetched before the abort is still delivered, as the pre-pump stream did",
    );
    assert.deepEqual(rec.saves, ["cursor-2"], "and its cursor is persisted at delivery");
    assert.equal(requests.length, 1, "the abort stops the loop at the next boundary");
    assert.equal(listener.health().state, "aborted");
  });

  it("an abort while the consumer is busy still delivers the pages already fetched", async () => {
    const { server, requests } = scriptedServer(scriptedLedgerPages(6));
    const rec = recordingCursorStore(null);
    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });
    const controller = new AbortController();
    const stream = listener.watch({
      pollIntervalMs: 1,
      maxBufferedPages: 2,
      signal: controller.signal,
    });

    const first = await stream.next();
    assert.deepEqual(
      first.value?.map((event) => event.ledger),
      [501],
    );
    await settle(20); // the consumer is off processing; the pump fills its bound
    assert.equal(requests.length, 3, "one delivered plus two buffered — the look-ahead is full");

    controller.abort(); // an external stop while pages sit in the buffer

    const seen: number[] = [];
    while (true) {
      const step = await stream.next();
      if (step.done === true) break;
      seen.push(
        ...step.value
          .map((event) => event.ledger)
          .filter((ledger): ledger is number => ledger !== null),
      );
    }

    assert.deepEqual(
      seen,
      [502, 503],
      "pages fetched before the abort are delivered, never silently dropped",
    );
    assert.deepEqual(
      rec.saves,
      ["cursor-2", "cursor-3", "cursor-4"],
      "each delivered page advances the stored cursor to its own position",
    );
    assert.equal(requests.length, 3, "the abort stops any further fetch");
    assert.equal(listener.health().state, "aborted");
  });

  it("delivers 100 events exactly once, in order, across random backpressure", async () => {
    // The gap/dup contract: pacing must never reorder, lose, or repeat an
    // event, no matter where a slow consumer's pulls land relative to the
    // pump's speculative fetches. 20 pages of 5 events, consumed at a
    // pseudo-random cadence — deterministic so a failure is reproducible.
    const TOTAL = 100;
    const PAGE_SIZE = 5;
    const pages = Array.from({ length: TOTAL / PAGE_SIZE }, (_, pageIndex) => ({
      events: Array.from({ length: PAGE_SIZE }, (_, offset) =>
        rawLedgerEvent(501 + pageIndex * PAGE_SIZE + offset),
      ),
      cursor: `cursor-${pageIndex + 2}`,
    }));

    const requests: rpc.Api.GetEventsRequest[] = [];
    let served = 0;
    const server = {
      async getLatestLedger() {
        return { sequence: 500 };
      },
      async getEvents(request: rpc.Api.GetEventsRequest) {
        requests.push(request);
        served += 1;
        const page = pages[served - 1];
        // Past the script the chain is merely quiet: an empty page, so a
        // pump that ran ahead during the final pull ends cleanly.
        return {
          events: page?.events ?? [],
          cursor: page?.cursor ?? `cursor-${served + 1}`,
          latestLedger: 500,
        };
      },
    } as unknown as rpc.Server;

    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };

    const seen: GuardEvent[] = [];
    const stream = new GuardTelemetryListener({ server, guard: GUARD }).watch({
      pollIntervalMs: 1,
    });
    for await (const page of stream) {
      // The artificially slow consumer: "render" or "log" before pulling again.
      await settle(Math.floor(random() * 4));
      seen.push(...page);
      if (seen.length >= TOTAL) break;
    }

    assert.deepEqual(
      seen.map((event) => event.ledger),
      Array.from({ length: TOTAL }, (_, index) => 501 + index),
      "every event exactly once, in emission order",
    );
    assert.equal(seen.length, TOTAL, "100 events in, 100 events out — no loss, no duplicates");
    assert.equal(new Set(seen.map((event) => event.id)).size, TOTAL, "stable ids are unique");
    assert.ok(
      requests.length <= pages.length + DEFAULT_MAX_BUFFERED_PAGES + 1,
      `fetches stay bounded by the delivered pages plus look-ahead (fetched ${requests.length})`,
    );
  });

  it("cancels promptly on abort while a fetch is pending", async () => {
    // Under backpressure the consumer can be parked on an empty buffer while a
    // speculative fetch hangs. Abort must end the iterator then and there, not
    // wait for that request to settle — `getEvents` takes no AbortSignal.
    const requests: rpc.Api.GetEventsRequest[] = [];
    const secondFetch = deferred<unknown>();
    const server = {
      async getLatestLedger() {
        return { sequence: 500 };
      },
      getEvents(request: rpc.Api.GetEventsRequest) {
        requests.push(request);
        if (requests.length === 1) {
          return Promise.resolve({
            events: [rawLedgerEvent(501)],
            cursor: "cursor-2",
            latestLedger: 500,
          });
        }
        // Never settles until the test says so.
        return secondFetch.promise;
      },
    } as unknown as rpc.Server;

    const listener = new GuardTelemetryListener({ server, guard: GUARD });
    const controller = new AbortController();
    const stream = listener.watch({ pollIntervalMs: 1, signal: controller.signal });

    const first = await stream.next();
    assert.deepEqual(
      first.value?.map((event) => event.ledger),
      [501],
    );
    await settle(); // the pump's speculative pull is now hanging
    assert.equal(requests.length, 2, "a second fetch is in flight and unresolved");

    const parked = stream.next(); // buffer empty: the consumer is waiting
    await settle();

    const abortedAt = Date.now();
    controller.abort();
    const step = await Promise.race([parked, settle(1_000).then(() => "timeout" as const)]);
    assert.notEqual(step, "timeout", "abort must not wait for the pending fetch");
    assert.equal((step as IteratorResult<GuardEvent[]>).done, true);
    assert.ok(
      Date.now() - abortedAt < 250,
      `abort ended the stream promptly (${Date.now() - abortedAt}ms)`,
    );
    assert.equal(listener.health().state, "aborted");

    // A fetch that settles after teardown is dropped, not delivered.
    secondFetch.resolve({
      events: [rawLedgerEvent(502)],
      cursor: "cursor-3",
      latestLedger: 500,
    });
    await settle();
    assert.equal((await stream.next()).done, true, "no post-teardown delivery");
    assert.equal(requests.length, 2, "teardown issues no further fetch");
  });

  it("swallows a pending fetch that rejects after teardown", async () => {
    // The pump must not turn a request abandoned by teardown into an
    // unhandled rejection — that would crash a Node host on a normal stop.
    const rejections: unknown[] = [];
    const onRejection = (error: unknown): void => {
      rejections.push(error);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const requests: rpc.Api.GetEventsRequest[] = [];
      const secondFetch = deferred<unknown>();
      const server = {
        async getLatestLedger() {
          return { sequence: 500 };
        },
        getEvents(request: rpc.Api.GetEventsRequest) {
          requests.push(request);
          if (requests.length === 1) {
            return Promise.resolve({
              events: [rawLedgerEvent(501)],
              cursor: "cursor-2",
              latestLedger: 500,
            });
          }
          return secondFetch.promise;
        },
      } as unknown as rpc.Server;

      const controller = new AbortController();
      const stream = new GuardTelemetryListener({ server, guard: GUARD }).watch({
        pollIntervalMs: 1,
        signal: controller.signal,
      });
      await stream.next();
      await settle();
      assert.equal(requests.length, 2);

      controller.abort();
      assert.equal((await stream.next()).done, true);

      secondFetch.reject(new Error("request abandoned by teardown"));
      await settle();
      assert.deepEqual(rejections, [], "a dropped request's rejection is swallowed");
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  describe("watch() startup latest-ledger resolution (issue #281)", () => {
    it("honors a pre-aborted signal before any startup RPC", async () => {
      let getLatestLedgerCalls = 0;
      let loadCursorCalls = 0;
      const server = {
        async getLatestLedger() {
          getLatestLedgerCalls += 1;
          return { sequence: 500 };
        },
        async getEvents() {
          return { events: [], cursor: "cursor-1", latestLedger: 500 };
        },
      } as unknown as rpc.Server;
      const store: CursorStore = {
        async load() {
          loadCursorCalls += 1;
          return null;
        },
        async save() {},
      };

      const controller = new AbortController();
      controller.abort();

      const listener = new GuardTelemetryListener({
        server,
        guard: GUARD,
        cursorStore: store,
      });

      const pages: GuardEvent[][] = [];
      for await (const events of listener.watch({ signal: controller.signal })) {
        pages.push(events);
      }

      assert.equal(pages.length, 0, "no pages are yielded on pre-aborted signal");
      assert.equal(
        loadCursorCalls,
        0,
        "cursorStore.load is not called when signal is already aborted",
      );
      assert.equal(
        getLatestLedgerCalls,
        0,
        "getLatestLedger is not called when signal is already aborted",
      );
      assert.equal(listener.health().state, "aborted");
    });

    it("retries startup latest-ledger failure with backoff and recovers without wall-clock sleeps", async () => {
      let ledgerCalls = 0;
      const delays: number[] = [];
      const server = {
        async getLatestLedger() {
          ledgerCalls += 1;
          if (ledgerCalls < 3) {
            throw new Error(`rpc temporary failure attempt ${ledgerCalls}`);
          }
          return { sequence: 500 };
        },
        async getEvents() {
          return {
            events: [rawLedgerEvent(501)],
            cursor: "cursor-2",
            latestLedger: 501,
          };
        },
      } as unknown as rpc.Server;

      const listener = new GuardTelemetryListener({ server, guard: GUARD });
      const pages = await takeFrom(
        listener.watch({
          pollIntervalMs: 1,
          sleep: async (ms) => {
            delays.push(ms);
          },
          retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
        }),
        1,
      );

      assert.deepEqual(pages, [[decodedEvent(501)]], "the recovered stream delivers events");
      assert.equal(ledgerCalls, 3, "2 failed attempts + 1 successful recovery");
      assert.deepEqual(delays, [100, 200], "startup backoff delays matched exponential schedule");
      const health = listener.health();
      assert.equal(health.state, "stopped");
      assert.equal(health.consecutiveFailures, 0, "recovery resets consecutive failure counter");
    });

    it("reports terminal error via onStreamError and healthState=failed when startup latest-ledger retries are exhausted", async () => {
      let ledgerCalls = 0;
      const delays: number[] = [];
      let streamErrors = 0;
      let streamError: unknown = null;

      const server = {
        async getLatestLedger() {
          ledgerCalls += 1;
          throw new Error(`rpc down attempt ${ledgerCalls}`);
        },
        async getEvents() {
          return { events: [], cursor: "cursor-1", latestLedger: 500 };
        },
      } as unknown as rpc.Server;

      const listener = new GuardTelemetryListener({ server, guard: GUARD });
      for await (const _events of listener.watch({
        pollIntervalMs: 1,
        sleep: async (ms) => {
          delays.push(ms);
        },
        retry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 200 },
        onStreamError: (err) => {
          streamErrors += 1;
          streamError = err;
        },
      })) {
        assert.fail("a terminal stream must not yield");
      }

      assert.equal(ledgerCalls, 3, "1 initial attempt + 2 retries");
      assert.deepEqual(delays, [50, 100], "backoff delays taken before exhaustion");
      assert.equal(streamErrors, 1, "onStreamError fired exactly once at exhaustion");
      assert.ok(streamError instanceof Error);
      assert.match((streamError as Error).message, /rpc down attempt 3/);
      const health = listener.health();
      assert.equal(health.state, "failed");
      assert.equal(health.consecutiveFailures, 3);
    });

    it("an abort during startup retry backoff ends the stream promptly without stream error", async () => {
      const controller = new AbortController();
      let streamErrors = 0;
      const server = {
        async getLatestLedger() {
          throw new Error("rpc down");
        },
        async getEvents() {
          return { events: [], cursor: "cursor-1", latestLedger: 500 };
        },
      } as unknown as rpc.Server;

      const listener = new GuardTelemetryListener({ server, guard: GUARD });
      for await (const _events of listener.watch({
        pollIntervalMs: 1,
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
        },
        retry: { maxRetries: 5, baseDelayMs: 100 },
        onStreamError: () => {
          streamErrors += 1;
        },
      })) {
        assert.fail("stream should not yield");
      }

      assert.equal(streamErrors, 0, "abort during startup backoff does not fire onStreamError");
      assert.equal(listener.health().state, "aborted");
    });
  });

  describe("watch() malformed committed event isolation (issue #284)", () => {
    it("isolates malformed topic/data XDR between valid events, preserves valid neighbors and advances cursor", async () => {
      const malformedEvent = {
        contractId: GUARD,
        type: "contract" as const,
        topic: [
          {
            type: "scvSymbol",
            sym: {
              asStringOrBytes() {
                throw new Error("corrupted topic XDR");
              },
            },
          } as unknown as xdr.ScVal,
        ],
        value: xdr.ScVal.scvMap([]),
        ledger: 502,
        ledgerClosedAt: null,
        txHash: "tx-502-malformed",
      };

      const server = {
        async getLatestLedger() {
          return { sequence: 500 };
        },
        async getEvents() {
          return {
            events: [rawLedgerEvent(501), malformedEvent, rawLedgerEvent(503)],
            cursor: "cursor-page-1",
            latestLedger: 503,
          };
        },
      } as unknown as rpc.Server;

      const listener = new GuardTelemetryListener({ server, guard: GUARD });
      const malformedCounts: number[] = [];
      const malformedDiagnostics: Array<{ ledger: number; transactionHash: string | null }> = [];

      const page = await listener.poll({
        startLedger: 500,
        onMalformedEvent: (diag) => malformedDiagnostics.push(diag),
      });

      assert.equal(page.events.length, 2, "the two valid events are preserved");
      assert.equal(page.events[0]!.ledger, 501);
      assert.equal(page.events[1]!.ledger, 503);
      assert.equal(page.cursor, "cursor-page-1", "cursor advances normally");
      assert.equal(
        page.dropped.malformedEvent,
        1,
        "malformedEvent is counted in dropped breakdown",
      );
      assert.equal(page.malformedEvents, 1, "malformedEvents summary count matches");
      assert.deepEqual(malformedDiagnostics, [
        { ledger: 502, transactionHash: "tx-502-malformed" },
      ]);

      // Also verify through watch() stream
      const pages = await takeFrom(
        listener.watch({
          startLedger: 500,
          onMalformed: (count) => malformedCounts.push(count),
        }),
        1,
      );

      assert.equal(pages.length, 1);
      assert.equal(pages[0]!.length, 2);
      assert.deepEqual(malformedCounts, [1], "onMalformed callback was notified with the count");
    });
  });
});

describe("watch() safe checkpointing on interruption & crash (issue #274)", () => {
  it("does not advance cursor when consumer crashes/throws before advancing past yield", async () => {
    const page1 = { events: [rawLedgerEvent(501)], cursor: "cursor-1" };
    const page1Replay = { events: [rawLedgerEvent(501)], cursor: "cursor-1" };

    const server1 = scriptedServer([page1]).server;
    const { server: server2, requests: requests2 } = scriptedServer([page1Replay]);
    const rec = recordingCursorStore(null);

    const firstListener = new GuardTelemetryListener({
      server: server1,
      guard: GUARD,
      cursorStore: rec.store,
    });

    // Simulate crash on consumer side when processing page 1 (before resuming/advancing past yield of page 1)
    try {
      for await (const events of firstListener.watch({ pollIntervalMs: 1 })) {
        if (events[0] && events[0].ledger === 501) {
          // Check saved cursor immediately inside the yield iteration block
          // The cursor for page 1 ("cursor-1") must NOT have been saved yet!
          assert.equal(
            rec.lastStored(),
            null,
            "cursor must not be saved while consumer is processing yielded page",
          );
          throw new Error("consumer crash mid-processing");
        }
      }
    } catch (err) {
      assert.equal((err as Error).message, "consumer crash mid-processing");
    }

    assert.equal(rec.lastStored(), null, "cursor remains unadvanced after crash");

    // Second listener (simulating process restart)
    const secondListener = new GuardTelemetryListener({
      server: server2,
      guard: GUARD,
      cursorStore: rec.store,
    });
    const resumedPages = await take(secondListener, 1);

    // Should re-fetch page 1 because cursor was not saved before crash
    assert.deepEqual(
      resumedPages,
      [[decodedEvent(501)]],
      "re-delivers page 1 on restart (at-least-once guarantee)",
    );
    assert.equal(
      requests2[0]?.cursor,
      undefined,
      "first poll after restart resumes from unadvanced cursor",
    );
  });

  it("saves page cursor after consumer advances past yield", async () => {
    const pages: ScriptedPage[] = [
      { events: [rawLedgerEvent(501)], cursor: "cursor-1" },
      { events: [rawLedgerEvent(502)], cursor: "cursor-2" },
    ];
    const { server } = scriptedServer(pages);
    const rec = recordingCursorStore(null);

    const listener = new GuardTelemetryListener({ server, guard: GUARD, cursorStore: rec.store });

    const consumed: number[] = [];
    for await (const events of listener.watch({ pollIntervalMs: 1 })) {
      if (events[0] && events[0].ledger !== null) {
        consumed.push(events[0].ledger);
      }
      if (consumed.length === 1) {
        // While processing 501, rec.lastStored() is still null
        assert.equal(rec.lastStored(), null);
      } else if (consumed.length === 2) {
        // When processing 502, consumer has advanced past yield of 501, so cursor-1 is saved!
        assert.equal(rec.lastStored(), "cursor-1");
        break;
      }
    }
  });
});

describe("Bounded event-ID de-duplication (issue #278)", () => {
  it("suppresses duplicate events across overlapping pages and re-fed diagnostic batches within horizon", async () => {
    const event1: GuardEvent = {
      id: "diag:hash1",
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "diagnostic",
      stream: "diagnostic",
      contractId: GUARD,
      ledger: null,
      ledgerClosedAt: null,
      observedAt: "2026-09-14T18:20:32Z",
      transactionHash: null,
      decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
      data: {},
    };
    const event2: GuardEvent = {
      id: "diag:hash2",
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "diagnostic",
      stream: "diagnostic",
      contractId: GUARD,
      ledger: null,
      ledgerClosedAt: null,
      observedAt: "2026-09-14T18:20:32Z",
      transactionHash: null,
      decision: { result: "blocked", reason: "protocol_call_rate_exceeded", source: "diagnostic" },
      data: {},
    };

    const batches = [
      { events: [event1, event2], observedAt: "2026-09-14T18:20:32Z" },
      { events: [event2], observedAt: "2026-09-14T18:20:33Z" }, // re-fed batch
    ];

    const { mergeGuardEventStreams } = await import("../../src/telemetry.ts");
    const emitted: GuardEvent[] = [];

    for await (const event of mergeGuardEventStreams([], batches, undefined, 10)) {
      emitted.push(event);
    }

    assert.equal(emitted.length, 2);
    assert.deepEqual(
      emitted.map((e) => e.id),
      ["diag:hash1", "diag:hash2"],
    );
  });

  it("bounds retained identity state over long streams past capacity", async () => {
    const { BoundedEventDeduplicator, mergeGuardEventStreams } = await import(
      "../../src/telemetry.ts"
    );

    const dedup = new BoundedEventDeduplicator(5);
    for (let i = 1; i <= 10; i++) {
      dedup.add(`id-${i}`);
    }

    assert.equal(dedup.size, 5, "deduplicator size never exceeds capacity 5");
    assert.equal(dedup.has("id-1"), false, "oldest id-1 was evicted");
    assert.equal(dedup.has("id-5"), false, "id-5 was evicted");
    assert.equal(dedup.has("id-6"), true, "id-6 is retained");
    assert.equal(dedup.has("id-10"), true, "id-10 is retained");

    // Test eviction and re-emission past bounded horizon in stream
    const batches = Array.from({ length: 15 }, (_, i) => ({
      events: [
        {
          id: `id-${i + 1}`,
          kind: "heartbeat" as const,
          topic: "event_heartbeat",
          source: "ledger" as const,
          stream: "committed" as const,
          contractId: GUARD,
          ledger: 100 + i,
          ledgerClosedAt: null,
          observedAt: null,
          transactionHash: `tx-${i + 1}`,
          decision: null,
          data: {},
        },
      ],
      observedAt: "2026-09-14T18:20:32Z",
    }));

    const streamedEvents: GuardEvent[] = [];
    // Stream with small dedupCapacity of 5
    for await (const event of mergeGuardEventStreams([], batches, undefined, 5)) {
      streamedEvents.push(event);
    }

    assert.equal(streamedEvents.length, 15, "all 15 unique events yielded");
  });
});
