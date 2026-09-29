/**
 * Unit tests for the guard's reason vocabulary.
 *
 * No network: these assert that the off-chain table matches the on-chain enum.
 * The exact numbers matter — `reasonNameFromCode` is what turns a decoded
 * `Error(Contract, #22)` into `per_tx_cap_exceeded`, and a table that drifts from
 * `stellar-agent-guard-contracts/src/types.rs` would silently mislabel every
 * refusal.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  ACCOUNT_STATE_REASONS,
  GUARD_REASON_CODES,
  GUARD_REASONS,
  GuardBlockedError,
  explainReason,
  isGuardReason,
  reasonName,
  reasonNameFromCode,
  type GuardReason,
} from "../../src/reasons.ts";

describe("reason code table", () => {
  it("matches the contract's Error enum exactly", () => {
    // Transcribed from stellar-agent-guard-contracts/src/types.rs `enum Error`.
    // If this fails, the SDK is describing a different contract.
    assert.deepEqual(GUARD_REASON_CODES, {
      unauthorized: 1,
      already_initialized: 2,
      not_initialized: 3,
      invalid_config: 4,
      invalid_amount: 5,
      admin_frozen: 10,
      heartbeat_expired: 11,
      no_policy: 12,
      paused: 13,
      outside_active_window: 14,
      asset_not_allowed: 20,
      recipient_not_allowed: 21,
      per_tx_cap_exceeded: 22,
      window_cap_exceeded: 23,
      protocol_not_allowed: 24,
      function_not_allowed: 25,
      unknown_contract: 26,
      self_function_not_allowed: 27,
      create_contract_not_allowed: 28,
    });
  });

  it("has no duplicate numeric codes", () => {
    const codes = Object.values(GUARD_REASON_CODES);
    assert.equal(new Set(codes).size, codes.length);
  });

  it("maps every code back to its name", () => {
    for (const [name, code] of Object.entries(GUARD_REASON_CODES)) {
      assert.equal(reasonNameFromCode(code), name);
    }
  });

  it("returns undefined for a code the contract does not define", () => {
    assert.equal(reasonNameFromCode(999), undefined);
  });
});

describe("GuardReason vocabulary", () => {
  it("derives GUARD_REASONS from the single reason table", () => {
    assert.deepEqual(Object.keys(GUARD_REASONS).sort(), Object.keys(GUARD_REASON_CODES).sort());
    for (const reason of Object.values(GUARD_REASONS)) {
      assert.equal(GUARD_REASONS[reason], reason);
    }
  });

  it("keeps GUARD_REASONS and the vendored contract fixture in lockstep, both ways", () => {
    const fixturePath = resolve(process.cwd(), "tests/fixtures/contract-fixtures.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      entries: Array<{ result: string; reason: string; code: number | null }>;
    };
    const fixtureReasons = fixture.entries
      .filter((entry) => entry.result === "blocked")
      .map((entry) => entry.reason)
      .sort();
    // deepEqual on sorted arrays is bidirectional: a reason present in only one
    // of the SDK vocabulary and the fixture fails in either direction.
    assert.deepEqual(Object.keys(GUARD_REASONS).sort(), fixtureReasons);
    for (const entry of fixture.entries) {
      if (entry.result !== "blocked") continue;
      assert.equal(GUARD_REASON_CODES[entry.reason as GuardReason], entry.code);
    }
  });

  it("recognises only the known vocabulary", () => {
    assert.equal(isGuardReason("paused"), true);
    assert.equal(isGuardReason("not_a_reason"), false);
    assert.equal(isGuardReason(22), false);
  });

  it("rejects an unknown reason at compile time", () => {
    // @ts-expect-error `drain_the_account` is not part of the guard vocabulary
    const notAReason: GuardReason = "drain_the_account";
    assert.equal(notAReason, "drain_the_account");
  });
});

describe("reasonName", () => {
  it("accepts a numeric code", () => {
    assert.equal(reasonName(22), "per_tx_cap_exceeded");
  });

  it("accepts the snake_case symbol the contract emits", () => {
    assert.equal(reasonName("window_cap_exceeded"), "window_cap_exceeded");
  });

  it("does not throw on an unknown numeric code", () => {
    assert.equal(reasonName(4242), "unknown_reason_4242");
  });
});

describe("explainReason", () => {
  it("explains a known reason by code and by name identically", () => {
    assert.equal(explainReason(21), explainReason("recipient_not_allowed"));
    assert.match(explainReason(21), /recipient/i);
  });

  it("falls back for an unrecognised reason rather than throwing", () => {
    assert.match(explainReason(777), /Unrecognised/);
  });
});

describe("GuardBlockedError", () => {
  it("carries the reason name, code and explanation", () => {
    const error = new GuardBlockedError({ reason: 22, stage: "preflight" });
    assert.equal(error.reason, "per_tx_cap_exceeded");
    assert.equal(error.code, 22);
    assert.equal(error.stage, "preflight");
    assert.match(error.message, /per_tx_cap_exceeded/);
  });

  it("defaults to uncharged, because a pre-flight block never broadcasts", () => {
    const error = new GuardBlockedError({ reason: "window_cap_exceeded", stage: "preflight" });
    assert.equal(error.charged, false);
    assert.equal(error.code, 23);
  });

  it("can be marked charged for a post-broadcast refusal", () => {
    const error = new GuardBlockedError({
      reason: "admin_frozen",
      stage: "submission",
      charged: true,
    });
    assert.equal(error.charged, true);
    assert.equal(error.name, "GuardBlockedError");
  });

  it("carries offending call and raw diagnostic event when provided", () => {
    const dummyCall = {
      contract: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      fn: "transfer",
      args: [],
    };
    const dummyEvent = { topics: ["event_auth_checked", "blocked", "paused"] };

    const error = new GuardBlockedError({
      reason: "paused",
      stage: "preflight",
      detail: "simulation refused",
      call: dummyCall,
      rawEvent: dummyEvent,
    });

    assert.equal(error.reason, "paused");
    assert.equal(error.code, 13);
    assert.equal(error.stage, "preflight");
    assert.equal(error.charged, false);
    assert.equal(error.detail, "simulation refused");
    assert.deepEqual(error.call, dummyCall);
    assert.deepEqual(error.rawEvent, dummyEvent);
    assert.match(error.message, /paused/);
    assert.match(error.message, /CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44/);
    assert.ok(error instanceof Error);
    assert.ok(error instanceof GuardBlockedError);
  });

  it("serializes to a structured, logging-friendly JSON object via toJSON()", () => {
    const dummyCall = {
      contract: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      fn: "transfer",
      args: [],
    };
    const dummyEvent = { type: "diagnostic", topics: ["event_auth_checked"] };

    const error = new GuardBlockedError({
      reason: "per_tx_cap_exceeded",
      stage: "preflight",
      detail: "limit exceeded",
      call: dummyCall,
      rawEvent: dummyEvent,
    });

    const json = error.toJSON();
    assert.equal(json["name"], "GuardBlockedError");
    assert.equal(json["reason"], "per_tx_cap_exceeded");
    assert.equal(json["code"], 22);
    assert.equal(json["stage"], "preflight");
    assert.equal(json["charged"], false);
    assert.equal(json["detail"], "limit exceeded");
    assert.deepEqual(json["call"], {
      contract: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      fn: "transfer",
      argsCount: 0,
    });
    assert.deepEqual(json["rawEvent"], dummyEvent);
    assert.equal(typeof json["message"], "string");
    assert.equal(typeof json["explanation"], "string");
  });
});

describe("account-state reasons", () => {
  it("separates 'the guard is not ready' from 'this call broke policy'", () => {
    for (const reason of ACCOUNT_STATE_REASONS) {
      assert.ok(
        reason in GUARD_REASON_CODES,
        `${reason} is listed as an account-state reason but is not a known reason`,
      );
    }
    assert.ok(!ACCOUNT_STATE_REASONS.includes("per_tx_cap_exceeded"));
  });
});
