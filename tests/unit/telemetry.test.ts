/**
 * Unit tests for the telemetry decoder's pure parts.
 *
 * The payloads here are not invented: they are verbatim diagnostic event shapes
 * captured from the live testnet run recorded in `docs/event-schema.md`, wrapped
 * in the `xdr.ScVal` form the RPC actually returns. Reconstructing them by hand
 * instead would test the test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import {
  DEFAULT_JITTER_FRACTION,
  GuardEventRingBuffer,
  GuardTelemetryListener,
  computePollDelay,
  describeGuardEvent,
  diagnosticsToEvents,
  guardEventId,
  guardEventsFromDiagnostics,
  isAllowedDecision,
  mergeGuardEventStreams,
  telemetryFromDecision,
  type GuardDiagnosticBatch,
  type GuardEvent,
  type GuardTelemetryGap,
  type RecentEventFilter,
} from "../../src/telemetry.ts";
import { unsafeContractAddress } from "../../src/policy.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");

/**
 * Build a diagnostic event in the shape the RPC returns: the host's own
 * diagnostic events arrive as `{ event: { contractId, body: { v0: {...} } } }`
 * with topics as `ScVal`s.
 */
function diagnosticEvent(topics: string[], data: xdr.ScVal = xdr.ScVal.scvMap([])) {
  return {
    event: {
      contractId: GUARD,
      type: "contract",
      body: {
        v0: {
          topics: topics.map((topic) => xdr.ScVal.scvSymbol(topic)),
          data,
        },
      },
    },
  };
}

describe("guardEventsFromDiagnostics", () => {
  it("decodes a real blocked decision from the captured event", () => {
    const events = guardEventsFromDiagnostics(
      [diagnosticEvent(["event_auth_checked", "blocked", "per_tx_cap_exceeded"])],
      GUARD,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "auth_checked");
    assert.equal(events[0]!.decision?.result, "blocked");
    assert.equal(events[0]!.decision?.reason, "per_tx_cap_exceeded");
    assert.equal(events[0]!.source, "diagnostic");
  });

  it("ignores host diagnostics that are not guard events", () => {
    const events = guardEventsFromDiagnostics(
      [
        diagnosticEvent(["fn_call", "transfer"]),
        diagnosticEvent(["error", "scecExceededLimit"]),
        diagnosticEvent(["core_metrics", "cpu_insn"]),
      ],
      GUARD,
    );
    assert.deepEqual(events, []);
  });

  it("keeps only the guard event when mixed with host noise", () => {
    const events = guardEventsFromDiagnostics(
      [
        diagnosticEvent(["fn_call", "transfer"]),
        diagnosticEvent(["event_auth_checked", "blocked", "window_cap_exceeded"]),
        diagnosticEvent(["core_metrics", "write_entry"]),
      ],
      GUARD,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.decision?.reason, "window_cap_exceeded");
  });

  it("decodes an allowed decision and normalises its empty reason symbol", () => {
    const events = guardEventsFromDiagnostics(
      [diagnosticEvent(["event_auth_checked", "allowed", ""])],
      GUARD,
    );
    assert.equal(events[0]!.decision?.result, "allowed");
    assert.equal(events[0]!.decision?.reason, null);
    assert.equal(isAllowedDecision(events[0]!.decision), true);
  });

  it("decodes heartbeat data as a timestamp payload, not a topic", () => {
    const events = guardEventsFromDiagnostics(
      [
        diagnosticEvent(
          ["event_heartbeat"],
          xdr.ScVal.scvMap([
            // XDR uint64 is a native bigint in this SDK, not a constructible class.
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("at"), val: xdr.ScVal.scvU64(1789393232n) }),
          ]),
        ),
      ],
      GUARD,
    );
    assert.equal(events[0]!.kind, "heartbeat");
    assert.equal(events[0]!.decision, null);
    assert.equal(String((vents[0]!.data as { at: bigint }).at), "1789393232");
  });

  it("returns nothing for a decision with no diagnostics", () => {
    assert.deepEqual(guardEventsFromDiagnostics([]), []);
  });
});

