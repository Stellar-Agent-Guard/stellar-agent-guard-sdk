/**
 * Unit tests for `serializeEvent()` — the canonical JSON serialization of a
 * `GuardEvent` for deterministic JSON-lines log shipping (issue #130).
 *
 * The `GOLDEN` strings are committed on purpose: the serialized shape is a
 * contract, so a change in output must show up as a deliberate golden-string
 * diff in this file rather than slip through as an unremarked refactor. The key
 * order, the drop-`undefined` policy, and the `bigint` → decimal-string rule are
 * documented in `docs/event-schema.md` under "Canonical JSON serialization".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serializeEvent, type GuardEvent } from "../../src/telemetry.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TX = "ab".repeat(32);

/** The stream facts shared by every committed fixture. */
const committed = {
  source: "ledger",
  stream: "committed",
  contractId: GUARD,
  ledgerClosedAt: "2026-09-14T00:00:00Z",
  observedAt: null,
  transactionHash: TX,
} as const;

/** The stream facts shared by every diagnostic fixture. */
const diagnostic = {
  source: "diagnostic",
  stream: "diagnostic",
  contractId: GUARD,
  ledger: null,
  ledgerClosedAt: null,
  observedAt: "2026-09-14T00:00:01Z",
  transactionHash: null,
} as const;

/** One representative event per `GuardEventKind`, plus both auth decisions. */
const FIXTURES: GuardEvent[] = [
  {
    id: `ledger:${TX}:event_auth_checked`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    ...committed,
    ledger: 4673929,
    decision: { result: "allowed", reason: null, source: "ledger" },
    data: {},
  },
  {
    id: `diag:${"0".repeat(64)}`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    ...diagnostic,
    decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
    data: {},
  },
  {
    id: `ledger:${TX}:event_heartbeat`,
    kind: "heartbeat",
    topic: "event_heartbeat",
    ...committed,
    ledger: 4673929,
    decision: null,
    data: { at: 1789393232n },
  },
  {
    id: `ledger:${TX}:event_initialized`,
    kind: "initialized",
    topic: "event_initialized",
    ...committed,
    ledger: 4673900,
    decision: null,
    data: { by: GUARD },
  },
  {
    id: `ledger:${TX}:event_frozen`,
    kind: "frozen",
    topic: "event_frozen",
    ...committed,
    ledger: 4673901,
    decision: null,
    data: { by: GUARD },
  },
  {
    id: `ledger:${TX}:event_unfrozen`,
    kind: "unfrozen",
    topic: "event_unfrozen",
    ...committed,
    ledger: 4673902,
    decision: null,
    data: { by: GUARD },
  },
  {
    id: `ledger:${TX}:event_policy_set`,
    kind: "policy_set",
    topic: "event_policy_set",
    ...committed,
    ledger: 4673903,
    decision: null,
    data: { by: GUARD },
  },
  {
    id: `ledger:${TX}:event_policy_revoked`,
    kind: "policy_revoked",
    topic: "event_policy_revoked",
    ...committed,
    ledger: 4673904,
    decision: null,
    data: { by: GUARD },
  },
  {
    id: `ledger:${TX}:event_unknown`,
    kind: "unknown",
    topic: "event_unknown",
    ...committed,
    ledger: 4673905,
    decision: null,
    data: null,
  },
];

/** The committed golden rendering of each fixture, in order. */
const GOLDEN: string[] = [
  `{"id":"ledger:${TX}:event_auth_checked","kind":"auth_checked","topic":"event_auth_checked","source":"ledger","stream":"committed","contractId":"${GUARD}","ledger":4673929,"ledgerClosedAt":"2026-09-14T00:00:00Z","observedAt":null,"transactionHash":"${TX}","decision":{"result":"allowed","reason":null,"source":"ledger"},"data":{}}`,
  `{"id":"diag:${"0".repeat(64)}","kind":"auth_checked","topic":"event_auth_checked","source":"diagnostic","stream":"diagnostic","contractId":"${GUARD}","ledger":null,"ledgerClosedAt":null,"observedAt":"2026-09-14T00:00:01Z","transactionHash":null,"decision":{"result":"blocked","reason":"per_tx_cap_exceeded","source":"diagnostic"},"data":{}}`,
  `{"id":"ledger:${TX}:event_heartbeat","kind":"heartbeat","topic":"event_heartbeat","source":"ledger","stream":"committed","contractId":"${GUARD}","ledger":4673929,"ledgerClosedAt":"2026-09-14T00:00:00Z","observedAt":null,"transactionHash":"${TX}","decision":null,"data":{"at":"1789393232"}}`,
  `{"id":"ledger:${TX}:event_initialized","kind":"initialized","topic":"event_initialized","source":"ledger","stream":"committed","contractId":"${GUARD}","ledger":4673900,"ledgerClosedAt":"2026-09-14T00:00:00Z","observedAt":null,"transactionHash":"${TX}","decision":null,"data":{"by":"${GUARD}"}}`,
  `{"id":"ledger:${TX}:event_frozen","kind":"frozen","topic":"event_frozen","source":"ledger","stream":"committed","contractId":"${GUARD}","ledger":4673901,"ledgerClosedAt":"2026-09-14T00:00:00Z","observedAt":null,"transactionHash":"${TX}","decision":null,"data":{"by":"${GUARD}"}}`,
  `{"id":"ledger:${TX}:event_unfrozen","kind":"unfrozen","topic":"event_unfrozen","source":"ledger","stream":"committed","contractId":"${GUARD}","ledger":4673902,"ledgerClosedAt":"2026-09-14T00:00:00Z","observedAt":null,"transactionHash":"${TX}","decision":null,"data":{"by":"${GUARD}"}}`,
  `{"id":"ledger:${TX}:event_policy_set","kind":"policy_set","topic":"event_policy_set","source":"ledger","stream":"committed","contractId":"${GUARD}","ledger":4673903,"ledgerClosedAt":"2026-09-14T00:00:00Z","observedAt":null,"transactionHash":"${TX}","decision":null,"data":{"by":"${GUARD}"}}`,
  `{"id":"ledger:${TX}:event_policy_revoked","kind":"policy_revoked","topic":"event_policy_revoked","source":"ledger","stream":"committed","contractId":"${GUARD}","ledger":4673904,"ledgerClosedAt":"2026-09-14T00:00:00Z","observedAt":null,"transactionHash":"${TX}","decision":null,"data":{"by":"${GUARD}"}}`,
  `{"id":"ledger:${TX}:event_unknown","kind":"unknown","topic":"event_unknown","source":"ledger","stream":"committed","contractId":"${GUARD}","ledger":4673905,"ledgerClosedAt":"2026-09-14T00:00:00Z","observedAt":null,"transactionHash":"${TX}","decision":null,"data":null}`,
];

