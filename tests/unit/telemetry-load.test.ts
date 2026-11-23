/**
 * Bounded load test for telemetry retention and serialization (issue #503).
 *
 * The ring buffer, the delivery-id deduplicator and `recentJsonLines()` are
 * exercised elsewhere with a handful of events. A 24/7 agent produces far more,
 * so this test drives the same structures at volume and pins the two properties
 * that would otherwise only show up in production:
 *
 * - **Capacity is a hard bound.** The ring never holds more than `max` events,
 *   and the deduplicator never holds more than its capacity, however many
 *   events arrive — a buffer that "mostly" respects its bound is a memory leak.
 * - **Work is linear and finishes inside a documented budget.** The budget below
 *   is deliberately generous (shared CI runners are noisy) but finite: a change
 *   that turns a push or an export into quadratic work fails here instead of in
 *   an operator's long-running listener.
 *
 * Determinism: the event set is generated from a seeded PRNG
 * (`tests/unit/seeded-random.ts`), never from wall-clock time or `Math.random`,
 * and nothing here touches the network. The hostile mix deliberately includes
 * unknown topics (which the listener drops) and repeated transaction hashes
 * (which produce duplicate stable ids), so neither can grow a structure without
 * bound.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rpc, xdr } from "@stellar/stellar-sdk";
import {
  BoundedEventDeduplicator,
  GuardEventRingBuffer,
  GuardTelemetryListener,
  parseEventRecord,
  type GuardEvent,
  type GuardEventDropCounts,
} from "../../src/telemetry.ts";
import { mulberry32 } from "./seeded-random.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

/** How many synthetic events the load test pushes through each structure. */
const EVENTS = 10_000;

/** Small enough that eviction is exercised on almost every push. */
const BUFFER_MAX = 256;

/** Delivery-id cap under test; smaller than the event count for the same reason. */
const DEDUP_CAPACITY = 512;

/**
 * Wall-clock budget for the whole body of each case, in milliseconds.
 *
 * Rationale: the three structures below are linear-time and the reference run
 * on a laptop is well under a second. 10 s leaves an order of magnitude of
 * headroom for a loaded shared CI runner while still failing a regression that
 * becomes quadratic (10,000² operations is seconds-to-minutes even in a tight
 * loop) or that starts re-serialising the retained window per event.
 */
const RUNTIME_BUDGET_MS = 10_000;

/** One synthetic committed event; `id` is a delivery key, not derived here. */
function syntheticEvent(index: number, duplicateOf?: number): GuardEvent {
  const source = duplicateOf ?? index;
  // Repeat the transaction hash every other event so ids collide in pairs:
  // the ring must still bound and the deduplicator must still collapse them.
  const txHash = `${(source >> 1).toString(16).padStart(64, "0")}`;
  return {
    id: `ledger:${txHash}:event_auth_checked`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "ledger",
    stream: "committed",
    contractId: GUARD,
    ledger: 1_000 + index,
    ledgerClosedAt: "2026-09-14T00:00:00Z",
    observedAt: null,
    transactionHash: txHash,
    decision: { result: "allowed", reason: null, source: "ledger" },
    data: { at: BigInt(index), budget: BigInt(index % 97) },
  };
}

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}

function emptyDrops(): GuardEventDropCounts {
  return {
    unknownTopic: 0,
    foreignContract: 0,
    missingContractId: 0,
    malformedContractId: 0,
    malformedEvent: 0,
  };
}