describe("telemetryFromDecision", () => {
  it("extracts events from a blocked pre-flight decision", () => {
    const events = telemetryFromDecision(
      {
        kind: "blocked",
        reason: "recipient_not_allowed",
        diagnosticEvents: [diagnosticEvent(["event_auth_checked", "blocked", "recipient_not_allowed"])],
      },
      GUARD,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.decision?.reason, "recipient_not_allowed");
  });

  it("returns nothing for an admissible decision, which has no diagnostics", () => {
    assert.deepEqual(telemetryFromDecision({ kind: "admissible" }, GUARD), []);
  });
});

describe("diagnosticsToEvents & decode equivalence", () => {
  it("decodes diagnostic events directly via canonical diagnosticsToEvents", () => {
    const rawEvents = [
      diagnosticEvent(["fn_call", "transfer"]),
      diagnosticEvent(["event_auth_checked", "blocked", "window_cap_exceeded"]),
    ];
    const events = diagnosticsToEvents(rawEvents, GUARD);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "auth_checked");
    assert.equal(events[0]!.decision?.result, "blocked");
    assert.equal(events[0]!.decision?.reason, "window_cap_exceeded");
    assert.equal(events[0]!.source, "diagnostic");
    assert.equal(events[0]!.contractId, GUARD);
  });

  it("yields identical output from guardEventsFromDiagnostics and telemetryFromDecision for equivalent inputs", () => {
    const diagEvents = [
      diagnosticEvent(["event_auth_checked", "blocked", "per_tx_cap_exceeded"]),
      diagnosticEvent(["core_metrics", "cpu_insn"]),
    ];

    const fromDiagnostics = guardEventsFromDiagnostics(diagEvents, GUARD);
    const fromDecision = telemetryFromDecision(
      {
        kind: "blocked",
        reason: "per_tx_cap_exceeded",
        diagnosticEvents: diagEvents,
      },
      GUARD,
    );
    const fromCanonical = diagnosticsToEvents(diagEvents, GUARD);

    assert.deepEqual(fromDiagnostics, fromDecision);
    assert.deepEqual(fromDiagnostics, fromCanonical);
    assert.equal(fromDiagnostics.length, 1);
    assert.equal(fromDiagnostics[0]!.decision?.reason, "per_tx_cap_exceeded");
  });

  it("tags decoded diagnostic events with stream=diagnostic and a null observedAt", () => {
    // The `stream` discriminator is additive (issue #67): present on every
    // decoded event, derived from `source`, and `observedAt` is left null so
    // only the unified stream stamps a real observation time.
    const events = guardEventsFromDiagnostics(
      [diagnosticEvent(["event_auth_checked", "blocked", "per_tx_cap_exceeded"])],
      GUARD,
    );
    assert.equal(events[0]!.stream, "diagnostic");
    assert.equal(events[0]!.source, "diagnostic");
    assert.equal(events[0]!.observedAt, null);
  });
});

describe("describeGuardEvent", () => {
  it("labels a ledger event with its ledger number and outcome", () => {
    const text = describeGuardEvent({
      id: `ledger:${"ab".repeat(32)}:event_auth_checked`,
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "ledger",
      stream: "committed",
      contractId: GUARD,
      ledger: 4674314,
      ledgerClosedAt: null,
      observedAt: null,
      transactionHash: "ab".repeat(32),
      decision: { result: "allowed", reason: null, source: "ledger" },
      data: {},
    });
    assert.match(text, /ledger 4674314/);
    assert.match(text, /allowed/);
  });

  it("labels a blocked decision as pre-broadcast, since it has no ledger", () => {
    const text = describeGuardEvent({
      id: `diag:${"0".repeat(64)}`,
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "diagnostic",
      stream: "diagnostic",
      contractId: GUARD,
      ledger: null,
      ledgerClosedAt: null,
      observedAt: null,
      transactionHash: null,
      decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
      data: {},
    });
    assert.match(text, /pre-broadcast/);
    assert.match(text, /per_tx_cap_exceeded/);
  });
});