/**
 * The documented normalizations, applied to an input so it can be compared to
 * `JSON.parse(serializeEvent(input))`: `bigint` → decimal string,
 * `Uint8Array` → `bytes:<hex>`, `undefined` dropped from objects (rendered as
 * `null` inside arrays).
 */
function normalized(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString("hex")}`;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const result = normalized(item);
      return result === undefined ? null : result;
    });
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = normalized(item);
      if (result !== undefined) out[key] = result;
    }
    return out;
  }
  return value;
}

describe("serializeEvent golden strings", () => {
  FIXTURES.forEach((event, index) => {
    it(`serializes the ${event.kind} fixture deterministically`, () => {
      assert.equal(serializeEvent(event), GOLDEN[index]);
    });
  });

  it("covers one fixture for every GuardEventKind", () => {
    const kinds = new Set(FIXTURES.map((event) => event.kind));
    assert.deepEqual(
      [...kinds].sort(),
      [
        "auth_checked",
        "frozen",
        "heartbeat",
        "initialized",
        "policy_revoked",
        "policy_set",
        "unfrozen",
        "unknown",
      ],
    );
  });
});

describe("serializeEvent contract", () => {
  it("emits top-level keys in the documented order", () => {
    const parsed = JSON.parse(serializeEvent(FIXTURES[0]!)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), [
      "id",
      "kind",
      "topic",
      "source",
      "stream",
      "contractId",
      "ledger",
      "ledgerClosedAt",
      "observedAt",
      "transactionHash",
      "decision",
      "data",
    ]);
    assert.deepEqual(Object.keys(parsed.decision as Record<string, unknown>), [
      "result",
      "reason",
      "source",
    ]);
  });

  it("drops undefined fields — top-level and nested — rather than emitting them", () => {
    const withUndefined = {
      ...FIXTURES[1]!,
      data: { at: undefined, keep: "yes" },
      extra: undefined,
    } as unknown as GuardEvent;
    const output = serializeEvent(withUndefined);
    assert.equal(output.includes("undefined"), false);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.equal("extra" in parsed, false);
    assert.deepEqual(parsed.data, { keep: "yes" });
  });

  it("keeps null — a real value on stream-dependent fields — in the output", () => {
    const parsed = JSON.parse(serializeEvent(FIXTURES[1]!)) as Record<string, unknown>;
    assert.equal(parsed.ledger, null);
    assert.equal(parsed.transactionHash, null);
    assert.equal("ledger" in parsed, true);
    assert.equal("transactionHash" in parsed, true);
  });

  it("renders bigint as a decimal string, valid JSON that JSON.parse reads back", () => {
    const output = serializeEvent(FIXTURES[2]!);
    assert.match(output, /"data":\{"at":"1789393232"\}/u);
    const parsed = JSON.parse(output) as { data: { at: unknown } };
    assert.equal(parsed.data.at, "1789393232");
  });

  it("renders a byte array with the repo's bytes:<hex> normalization", () => {
    const event = {
      ...FIXTURES[0]!,
      data: { blob: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]) },
    } as GuardEvent;
    const parsed = JSON.parse(serializeEvent(event)) as { data: { blob: unknown } };
    assert.equal(parsed.data.blob, "bytes:deadbeef");
  });

  it("renders undefined inside an array as null so indices stay stable", () => {
    const event = { ...FIXTURES[0]!, data: [1, undefined, 3] } as unknown as GuardEvent;
    const parsed = JSON.parse(serializeEvent(event)) as { data: unknown[] };
    assert.deepEqual(parsed.data, [1, null, 3]);
  });

  it("round-trips: JSON.parse(serializeEvent(e)) is shape-equal modulo normalization", () => {
    for (const event of FIXTURES) {
      assert.deepEqual(JSON.parse(serializeEvent(event)), normalized(event));
    }
  });

  it("never throws on a bigint payload (JSON.stringify would)", () => {
    assert.throws(() => JSON.stringify({ at: 1789393232n }));
    assert.doesNotThrow(() => serializeEvent(FIXTURES[2]!));
  });
});
