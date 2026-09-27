/**
 * Fixture-driven tests: decode REAL live-RPC payloads through the SDK's own
 * production parsers.
 *
 * The rest of the suite mocks RPC with hand-written objects. Those mocks encode
 * what a test author believes the network returns, so when
 * `@stellar/stellar-sdk` renames or reshapes a field the mocks stay green while
 * production breaks — precisely the drift a test suite should catch. These tests
 * instead load payloads recorded from the live Phase 2 instance
 * (`scripts/capture-rpc-fixtures.ts`) and run them through `parseRawEvents` /
 * `parseRawSimulation` — the same parse path the production clients use — before
 * asserting on the SDK's public decode functions.
 *
 * Provenance for every fixture is asserted here too, so a captured file cannot
 * be quietly swapped for a hand-written object.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { rpc } from "@stellar/stellar-sdk";
import { parseRawEvents, parseRawSimulation } from "@stellar/stellar-sdk/rpc";
import {
  GuardTelemetryListener,
  guardEventsFromDiagnostics,
  type GuardTelemetryGap,
} from "../../src/telemetry.ts";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/rpc");

interface FixtureHeader {
  source: string;
  method: string;
  contractId: string | null;
  network: string;
  rpcUrl: string;
  capturedAt: string;
  stellarSdkVersion: string;
  note: string;
}

type LoadedFixture<T> = FixtureHeader & { response: T };

function loadFixture<T>(name: string): LoadedFixture<T> {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8")) as LoadedFixture<T>;
}

const FIXTURE_NAMES = [
  "get-events-guard-page.json",
  "simulate-success-status.json",
  "simulate-error-wrong-agent.json",
] as const;

/** The guard the fixtures were recorded against, read from a fixture itself. */
const GUARD =
  loadFixture<unknown>("get-events-guard-page.json").contractId ??
  "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

/** A fake `rpc.Server` returning a fixture's already-parsed response unchanged. */
function fixtureServer(response: unknown) {
  return {
    getLatestLedger: async () => ({
      sequence: (response as { latestLedger?: number }).latestLedger ?? 1,
    }),
    getEvents: async () => response,
  };
}

describe("recorded RPC fixtures: provenance header", () => {
  for (const name of FIXTURE_NAMES) {
    it(`records where ${name} came from, so it cannot be hand-written by accident`, () => {
      const fixture = loadFixture(name);
      for (const key of [
        "source",
        "method",
        "contractId",
        "network",
        "rpcUrl",
        "capturedAt",
        "stellarSdkVersion",
        "note",
      ] as const) {
        assert.ok(fixture[key], `${name} is missing provenance field '${key}'`);
      }
      assert.equal(fixture.network, "testnet");
      assert.match(fixture.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(fixture.stellarSdkVersion, /^\d+\./);
      assert.ok(fixture.response, `${name} carries no response payload`);
    });
  }
});

describe("recorded getEvents page", () => {
  it("parses through the listener's production path and exposes the retention window", async () => {
    const fixture = loadFixture<rpc.Api.RawGetEventsResponse>("get-events-guard-page.json");
    const parsed = parseRawEvents(fixture.response);

    // The retention window is what the gap detector (issue #86) relies on; a
    // field rename here is exactly the drift this fixture exists to catch.
    assert.equal(typeof parsed.oldestLedger, "number");
    assert.equal(typeof parsed.latestLedger, "number");
    assert.ok(parsed.latestLedger >= parsed.oldestLedger);
    assert.equal(typeof parsed.cursor, "string");

    const listener = new GuardTelemetryListener({
      server: fixtureServer(parsed) as never,
      guard: GUARD,
    });
    const page = await listener.poll({ startLedger: parsed.oldestLedger });
    assert.equal(page.oldestLedger, parsed.oldestLedger);
    assert.equal(page.latestLedger, parsed.latestLedger);
    assert.equal(page.events.length, parsed.events.length);
    for (const event of page.events) assert.ok(event.id.length > 0, "decoded events carry ids");
  });

  it("drives gap detection from the recorded retention window", async () => {
    const fixture = loadFixture<rpc.Api.RawGetEventsResponse>("get-events-guard-page.json");
    const parsed = parseRawEvents(fixture.response);
    const listener = new GuardTelemetryListener({
      server: fixtureServer(parsed) as never,
      guard: GUARD,
    });

    const gaps: GuardTelemetryGap[] = [];
    const controller = new AbortController();
    const startLedger = Math.max(1, parsed.oldestLedger - 25);
    for await (const _batch of listener.watch({
      startLedger,
      onGap: (gap) => gaps.push(gap),
      sleep: async () => controller.abort(),
      signal: controller.signal,
    })) {
      // Drain: the assertion is about the notice, not the (empty) stream.
    }

    assert.equal(gaps.length, 1);
    assert.deepEqual(gaps[0], {
      fromLedger: startLedger,
      toLedger: parsed.oldestLedger - 1,
      reason: "history_pruned",
      retainedFromLedger: parsed.oldestLedger,
      retainedToLedger: parsed.latestLedger,
    });
  });
});

describe("recorded simulateTransaction payloads", () => {
  it("parses the recorded success with a real footprint and resource fee", () => {
    const fixture = loadFixture<rpc.Api.RawSimulateTransactionResponse>(
      "simulate-success-status.json",
    );
    const parsed = parseRawSimulation(fixture.response);
    assert.equal(rpc.Api.isSimulationError(parsed), false);

    const success = parsed as rpc.Api.SimulateTransactionSuccessResponse;
    assert.ok(success.transactionData, "footprint-bearing transactionData must parse");
    assert.match(String(success.minResourceFee), /^\d+$/, "resource fee is a decimal string");
  });

  it("never fabricates a guard event from a real host-failure diagnostic payload", () => {
    const fixture = loadFixture<rpc.Api.RawSimulateTransactionResponse>(
      "simulate-error-wrong-agent.json",
    );
    const parsed = parseRawSimulation(fixture.response);
    assert.equal(rpc.Api.isSimulationError(parsed), true);

    const error = parsed as rpc.Api.SimulateTransactionErrorResponse;
    assert.match(String(error.error), /HostError|Error\(/);

    // The recorded failure carries real host diagnostics, and not one of them may
    // be read as a guard decision: a host trap is not a policy refusal.
    const events = (error as unknown as { events?: unknown[] }).events ?? [];
    assert.ok(events.length > 0, "the recorded failure carries diagnostics");
    assert.deepEqual(
      guardEventsFromDiagnostics(events, GUARD),
      [],
      "host failures must not decode to guard events",
    );
  });
});
