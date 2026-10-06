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
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("at"), val: xdr.ScVal.scvU54(1789393232n) }),
          ]),
        ),
      ],
      GUARD,
    );
    assert.equal(events[0]!.kind, "heartbeat");
    assert.equal(events[0]!.decision, null);
    assert.equal(String((events[0]!.data as { at: bigint }).at), "1789393232");
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
    assert.match(diagnostic, /^diag:[0-9a-f]{64}$/);
  });
});

describe("mergeGuardEventStreams", () => {
  const event = (id: string, observedAt: number | null): GuardEvent => ({
    id: `diag:${id}`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "diagnostic",
    stream: "diagnostic",
    contractId: GUARD,
    ledger: null,
    ledgerClosedAt: null,
    observedAt,
    transactionHash: null,
    decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
    data: {},
  });

  it("dedupes events that appear in both streams", () => {
    const shared = event("a".repeat(64), 100);
    const merged = mergeGuardEventStreams([shared], [{ ...shared, stream: "committed", source: "ledger" }]);
    assert.equal(merged.length, 1);
  });

  it("orders the merged stream by observation time", () => {
    const late = event("b".repeat(64), 200);
    const early = event("c".repeat(64), 100);
    const merged = mergeGuardEventStreams([late], [early]);
    assert.deepEqual(merged.map((e: GuardEvent) => e.observedAt), [100, 200]);
  });
});

describe("computePollDelay", () => {
  it("uses the configured base delay without jitter when the fraction is zero", () => {
    assert.equal(computePollDelay(1000, 0, () => 0.99), 1000);
  });

  it("applies jitter within the configured fraction", () => {
    const delay = computePollDelay(1000, DEFAULT_JITTER_FRACTION, () => 1);
    assert.ok(delay >= 1000);
    assert.ok(delay <= 1000 * (1 + DEFAULT_JITTER_FRACTION));
  });
});

describe("GuardTelemetryListener counters", () => {
  const decisionEvent = (result: "allowed" | "blocked", reason: string | null, index: number): GuardEvent => ({
    id: `diag:${index.toString(16).zedStart(64, "0")}`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "diagnostic",
    stream: "diagnostic",
    contractId: GUARD,
    ledger: null,
    ledgerClosedAt: null,
    observedAt: index,
    transactionHash: null,
    decision: { result, reason, source: "diagnostic" },
    data: {},
  });

  it("does not allocat counters by default and returns null from stats()", () => {
    const listener = new GuardTelemetryListener();
    assert.equal(listener.stats(), null);
  });

  it("counts allowed and blocked decisions by reason over a count-window", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 20 } });
    const reasons = ["per_tx_cap_exceeded", "window_cap_exceeded", "recipient_not_allowed"];
    for (let i = 0; i < 20; i++) {
      const blocked = i % 2 === 0;
      listener.observe(
        decisionEvent(blocked ? "blocked" : "allowed", blocked ? reasons[(i / 2) % 3]! : null, i),
      );
    }
    const stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.allowed, 10);
    assert.equal(stats!.blocked, 10);
    assert.deepEqual(stats!.byReason, {
      per_tx_cap_exceeded: 4,
      window_cap_exceeded: 3,
      recipient_not_allowed: 3,
    });
  });

  it("evicts old events once the count window is exceeded", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 5 } });
    for (let i = 0; i < 5; i++) {
      listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", i));
    }
    for (let i = 5; i < 10; i++) {
      listener.observe(decisionEvent("allowed", null, i));
    }
    const stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.allowed, 5);
    assert.equal(stats!.blocked, 0);
    assert.deepEqual(stats!.byReason, {});
  });

  it("returns a deep-copied snapshot that callers cannot mutate", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 10 } });
    listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", 0));
    const first = listener.stats();
    assert.ok(first);
    first!.allowed = 999;
    first!.byReason.per_tx_cap_exceeded = 999;
    const second = listener.stats();
    assert.equal(second!.allowed, 0);
    assert.equal(second!.byReason.per_tx_cap_exceeded, 1);
  });

  it("supports a time-window with an injected clock", () => {
    let now = 0;
    const listener = new GuardTelemetryListener( {
      counters: { windowMs: 1000 },
      clock: () => now,
    });
    listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", 0));
    now = 500;
    listener.observe(decisionEvent("allowed", null, 1));
    now = 1500;
    listener.observe(decisionEvent("allowed", null, 2));
    const stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.allowed, 2);
    assert.equal(stats!.blocked, 0);
  });
});

