/**
 * Unit tests for live fixture lifecycle, schema validation, and precondition checks.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Account, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import {
  ENV_FILE,
  FIXTURE_PATH as HARNESS_FIXTURE_PATH,
  GUARD_FIXTURE_ENV_VAR,
  REDEPLOY_INSTRUCTION,
  assertFixtureSchema,
  assertPreconditions,
  isEphemeralMode,
  isSharedFixtureMode,
  resetSharedFixtureWarning,
  resolveEnvFile,
  resolveFixturePath,
  sharedFixtureWarningMessage,
  warnIfSharedFixture,
  type Phase2Config,
} from "../integration/harness.ts";
import { unsafeContractAddress, unsafeAccountAddress } from "../../src/policy.ts";

const FIXTURE_PATH = resolve(process.cwd(), "tests/fixtures/phase2-instance.json");

describe("fixture instance schema validation", () => {
  it("validates the committed phase2-instance.json against the expected schema", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as unknown;
    assert.doesNotThrow(() => assertFixtureSchema(raw));
  });

  it("fails with actionable message if root keys are missing", () => {
    assert.throws(
      () => assertFixtureSchema({ network: "testnet" }),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(err.message, /missing root key/);
        assert.match(err.message, new RegExp(REDEPLOY_INSTRUCTION));
        return true;
      },
    );
  });

  it("fails with actionable message if phase2EnforcementInstance keys are missing", () => {
    const partial = {
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      phase2EnforcementInstance: {
        guard: unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44"),
      },
    };

    assert.throws(
      () => assertFixtureSchema(partial),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(err.message, /missing key/);
        assert.match(err.message, new RegExp(REDEPLOY_INSTRUCTION));
        return true;
      },
    );
  });

  it("fails with actionable message if address keys are missing", () => {
    const partialAddresses = {
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      phase2EnforcementInstance: {
        guard: unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44"),
        token: unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"),
        tokenIssuer: unsafeAccountAddress(
          "GCE5SDY44O23HRRN4XRTOZ2DJRAKN3WKYMUGIMYCS7RB7OG27MKN5ZPO",
        ),
        wasmHashLedger: "f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63",
        addresses: {
          admin: unsafeAccountAddress("GDCPT4Z3MBH7X6IX6A6BHIENUL7DRZ44O2SL2V72QJVOEJHJROP3PQDG"),
        },
        transactions: {},
        mints: [],
        status: { admin_frozen: false, has_policy: true, heartbeat_expired: false },
        policy: {},
        guardTokenBalance: "1000",
      },
    };

    assert.throws(
      () => assertFixtureSchema(partialAddresses),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(err.message, /addresses missing role/);
        assert.match(err.message, new RegExp(REDEPLOY_INSTRUCTION));
        return true;
      },
    );
  });
});

describe("assertPreconditions live suite preflight checks", () => {
  const guard = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
  const token = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
  const admin = Keypair.random();
  const agent = Keypair.random();

  const mockConfig: Phase2Config = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    guard,
    token,
    keys: {
      admin,
      agent,
      recipient: Keypair.random(),
      outsider: Keypair.random(),
    },
    policy: {
      per_tx_cap: 1000n,
      window_secs: 60n,
      window_cap: 150n,
      assets: [token],
      protocols: [],
      recipients: [],
      allow_any_recipient: false,
      active_from: 0n,
      active_until: 0n,
      paused: false,
      dms_grace_secs: 0n,
    },
  };

  function createMockPreconditionsServer(
    overrides: {
      contractExists?: boolean;
      hasPolicy?: boolean;
      adminFrozen?: boolean;
      heartbeatExpired?: boolean;
      agentXlmBalance?: string;
      tokenBalance?: bigint;
    } = {},
  ) {
    const {
      contractExists = true,
      hasPolicy = true,
      adminFrozen = false,
      heartbeatExpired = false,
      agentXlmBalance = "100.0",
      tokenBalance = 5000n,
    } = overrides;

    return {
      async getContractInstance(id: string) {
        if (!contractExists) throw new Error("Contract not found on ledger");
        return { id };
      },
      async getAccount(address: string) {
        return new Account(address, "100");
      },
      async getAccountEntry(_address: string) {
        return {
          balance: BigInt(Math.round(parseFloat(agentXlmBalance) * 10_000_000)),
        };
      },
      async simulateTransaction(tx: unknown) {
        const anyTx = tx as {
          operations?: Array<{
            func?: {
              invokeContract?: {
                functionName?: {
                  toString: () => string;
                };
              };
            };
          }>;
        };
        const fnName = anyTx.operations?.[0]?.func?.invokeContract?.functionName?.toString();

        if (fnName === "status") {
          return {
            result: {
              retval: xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("has_policy"),
                  val: xdr.ScVal.scvBool(hasPolicy),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("admin_frozen"),
                  val: xdr.ScVal.scvBool(adminFrozen),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("heartbeat_expired"),
                  val: xdr.ScVal.scvBool(heartbeatExpired),
                }),
              ]),
            },
          };
        }

        if (fnName === "policy") {
          if (!hasPolicy) return { result: { retval: xdr.ScVal.scvVoid() } };
          return {
            result: {
              retval: xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("per_tx_cap"),
                  val: nativeToScVal(1000n, { type: "i128" }),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("window_cap"),
                  val: nativeToScVal(150n, { type: "i128" }),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("window_secs"),
                  val: nativeToScVal(60n, { type: "u64" }),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("paused"),
                  val: xdr.ScVal.scvBool(false),
                }),
              ]),
            },
          };
        }

        if (fnName === "balance") {
          return {
            result: {
              retval: nativeToScVal(tokenBalance, { type: "i128" }),
            },
          };
        }

        return { result: { retval: xdr.ScVal.scvVoid() } };
      },
    } as unknown as rpc.Server;
  }

  it("Check 1: fails when guard contract does not exist on testnet", async () => {
    const mockServer = createMockPreconditionsServer({ contractExists: false });
    await assert.rejects(
      async () => assertPreconditions(mockServer, mockConfig),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(err.message, /\[FIXTURE PRECONDITION FAILED\] Guard contract/);
        assert.match(err.message, /does not exist on testnet ledger/);
        assert.match(err.message, new RegExp(REDEPLOY_INSTRUCTION));
        return true;
      },
    );
  });

  it("Check 2: fails when guard policy is absent or frozen", async () => {
    const mockServer = createMockPreconditionsServer({ hasPolicy: false });
    await assert.rejects(
      async () => assertPreconditions(mockServer, mockConfig),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(
          err.message,
          /\[FIXTURE PRECONDITION FAILED\] Guard policy is invalid or frozen/,
        );
        assert.match(err.message, new RegExp(REDEPLOY_INSTRUCTION));
        return true;
      },
    );

    const frozenServer = createMockPreconditionsServer({ adminFrozen: true });
    await assert.rejects(
      async () => assertPreconditions(frozenServer, mockConfig),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(
          err.message,
          /\[FIXTURE PRECONDITION FAILED\] Guard policy is invalid or frozen/,
        );
        assert.match(err.message, new RegExp(REDEPLOY_INSTRUCTION));
        return true;
      },
    );
  });

  it("Check 3: fails when agent account native balance is below minimum", async () => {
    const mockServer = createMockPreconditionsServer({ agentXlmBalance: "1.5" });
    await assert.rejects(
      async () => assertPreconditions(mockServer, mockConfig, { minAgentXlm: 10 }),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(err.message, /\[FIXTURE PRECONDITION FAILED\] Agent account/);
        assert.match(err.message, /is below minimum required/);
        assert.match(err.message, new RegExp(REDEPLOY_INSTRUCTION));
        return true;
      },
    );
  });

  it("Check 4: fails when guard token balance is below minimum", async () => {
    const mockServer = createMockPreconditionsServer({ tokenBalance: 50n });
    await assert.rejects(
      async () => assertPreconditions(mockServer, mockConfig, { minTokenBalance: 1000n }),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(err.message, /\[FIXTURE PRECONDITION FAILED\] Guard token balance/);
        assert.match(err.message, /is below minimum required/);
        assert.match(err.message, new RegExp(REDEPLOY_INSTRUCTION));
        return true;
      },
    );
  });

  it("All checks pass when fixture is valid and funded", async () => {
    const mockServer = createMockPreconditionsServer();
    const result = await assertPreconditions(mockServer, mockConfig);
    assert.equal(result.codeExists, true);
    assert.equal(result.policyInstalled, true);
    assert.equal(result.agentFunded, true);
    assert.equal(result.tokenFunded, true);
  });
});

describe("parallel-safe live suite execution and fixture resolution (issue #98)", () => {
  const originalGuardFixture = process.env[GUARD_FIXTURE_ENV_VAR];
  const originalEphemeralEnv = process.env["GUARD_EPHEMERAL_ENV_FILE"];
  const originalEphemeralFixture = process.env["GUARD_EPHEMERAL_FIXTURE"];

  afterEach(() => {
    if (originalGuardFixture !== undefined) {
      process.env[GUARD_FIXTURE_ENV_VAR] = originalGuardFixture;
    } else {
      delete process.env[GUARD_FIXTURE_ENV_VAR];
    }
    if (originalEphemeralEnv !== undefined) {
      process.env["GUARD_EPHEMERAL_ENV_FILE"] = originalEphemeralEnv;
    } else {
      delete process.env["GUARD_EPHEMERAL_ENV_FILE"];
    }
    if (originalEphemeralFixture !== undefined) {
      process.env["GUARD_EPHEMERAL_FIXTURE"] = originalEphemeralFixture;
    } else {
      delete process.env["GUARD_EPHEMERAL_FIXTURE"];
    }
    resetSharedFixtureWarning();
  });

  it("defaults to ephemeral mode when GUARD_FIXTURE is not set", () => {
    delete process.env[GUARD_FIXTURE_ENV_VAR];
    assert.equal(isSharedFixtureMode(), false);
    assert.equal(isEphemeralMode(), true);
  });

  it("recognizes shared mode when GUARD_FIXTURE is set to shared, 1, true, or path", () => {
    for (const val of ["shared", "1", "true", "default", "tests/fixtures/phase2-instance.json"]) {
      process.env[GUARD_FIXTURE_ENV_VAR] = val;
      assert.equal(isSharedFixtureMode(), true, `Expected shared mode for ${val}`);
      assert.equal(isEphemeralMode(), false, `Expected not ephemeral mode for ${val}`);
    }
  });

  it("resolves default fixture path to FIXTURE_PATH in shared mode", () => {
    process.env[GUARD_FIXTURE_ENV_VAR] = "shared";
    assert.equal(resolveFixturePath(), HARNESS_FIXTURE_PATH);
  });

  it("resolves custom fixture path when specified in GUARD_FIXTURE", () => {
    process.env[GUARD_FIXTURE_ENV_VAR] = "custom/test-fixture.json";
    assert.equal(resolveFixturePath(), "custom/test-fixture.json");
  });

  it("resolves env file to ENV_FILE in shared mode", () => {
    process.env[GUARD_FIXTURE_ENV_VAR] = "shared";
    assert.equal(resolveEnvFile(), ENV_FILE);
  });

  it("resolves to ephemeral env and fixture files when GUARD_EPHEMERAL_* env vars are set", () => {
    delete process.env[GUARD_FIXTURE_ENV_VAR];
    process.env["GUARD_EPHEMERAL_ENV_FILE"] = ".env.custom.ephemeral";
    process.env["GUARD_EPHEMERAL_FIXTURE"] = "custom.ephemeral.json";
    assert.equal(resolveEnvFile(), ".env.custom.ephemeral");
    assert.equal(resolveFixturePath(), "custom.ephemeral.json");
  });

  it("generates actionable shared fixture warning message", () => {
    const msg = sharedFixtureWarningMessage("tests/fixtures/phase2-instance.json");
    assert.match(msg, /\[GUARD_FIXTURE\] WARNING: Running against shared testnet fixture/);
    assert.match(msg, /tests\/fixtures\/phase2-instance\.json/);
    assert.match(msg, /interleave sequence numbers and rolling window spend/);
    assert.match(msg, /unset GUARD_FIXTURE to use default ephemeral mode/);
  });

  it("warnIfSharedFixture warns once and deduplicates", () => {
    process.env[GUARD_FIXTURE_ENV_VAR] = "shared";
    resetSharedFixtureWarning();

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      warnIfSharedFixture();
      warnIfSharedFixture();
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /\[GUARD_FIXTURE\] WARNING/);
    } finally {
      console.warn = origWarn;
    }
  });
});
