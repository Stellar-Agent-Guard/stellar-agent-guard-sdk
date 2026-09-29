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
  GuardTelemetryListener,
  computePollDelay,
  describeGuardEvent,
  diagnosticsToEvents,
  guardEventId,
  guardEventsFromDiagnostics,
  isAllowedDecision,
  telemetryFromDecision,
  type GuardEvent,
  type GuardTelemetryGap,
} from "../../src/telemetry.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

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
});

describe("describeGuardEvent", () => {
  it("labels a ledger event with its ledger number and outcome", () => {
    const text = describeGuardEvent({
      id: `ledger:${"ab".repeat(32)}:event_auth_checked`,
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "ledger",
      contractId: GUARD,
      ledger: 4674314,
      ledgerClosedAt: null,
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
      contractId: GUARD,
      ledger: null,
      ledgerClosedAt: null,
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
      transactionHash: "ab".repeat(32),
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
    assert.match(committed, /^ledger:/);
    assert.match(diagnostic, /^diag:/);
    assert.notEqual(committed, diagnostic);
  });

  it("does not let object key order in decoded data change the id", () => {
    const base = {
      source: "diagnostic" as const,
      topics: ["event_heartbeat"],
      contractId: GUARD,
      ledger: null,
      transactionHash: null,
      simulationIndex: 0,
    };
    assert.equal(
      guardEventId({ ...base, data: { at: 1789393232n, by: null } }),
      guardEventId({ ...base, data: { by: null, at: 1789393232n } }),
    );
  });
});

describe("isAllowedDecision", () => {
  it("is false for a null decision rather than throwing", () => {
    assert.equal(isAllowedDecision(null), false);
  });
});

describe("telemetry polling jitter", () => {
  it("defaults to full jitter with documented fraction (0.2)", () => {
    assert.equal(DEFAULT_JITTER_FRACTION, 0.2);
    // RNG = 0 => delay = interval * (1 - 0.2) = 4000
    const minDelay = computePollDelay(5_000, "full", () => 0);
    assert.equal(minDelay, 4_000);

    // RNG = 1 => delay = interval * 1.0 = 5000
    const maxDelay = computePollDelay(5_000, "full", () => 1);
    assert.equal(maxDelay, 5_000);

    // RNG = 0.5 => delay = interval * 0.9 = 4500
    const midDelay = computePollDelay(5_000, "full", () => 0.5);
    assert.equal(midDelay, 4_500);
  });

  it("produces deterministic fixed interval when jitter is none", () => {
    const d1 = computePollDelay(5_000, "none", () => 0);
    const d2 = computePollDelay(5_000, "none", () => 0.5);
    const d3 = computePollDelay(5_000, "none", () => 1);
    assert.equal(d1, 5_000);
    assert.equal(d2, 5_000);
    assert.equal(d3, 5_000);
  });

  it("delays fall within expected range and differ across ticks", () => {
    const sequence = [0.1, 0.9, 0.4, 0.7, 0.0, 1.0];
    let idx = 0;
    const rng = () => sequence[idx++ % sequence.length]!;

    const delays = Array.from({ length: 6 }, () => computePollDelay(5_000, "full", rng));
    for (const d of delays) {
      assert.ok(d >= 4_000 && d <= 5_000, `Delay ${d} outside [4000, 5000]`);
    }
    // Verify variance across ticks
    assert.notEqual(delays[0], delays[1]);
    assert.notEqual(delays[1], delays[2]);
    assert.equal(delays[4], 4_000);
    assert.equal(delays[5], 5_000);
  });

  it("watch() applies jittered delays between polling ticks", async () => {
    const delaysRecorded: number[] = [];
    const fakeServer = {
      getLatestLedger: async () => ({ sequence: 100 }),
      getEvents: async () => ({
        events: [],
        cursor: "cursor_1",
        latestLedger: 100,
      }),
    };

    const listener = new GuardTelemetryListener({
      server: fakeServer as never,
      guard: GUARD,
    });

    const controller = new AbortController();
    const rngSequence = [0.0, 0.5, 1.0];
    let rngCall = 0;

    let tick = 0;
    const watcher = listener.watch({
      pollIntervalMs: 5_000,
      jitter: "full",
      rng: () => rngSequence[rngCall++ % rngSequence.length]!,
      sleep: async (ms) => {
        delaysRecorded.push(ms);
        tick++;
        if (tick >= 3) {
          controller.abort();
        }
      },
      signal: controller.signal,
    });

    // Run the generator
    for await (const _events of watcher) {
      // no events yielded since fake response is empty
    }

    assert.deepEqual(delaysRecorded, [4_000, 4_500, 5_000]);
  });
});

/**
 * Coverage-gap detection (issue #86).
 *
 * The RPC reports its retention window (`oldestLedger` / `latestLedger`) on
 * every `getEvents` response, so a pruned range is a fact the listener can
 * prove — not a guess inferred from how sparse the events look. These tests pin
 * both halves of that: a gap is reported once with the correct bounds, and a
 * simply-quiet range is not reported at all.
 */
describe("GuardTelemetryListener coverage-gap detection", () => {
  /** A committed ledger event in the shape `poll()` reads from the RPC. */
  function ledgerEvent(ledger: number) {
    return {
      contractId: GUARD,
      type: "contract",
      ledger,
      ledgerClosedAt: "2026-09-27T00:00:00Z",
      txHash: "ab".repeat(32),
      topic: ["event_auth_checked", "allowed", ""].map((topic) => xdr.ScVal.scvSymbol(topic)),
      value: xdr.ScVal.scvMap([]),
    };
  }

  /** A fake RPC serving queued getEvents pages, recording what it was asked. */
  function pagedServer(
    pages: Array<{ events: unknown[]; oldestLedger?: number; latestLedger: number }>,
  ) {
    let index = 0;
    return {
      getLatestLedger: async () => ({ sequence: pages[0]?.latestLedger ?? 1 }),
      getEvents: async () => {
        const page = pages[Math.min(index, pages.length - 1)]!;
        index += 1;
        return { ...page, cursor: `cursor_${index}` };
      },
    };
  }

  async function drainWatch(
    listener: GuardTelemetryListener,
    params: Parameters<GuardTelemetryListener["watch"]>[0],
    abortAfterTicks: number,
  ): Promise<GuardEvent[][]> {
    const controller = new AbortController();
    let ticks = 0;
    const batches: GuardEvent[][] = [];
    for await (const batch of listener.watch({
      ...params,
      sleep: async () => {
        if (++ticks >= abortAfterTicks) controller.abort();
      },
      signal: controller.signal,
    })) {
      batches.push(batch);
    }
    return batches;
  }

  it("exposes the retention boundary on poll() for callers managing their own loop", async () => {
    const server = pagedServer([{ events: [], oldestLedger: 4778215, latestLedger: 4899174 }]);
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const page = await listener.poll({ startLedger: 4_899_000 });
    assert.equal(page.oldestLedger, 4_778_215);
    assert.equal(page.latestLedger, 4_899_174);
  });

  it("reports the pruned range exactly once when retention moved past a fresh startLedger", async () => {
    // Three polls, all with the retention edge at 500. The gap must be announced
    // on the first and then stay quiet — an alert per poll would be noise, and
    // coverage cannot un-break itself. Only the real ledger-500 event streams:
    // the missing range is reported, never filled with fabricated events.
    const server = pagedServer([
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 600 },
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 601 },
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 602 },
    ]);
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const batches = await drainWatch(
      listener,
      { startLedger: 100, onGap: (gap) => gaps.push(gap) },
      3,
    );

    assert.equal(gaps.length, 1, "once per discontinuity, not once per poll");
    assert.deepEqual(gaps[0], {
      fromLedger: 100,
      toLedger: 499,
      reason: "history_pruned",
      retainedFromLedger: 500,
      retainedToLedger: 600,
    });
    assert.deepEqual(
      batches.flat().map((event) => event.ledger),
      [500, 500, 500],
      "only real events stream — no dummies for the pruned range",
    );
  });

  it("does not report a gap when the requested range is inside the retention window", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(100)], oldestLedger: 90, latestLedger: 120 },
    ]);
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const batches = await drainWatch(
      listener,
      { startLedger: 100, onGap: (gap) => gaps.push(gap) },
      1,
    );
    assert.deepEqual(gaps, [], "a quiet-but-retained range is silence, not loss");
    assert.equal(batches.flat().length, 1);
  });

  it("uses the caller's resume ledger to prove a pruned cursor", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 600 },
    ]);
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    await drainWatch(
      listener,
      { cursor: "saved_cursor", resumeLedger: 100, onGap: (gap) => gaps.push(gap) },
      1,
    );
    assert.deepEqual(gaps, [
      {
        fromLedger: 101,
        toLedger: 499,
        reason: "history_pruned",
        retainedFromLedger: 500,
        retainedToLedger: 600,
      },
    ]);
  });

  it("reports no gap for a cursor resume that is still inside retention", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(400)], oldestLedger: 100, latestLedger: 600 },
    ]);
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    await drainWatch(
      listener,
      { cursor: "saved_cursor", resumeLedger: 100, onGap: (gap) => gaps.push(gap) },
      1,
    );
    assert.deepEqual(gaps, []);
  });

  it("cannot prove a gap from a cursor alone, and does not pretend to", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 600 },
    ]);
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    await drainWatch(listener, { cursor: "saved_cursor", onGap: (gap) => gaps.push(gap) }, 1);
    assert.deepEqual(gaps, [], "without resumeLedger the boundary cannot be derived");
  });

  it("isolates a throwing onGap so the stream keeps yielding real events", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 600 },
    ]);
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const batches = await drainWatch(
      listener,
      {
        startLedger: 100,
        onGap: () => {
          throw new Error("alerting sink is down");
        },
      },
      1,
    );
    assert.equal(batches.flat().length, 1);
    assert.equal(batches.flat()[0]!.ledger, 500);
  });

  it("skips gap detection when the host reports no retention boundary", async () => {
    const server = {
      getLatestLedger: async () => ({ sequence: 100 }),
      getEvents: async () => ({ events: [], cursor: "c", latestLedger: 100 }),
    };
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    await drainWatch(listener, { startLedger: 1, onGap: (gap) => gaps.push(gap) }, 1);
    assert.deepEqual(gaps, []);
    const page = await listener.poll({ startLedger: 1 });
    assert.equal(page.oldestLedger, null);
  });

  it("leaves the stream untouched when no onGap callback is supplied", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(50)], oldestLedger: 500, latestLedger: 600 },
    ]);
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const batches = await drainWatch(listener, { startLedger: 100 }, 1);
    assert.equal(batches.flat().length, 1);
    assert.equal(batches.flat()[0]!.ledger, 50);
  });
});

