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
  AdapterConfigError,
  AdapterMappingError,
  BroadcastError,
  ConcurrentTelemetryStreamError,
  ContractResponseError,
  FeeCapExceededError,
  GuardBlockedError,
  GuardError,
  GuardUndeterminedError,
  HeartbeatBlockedError,
  HeartbeatDryRunError,
  HeartbeatIntervalError,
  InvalidFeeCeilingError,
  InvalidInputError,
  InvokeRetryError,
  PolicyDecodeError,
  PolicyEncodeError,
  PolicyFileReadError,
  PolicyValidationError,
  PreFlightUndeterminedError,
  RateLimitedError,
  RpcTimeoutError,
  SigningError,
  SimulationError,
  decodeCheckResult,
  decodePolicy,
} from "../../src/index.ts";
import * as sdk from "../../src/index.ts";

describe("typed guard errors", () => {
  it("puts every public SDK error under one GuardError base", () => {
    const errors: GuardError[] = [
      new SimulationError("simulation", { stage: "probe" }),
      new SigningError("signing"),
      new BroadcastError("broadcast"),
      new ContractResponseError("response", { field: "result" }),
      new PolicyDecodeError("policy", { path: "assets[0]" }),
      new GuardBlockedError({ reason: "paused", stage: "preflight" }),
      new GuardUndeterminedError("no verdict"),
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

  it("models an undetermined preflight as a typed undetermined failure", () => {
    const cause = new Error("RPC unavailable");
    const error = new GuardUndeterminedError("could not classify", { cause });
    assert.ok(error instanceof GuardUndeterminedError);
    assert.ok(error instanceof GuardError);
    assert.equal(error.stage, "preflight");
    assert.equal(error.detail, "could not classify");
    assert.equal(error.cause, cause);
  });

  it("retains PreFlightUndeterminedError compatibility as an alias to GuardUndeterminedError", () => {
    const cause = new Error("RPC unavailable");
    const error = new PreFlightUndeterminedError("could not classify", { cause });
    assert.ok(error instanceof GuardUndeterminedError);
    assert.ok(error instanceof PreFlightUndeterminedError);
    assert.ok(error instanceof GuardError);
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

  it("fails closed instead of throwing for an unexpected CheckResult", () => {
    // The decoder is total by design: a hostile or future payload must resolve
    // to the typed `undetermined` fallback, never an exception in the verdict path.
    assert.deepEqual(decodeCheckResult({ SomethingElse: true }), { kind: "undetermined" });
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

/* -------------------------------------------------------------------------- */
/*                    JSON serialization for every guard error                */
/* -------------------------------------------------------------------------- */

/**
 * One package-root error class plus the arguments needed to construct it.
 *
 * The coverage test compares this list with the exported classes, so a new
 * exported error type must add itself here — and its `toJSON()` contract is
 * exercised in the same run.
 */
const ERROR_CASES: Array<[string, () => Error]> = [
  ["GuardError", () => new GuardError("boom")],
  [
    "GuardUndeterminedError",
    () => new GuardUndeterminedError("could not classify", { cause: new Error("root") }),
  ],
  ["InvalidInputError", () => new InvalidInputError("field", "rule", "detail")],
  ["InvalidFeeCeilingError", () => new InvalidFeeCeilingError("maxFeeCap", -1n)],
  [
    "SimulationError",
    () =>
      new SimulationError("simulation failed", {
        stage: "probe",
        diagnosticEvents: [xdr.ScVal.scvVoid()],
        cause: new Error("root"),
      }),
  ],
  [
    "RateLimitedError",
    () => new RateLimitedError({ stage: "simulate", retryAfterMs: 1000, attempts: 2 }),
  ],
  [
    "SigningError",
    () => new SigningError("sign failed", { address: "GABC", cause: new Error("root") }),
  ],
  [
    "BroadcastError",
    () =>
      new BroadcastError({
        attempts: 2,
        lastFee: 100n,
        failure: {
          resultXdr: "AAAA-TAMPERED-SIGNATURE",
          resultCode: "tx_insufficient_fee",
          message: "fee too low",
          diagnosticEvents: [xdr.ScVal.scvVoid()],
        },
      }),
  ],
  [
    "FeeCapExceededError",
    () =>
      new FeeCapExceededError({
        maxFeeCap: 100n,
        resourceFeeStroops: 50n,
        inclusionFeeStroops: 60n,
        attempt: 0,
      }),
  ],
  [
    "ContractResponseError",
    () => new ContractResponseError("bad response", { field: "result", stage: "simulate" }),
  ],
  ["PolicyDecodeError", () => new PolicyDecodeError("bad policy", { path: "assets[0]" })],
  [
    "PolicyEncodeError",
    () =>
      new PolicyEncodeError([
        { path: "per_tx_cap", rule: "invalid_type", message: "expected integer" },
      ]),
  ],
  [
    "PolicyFileReadError",
    () => new PolicyFileReadError("read failed", { path: "/tmp/p.json", code: "ENOENT" }),
  ],
  [
    "PolicyValidationError",
    () =>
      new PolicyValidationError("invalid policy", {
        path: "p.json",
        failures: [{ path: "window_cap", rule: "window_requires_secs", message: "needs window" }],
      }),
  ],
  [
    "AdapterMappingError",
    () => new AdapterMappingError("mapping failed", { field: "toContractCall" }),
  ],
  [
    "AdapterConfigError",
    () =>
      new AdapterConfigError("bad config", {
        field: "toContractCall",
        expected: "a function",
        adapter: "langchain",
      }),
  ],
  ["GuardBlockedError", () => new GuardBlockedError({ reason: "paused", stage: "preflight" })],
  [
    "HeartbeatBlockedError",
    () => new HeartbeatBlockedError({ reason: "paused", detail: "detail" }),
  ],
  [
    "HeartbeatDryRunError",
    () => new HeartbeatDryRunError({ verdict: "blocked", reason: "paused", detail: null }),
  ],
  ["HeartbeatIntervalError", () => new HeartbeatIntervalError(10, 10n, 2000)],
  [
    "RpcTimeoutError",
    () => new RpcTimeoutError({ stage: "pre-flight", aborted: false, timeoutMs: 1000 }),
  ],
  [
    "InvokeRetryError",
    () =>
      new InvokeRetryError({
        attempts: 2,
        lastOutcome: {
          kind: "error",
          detail: "budget exhausted",
          error: new SigningError("sign failed"),
          diagnosticEvents: [xdr.ScVal.scvVoid()],
          transactionHash: "abc123",
        } as never,
      }),
  ],
  ["ConcurrentTelemetryStreamError", () => new ConcurrentTelemetryStreamError("watch")],
];

describe("guard error JSON serialization (#477)", () => {
  it("covers every exported error class", () => {
    const exported = Object.entries(sdk)
      .filter(([, value]) => {
        if (typeof value !== "function") return false;
        if (value === GuardError || value === InvalidInputError) return true;
        // Exported error classes outside both roots (they extend Error and
        // implement the same `toJSON()` contract).
        if (value === HeartbeatIntervalError || value === InvokeRetryError) return true;
        const prototype = (value as { prototype?: unknown }).prototype;
        return (
          prototype !== undefined &&
          (prototype instanceof GuardError || prototype instanceof InvalidInputError)
        );
      })
      // Alias for GuardUndeterminedError, not a separate class.
      .map(([name]) => name)
      .filter((name) => name !== "PreFlightUndeterminedError")
      .sort();

    assert.deepEqual(exported, ERROR_CASES.map(([name]) => name).sort());
  });

  for (const [name, create] of ERROR_CASES) {
    it(`${name} serializes useful fields without a replacer`, () => {
      const error = create();
      // Throws on a raw bigint, so this also proves every bigint field is safe.
      const json = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;

      assert.equal(json["name"], error.name);
      assert.equal(json["message"], error.message);
      assert.equal(typeof json["message"], "string");
      assert.ok((json["message"] as string).length > 0);
    });
  }

  it("stringifies bigint fee fields instead of throwing", () => {
    const json = JSON.parse(
      JSON.stringify(
        new FeeCapExceededError({
          maxFeeCap: 100n,
          resourceFeeStroops: 50n,
          inclusionFeeStroops: 60n,
          attempt: 1,
        }),
      ),
    ) as Record<string, unknown>;

    assert.equal(json["maxFeeCap"], "100");
    assert.equal(json["totalFeeStroops"], "110");
    assert.equal(json["attempt"], 1);
  });

  it("omits XDR, signatures and diagnostic events, including nested payloads", () => {
    const broadcast = new BroadcastError({
      attempts: 2,
      lastFee: 100n,
      failure: {
        resultXdr: "AAAA-TAMPERED-SIGNATURE",
        resultCode: "tx_insufficient_fee",
        message: "fee too low",
        diagnosticEvents: [xdr.ScVal.scvVoid()],
      },
    });
    const text = JSON.stringify(broadcast);

    assert.equal(text.includes("TAMPERED"), false);
    assert.equal(text.includes("diagnosticEvents"), false);
    const json = JSON.parse(text) as { failure: Record<string, unknown>; transactionHash: unknown };
    assert.equal(json.failure["resultCode"], "tx_insufficient_fee");
    assert.equal(json.failure["message"], "fee too low");
    assert.equal("resultXdr" in json.failure, false);

    const simulation = JSON.parse(
      JSON.stringify(
        new SimulationError("simulation failed", {
          stage: "probe",
          diagnosticEvents: [xdr.ScVal.scvVoid()],
        }),
      ),
    ) as Record<string, unknown>;
    assert.equal("diagnosticEvents" in simulation, false);
    assert.equal(simulation["stage"], "probe");
  });

  it("summarizes a cause instead of stringifying it blindly", () => {
    const cause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const json = JSON.parse(
      JSON.stringify(new GuardUndeterminedError("could not classify", { cause })),
    ) as { cause: Record<string, unknown> };

    assert.deepEqual(json.cause, {
      name: "Error",
      message: "connection reset",
      code: "ECONNRESET",
    });
    assert.equal("stack" in json.cause, false);
    assert.equal(
      JSON.stringify(new GuardUndeterminedError("x", { cause: { request: "secret" } })),
      JSON.stringify(new GuardUndeterminedError("x", { cause: { request: "secret" } })),
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(new GuardUndeterminedError("x", { cause: { request: "secret" } })))
        .cause,
      { type: "Object" },
    );
  });

  it("keeps class-specific fields on the derived classes", () => {
    const policy = JSON.parse(
      JSON.stringify(
        new PolicyValidationError("invalid policy", {
          path: "p.json",
          failures: [{ path: "window_cap", rule: "window_requires_secs", message: "needs window" }],
        }),
      ),
    ) as Record<string, unknown>;

    assert.equal(policy["path"], "p.json");
    assert.deepEqual(policy["failures"], [
      { path: "window_cap", rule: "window_requires_secs", message: "needs window" },
    ]);

    const encode = JSON.parse(
      JSON.stringify(
        new PolicyEncodeError([{ path: "assets[0]", rule: "invalid_address", message: "bad" }]),
      ),
    ) as Record<string, unknown>;
    assert.equal(encode["path"], "assets[0]");
    assert.equal(encode["rule"], "invalid_address");
    assert.ok(Array.isArray(encode["failures"]));
  });

  it("preserves GuardBlockedError's published toJSON shape", () => {
    const json = new GuardBlockedError({
      reason: "recipient_not_allowed",
      stage: "preflight",
    }).toJSON();

    assert.equal(json["name"], "GuardBlockedError");
    assert.equal(json["reason"], "recipient_not_allowed");
    assert.equal(json["code"], 21);
    assert.equal(json["stage"], "preflight");
  });
});
