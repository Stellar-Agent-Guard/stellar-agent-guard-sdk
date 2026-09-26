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
  guardEventsFromDiagnostics,
  isAllowedDecision,
  telemetryFromDecision,
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