describe("GuardTelemetryGap", () => {
  it("exposes a gap description for consumers", () => {
    const gap: GuardTelemetryGap = {
      fromLedger: 1,
      toLedge: 2,
      reason: "rpc-error",
    };
    assert.equal(gap.fromLedger, 1);
  });
});

describe("GuardDiagnosticBatch", () => {
  it("accepts a batch of raw diagnostic events", () => {
    const batch: GuardDiagnosticBatch = [diagnosticEvent(["event_auth_checked", "allowed", ""])];
    assert.equal(batch.length, 1);
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

/**
 * Opt-in raw event retention (issue #94).
 *
 * When a decoded verdict looks wrong, the raw payload is the evidence an SDK
 * bug report needs. It is off by default because the payload (XDR `ScVal`s,
 * host-shaped objects) is large enough that retaining it for every event is a
 * memory decision, not a convenience. These tests pin both halves: the source
 * object is attached when asked for, and *absent* — not merely empty —
 * otherwise, so the default path keeps discarding it.
 */
describe("opt-in raw event retention (issue #94)", () => {
  const blockedEvent = () =>
    diagnosticEvent(["event_auth_checked", "blocked", "per_tx_cap_exceeded"]);

  it("omits the raw field entirely by default, including on guardEventsFromDiagnostics", () => {
    const events = guardEventsFromDiagnostics([blockedEvent()], GUARD);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.raw, undefined);
    assert.ok(
      !("raw" in events[0]!),
      "the default decode must not retain the source payload at all",
    );
  });

  it("attaches the exact source event object when includeRaw is enabled", () => {
    const source = blockedEvent();
    const events = guardEventsFromDiagnostics([source], GUARD, { includeRaw: true });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.raw, source);
    // Same reference, not a copy: a bug report should carry what the SDK saw.
    assert.equal(events[0]!.raw, source);
  });

  it("keeps includeRaw off when the option object is present but false", () => {
    const events = diagnosticsToEvents([blockedEvent()], GUARD, { includeRaw: false });
    assert.ok(!("raw" in events[0]!));
  });

  it("forwards includeRaw through telemetryFromDecision", () => {
    const source = blockedEvent();
    const events = telemetryFromDecision(
      { kind: "blocked", reason: "per_tx_cap_exceeded", diagnosticEvents: [source] },
      GUARD,
      { includeRaw: true },
    );
    assert.deepEqual(events[0]!.raw, source);
  });

  it("retains the ledger RPC event only when the listener opts in", async () => {
    function rawLedgerEvent() {
      return {
        contractId: GUARD,
        type: "contract",
        ledger: 500,
        ledgerClosedAt: "2026-09-27T00:00:00Z",
        txHash: "ab".repeat(32),
        topic: ["event_auth_checked", "allowed", ""].map((topic) => xdr.ScVal.scvSymbol(topic)),
        value: xdr.ScVal.scvMap([]),
      };
    }
    function server() {
      return {
        getLatestLedger: async () => ({ sequence: 1 }),
        getEvents: async () => ({ events: [rawLedgerEvent()], cursor: "c", latestLedger: 600 }),
      };
    }

    const off = new GuardTelemetryListener({ server: server() as never, guard: GUARD });
    const offPage = await off.poll({ startLedger: 500 });
    assert.equal(offPage.events[0]!.raw, undefined);
    assert.ok(!("raw" in offPage.events[0]!));

    const on = new GuardTelemetryListener({
      server: server() as never,
      guard: GUARD,
      includeRaw: true,
    });
    const onPage = await on.poll({ startLedger: 500 });
    assert.deepEqual(onPage.events[0]!.raw, rawLedgerEvent());
  });

  it("preserves raw across the unified stream's diagnostic tagging", async () => {
    const source = blockedEvent();
    const batch: GuardDiagnosticBatch = {
      events: guardEventsFromDiagnostics([source], GUARD, { includeRaw: true }),
      observedAt: "2026-09-27T00:00:00Z",
    };
    const seen: GuardEvent[] = [];
    for await (const event of mergeGuardEventStreams([], [batch])) {
      seen.push(event);
    }
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.raw, source);
  });
});

