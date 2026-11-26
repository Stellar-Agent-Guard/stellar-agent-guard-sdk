/**
 * Public error-hierarchy contract.
 *
 * These imports deliberately come from the package root: the package exposes
 * only `.`, so a class that exists in a source file but is not re-exported is
 * not part of the SDK's usable API.
 */
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Account, Keypair, rpc, Transaction, xdr } from "@stellar/stellar-sdk";
import * as sdk from "../../src/index.ts";
import * as fsModule from "../../src/fs.ts";
import {
  AdapterConfigError,
  AdapterMappingError,
  AuthRefreshError,
  BroadcastError,
  ConcurrentTelemetryStreamError,
  ContractResponseError,
  CostPreChecker,
  DEFAULT_GUARD_POLICY,
  FeeCapExceededError,
  GuardBlockedError,
  GuardError,
  GuardTelemetryListener,
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
  PreFlightInterceptor,
  PreFlightUndeterminedError,
  RateLimitedError,
  RpcTimeoutError,
  SigningError,
  SimulationError,
  createLangChainGuardMiddleware,
  decodeCheckResult,
  decodePolicy,
  heartbeat,
  normalizeMappedCall,
  policyToJson,
  policyToScVal,
  readGuardStatus,
  startHeartbeat,
  validateAgentPublicKey,
  validateContractCall,
} from "../../src/index.ts";
import { loadPolicyFromFile } from "../../src/fs.ts";
import { withRpcAbort } from "../../src/invoke.ts";
import {
  buildGuardAuthEntry,
  parseSimulationResourceFee,
  refreshNearExpiryAuthEntries,
  submitAndPoll,
} from "../../src/tx.ts";

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

/**
 * Snapshot tests for public error messages and codes (issue #491).
 *
 * Error messages are part of the developer experience and documented troubleshooting.
 * Snapshots ensure every change to default message shapes or structured attributes
 * (`code`, `rule`, `path`, `stage`) is deliberate and reviewed.
 */
interface ErrorSnapshot {
  name: string;
  message: string;
  code?: string | number | null;
  rule?: string;
  path?: string;
  stage?: string;
}

function snapshotOf(error: unknown): ErrorSnapshot {
  assert.ok(error instanceof Error, "expected instance of Error");
  const err = error as Error & {
    code?: string | number | null;
    rule?: string;
    path?: string;
    stage?: string;
  };
  const snapshot: ErrorSnapshot = {
    name: err.name,
    message: err.message,
  };
  if ("code" in err && err.code !== undefined) snapshot.code = err.code;
  if ("rule" in err && err.rule !== undefined) snapshot.rule = err.rule;
  if ("path" in err && err.path !== undefined) snapshot.path = err.path;
  if ("stage" in err && err.stage !== undefined) snapshot.stage = err.stage;
  return snapshot;
}