/**
 * Stable-id coverage (issue #33).
 *
 * A blocked decision is rolled back before broadcast, so it has no transaction
 * to anchor on — the only way a telemetry consumer can tell two refusals apart,
 * or recognise a re-parse as the same refusal, is the `id` the SDK derives.
 * Both properties are pinned here: determinism across re-parses, and
 * distinctness between two different blocks inside one simulation.
 */
describe("GuardEvent.id", () => {
  const blocked = (reason: string) =>
    diagnosticEvent(["event_auth_checked", "blocked", reason]);

  it("gives every decoded diagnostic event a non-null synthetic id", () => {
    const events = guardEventsFromDiagnostics([blocked("per_tx_cap_exceeded")], GUARD);
    assert.equal(events.length, 1);
    assert.ok(events[0]!.id.length > 0, "id must never be empty");
    assert.match(events[0]!.id, /^diag:[0-9a-f]{64}$/);
  });

  it("is deterministic: the same diagnostic event re-parsed yields the same id", () => {
    const batch = [blocked("per_tx_cap_exceeded"), blocked("recipient_not_allowed")];
    const first = guardEventsFromDiagnostics(batch, GUARD);
    const second = guardEventsFromDiagnostics(batch, GUARD);
    assert.deepEqual(
      first.map((event) => event.id),
      second.map((event) => event.id),
    );
  });

  it("keeps two distinct blocks in one simulation distinct, because their positions differ", () => {
    // Same topic list, same data: only the position within the batch separates
    // them, which is exactly the case a txHash-based id could not cover.
    const events = guardEventsFromDiagnostics([blocked("per_tx_cap_exceeded"), blocked("per_tx_cap_exceeded")], GUARD);
    assert.equal(events.length, 2);
    assert.notEqual(events[0]!.id, events[1]!.id);
  });

  it("gives the same ledger transaction's several events distinct ids", () => {
    // A heartbeat transaction commits both event_auth_checked and
    // event_heartbeat (live capture in docs/event-schema.md), so the txHash
    // alone is not an identity.
    const txHash = "ab".repeat(32);
    const decision = guardEventId({
      source: "ledger",
      topics: ["event_auth_checked", "allowed", ""],
      data: {},
      contractId: GUARD,
      ledger: 4674314,
      transactionHash: txHash,
      simulationIndex: null,
    });
    const heartbeat = guardEventId({
      source: "ledger",
      topics: ["event_heartbeat"],
      data: { at: 1789393232n },
      contractId: GUARD,
      ledger: 4674314,
      transactionHash: txHash,
      simulationIndex: null,
    });
    assert.notEqual(decision, heartbeat);
    assert.equal(decision, `ledger:${txHash}:event_auth_checked`);
    assert.equal(heartbeat, `ledger:${txHash}:event_heartbeat`);
  });

  it("anchors a committed event on its transaction hash, not on its page position", () => {
    const first = guardEventId({
      source: "ledger",
      topics: ["event_auth_checked", "blocked", "per_tx_cap_exceeded"],
      data: {},
      contractId: GUARD,
      ledger: 4674314,
      transactionHash: "cd".repeat(32),
      simulationIndex: null,
    });
    const second = guardEventId({
      source: "ledger",
      topics: ["event_auth_checked", "blocked", "per_tx_cap_exceeded"],
      data: {},
      contractId: GUARD,
      ledger: 9999999,
      transactionHash: "cd".repeat(32),
      simulationIndex: null,
    });
    assert.equal(first, second, "re-polling the ledger must not renumber an event");
  });

  it("falls back to the ledger sequence when a committed event arrives without a hash", () => {
    const id = guardEventId({
      source: "ledger",
      topics: ["event_heartbeat"],
      data: null,
      contractId: GUARD,
      ledger: 4674314,
      transactionHash: null,
      simulationIndex: null,
    });
    assert.equal(id, "ledger:4674314:event_heartbeat");
  });

  it("separates the two streams even when the content is identical", () => {
    const topics = ["event_auth_checked", "blocked", "per_tx_cap_exceeded"];
    const committed = guardEventId({
      source: "ledger",
      topics,
      data: {},
      contractId: GUARD,
      ledger: 4674314,
      transactionHash: "ef".repeat(32),
      simulationIndex: null,
    });
    const diagnostic = guardEventId({
      source: "diagnostic",
      topics,
      data: {},
      contractId: GUARD,
      ledger: null,
      transactionHash: null,
      simulationIndex: 0,
    });
    assert.notEqual(committed, diagnostic);
    assert.match(committed, /^ledger:/);
    assert.match(diagnostic, /^diag:/);
  });
});