/**
 * Abort cancellation (issue #95).
 *
 * `watch({ signal })` promises teardown, not a slow fade. A stopped listener
 * must not keep issuing `getEvents` requests ("zombie polls"), must not make
 * its caller wait out the poll interval first, and must not leave the process
 * holding an unhandled rejection or an open timer.
 *
 * One limit is honest rather than papered over — `@stellar/stellar-sdk`'s
 * `getEvents` takes no `AbortSignal`, so a request already in flight cannot be
 * cancelled — and the mid-flight case below is written the way a real
 * fetch-level abort would look: the mock rejects the in-flight request when the
 * caller aborts, and the loop is asserted to end quietly rather than surfacing
 * that rejection or firing another poll.
 */
describe("GuardTelemetryListener abort cancellation (issue #95)", () => {
  /**
   * The outcome of `wait` if it settles within `ms`, or `"hung"` if it does not.
   *
   * The timer is cleared the moment the race settles, so the guard against a
   * hang is not itself an open handle — the failure mode this suite is about.
   */
  async function settledWithin<T>(wait: Promise<T>, ms = 1_000): Promise<T | "hung"> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        wait,
        new Promise<"hung">((resolve) => {
          timer = setTimeout(() => resolve("hung"), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  it("issues no RPC call at all when aborted before the first pull", async () => {
    let getEventsCalls = 0;
    let getLatestLedgerCalls = 0;
    const server = {
      getLatestLedger: async () => {
        getLatestLedgerCalls += 1;
        return { sequence: 500 };
      },
      getEvents: async () => {
        getEventsCalls += 1;
        return { events: [], cursor: "cursor_1", latestLedger: 500 };
      },
    };
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const controller = new AbortController();
    controller.abort();

    const batches: GuardEvent[][] = [];
    for await (const batch of listener.watch({ signal: controller.signal })) {
      batches.push(batch);
    }

    assert.deepEqual(batches, []);
    assert.equal(getEventsCalls, 0, "no zombie poll before the iterator even starts");
    assert.equal(
      getLatestLedgerCalls,
      0,
      "an already-aborted watch must not probe the head to resolve a default start ledger",
    );
  });

  it("ends on abort during an in-flight request, with no further poll and no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const controller = new AbortController();
      let getEventsCalls = 0;
      const server = {
        getLatestLedger: async () => ({ sequence: 500 }),
        getEvents: () => {
          getEventsCalls += 1;
          // Settles only when the caller aborts — the shape a fetch-level
          // cancellation rejection has.
          return new Promise((_resolve, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => {
                const error = new Error("The operation was aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        },
      };
      const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
      const iterator = listener
        .watch({ startLedger: 400, signal: controller.signal })[Symbol.asyncIterator]();

      const inFlight = iterator.next();
      assert.equal(getEventsCalls, 1, "the first pull dispatches exactly one request");
      controller.abort();

      // No fake timers: the abort alone has to end the iterator, and the
      // sentinel exists only so a regression fails loudly instead of hanging.
      const outcome = await settledWithin(
        inFlight.then(
          () => "ended",
          () => "threw",
        ),
      );
      assert.equal(
        outcome,
        "ended",
        "abort during an in-flight request must end the iterator, not throw or hang",
      );

      assert.equal(getEventsCalls, 1, "post-abort zombie poll: no request may follow the abort");
      assert.deepEqual(unhandled, [], "abort teardown must not produce an unhandled rejection");
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("aborts between pages without serving out the poll interval, and polls no further", async () => {
    const controller = new AbortController();
    let getEventsCalls = 0;
    const sleepDelays: number[] = [];
    const server = {
      getLatestLedger: async () => ({ sequence: 500 }),
      getEvents: async () => {
        getEventsCalls += 1;
        return { events: [], cursor: `cursor_${getEventsCalls}`, latestLedger: 500 };
      },
    };
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });

    const drain = (async () => {
      for await (const _batch of listener.watch({
        startLedger: 400,
        pollIntervalMs: 5_000,
        jitter: "none",
        signal: controller.signal,
        sleep: (ms) => {
          sleepDelays.push(ms);
          // Never settles on its own: only the abort ends this wait, so what is
          // under test is the race against the signal, not the timer.
          return new Promise<void>(() => {
            controller.abort();
          });
        },
      })) {
        // Drain: the assertion is that this loop ends at all.
      }
    })();

    const outcome = await settledWithin(
      drain.then(
        () => "ended",
        () => "threw",
      ),
    );
    assert.equal(outcome, "ended", "abort during the poll delay must end the iterator, not hang");
    assert.equal(getEventsCalls, 1, "the aborted interval must not be followed by another poll");
    assert.deepEqual(sleepDelays, [5_000], "the delay is requested once, then cut short");
  });
});