const CONSTRUCTOR_SNAPSHOTS: Record<string, ErrorSnapshot> = {
  AdapterConfigError: {
    name: "AdapterConfigError",
    message: "adapter config is missing required option",
  },
  AdapterMappingError: {
    name: "AdapterMappingError",
    message: "call mapping failed for action",
  },
  AuthRefreshError: {
    name: "AuthRefreshError",
    message: "auth entry expired before the enforced simulation",
  },
  BroadcastError: {
    name: "BroadcastError",
    message: "transaction submission rejected by network",
  },
  ConcurrentTelemetryStreamError: {
    name: "ConcurrentTelemetryStreamError",
    message:
      "GuardTelemetryListener already has an active watch()/watchAll() stream; watch() cannot start concurrently. Use one listener per stream.",
    code: "telemetry.concurrent_stream",
  },
  ContractResponseError: {
    name: "ContractResponseError",
    message: "simulation response missing expected field",
    stage: "assemble",
  },
  FeeCapExceededError: {
    name: "FeeCapExceededError",
    message:
      "fee cap exceeded: total 1100 stroops (resource 800 + inclusion 300) exceeds maxFeeCap 1000 stroops; nothing was broadcast",
    code: "fee_cap_exceeded",
  },
  GuardBlockedError: {
    name: "GuardBlockedError",
    message:
      "stellar-agent-guard blocked this action (paused): The policy's admin kill switch is engaged.",
    code: 13,
    stage: "preflight",
  },
  GuardError: {
    name: "GuardError",
    message: "guard operational failure",
  },
  GuardUndeterminedError: {
    name: "GuardUndeterminedError",
    message:
      "stellar-agent-guard could not determine this action's status\nsimulation could not reach a decision",
    stage: "preflight",
  },
  HeartbeatBlockedError: {
    name: "HeartbeatBlockedError",
    message:
      "stellar-agent-guard blocked the heartbeat (paused): The policy's admin kill switch is engaged.\nkill switch is active",
  },
  HeartbeatDryRunError: {
    name: "HeartbeatDryRunError",
    message:
      "stellar-agent-guard heartbeat ran as a dry run and never reached the guard (verdict: blocked, reason: paused): The policy's admin kill switch is engaged.\ndry run refusal",
  },
  HeartbeatIntervalError: {
    name: "HeartbeatIntervalError",
    message:
      "heartbeat interval 60000ms exceeds one third of the dead-man grace window (60s → at most 20000ms); a single missed beat could freeze the account",
  },
  InvalidFeeCeilingError: {
    name: "InvalidFeeCeilingError",
    message:
      "Invalid input for 'maxFeeStroops': violates rule 'non_negative_bigint' (expected a non-negative bigint, got -1n)",
    rule: "non_negative_bigint",
  },
  InvalidInputError: {
    name: "InvalidInputError",
    message: "Invalid input for 'call': violates rule 'required' (call must be an object)",
    rule: "required",
  },
  InvokeRetryError: {
    name: "InvokeRetryError",
    message:
      "stellar-agent-guard invoke retry budget exhausted after 3 attempt(s) (last cause: stale_ledger_sequence)\nsequence number expired",
  },
  PolicyDecodeError: {
    name: "PolicyDecodeError",
    message: "validate_policy returned an undecodable ScVal",
    path: "policy",
  },
  PolicyEncodeError: {
    name: "PolicyEncodeError",
    message:
      "Invalid input for 'assets[0]': violates rule 'missing_field' (asset address is required)",
    rule: "missing_field",
    path: "assets[0]",
  },
  PolicyFileReadError: {
    name: "PolicyFileReadError",
    message: "cannot read policy file 'policy.json' (ENOENT)",
    code: "ENOENT",
    path: "policy.json",
  },
  PolicyValidationError: {
    name: "PolicyValidationError",
    message:
      "policy file 'policy.json' failed validation with 1 failure(s): empty_vector_noop at assets",
    path: "policy.json",
  },
  PreFlightUndeterminedError: {
    name: "GuardUndeterminedError",
    message:
      "stellar-agent-guard could not determine this action's status\npreflight interceptor could not determine status",
    stage: "preflight",
  },
  RateLimitedError: {
    name: "RateLimitedError",
    message: "the RPC rate-limited the simulation (HTTP 429) on 2 attempt(s); Retry-After 1000ms",
    stage: "simulate",
  },
  RpcTimeoutError: {
    name: "RpcTimeoutError",
    message: "RPC call during 'simulate' exceeded timeout of 5000ms",
    stage: "simulate",
  },
  SigningError: {
    name: "SigningError",
    message: "agent key signature failed",
  },
  SimulationError: {
    name: "SimulationError",
    message: "simulation request failed",
    stage: "simulate",
  },
};