/**
 * Polling backoff coverage (issue #67).
 *
 * `computePollDelay` is pure, so the backoff curve can be pinned exactly:
 * exponential growth, the jitter bound, and the ceiling.
 */
describe("computePollDelay", () => {
  it("grows exponentially with the attempt count", () => {
    const base = 1000;
    const cap = 60,000;
    const first = computePollDelay(1, base, cap, 0);
    const second = computePollDelay(2, base, cap, 0);
    const third = computePollDelay(3, base, cap, 0);
    assert.equal(first, base);
    assert.equal(second, base * 2);
    assert.equal(third, base * 4);
  });

  it("never exceeds the cap", () => {
    const delay = computePollDelay(50, 1000, 5,000, 0);
    assert.equal(delay, 5,000);
  });

  it("applies jitter within the configured fraction", () => {
    const base = 1000;
    const delay = computePollDelay(1, base, 60,000, DEFAULT_JITTER_FRACTION, () => 0.5);
    const low = base * (1 - DEFAULT_JITTER_FRACTION);
    const high = base * (1 + DEFAULT_JITTER_FRACTION);
    assert.ok(delay >= low && delay <= high);
  });

  it("is deterministic with a stubbed random source", () => {
    const a = computePollDelay(3, 1000, 60,000, 0.2, () => 0.1);
    const b = computePollDelay(3, 1000, 60,000, 0.2, () => 0.1);
    assert.equal(a, b);
  });
});

/**
 * Merging the two streams (issue #67).
 *
 * The listener delivers a committed event and the diagnostic event that
 * describes the same decision. `mergeGuardEventStreams` de-duplicates them on
 * the stable id and keeps the committed view.
 */
describe("mergeGuardEventStreams", () => {
  const committed: GuardEvent = {
    id: `ledger:${"ab".repeat(32)}:event_auth_checked`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "ledger",
    stream: "committed",
    contractId: GUARD,
    ledger: 4674314,
    ledgerClosedAt: null,
    observedAt: null,
    transactionHash: "ab".repeat(32),
    decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "ledger" },
    data: {},
  };
  const diagnostic: GuardEvent = {
    id: `diag:${"0".repeat(64)}`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "diagnostic",
    stream: "diagnostic",
    contractId: GUARD,
    ledger: null,
    ledgerClosedAt: null,
    observedAt: null,
    transactionHash: null,
    decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
    data: {},
  };

  it("returns the committed event alone when there is no diagnostic counterpart", () => {
    assert.deepEqual(mergeGuardEventStreams([committed], []), [committed]);
  });

  it("returns the diagnostic event alone when there is no committed counterpart", () => {
    assert.deepEqual(mergeGuardEventStreams([], [diagnostic]), [diagnostic]);
  });

  it("prefers the committed view when both streams carry the same id", () => {
    const sharedId = committed.id;
    const duplicate: GuardEvent = { ...diagnostic, id: sharedId };
    const merged = mergeGuardEventStreams([committed], [duplicate]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.stream, "committed");
  });

  it("keeps events from both streams when their ids differ", () => {
    const merged = mergeGuardEventStreams([committed], [diagnostic]);
    assert.equal(merged.length, 2);
  });
});

