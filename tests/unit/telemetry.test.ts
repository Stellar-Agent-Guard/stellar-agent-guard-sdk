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
  describeGuardEvent,
  guardEventId,
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