const CONSTRUCTORS: Record<string, () => Error> = {
  AdapterConfigError: () =>
    new AdapterConfigError("adapter config is missing required option", {
      field: "interceptor",
      expected: "an object exposing a check(...) method",
      adapter: "langchain",
    }),
  AdapterMappingError: () =>
    new AdapterMappingError("call mapping failed for action", {
      field: "toContractCall",
    }),
  AuthRefreshError: () =>
    new AuthRefreshError("auth entry expired before the enforced simulation", {
      address: "GABC",
      expirationLedger: 1003,
      currentLedger: 1000,
      marginLedgers: 5,
    }),
  BroadcastError: () =>
    new BroadcastError("transaction submission rejected by network", {
      transactionHash: null,
    }),
  ConcurrentTelemetryStreamError: () => new ConcurrentTelemetryStreamError("watch"),
  ContractResponseError: () =>
    new ContractResponseError("simulation response missing expected field", {
      field: "minResourceFee",
      stage: "assemble",
    }),
  FeeCapExceededError: () =>
    new FeeCapExceededError({
      maxFeeCap: 1000n,
      resourceFeeStroops: 800n,
      inclusionFeeStroops: 300n,
      attempt: 0,
    }),
  GuardBlockedError: () =>
    new GuardBlockedError({
      reason: "paused",
      stage: "preflight",
    }),
  GuardError: () => new GuardError("guard operational failure"),
  GuardUndeterminedError: () =>
    new GuardUndeterminedError("simulation could not reach a decision", {
      stage: "preflight",
    }),
  HeartbeatBlockedError: () =>
    new HeartbeatBlockedError({
      reason: "paused",
      detail: "kill switch is active",
    }),
  HeartbeatDryRunError: () =>
    new HeartbeatDryRunError({
      verdict: "blocked",
      reason: "paused",
      detail: "dry run refusal",
    }),
  HeartbeatIntervalError: () => new HeartbeatIntervalError(60000, 60n, 20000),
  InvalidFeeCeilingError: () => new InvalidFeeCeilingError("maxFeeStroops", -1n),
  InvalidInputError: () => new InvalidInputError("call", "required", "call must be an object"),
  InvokeRetryError: () =>
    new InvokeRetryError({
      attempts: 3,
      lastOutcome: {
        kind: "error",
        stage: "submit",
        cause: "stale_ledger_sequence",
        detail: "sequence number expired",
        error: new GuardError("sequence collision"),
      } as unknown as sdk.InvokeErrorOutcome,
    }),
  PolicyDecodeError: () =>
    new PolicyDecodeError("validate_policy returned an undecodable ScVal", {
      path: "policy",
    }),
  PolicyEncodeError: () =>
    new PolicyEncodeError([
      { path: "assets[0]", rule: "missing_field", message: "asset address is required" },
    ]),
  PolicyFileReadError: () =>
    new PolicyFileReadError("cannot read policy file 'policy.json' (ENOENT)", {
      path: "policy.json",
      code: "ENOENT",
    }),
  PolicyValidationError: () =>
    new PolicyValidationError(
      "policy file 'policy.json' failed validation with 1 failure(s): empty_vector_noop at assets",
      {
        path: "policy.json",
        failures: [
          {
            path: "assets",
            rule: "empty_vector_noop",
            message: "empty vector has no effect",
          },
        ],
      },
    ),
  PreFlightUndeterminedError: () =>
    new PreFlightUndeterminedError("preflight interceptor could not determine status", {
      stage: "preflight",
    }),
  RateLimitedError: () =>
    new RateLimitedError({
      stage: "simulate",
      retryAfterMs: 1000,
      attempts: 2,
    }),
  RpcTimeoutError: () =>
    new RpcTimeoutError({
      stage: "simulate",
      aborted: false,
      timeoutMs: 5000,
    }),
  SigningError: () => new SigningError("agent key signature failed"),
  SimulationError: () =>
    new SimulationError("simulation request failed", {
      stage: "simulate",
    }),
};