/**
 * `watch()` start-cursor option (issue #68).
 *
 * The listener's start position used to be implicit (RPC default). The
 * `startFrom` option makes it explicit and maps onto the stellar-sdk
 * `getEvents` start-cursor semantics:
 *
 *   - `{ ledger: N }` -> `startingLedger: N` (backfill after a cursor-store gap)
 *   - `'latest'` -> fetch the current cursor without yielding backlog
 *   - `'oldest-available'` -> no cursor / no startingLedger (replay from the beinning)
 *
 * The mocked RPC below records the exact parameters each mode sends, which
 * is the only way to pin the mapping without a live network.
 */
describe("GuardTelemetryListener.watch startFrom", () => {
  type GetEventsParams = {
    contractIds?: string[];
    cursor?: string;
    startingLedger?: number;
    limit?: number;
  };

  interface MockCall {
    params: GetEventsParams;
  }

  /**
   * Minimal fake RPC that records the parameters of every `getEvents` call
   * and returns a scripted page of events. Pages are consumed in order.
   */
  function makeMockRpc(pages: Array<{ events: unknown[]; cursor?: string }>) {
    const calls: MockCall[] = [];
    let index = 0;
    const rpc = {
      getEvents(params: GetEventsParams) {
        calls.push({ params });
        const page = pages[index] ?? { events: [] };
        index += 1;
        return Promise.resolve({
          events: page.events,
          cursor: page.cursor ?? params.cursor ?? "0",
        });
      },
    };
    return { rpc, calls };
  }

  it("maps { ledger } to a startingLedger parameter and sends no cursor", () => {
    const { rpc, calls } = makeMockRpc([{ events: [] }]);
    const listener = new GuardTelemetryListener({
      contractId: GUARD,
      rpc,
      startFrom: { ledger: 4674300 },
    });
    await listener.watch(() => {});
    assert.equal(calls.length >= 1, true);
    assert.equal(calls[0]!.params.startingLedger, 4674300);
    assert.equal(calls[0]!.params.cursor, undefined);
  });

  it("maps 'oldest-available' to neither cursor nor startingLedger", () => {
    const { rpc, calls } = makeMockRpc([{ events: [] }]);
    const listener = new GuardTelemetryListener({
      contractId: GUARD,
      rpc,
      startFrom: "oldest-available",
    });
    await listener.watch(() => {});
    assert.equal(calls[0]!.params.startingLedger, undefined);
    assert.equal(calls[0]!.params.cursor, undefined);
  });

  it("maps 'latest' to a cursor fetch and yields no backlog before new arrivals", () => {
    // Page 0: the cursor fetch that establishes "now". The backlog event
    // is present in the RPC response but must not be delivered.
    // Page 1: the next arrival, which must be delivered.
    const backlogEvent = diagnosticEvent(["event_auth_checked", "blocked", "per_tx_cap_exceeded"]);
    const newEvent = diagnosticEvent(["event_auth_checked", "blocked", "window_cap_exceeded"]);
    const { rpc, calls } = makeMockRpc([
      { events: [backlogEvent], cursor: "cursor-now" },
      { events: [newEvent], cursor: "cursor-next" },
    ]);
    const listener = new GuardTelemetryListener({
      contractId: GUARD,
      rpc,
      startFrom: "latest",
    });
    const delivered: GuardEvent[] = [];
    await listener.watch((event) => {
      delivered.push(event);
    });
    // The backlog event must not be delivered; the new arrival must be.
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.decision?.reason, "window_cap_exceeded");
    // The first call establishes the cursor without a startingLedger.
    assert.equal(calls[0]!.params.startingLedger, undefined);
    // The second call resumes from the fetched cursor.
    assert.equal(calls[1]!.params.cursor, "cursor-now");
  });

  it("lets an explicit startFrom override a stored cursor", () => {
    const { rpc, calls } = makeMockRpc([{ events: [] }]);
    const listener = new GuardTelemetryListener({
      contractId: GUARD,
      rpc,
      cursor: "cursor-from-store",
      startFrom: { ledger: 4674300 },
    });
    await listener.watch(() => {});
    assert.equal(calls[0]!.params.startingLedger, 4674300);
    assert.equal(calls[0]!.params.cursor, undefined);
  });
});

