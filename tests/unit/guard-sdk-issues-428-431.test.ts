/**
 * Tests for issues #428, #429, #430, #431.
 *
 * #428 — watchPolicyFile: debounced policy watcher with SHA-256 dedup
 * #429 — onStateChange callback on GuardTelemetryWatchParams
 * #430 — since / until time filters on RecentEventFilter
 * #431 — TelemetryMetricsSink + NOOP_METRICS_SINK + metrics on GuardTelemetryConfig
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { rpc, xdr } from "@stellar/stellar-sdk";
import {
  InvalidInputError,
  PolicyDecodeError,
  PolicyFileReadError,
  PolicyValidationError,
  policyToJson,
  unsafeAccountAddress,
  unsafeContractAddress,
  type PolicyConfig,
} from "../../src/index.ts";
import { watchPolicyFile } from "../../src/fs.ts";
import {
  GuardEventRingBuffer,
  GuardTelemetryListener,
  NOOP_METRICS_SINK,
  type GuardEvent,
  type GuardTelemetryStateChange,
  type RecentEventFilter,
  type TelemetryMetricsSink,
} from "../../src/telemetry.ts";

// ─── shared fixtures ──────────────────────────────────────────────────────────

const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");
const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

function samplePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: [TOKEN],
    protocols: [],
    recipients: [RECIPIENT],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
    ...overrides,
  };
}

function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── #428: watchPolicyFile ────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "guard-sdk-428-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function writeTemp(name: string, content: string): string {
  const file = join(scratch, name);
  writeFileSync(file, content, "utf8");
  return file;
}

describe("watchPolicyFile (issue #428)", () => {
  it("calls onPolicy immediately with the initial valid policy", async () => {
    const policy = samplePolicy();
    const file = writeTemp("watch-initial.json", JSON.stringify(policyToJson(policy)));
    const received: unknown[] = [];
    const ac = new AbortController();

    const done = watchPolicyFile(file, {
      onPolicy: (p) => received.push(p),
      signal: ac.signal,
    });
    ac.abort();
    await done;

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], policy);
  });

  it("resolves without calling onPolicy when the file is missing", async () => {
    const missing = join(scratch, "no-such-file.json");
    const errors: unknown[] = [];
    const ac = new AbortController();

    const done = watchPolicyFile(missing, {
      onPolicy: () => assert.fail("should not be called"),
      onError: (e) => errors.push(e),
      signal: ac.signal,
    });
    ac.abort();
    await done;

    assert.equal(errors.length, 1);
    assert(errors[0] instanceof PolicyFileReadError);
    assert.equal((errors[0] as PolicyFileReadError).code, "ENOENT");
  });

  it("calls onError with PolicyDecodeError for invalid JSON", async () => {
    const file = writeTemp("watch-invalid.json", "{ not json");
    const errors: unknown[] = [];
    const ac = new AbortController();

    const done = watchPolicyFile(file, {
      onPolicy: () => assert.fail("should not be called"),
      onError: (e) => errors.push(e),
      signal: ac.signal,
    });
    ac.abort();
    await done;

    assert.equal(errors.length, 1);
    assert(errors[0] instanceof PolicyDecodeError);
  });

  it("calls onError with PolicyValidationError for a structurally invalid policy", async () => {
    const badPolicy = samplePolicy({ recipients: [RECIPIENT, RECIPIENT] });
    const file = writeTemp("watch-invalid-policy.json", JSON.stringify(policyToJson(badPolicy)));
    const errors: unknown[] = [];
    const ac = new AbortController();

    const done = watchPolicyFile(file, {
      onPolicy: () => assert.fail("should not be called"),
      onError: (e) => errors.push(e),
      signal: ac.signal,
    });
    ac.abort();
    await done;

    assert.equal(errors.length, 1);
    assert(errors[0] instanceof PolicyValidationError);
  });

  it("resolves immediately when signal is already aborted", async () => {
    const policy = samplePolicy();
    const file = writeTemp("watch-pre-aborted.json", JSON.stringify(policyToJson(policy)));
    const ac = new AbortController();
    ac.abort(); // abort before calling

    const received: unknown[] = [];
    await watchPolicyFile(file, {
      onPolicy: (p) => received.push(p),
      signal: ac.signal,
    });

    // Initial load still happens even when pre-aborted
    assert.equal(received.length, 1);
  });

  it("never rejects — a throwing onPolicy callback is swallowed", async () => {
    const policy = samplePolicy();
    const file = writeTemp("watch-throw.json", JSON.stringify(policyToJson(policy)));
    const ac = new AbortController();

    const done = watchPolicyFile(file, {
      onPolicy: () => { throw new Error("observer exploded"); },
      signal: ac.signal,
    });
    ac.abort();
    // Should not reject
    await assert.doesNotReject(() => done);
  });
});

// ─── #430: since / until on RecentEventFilter ─────────────────────────────────

function makeEvent(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return {
    id: "ledger:tx1:event_heartbeat",
    kind: "heartbeat",
    topic: "event_heartbeat",
    source: "ledger",
    stream: "committed",
    contractId: GUARD,
    ledger: 100,
    ledgerClosedAt: null,
    observedAt: null,
    transactionHash: "tx1",
    decision: null,
    data: { at: 100n },
    ...overrides,
  };
}

describe("RecentEventFilter since/until (issue #430)", () => {
  it("since filters out events before the lower bound", () => {
    const buf = new GuardEventRingBuffer(10);
    buf.push(makeEvent({ id: "e1", ledgerClosedAt: "2024-01-01T00:00:00Z" }));
    buf.push(makeEvent({ id: "e2", ledgerClosedAt: "2024-06-01T00:00:00Z" }));
    buf.push(makeEvent({ id: "e3", ledgerClosedAt: "2025-01-01T00:00:00Z" }));

    const filter: RecentEventFilter = { since: "2024-04-01T00:00:00Z" };
    const results = buf.recent(filter);

    assert.equal(results.length, 2);
    assert.equal(results[0]!.id, "e2");
    assert.equal(results[1]!.id, "e3");
  });

  it("until filters out events after the upper bound", () => {
    const buf = new GuardEventRingBuffer(10);
    buf.push(makeEvent({ id: "e1", ledgerClosedAt: "2024-01-01T00:00:00Z" }));
    buf.push(makeEvent({ id: "e2", ledgerClosedAt: "2024-06-01T00:00:00Z" }));
    buf.push(makeEvent({ id: "e3", ledgerClosedAt: "2025-01-01T00:00:00Z" }));

    const filter: RecentEventFilter = { until: "2024-07-01T00:00:00Z" };
    const results = buf.recent(filter);

    assert.equal(results.length, 2);
    assert.equal(results[0]!.id, "e1");
    assert.equal(results[1]!.id, "e2");
  });

  it("since and until together bound a window", () => {
    const buf = new GuardEventRingBuffer(10);
    buf.push(makeEvent({ id: "e1", ledgerClosedAt: "2024-01-01T00:00:00Z" }));
    buf.push(makeEvent({ id: "e2", ledgerClosedAt: "2024-06-01T00:00:00Z" }));
    buf.push(makeEvent({ id: "e3", ledgerClosedAt: "2025-01-01T00:00:00Z" }));

    const filter: RecentEventFilter = {
      since: "2024-04-01T00:00:00Z",
      until: "2024-08-01T00:00:00Z",
    };
    const results = buf.recent(filter);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, "e2");
  });

  it("accepts Date objects for since and until", () => {
    const buf = new GuardEventRingBuffer(10);
    buf.push(makeEvent({ id: "e1", ledgerClosedAt: "2024-01-01T00:00:00Z" }));
    buf.push(makeEvent({ id: "e2", ledgerClosedAt: "2025-01-01T00:00:00Z" }));

    const filter: RecentEventFilter = {
      since: new Date("2024-07-01T00:00:00Z"),
    };
    const results = buf.recent(filter);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, "e2");
  });

  it("events with null ledgerClosedAt fall back to observedAt", () => {
    const buf = new GuardEventRingBuffer(10);
    buf.push(makeEvent({ id: "e1", ledgerClosedAt: null, observedAt: "2024-06-01T00:00:00Z" }));
    buf.push(makeEvent({ id: "e2", ledgerClosedAt: null, observedAt: null }));

    const filter: RecentEventFilter = { since: "2024-04-01T00:00:00Z" };
    const results = buf.recent(filter);

    // e1 passes (observedAt >= since), e2 excluded (null timestamp)
    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, "e1");
  });

  it("throws InvalidInputError with rule 'valid_date' for a bad since string", () => {
    const buf = new GuardEventRingBuffer(10);
    buf.push(makeEvent({ id: "e1", ledgerClosedAt: "2024-01-01T00:00:00Z" }));

    assert.throws(
      () => buf.recent({ since: "not-a-date" }),
      (error: unknown) => {
        assert(error instanceof InvalidInputError);
        assert.equal(error.rule, "valid_date");
        assert.equal(error.field, "filter.since");
        return true;
      },
    );
  });

  it("throws InvalidInputError with rule 'valid_date' for a bad until string", () => {
    const buf = new GuardEventRingBuffer(10);
    buf.push(makeEvent({ id: "e1", ledgerClosedAt: "2024-01-01T00:00:00Z" }));

    assert.throws(
      () => buf.recent({ until: "bad-date" }),
      (error: unknown) => {
        assert(error instanceof InvalidInputError);
        assert.equal(error.rule, "valid_date");
        assert.equal(error.field, "filter.until");
        return true;
      },
    );
  });
});

// ─── #431: TelemetryMetricsSink / NOOP_METRICS_SINK ──────────────────────────

describe("TelemetryMetricsSink / NOOP_METRICS_SINK (issue #431)", () => {
  it("NOOP_METRICS_SINK.counter() does not throw", () => {
    assert.doesNotThrow(() => NOOP_METRICS_SINK.counter("test", 1, { a: "b" }));
    assert.doesNotThrow(() => NOOP_METRICS_SINK.counter("test", 1));
  });

  it("NOOP_METRICS_SINK.gauge() does not throw", () => {
    assert.doesNotThrow(() => NOOP_METRICS_SINK.gauge("test", 42, { env: "prod" }));
    assert.doesNotThrow(() => NOOP_METRICS_SINK.gauge("test", 42));
  });

  it("a custom sink receives counter and gauge calls from watch()", async () => {
    const counters: Array<{ name: string; value: number; labels?: Record<string, string> | undefined }> = [];
    const gauges: Array<{ name: string; value: number; labels?: Record<string, string> | undefined }> = [];

    const sink: TelemetryMetricsSink = {
      counter(name, value, labels?) { counters.push({ name, value, ...(labels !== undefined ? { labels } : {}) }); },
      gauge(name, value, labels?) { gauges.push({ name, value, ...(labels !== undefined ? { labels } : {}) }); },
    };

    const server = {
      async getLatestLedger() { return { sequence: 500 }; },
      async getEvents(_req: rpc.Api.GetEventsRequest) {
        return {
          events: [{
            contractId: GUARD,
            type: "contract" as const,
            topic: [xdr.ScVal.scvSymbol("event_heartbeat")],
            value: xdr.ScVal.scvMap([
              new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("at"), val: xdr.ScVal.scvU64(1n) }),
            ]),
            ledger: 1,
            ledgerClosedAt: null,
            txHash: "tx1",
          }],
          cursor: "1",
          latestLedger: 500,
        };
      },
    };

    const listener = new GuardTelemetryListener({
      server: server as unknown as rpc.Server,
      guard: GUARD,
      metrics: sink,
    });

    const ac = new AbortController();
    const stream = listener.watch({ pollIntervalMs: 1, signal: ac.signal });
    // consume one page then stop
    for await (const _events of stream) { ac.abort(); }

    // After one successful poll, guard_telemetry_events_observed gauge should be recorded
    const eventsGauge = gauges.find((g) => g.name === "guard_telemetry_events_observed");
    assert.ok(eventsGauge, "gauge guard_telemetry_events_observed must be emitted");
    assert.equal(eventsGauge.value, 1);
  });
});

// ─── #429: onStateChange callback ────────────────────────────────────────────

describe("onStateChange callback (issue #429)", () => {
  it("fires with from=idle, to=running on stream start", async () => {
    const changes: GuardTelemetryStateChange[] = [];

    const server = {
      async getLatestLedger() { return { sequence: 500 }; },
      async getEvents(_req: rpc.Api.GetEventsRequest) {
        return { events: [], cursor: "1", latestLedger: 500 };
      },
    };

    const listener = new GuardTelemetryListener({
      server: server as unknown as rpc.Server,
      guard: GUARD,
    });

    const ac = new AbortController();
    // Abort after a short delay so the stream starts and fires state changes
    setTimeout(() => ac.abort(), 50);

    for await (const _events of listener.watch({
      pollIntervalMs: 1,
      signal: ac.signal,
      onStateChange: (c) => changes.push(c),
    })) { /* drain */ }

    const startChange = changes.find((c) => c.from === "idle" && c.to === "running");
    assert.ok(startChange, "should fire idle→running on stream start");
    assert.ok(startChange.at, "at must be an ISO string");
    assert.ok(startChange.reason, "reason must be set");
  });

  it("fires a final state transition when stream ends", async () => {
    const changes: GuardTelemetryStateChange[] = [];

    const server = {
      async getLatestLedger() { return { sequence: 500 }; },
      async getEvents(_req: rpc.Api.GetEventsRequest) {
        return { events: [], cursor: "1", latestLedger: 500 };
      },
    };

    const listener = new GuardTelemetryListener({
      server: server as unknown as rpc.Server,
      guard: GUARD,
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    for await (const _events of listener.watch({
      pollIntervalMs: 1,
      signal: ac.signal,
      onStateChange: (c) => changes.push(c),
    })) { /* drain */ }

    const endChange = changes.find((c) => c.to === "stopped" || c.to === "aborted");
    assert.ok(endChange, "must fire a final state change when stream ends");
  });

  it("GuardTelemetryStateChange has from, to, at, reason fields", async () => {
    const changes: GuardTelemetryStateChange[] = [];

    const server = {
      async getLatestLedger() { return { sequence: 500 }; },
      async getEvents(_req: rpc.Api.GetEventsRequest) {
        return { events: [], cursor: "1", latestLedger: 500 };
      },
    };

    const listener = new GuardTelemetryListener({
      server: server as unknown as rpc.Server,
      guard: GUARD,
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    for await (const _events of listener.watch({
      pollIntervalMs: 1,
      signal: ac.signal,
      onStateChange: (c) => changes.push(c),
    })) { /* drain */ }

    assert.ok(changes.length > 0, "must have at least one state change");
    for (const change of changes) {
      assert.ok(typeof change.from === "string", "from must be a string");
      assert.ok(typeof change.to === "string", "to must be a string");
      assert.ok(typeof change.at === "string", "at must be a string");
      assert.ok(typeof change.reason === "string", "reason must be a string");
      assert.ok(Number.isFinite(new Date(change.at).getTime()), "at must be a valid date");
    }
  });

  it("a throwing onStateChange callback is swallowed", async () => {
    const server = {
      async getLatestLedger() { return { sequence: 500 }; },
      async getEvents(_req: rpc.Api.GetEventsRequest) {
        return { events: [], cursor: "1", latestLedger: 500 };
      },
    };

    const listener = new GuardTelemetryListener({
      server: server as unknown as rpc.Server,
      guard: GUARD,
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    await assert.doesNotReject(async () => {
      for await (const _events of listener.watch({
        pollIntervalMs: 1,
        signal: ac.signal,
        onStateChange: () => { throw new Error("callback exploded"); },
      })) { /* drain */ }
    });
  });
});