const RUNTIME_SNAPSHOTS: Record<string, ErrorSnapshot> = {
  AdapterConfigError: {
    name: "AdapterConfigError",
    message:
      "langchain adapter options are invalid: 2 problem(s) found (`interceptor`, `toContractCall`).\n  - `interceptor` is required and must be a PreFlightInterceptor (an object exposing a `check(...)` method).\n  - `toContractCall` or `toContractCalls` is required; supply one to map the action to the guarded contract call(s).",
  },
  AdapterMappingError: {
    name: "AdapterMappingError",
    message:
      "`toContractCall` returned a malformed contract call: expected { contract, fn, args } with a non-empty contract and fn and an args array.",
  },
  AuthRefreshError: {
    name: "AuthRefreshError",
    message:
      "auth entry expiring at ledger 1003 is within the 5-ledger refresh margin of ledger 1000 and could not be refreshed",
  },
  BroadcastError: {
    name: "BroadcastError",
    message: "transaction submission request failed",
  },
  ConcurrentTelemetryStreamError: {
    name: "ConcurrentTelemetryStreamError",
    message:
      "GuardTelemetryListener already has an active watch()/watchAll() stream; watch() cannot start concurrently. Use one listener per stream.",
    code: "telemetry.concurrent_stream",
  },
  ContractResponseError: {
    name: "ContractResponseError",
    message: 'simulation returned an invalid resource fee: "invalid-fee"',
    stage: "assemble",
  },
  FeeCapExceededError: {
    name: "FeeCapExceededError",
    message:
      "fee cap exceeded: total 1100 stroops (resource 800 + inclusion 300) exceeds maxFeeCap 1000 stroops; nothing was broadcast",
    code: "fee_cap_exceeded",
  },
  GuardBlockedError: {
    name: "GuardBlockedError",
    message:
      "stellar-agent-guard blocked this action (paused): The policy's admin kill switch is engaged. [call: guard_account.transfer(0 args)]\nThe policy's admin kill switch is engaged.",
    code: 13,
    stage: "preflight",
  },
  GuardError: {
    name: "GuardError",
    message: "heartbeat produced no outcome",
  },
  GuardUndeterminedError: {
    name: "GuardUndeterminedError",
    message:
      "stellar-agent-guard could not determine this action's status\nsimulation could not reach a decision",
    stage: "preflight",
  },
  HeartbeatBlockedError: {
    name: "HeartbeatBlockedError",
    message:
      "stellar-agent-guard blocked the heartbeat (paused): The policy's admin kill switch is engaged.\nguard kill switch active",
  },
  HeartbeatDryRunError: {
    name: "HeartbeatDryRunError",
    message:
      "stellar-agent-guard heartbeat ran as a dry run and never reached the guard (verdict: blocked, reason: paused): The policy's admin kill switch is engaged.\ndry run refusal",
  },
  HeartbeatIntervalError: {
    name: "HeartbeatIntervalError",
    message:
      "heartbeat interval 30000ms exceeds one third of the dead-man grace window (60s → at most 20000ms); a single missed beat could freeze the account",
  },
  InvalidFeeCeilingError: {
    name: "InvalidFeeCeilingError",
    message:
      "Invalid input for 'maxFeeStroops': violates rule 'non_negative_bigint' (expected a non-negative bigint, got -1n)",
    rule: "non_negative_bigint",
  },
  InvalidInputError: {
    name: "InvalidInputError",
    message: "Invalid input for 'call': violates rule 'required' (call must be an object)",
    rule: "required",
  },
  InvokeRetryError: {
    name: "InvokeRetryError",
    message:
      "stellar-agent-guard invoke retry budget exhausted after 3 attempt(s) (last cause: stale_ledger_sequence)\nsequence number expired",
  },
  PolicyDecodeError: {
    name: "PolicyDecodeError",
    message:
      "cannot decode policy field policy: no policy is installed (Void is None, not a config)",
    path: "policy",
  },
  PolicyEncodeError: {
    name: "PolicyEncodeError",
    message:
      "Invalid input for 'assets[0]': violates rule 'invalid_address' (\"not-an-address\" is not a valid Stellar address)",
    rule: "invalid_address",
    path: "assets[0]",
  },
  PolicyFileReadError: {
    name: "PolicyFileReadError",
    message: "cannot read policy file 'missing-policy.json' (ENOENT)",
    code: "ENOENT",
    path: "missing-policy.json",
  },
  PolicyValidationError: {
    name: "PolicyValidationError",
    message:
      "policy file 'invalid-policy.json' failed validation with 2 failure(s): empty_vector_noop at assets; empty_vector_noop at recipients",
    path: "invalid-policy.json",
  },
  PreFlightUndeterminedError: {
    name: "GuardUndeterminedError",
    message:
      "stellar-agent-guard could not determine this action's status\nsimulation could not reach a decision",
    stage: "preflight",
  },
  RateLimitedError: {
    name: "RateLimitedError",
    message: "the RPC rate-limited the simulation (HTTP 429) on 2 attempt(s); Retry-After 1000ms",
    stage: "simulate",
  },
  RpcTimeoutError: {
    name: "RpcTimeoutError",
    message: "RPC call during 'simulate' aborted by caller signal",
    stage: "simulate",
  },
  SigningError: {
    name: "SigningError",
    message:
      "signer.publicKey must be a checksum-valid G... Ed25519 StrKey or a 64-character hex-encoded 32-byte public key",
  },
  SimulationError: {
    name: "SimulationError",
    message: "reading guard status returned no value",
    stage: "simulate",
  },
};