describe("GuardEventRingBuffer (issue #68)", () => {
  /** A minimal well-formed event; only the fields a test cares about are overridden. */
  function event(partial: Partial<GuardEvent>): GuardEvent {
    return {
      id: "id",
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "ledger",
      stream: "committed",
      contractId: GUARD,
      ledger: 100,
      ledgerClosedAt: null,
      observedAt: null,
      transactionHash: null,
      decision: null,
      data: null,
      ...partial,
    };
  }

  it("rejects a max that is not a positive integer", () => {
    assert.throws(() => new GuardEventRingBuffer(0), RangeError);
    assert.throws(() => new GuardEventRingBuffer(-1), RangeError);
    assert.throws(() => new GuardEventRingBuffer(2.5), RangeError);
  });

  it("evicts oldest first and preserves order once full (FIFO)", () => {
    const buffer = new GuardEventRingBuffer(5);
    for (let i = 1; i <= 8; i += 1) buffer.push(event({ id: `e${i}`, ledger: i }));

    assert.equal(buffer.size, 5, "push max+3 retains exactly max");
    assert.deepEqual(
      buffer.recent().map((entry) => entry.id),
      ["e4", "e5", "e6", "e7", "e8"],
      "the three oldest are evicted and the rest stay in order",
    );
  });

  it("keeps the newest window across many wraps of the ring", () => {
    const buffer = new GuardEventRingBuffer(3);
    for (let i = 1; i <= 100; i += 1) buffer.push(event({ id: `e${i}`, ledger: i }));
    assert.deepEqual(buffer.recent().map((entry) => entry.id), ["e98", "e99", "e100"]);
  });

  it("filters by stream and reason", () => {
    const buffer = new GuardEventRingBuffer(10);
    buffer.push(event({ id: "allowed" }));
    buffer.push(
      event({
        id: "cap",
        source: "diagnostic",
        stream: "diagnostic",
        decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
      }),
    );
    buffer.push(
      event({
        id: "paused",
        source: "diagnostic",
        stream: "diagnostic",
        decision: { result: "blocked", reason: "paused", source: "diagnostic" },
      }),
    );

    assert.deepEqual(
      buffer.recent({ stream: "diagnostic" }).map((entry) => entry.id),
      ["cap", "paused"],
    );
    assert.deepEqual(
      buffer.recent({ reason: "paused" }).map((entry) => entry.id),
      ["paused"],
    );
    assert.deepEqual(buffer.recent({ stream: "committed", reason: "paused" }), []);
  });

  it("filters by ledger range and excludes ledger-less diagnostics from a range", () => {
    const buffer = new GuardEventRingBuffer(10);
    buffer.push(event({ id: "l10", ledger: 10 }));
    buffer.push(event({ id: "l20", ledger: 20 }));
    buffer.push(event({ id: "diag", ledger: null, source: "diagnostic", stream: "diagnostic" }));

    assert.deepEqual(
      buffer.recent({ fromLedger: 15 }).map((entry) => entry.id),
      ["l20"],
    );
    assert.deepEqual(
      buffer.recent({ toLedger: 15 }).map((entry) => entry.id),
      ["l10"],
    );
    assert.deepEqual(
      buffer.recent({ fromLedger: 0, toLedger: 100 }).map((entry) => entry.id),
      ["l10", "l20"],
      "a ledger-less diagnostic is not inside a ledger range",
    );
  });

  it("hands out a copy, so a caller cannot mutate retained events", () => {
    const buffer = new GuardEventRingBuffer(2);
    buffer.push(event({ id: "a" }));
    const returned = buffer.recent();
    returned.pop();
    assert.equal(buffer.recent().length, 1);
  });
});

