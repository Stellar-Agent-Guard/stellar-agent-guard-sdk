/** Fixture-driven replay tests for offline enforcement verdict decoding. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { guardEventsFromDiagnostics } from "../../src/telemetry.ts";
import type { GuardReason } from "../../src/reasons.ts";

const FIXTURES_DIR = resolve(process.cwd(), "tests/fixtures/rpc");

interface ReplayFixtureHeader {
  source: string;
  method: string;
  network: string;
  createdAt: string;
  stellarSdkVersion: string;
  note: string;
}

interface ReplayFixture {
  header: ReplayFixtureHeader;
  guardContractId: string;
  simulationRequest: { note: string };
  simulationResponse: rpc.Api.RawSimulateTransactionResponse;
  expected: {
    verdict: "admissible" | "blocked" | "undetermined";
    reason?: GuardReason;
  };
}

function loadReplayFixture(name: string): ReplayFixture {
  const raw = JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), "utf8"));
  return raw as ReplayFixture;
}

function extractVerdict(
  rawSimulation: rpc.Api.RawSimulateTransactionResponse,
  guardContract: string,
): { verdict: "admissible" | "blocked" | "undetermined"; reason?: string | undefined } {
  const failed = "error" in rawSimulation;
  const diagnostics = (rawSimulation.events ?? []).flatMap((rawEvent) => {
    try {
      return [xdr.DiagnosticEvent.fromXDR(rawEvent, "base64").event];
    } catch {
      return [];
    }
  });
  const decision = guardEventsFromDiagnostics(diagnostics, guardContract).find(
    (event) => event.decision !== null,
  )?.decision;

  if (failed) {
    return decision?.result === "blocked"
      ? { verdict: "blocked", reason: decision.reason ?? undefined }
      : { verdict: "undetermined" };
  }

  return decision?.result === "allowed"
    ? { verdict: "admissible" }
    : { verdict: "undetermined" };
}

describe("offline enforcement replay", () => {
  const replayFixtures = [
    "replay-admissible.json",
    "replay-blocked-per-tx-cap.json",
    "replay-blocked-recipient-not-allowed.json",
    "replay-blocked-window-cap.json",
    "replay-blocked-paused.json",
    "replay-undetermined-malformed.json",
  ] as const;

  for (const fixtureName of replayFixtures) {
    it(`replays ${fixtureName} and extracts its expected verdict`, () => {
      const fixture = loadReplayFixture(fixtureName);

      assert.ok(fixture.header.source, `${fixtureName} missing provenance source`);
      assert.ok(fixture.header.createdAt, `${fixtureName} missing createdAt`);
      assert.match(fixture.header.createdAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(fixture.header.network, "testnet");
      assert.ok(fixture.guardContractId, `${fixtureName} missing guardContractId`);

      const actual = extractVerdict(fixture.simulationResponse, fixture.guardContractId);
      assert.equal(actual.verdict, fixture.expected.verdict, `${fixtureName}: verdict mismatch`);

      if (fixture.expected.verdict === "blocked") {
        assert.ok(actual.reason, `${fixtureName}: blocked verdict must carry reason`);
        assert.equal(actual.reason, fixture.expected.reason, `${fixtureName}: reason mismatch`);
      }
    });
  }

  it("does not infer approval from a successful simulation without an allowed event", () => {
    const fixture = loadReplayFixture("replay-admissible.json");
    const response = { ...fixture.simulationResponse, events: [] };
    assert.equal(extractVerdict(response, fixture.guardContractId).verdict, "undetermined");
  });

  it("records fixture provenance and the request/response pair", () => {
    for (const name of replayFixtures) {
      const fixture = loadReplayFixture(name);
      assert.ok(fixture.header.method);
      assert.ok(fixture.header.stellarSdkVersion);
      assert.ok(fixture.header.note);
      assert.ok(fixture.simulationRequest.note);
      assert.ok(fixture.simulationResponse);
      assert.ok(fixture.expected);
    }
  });
});