const RUNTIME_THROWS: Record<string, () => Promise<void> | void> = {
  AdapterConfigError: () => {
    createLangChainGuardMiddleware({} as unknown as sdk.LangChainGuardOptions);
  },
  AdapterMappingError: () => {
    normalizeMappedCall({} as unknown as sdk.ContractCall, "toContractCall");
  },
  AuthRefreshError: async () => {
    const entry = await buildGuardAuthEntry({
      guard: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      call: {
        contract:
          "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as unknown as sdk.ContractAddress,
        fn: "transfer",
        args: [],
      },
      signer: Keypair.random(),
      nonce: 1n,
      signatureExpirationLedger: 1003,
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    await refreshNearExpiryAuthEntries({
      entries: [entry],
      currentLedger: 1000,
      refresh: async () => {
        throw new Error("signer unavailable");
      },
    });
  },
  BroadcastError: async () => {
    await submitAndPoll(
      {
        sendTransaction: async () => {
          throw new Error("network rejected");
        },
      } as unknown as rpc.Server,
      { networkPassphrase: "test" } as unknown as Transaction,
      [],
    );
  },
  ConcurrentTelemetryStreamError: async () => {
    const rawEvent = {
      contractId: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      type: "contract" as const,
      topic: [xdr.ScVal.scvSymbol("event_heartbeat")],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("at"), val: xdr.ScVal.scvU64(100n) }),
      ]),
      ledger: 100,
      ledgerClosedAt: null,
      txHash: "tx-1",
    };
    const listener = new GuardTelemetryListener({
      server: {
        getLatestLedger: async () => ({ sequence: 500 }),
        getEvents: async () => ({ events: [rawEvent], cursor: "c1", latestLedger: 500 }),
      } as unknown as rpc.Server,
      guard: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
    });
    const first = listener.watch({ pollIntervalMs: 1 });
    await first.next();
    const second = listener.watch({ pollIntervalMs: 1 });
    try {
      await second.next();
    } finally {
      await first.return?.();
      await second.return?.();
    }
  },
  ContractResponseError: () => {
    parseSimulationResourceFee("invalid-fee", { stage: "assemble" });
  },
  FeeCapExceededError: () => {
    throw CONSTRUCTORS["FeeCapExceededError"]!();
  },
  GuardBlockedError: async () => {
    const interceptor = new PreFlightInterceptor({
      server: {} as unknown as rpc.Server,
      guard:
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as unknown as sdk.ContractAddress,
      agent: Keypair.random(),
      source: Keypair.random(),
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    interceptor.check = async () =>
      ({
        kind: "blocked",
        allowed: false,
        reason: "paused",
        stage: "preflight",
        detail: "The policy's admin kill switch is engaged.",
        charged: false,
      }) as unknown as sdk.PreFlightDecision;
    await interceptor.assertAllowed({
      contract: "guard_account" as unknown as sdk.ContractAddress,
      fn: "transfer",
      args: [],
    });
  },
  GuardError: async () => {
    await heartbeat({
      server: {} as unknown as rpc.Server,
      guard:
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as unknown as sdk.ContractAddress,
      signer: {} as unknown as sdk.AgentSigner,
      submit: async () => ({ outcome: undefined as unknown as sdk.InvokeOutcome }),
    });
  },
  GuardUndeterminedError: async () => {
    const interceptor = new PreFlightInterceptor({
      server: {} as unknown as rpc.Server,
      guard:
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as unknown as sdk.ContractAddress,
      agent: Keypair.random(),
      source: Keypair.random(),
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    interceptor.check = async () =>
      ({
        kind: "undetermined",
        allowed: false,
        stage: "preflight",
        detail: "simulation could not reach a decision",
        cause: "simulation_failed",
        latencyMs: 10,
      }) as unknown as sdk.PreFlightDecision;
    await interceptor.assertAllowed({
      contract: "guard_account" as unknown as sdk.ContractAddress,
      fn: "transfer",
      args: [],
    });
  },
  HeartbeatBlockedError: async () => {
    await heartbeat({
      server: {} as unknown as rpc.Server,
      guard:
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as unknown as sdk.ContractAddress,
      signer: {} as unknown as sdk.AgentSigner,
      submit: async () => ({
        outcome: {
          kind: "blocked",
          reason: "paused",
          stage: "submission",
          detail: "guard kill switch active",
        } as unknown as sdk.InvokeOutcome,
      }),
    });
  },
  HeartbeatDryRunError: async () => {
    await heartbeat({
      server: {} as unknown as rpc.Server,
      guard:
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as unknown as sdk.ContractAddress,
      signer: {} as unknown as sdk.AgentSigner,
      submit: async () => ({
        outcome: {
          kind: "dry_run",
          verdict: "blocked",
          reason: "paused",
          stage: "simulate",
          detail: "dry run refusal",
        } as unknown as sdk.InvokeOutcome,
      }),
    });
  },
  HeartbeatIntervalError: async () => {
    await startHeartbeat({
      server: {} as unknown as rpc.Server,
      guard:
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as unknown as sdk.ContractAddress,
      signer: {} as unknown as sdk.AgentSigner,
      intervalMs: 30000,
      graceSecs: 60n,
    });
  },
  InvalidFeeCeilingError: () => {
    new CostPreChecker({
      interceptor: { check: async () => ({}) as unknown as sdk.PreFlightDecision },
      maxFeeStroops: -1n,
    });
  },
  InvalidInputError: () => {
    validateContractCall(null as unknown as sdk.ContractCall);
  },
  InvokeRetryError: () => {
    throw CONSTRUCTORS["InvokeRetryError"]!();
  },
  PolicyDecodeError: () => {
    decodePolicy(xdr.ScVal.scvVoid());
  },
  PolicyEncodeError: () => {
    policyToScVal({
      ...DEFAULT_GUARD_POLICY,
      assets: ["not-an-address" as unknown as sdk.ContractAddress],
    });
  },
  PolicyFileReadError: async () => {
    await loadPolicyFromFile("missing-policy.json");
  },
  PolicyValidationError: async () => {
    const filename = "invalid-policy.json";
    writeFileSync(
      filename,
      JSON.stringify(
        policyToJson({
          ...DEFAULT_GUARD_POLICY,
          per_tx_cap: 2000n,
          window_cap: 1000n,
        }),
      ),
    );
    try {
      await loadPolicyFromFile(filename);
    } finally {
      rmSync(filename, { force: true });
    }
  },
  PreFlightUndeterminedError: async () => {
    const interceptor = new PreFlightInterceptor({
      server: {} as unknown as rpc.Server,
      guard:
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as unknown as sdk.ContractAddress,
      agent: Keypair.random(),
      source: Keypair.random(),
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    interceptor.check = async () =>
      ({
        kind: "undetermined",
        allowed: false,
        stage: "preflight",
        detail: "simulation could not reach a decision",
        cause: "simulation_failed",
        latencyMs: 10,
      }) as unknown as sdk.PreFlightDecision;
    await interceptor.assertAllowed({
      contract: "guard_account" as unknown as sdk.ContractAddress,
      fn: "transfer",
      args: [],
    });
  },
  RateLimitedError: async () => {
    const server = {
      async getAccount() {
        return new Account("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", "100");
      },
      async getLatestLedger() {
        return { sequence: 1000 };
      },
      async simulateTransaction() {
        const error = new Error("rate limited") as Error & {
          response?: { status: number; headers?: Record<string, string> };
        };
        error.response = { status: 429, headers: { "retry-after": "1" } };
        throw error;
      },
    };
    const interceptor = new PreFlightInterceptor({
      server: server as unknown as rpc.Server,
      guard:
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as unknown as sdk.ContractAddress,
      agent: Keypair.random(),
      source: Keypair.random(),
      networkPassphrase: "Test SDF Network ; September 2015",
      clock: { now: () => 0, sleep: async () => {} },
    });
    const decision = await interceptor.check({
      contract:
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as unknown as sdk.ContractAddress,
      fn: "test",
      args: [],
    });
    if (decision.kind === "undetermined" && decision.error) {
      throw decision.error;
    }
  },
  RpcTimeoutError: async () => {
    await withRpcAbort({ stage: "simulate", signal: AbortSignal.abort() }, async () => {});
  },
  SigningError: () => {
    validateAgentPublicKey("");
  },
  SimulationError: async () => {
    const server = {
      getAccount: async () =>
        new Account("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", "1"),
      simulateTransaction: async () => ({ result: {} }),
    };
    await readGuardStatus({
      server: server as unknown as rpc.Server,
      guard: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      source: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    });
  },
};

describe("public error snapshots (issue #491)", () => {
  it("registers a snapshot for every exported error class", () => {
    const allExports = { ...sdk, ...fsModule };
    const exportedErrorClasses = Object.entries(allExports)
      .filter(
        ([_, val]) => typeof val === "function" && val.prototype && val.prototype instanceof Error,
      )
      .map(([name]) => name)
      .sort();

    assert.deepEqual(Object.keys(CONSTRUCTOR_SNAPSHOTS).sort(), exportedErrorClasses);
    assert.deepEqual(Object.keys(RUNTIME_SNAPSHOTS).sort(), exportedErrorClasses);
  });

  it("ensures snapshots contain no sensitive values (addresses, hashes, XDR)", () => {
    const stellarAddressPattern = /\b[GA][A-Z2-7]{55}\b/;
    const contractAddressPattern = /\bC[A-Z2-7]{55}\b/;
    const hexHashPattern = /\b[0-9a-fA-F]{64}\b/;
    const xdrPattern = /\bAAAA[A-Za-z0-9+/=]{10,}\b/;

    for (const [name, snapshot] of Object.entries(CONSTRUCTOR_SNAPSHOTS)) {
      for (const field of [
        snapshot.message,
        snapshot.path ?? "",
        String(snapshot.code ?? ""),
        snapshot.rule ?? "",
        snapshot.stage ?? "",
      ]) {
        assert.doesNotMatch(
          field,
          stellarAddressPattern,
          `${name} constructor snapshot leaked account address`,
        );
        assert.doesNotMatch(
          field,
          contractAddressPattern,
          `${name} constructor snapshot leaked contract address`,
        );
        assert.doesNotMatch(field, hexHashPattern, `${name} constructor snapshot leaked hex hash`);
        assert.doesNotMatch(field, xdrPattern, `${name} constructor snapshot leaked XDR payload`);
      }
    }

    for (const [name, snapshot] of Object.entries(RUNTIME_SNAPSHOTS)) {
      for (const field of [
        snapshot.message,
        snapshot.path ?? "",
        String(snapshot.code ?? ""),
        snapshot.rule ?? "",
        snapshot.stage ?? "",
      ]) {
        assert.doesNotMatch(
          field,
          stellarAddressPattern,
          `${name} runtime snapshot leaked account address`,
        );
        assert.doesNotMatch(
          field,
          contractAddressPattern,
          `${name} runtime snapshot leaked contract address`,
        );
        assert.doesNotMatch(field, hexHashPattern, `${name} runtime snapshot leaked hex hash`);
        assert.doesNotMatch(field, xdrPattern, `${name} runtime snapshot leaked XDR payload`);
      }
    }
  });

  it("ensures snapshots are stable across platforms", () => {
    for (const [name, snapshot] of Object.entries(CONSTRUCTOR_SNAPSHOTS)) {
      assert.doesNotMatch(
        snapshot.message,
        /\r/,
        `${name} constructor snapshot contains CR line ending`,
      );
      if (snapshot.path) {
        assert.doesNotMatch(
          snapshot.path,
          /\\/,
          `${name} constructor path contains Windows backslash`,
        );
      }
    }

    for (const [name, snapshot] of Object.entries(RUNTIME_SNAPSHOTS)) {
      assert.doesNotMatch(
        snapshot.message,
        /\r/,
        `${name} runtime snapshot contains CR line ending`,
      );
      if (snapshot.path) {
        assert.doesNotMatch(snapshot.path, /\\/, `${name} runtime path contains Windows backslash`);
      }
    }
  });

  describe("constructor message shapes", () => {
    for (const [name, expected] of Object.entries(CONSTRUCTOR_SNAPSHOTS)) {
      it(`matches snapshot for ${name}`, () => {
        const create = CONSTRUCTORS[name];
        assert.ok(create, `missing constructor factory for ${name}`);
        const err = create();
        assert.deepEqual(snapshotOf(err), expected);
      });
    }
  });

  describe("representative runtime throws", () => {
    for (const [name, expected] of Object.entries(RUNTIME_SNAPSHOTS)) {
      it(`matches runtime throw snapshot for ${name}`, async () => {
        const trigger = RUNTIME_THROWS[name];
        assert.ok(trigger, `missing runtime throw factory for ${name}`);
        try {
          await trigger();
          assert.fail(`expected runtime throw for ${name}`);
        } catch (error) {
          if (error instanceof assert.AssertionError) throw error;
          assert.deepEqual(snapshotOf(error), expected);
        }
      });
    }
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
    "AuthRefreshError",
    () =>
      new AuthRefreshError("auth entry expired before the enforced simulation", {
        address: "GABC",
        expirationLedger: 1003,
        currentLedger: 1000,
        marginLedgers: 5,
      }),
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
