/**
 * Public error-hierarchy contract.
 *
 * These imports deliberately come from the package root: the package exposes
 * only `.`, so a class that exists in a source file but is not re-exported is
 * not part of the SDK's usable API.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import {
  BroadcastError,
  ContractResponseError,
  GuardBlockedError,
  GuardError,
  PolicyDecodeError,
  PreFlightUndeterminedError,
  SigningError,
  SimulationError,
  decodeCheckResult,
  decodePolicy,
} from "../../src/index.ts";

describe("typed guard errors", () => {
  it("puts every public SDK error under one GuardError base", () => {
    const errors: GuardError[] = [
      new SimulationError("simulation", { stage: "probe" }),
      new SigningError("signing"),
      new BroadcastError("broadcast"),
      new ContractResponseError("response", { field: "result" }),
      new PolicyDecodeError("policy", { path: "assets[0]" }),
      new GuardBlockedError({ reason: "paused", stage: "preflight" }),
      new PreFlightUndeterminedError("no verdict"),
    ];

    for (const error of errors) {
      assert.ok(error instanceof GuardError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, error.constructor.name);
    }
  });

  it("preserves the published GuardBlockedError shape while adding the base class", () => {
    const error = new GuardBlockedError({
      reason: "per_tx_cap_exceeded",
      stage: "preflight",
      detail: "1001 > 1000",
      charged: false,
    });
    assert.ok(error instanceof GuardError);
    assert.equal(error.name, "GuardBlockedError");
    assert.equal(error.reason, "per_tx_cap_exceeded");
    assert.equal(error.code, 22);
    assert.equal(error.stage, "preflight");
    assert.equal(error.charged, false);
    assert.match(error.message, /per_tx_cap_exceeded/);
    assert.match(error.message, /1001 > 1000/);
  });

  it("models an undetermined preflight as a typed simulation failure", () => {
    const cause = new Error("RPC unavailable");
    const error = new PreFlightUndeterminedError("could not classify", { cause });
    assert.ok(error instanceof SimulationError);
    assert.equal(error.stage, "preflight");
    assert.equal(error.detail, "could not classify");
    assert.equal(error.cause, cause);
  });

  it("preserves the original cause for programmatic classification", () => {
    const cause = new RangeError("bad key");
    const signing = new SigningError("sign failed", { address: "GABC", cause });
    assert.equal(signing.cause, cause);
    assert.equal(signing.address, "GABC");

    const hash = "a".repeat(64);
    const broadcast = new BroadcastError("send failed", { transactionHash: hash, cause });
    assert.equal(broadcast.transactionHash, hash);
    assert.equal(broadcast.cause, cause);
  });

  it("throws ContractResponseError for an unexpected CheckResult", () => {
    assert.throws(
      () => decodeCheckResult({ SomethingElse: true }),
      (error: unknown) => {
        assert.ok(error instanceof ContractResponseError);
        assert.equal(error.field, "CheckResult");
        return true;
      },
    );
  });

  it("throws PolicyDecodeError with the failing field path", () => {
    assert.throws(
      () => decodePolicy(xdr.ScVal.scvVoid()),
      (error: unknown) => {
        assert.ok(error instanceof PolicyDecodeError);
        assert.equal(error.path, "policy");
        return true;
      },
    );
  });
});