describe("telemetry retention under load (issue #503)", () => {
  it("keeps the ring buffer at its capacity and in observation order at volume", () => {
    const startedAt = performance.now();
    const buffer = new GuardEventRingBuffer(BUFFER_MAX);
    const ids: string[] = [];

    for (let index = 0; index < EVENTS; index += 1) {
      const event = syntheticEvent(index);
      ids.push(event.id);
      buffer.push(event);
      // The bound holds after *every* push, not only at the end: an eviction
      // bug that lets the window grow between full and full would be invisible
      // to a single final assertion.
      assert.equal(buffer.size, Math.min(index + 1, BUFFER_MAX));
    }

    const recent = buffer.recent();
    assert.equal(recent.length, BUFFER_MAX);
    assert.equal(recent[0]!.id, ids[EVENTS - BUFFER_MAX], "oldest retained event");
    assert.equal(recent[BUFFER_MAX - 1]!.id, ids[EVENTS - 1], "newest retained event");
    // Observation order is exactly the tail of the input order.
    assert.deepEqual(
      recent.map((event) => event.id),
      ids.slice(EVENTS - BUFFER_MAX),
    );
    assert.ok(elapsedMs(startedAt) < RUNTIME_BUDGET_MS, "ring buffer stays within budget");
  });

  it("never lets the deduplicator exceed its capacity, even with duplicate ids", () => {
    const startedAt = performance.now();
    const dedup = new BoundedEventDeduplicator(DEDUP_CAPACITY);
    const random = mulberry32(0x503);
    const seenByModel = new Set<string>();
    const modelQueue: string[] = [];
    let accepted = 0;
    let duplicates = 0;

    for (let index = 0; index < EVENTS; index += 1) {
      // A hostile mix: mostly fresh ids plus a stream of re-delivered ones.
      const duplicate = index > 0 && random() < 0.4;
      const event = duplicate
        ? syntheticEvent(index, Math.floor(random() * index))
        : syntheticEvent(index);

      if (dedup.has(event.id)) {
        duplicates += 1;
      } else {
        accepted += 1;
      }

      // The model mirrors the documented FIFO rule exactly, so the assertion
      // is about the implementation matching its contract, not about sampling
      // a lucky interleaving.
      if (!seenByModel.has(event.id)) {
        if (modelQueue.length >= DEDUP_CAPACITY) {
          const oldest = modelQueue.shift();
          if (oldest !== undefined) seenByModel.delete(oldest);
        }
        seenByModel.add(event.id);
        modelQueue.push(event.id);
      }

      dedup.add(event.id);
      assert.equal(dedup.size, seenByModel.size);
      assert.ok(dedup.size <= DEDUP_CAPACITY, "deduplicator capacity is a hard bound");
    }

    assert.ok(duplicates > 0, "the fixture actually produced duplicate ids");
    assert.equal(accepted + duplicates, EVENTS);
    assert.equal(dedup.size, seenByModel.size);
    assert.ok(elapsedMs(startedAt) < RUNTIME_BUDGET_MS, "dedup stays within budget");
  });

  it("exports at most buffer.max JSON Lines after 10,000 events, incl. unknown topics", async () => {
    const startedAt = performance.now();
    const random = mulberry32(0x504);
    let unknownTopicEvents = 0;

    const pageEvents = Array.from({ length: EVENTS }, (_, index) => {
      // Every twentieth event carries a topic this SDK does not know: the
      // listener must drop it rather than let noise push real events out.
      const unknown = index % 20 === 0;
      if (unknown) unknownTopicEvents += 1;
      const duplicateTx = index % 2 === 1;
      const txHash = `tx-${duplicateTx ? index - 1 : index}`;
      const value = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("at"),
          val: xdr.ScVal.scvU64(BigInt(Math.floor(random() * 1_000_000))),
        }),
      ]);
      return {
        contractId: GUARD,
        type: "contract" as const,
        topic: [xdr.ScVal.scvSymbol(unknown ? "event_unknown_topic" : "event_heartbeat")],
        value,
        ledger: 2_000 + index,
        ledgerClosedAt: null,
        txHash,
      };
    });

    const listener = new GuardTelemetryListener({
      server: {
        async getEvents() {
          return { cursor: "cursor-load", latestLedger: 20_000, events: pageEvents };
        },
        async getLatestLedger() {
          return { sequence: 20_000 };
        },
      } as unknown as rpc.Server,
      guard: GUARD,
      buffer: { max: BUFFER_MAX },
    });

    const result = await listener.poll({ startLedger: 1_000, cursor: "cursor-start" });
    assert.equal(result.events.length, EVENTS - unknownTopicEvents);
    assert.equal(result.dropped.unknownTopic, unknownTopicEvents);
    assert.deepEqual({ ...result.dropped, unknownTopic: 0 }, emptyDrops());

    // The retained window is the bound, not the page size.
    assert.equal(listener.recent().length, BUFFER_MAX);

    const jsonLines = listener.recentJsonLines();
    const lines = jsonLines === "" ? [] : jsonLines.slice(0, -1).split("\n");
    assert.equal(lines.length, BUFFER_MAX, "export is bounded by buffer.max");
    for (const line of lines) {
      const record = parseEventRecord(line);
      assert.equal(record.event.topic, "event_heartbeat");
    }
    // Deterministic across calls, and no unbounded intermediate is retained.
    assert.equal(listener.recentJsonLines(), jsonLines);
    assert.equal(listener.recent().length, BUFFER_MAX);

    assert.ok(elapsedMs(startedAt) < RUNTIME_BUDGET_MS, "poll + export stay within budget");
  });
});