describe("GuardTelemetryListener opt-in buffer (issue #68)", () => {
  function rawLedgerEvent(ledger: number) {
    return {
      contractId: GUARD,
      ledger,
      ledgerClosedAt: "2026-09-27T00:00:00Z",
      txHash: "ab".repeat(32),
      topic: ["event_auth_checked", "allowed", ""].map((topic) => xdr.ScVal.scvSymbol(topic)),
      value: xdr.ScVal.scvMap([]),
    };
  }

  function singlePageServer(events: unknown[]) {
    return {
      getLatestLedger: async () => ({ sequence: 1 }),
      getEvents: async () => ({ events, cursor: "cursor_1", latestLedger: 600 }),
    };
  }

  it("retains committed events decoded by poll()", async () => {
    const server = singlePageServer([rawLedgerEvent(500)]);
    const listener = new GuardTelemetryListener({
      server: server as never,
      guard: GUARD,
      buffer: { max: 5 },
    });

    await listener.poll({ startLedger: 500 });

    const recent = listener.recent();
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.ledger, 500);
    assert.equal(recent[0]!.stream, "committed");
  });

  it("keeps nothing when no buffer is configured (default off)", async () => {
    const server = singlePageServer([rawLedgerEvent(500)]);
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });

    await listener.poll({ startLedger: 500 });

    assert.deepEqual(listener.recent(), [], "no buffer requested → recent() is always empty");
  });

  it("retains diagnostic events merged by watchAll()", async () => {
    const server = singlePageServer([]);
    const listener = new GuardTelemetryListener({
      server: server as never,
      guard: GUARD,
      buffer: { max: 5 },
    });
    const blocked = guardEventsFromDiagnostics(
      [diagnosticEvent(["event_auth_checked", "blocked", "paused"])],
      GUARD,
    );
    async function* diagnostics(): AsyncIterable<GuardDiagnosticBatch> {
      yield { events: blocked, observedAt: "2026-09-27T00:00:00Z" };
    }

    const controller = new AbortController();
    let ticks = 0;
    const seen: GuardEvent[] = [];
    for await (const event of listener.watchAll({
      startLedger: 500,
      signal: controller.signal,
      sleep: async () => {
        if (++ticks >= 2) controller.abort();
      },
      diagnostics: diagnostics(),
    })) {
      seen.push(event);
    }

    assert.ok(
      seen.some((event) => event.stream === "diagnostic"),
      "the blocked decision must reach the unified stream",
    );
    const recent = listener.recent({ stream: "diagnostic" });
    assert.equal(recent.length, 1, "the diagnostic half is what watchAll() adds to the buffer");
    assert.equal(recent[0]!.decision?.reason, "paused");
  });

  it("exposes the filter surface through the listener accessor", async () => {
    const server = singlePageServer([rawLedgerEvent(10), rawLedgerEvent(20)]);
    const listener = new GuardTelemetryListener({
      server: server as never,
      guard: GUARD,
      buffer: { max: 5 },
    });

    await listener.poll({ startLedger: 10 });

    const filter: RecentEventFilter = { stream: "committed", fromLedger: 15 };
    const filtered = listener.recent(filter);
    assert.deepEqual(
      filtered.map((event) => event.ledger),
      [20],
    );
  });
});