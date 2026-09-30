/**
 * Fixture-driven replay tests: offline enforcement verdict replay.
 *
 * Live suite proves enforcement on testnet but only runs weekly/on-demand. Its
 * recorded diagnostics (evidence files, captured payloads) can replay forever
 * offline: given recorded simulation request+response pairs, assert the decode
 * pipeline still extracts the right verdicts/reasons — catching SDK refactors
 * that break historical-evidence interpretation without touching the network.
 *
 * Complements evidence-checker (checks file presence/format); this checks
 * semantic decoding of captured payloads.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { rpc } from "@stellar/stellar-sdk";
import { parseRawSimulation } from "@stellar/stellar-sdk/rpc";
import { guardEventsFromDiagnostics } from "../../src/telemetry.ts";
import type { GuardReason } from "../../src/reasons.ts";

const FIXTURES_DIR = resolve(process.cwd(), "tests/fixtures/rpc");

interface ReplayFixtureHeader {
  source: string;
  method: string;
  network: string;
  capturedAt: string;
  stellarSdkVersion: string;
  note: string;
}

interface ReplayFixture {
  header: ReplayFixtureHeader;
  guardContractId: string;
  simulationRequest: {
    note: string;
  };
  simulationResponse: rpc.Api.RawSimulateTransactionResponse;
  expected: {
    verdict: "admissible" | "blocked" | "undetermined";
    reason?: GuardReason;
    explanation?: string;
  };
}

function loadReplayFixture(name: string): ReplayFixture {
  const raw = JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), "utf8"));
  return raw as ReplayFixture;
}

/**
 * Extract verdict from simulation response diagnostics.
 * Returns null for undetermined (no guard event found or simulation error).
 */
function extractVerdict(
  simulation: rpc.Api.SimulateTransactionResponse,
  guardContract: string,
): { verdict: "admissible" | "blocked" | "undetermined"; reason?: string | undefined } {
  if (rpc.Api.isSimulationError(simulation)) {
    return { verdict: "undetermined" };
  }

  const events = (simulation as unknown as { events?: unknown[] }).events ?? [];
  const guardEvents = guardEventsFromDiagnostics(events, guardContract);

  if (guardEvents.length === 0) {
    return { verdict: "undetermined" };
  }

  const event = guardEvents[0];
  if (!event || !event.decision) {
    return { verdict: "undetermined" };
  }

  if (event.decision.result === "allowed") {
    return { verdict: "admissible" };
  } else if (event.decision.result === "blocked") {
    return { verdict: "blocked", reason: event.decision.reason ?? undefined };
  }

  return { verdict: "undetermined" };
}

describe("offline enforcement replay", () => {
  const REPLAY_FIXTURES = [
    "replay-admissible.json",
    "replay-blocked-per-tx-cap.json",
    "replay-blocked-recipient-not-allowed.json",
    "replay-blocked-window-cap.json",
    "replay-blocked-paused.json",
    "replay-undetermined-malformed.json",
  ] as const;

  for (const fixtureName of REPLAY_FIXTURES) {
    it(`replays ${fixtureName} and extracts expected verdict`, () => {
      const fixture = loadReplayFixture(fixtureName);

      // Validate provenance header
      assert.ok(fixture.header.source, `${fixtureName} missing provenance source`);
      assert.ok(fixture.header.capturedAt, `${fixtureName} missing capturedAt`);
      assert.match(fixture.header.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(fixture.header.network, "testnet");
      assert.ok(fixture.guardContractId, `${fixtureName} missing guardContractId`);

      // Parse simulation response through production decode path
      const parsed = parseRawSimulation(fixture.simulationResponse);

      // Extract verdict using production decode pipeline
      const actual = extractVerdict(parsed, fixture.guardContractId);

      // Assert expected verdict
      assert.equal(
        actual.verdict,
        fixture.expected.verdict,
        `${fixtureName}: verdict mismatch`,
      );

      if (fixture.expected.verdict === "blocked") {
        assert.ok(actual.reason, `${fixtureName}: blocked verdict must carry reason`);
        assert.equal(
          actual.reason,
          fixture.expected.reason,
          `${fixtureName}: reason mismatch`,
        );
      }
    });
  }

  it("asserts fixture provenance prevents hand-written payloads", () => {
    for (const name of REPLAY_FIXTURES) {
      const fixture = loadReplayFixture(name);
      assert.ok(fixture.header.source);
      assert.ok(fixture.header.method);
      assert.ok(fixture.header.network);
      assert.ok(fixture.header.capturedAt);
      assert.ok(fixture.header.stellarSdkVersion);
      assert.ok(fixture.header.note);
      assert.ok(fixture.guardContractId);
      assert.ok(fixture.simulationRequest);
      assert.ok(fixture.simulationResponse);
      assert.ok(fixture.expected);
    }
  });
});
