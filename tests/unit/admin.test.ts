/**
 * Unit tests for admin operations helpers (src/admin.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Account,
  Address,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  agentPubkeyToScVal,
  buildFreezeCall,
  buildRotateAgentKeyCall,
  buildSetPolicyCall,
  buildUnfreezeCall,
  isAdminOpOutcome,
  previewSetPolicy,
  submitFreeze,
  submitRotateAgentKey,
  submitSetPolicy,
  submitUnfreeze,
  waitForAdminOp,
  type AdminInvokeOutcome,
} from "../../src/admin.ts";
import type { AdminOpOutcome } from "../../src/admin.ts";
import { FakeClock } from "../../src/clock.ts";
import { policyHash } from "../../src/policy-json.ts";
import { InvalidInputError } from "../../src/errors.ts";
import {
  policyToScVal,
  type ContractAddress,
  type PolicyConfig,
  unsafeContractAddress,
  unsafeAccountAddress,
} from "../../src/policy.ts";
import { RpcTimeoutError } from "../../src/invoke.ts";
import type { AdminSigner } from "../../src/tx.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = unsafeAccountAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ");

const TEST_POLICY: PolicyConfig = {
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
};

function createMockServer(adminPubkey: string) {
  let simulatedTx: unknown = null;
  let sentTx: unknown = null;

  const mockServer = {
    getAccount: async (_address: string) => {
      return new Account(adminPubkey, "100");
    },
    getLatestLedger: async () => ({ sequence: 1000 }),
    simulateTransaction: async (tx: unknown) => {
      simulatedTx = tx;
      return {
        result: {
          auth: [
            new xdr.SorobanAuthorizationEntry({
              credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
                new xdr.SorobanAddressCredentials({
                  address: new Address(adminPubkey).toScAddress(),
                  nonce: 100n,
                  signatureExpirationLedger: 11000,
                  signature: xdr.ScVal.scvVoid(),
                }),
              ),
              rootInvocation: new xdr.SorobanAuthorizedInvocation({
                function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                  new xdr.InvokeContractArgs({
                    contractAddress: new Address(GUARD).toScAddress(),
                    functionName: "set_policy",
                    args: [],
                  }),
                ),
                subInvocations: [],
              }),
            }),
          ],
        },
        minResourceFee: "1000",
        transactionData: new SorobanDataBuilder(),
      };
    },
    sendTransaction: async (tx: unknown) => {
      sentTx = tx;
      return { status: "PENDING", hash: "admin_tx_hash_123" };
    },
    getTransaction: async (_hash: string) => {
      return {
        status: "SUCCESS",
        ledger: 1001,
        events: { contractEventsXdr: [] },
      };
    },
    getSimulatedTx: () => simulatedTx,
    getSentTx: () => sentTx,
  };

  return mockServer;
}

describe("admin call builders", () => {
  it("buildSetPolicyCall encodes identical ScVal to policyToScVal (no duplicated encoding)", () => {
    const call = buildSetPolicyCall(GUARD, TEST_POLICY);
    assert.equal(call.contract, GUARD);
    assert.equal(call.fn, "set_policy");
    assert.equal(call.args.length, 1);

    const directScVal = policyToScVal(TEST_POLICY);
    assert.deepEqual(call.args[0]!.toXDR("base64"), directScVal.toXDR("base64"));
  });

  it("buildFreezeCall produces empty args invocation", () => {
    const call = buildFreezeCall(GUARD);
    assert.equal(call.contract, GUARD);
    assert.equal(call.fn, "freeze");
    assert.deepEqual(call.args, []);
  });

  it("buildUnfreezeCall produces empty args invocation", () => {
    const call = buildUnfreezeCall(GUARD);
    assert.equal(call.contract, GUARD);
    assert.equal(call.fn, "unfreeze");
    assert.deepEqual(call.args, []);
  });

  it("buildRotateAgentKeyCall encodes agent public key correctly", () => {
    const agentKp = Keypair.random();
    const call = buildRotateAgentKeyCall(GUARD, agentKp.publicKey());
    assert.equal(call.contract, GUARD);
    assert.equal(call.fn, "rotate_agent_key");
    assert.equal(call.args.length, 1);

    const decoded = Buffer.from(scValToNative(call.args[0]!) as Uint8Array);
    assert.deepEqual(decoded, Buffer.from(agentKp.rawPublicKey()));
  });
});

describe("agentPubkeyToScVal conversion", () => {
  const kp = Keypair.random();

  it("accepts Keypair instance", () => {
    const sc = agentPubkeyToScVal(kp);
    assert.deepEqual(Buffer.from(scValToNative(sc) as Uint8Array), Buffer.from(kp.rawPublicKey()));
  });

  it("accepts StrKey G... string", () => {
    const sc = agentPubkeyToScVal(kp.publicKey());
    assert.deepEqual(Buffer.from(scValToNative(sc) as Uint8Array), Buffer.from(kp.rawPublicKey()));
  });

  it("accepts raw 32-byte Uint8Array / Buffer", () => {
    const raw = Buffer.from(StrKey.decodeEd25519PublicKey(kp.publicKey()));
    const sc = agentPubkeyToScVal(raw);
    assert.deepEqual(Buffer.from(scValToNative(sc) as Uint8Array), raw);
  });

  it("accepts 64-char hex string", () => {
    const hex = Buffer.from(kp.rawPublicKey()).toString("hex");
    const sc = agentPubkeyToScVal(hex);
    assert.deepEqual(Buffer.from(scValToNative(sc) as Uint8Array), Buffer.from(kp.rawPublicKey()));
  });

  it("validates the StrKey checksum and reports a typed field error without echoing input", () => {
    const invalid = kp.publicKey().slice(0, -1) + (kp.publicKey().endsWith("A") ? "B" : "A");
    assert.throws(
      () => agentPubkeyToScVal(invalid),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.equal(error.field, "newAgent");
        assert.match(error.message, /G\.\.\. Ed25519 public key/);
        assert.doesNotMatch(error.message, new RegExp(invalid));
        return true;
      },
    );
  });

  it("rejects wrong byte lengths and malformed hex with typed field errors", () => {
    for (const invalid of [new Uint8Array(16), "z".repeat(64), "a".repeat(63)]) {
      assert.throws(
        () => agentPubkeyToScVal(invalid),
        (error: unknown) => error instanceof InvalidInputError && error.field === "newAgent",
      );
    }
  });
});

describe("typed admin submit functions with Keypair admin", () => {
  const adminKp = Keypair.random();

  it("submitSetPolicy simulates, signs auth, and broadcasts", async () => {
    const mockServer = createMockServer(adminKp.publicKey());
    const outcome = await submitSetPolicy({
      server: mockServer as never,
      guard: GUARD,
      policy: TEST_POLICY,
      admin: adminKp,
      pollIntervalMs: 1,
    });

    assert.equal(outcome.kind, "allowed");
    if (outcome.kind === "allowed") {
      assert.equal(outcome.submission.hash, "admin_tx_hash_123");
      assert.equal(outcome.submission.ledger, 1001);
    }
  });

  it("submitFreeze submits freeze operation", async () => {
    const mockServer = createMockServer(adminKp.publicKey());
    const outcome = await submitFreeze({
      server: mockServer as never,
      guard: GUARD,
      admin: adminKp,
      pollIntervalMs: 1,
    });

    assert.equal(outcome.kind, "allowed");
  });

  it("submitUnfreeze submits unfreeze operation", async () => {
    const mockServer = createMockServer(adminKp.publicKey());
    const outcome = await submitUnfreeze({
      server: mockServer as never,
      guard: GUARD,
      admin: adminKp,
      pollIntervalMs: 1,
    });

    assert.equal(outcome.kind, "allowed");
  });

  it("submitRotateAgentKey submits rotate_agent_key operation", async () => {
    const newAgent = Keypair.random();
    const mockServer = createMockServer(adminKp.publicKey());
    const outcome = await submitRotateAgentKey({
      server: mockServer as never,
      guard: GUARD,
      newAgent: newAgent.publicKey(),
      admin: adminKp,
      pollIntervalMs: 1,
    });

    assert.equal(outcome.kind, "allowed");
  });
});

describe("typed admin submit functions with custom AdminSigner (e.g. Freighter)", () => {
  const adminKp = Keypair.random();
  let signedTxHookCalled = false;

  const customSigner: AdminSigner = {
    publicKey: async () => adminKp.publicKey(),
    signTransaction: async (tx) => {
      signedTxHookCalled = true;
      tx.sign(adminKp);
      return tx;
    },
  };

  it("supports classic custom AdminSigner for setPolicy", async () => {
    signedTxHookCalled = false;
    const mockServer = createMockServer(adminKp.publicKey());
    const outcome = await submitSetPolicy({
      server: mockServer as never,
      guard: GUARD,
      policy: TEST_POLICY,
      admin: customSigner,
      pollIntervalMs: 1,
    });

    assert.equal(outcome.kind, "allowed");
    assert.equal(signedTxHookCalled, true);
  });
});

/**
 * Cancellation and per-call timeouts, forwarded to `invoke()` unchanged.
 *
 * An operator applying or freezing a policy needs the same bounded RPC
 * behaviour a normal invocation has, without dropping to the raw `invoke()`
 * call. The forwarding must be exact: an already-aborted signal must produce
 * the documented typed outcome (the `error` arm carrying an `RpcTimeoutError`)
 * *before any RPC*, and a fired timeout must be reported the same way.
 */
describe("admin helpers forward signal and timeoutMs", () => {
  const adminKp = Keypair.random();

  /** A server that fails the test if it is ever called. */
  function forbiddenServer(calls: string[]) {
    const forbidden = (name: string) => async () => {
      calls.push(name);
      throw new Error(`the RPC must not be reached: ${name}`);
    };
    return {
      getAccount: forbidden("getAccount"),
      getLatestLedger: forbidden("getLatestLedger"),
      simulateTransaction: forbidden("simulateTransaction"),
      sendTransaction: forbidden("sendTransaction"),
      getTransaction: forbidden("getTransaction"),
    } as unknown as never;
  }

  const helpers: Array<{
    name: string;
    run: (params: {
      server: never;
      guard: ContractAddress;
      admin: Keypair;
      signal: AbortSignal;
    }) => Promise<{
      kind: string;
      error?: unknown;
    }>;
  }> = [
    {
      name: "submitSetPolicy",
      run: (params) =>
        submitSetPolicy({ ...params, policy: TEST_POLICY }) as Promise<{
          kind: string;
          error?: unknown;
        }>,
    },
    { name: "submitFreeze", run: (params) => submitFreeze(params) as Promise<{ kind: string }> },
    {
      name: "submitUnfreeze",
      run: (params) => submitUnfreeze(params) as Promise<{ kind: string }>,
    },
    {
      name: "submitRotateAgentKey",
      run: (params) =>
        submitRotateAgentKey({ ...params, newAgent: Keypair.random().publicKey() }) as Promise<{
          kind: string;
        }>,
    },
  ];

  for (const helper of helpers) {
    it(`${helper.name} returns the typed abort outcome without any RPC call`, async () => {
      const controller = new AbortController();
      controller.abort();
      const calls: string[] = [];

      const outcome = await helper.run({
        server: forbiddenServer(calls),
        guard: GUARD,
        admin: adminKp,
        signal: controller.signal,
      });

      assert.equal(outcome.kind, "error");
      assert.ok(outcome.error instanceof RpcTimeoutError);
      assert.equal(outcome.error.aborted, true);
      assert.deepEqual(calls, [], "an aborted signal must stop the pipeline before any RPC");
    });
  }

  it("reports a fired per-call timeout as the same typed timeout outcome", async () => {
    const never = () => new Promise<never>(() => {});
    const server = {
      getAccount: never,
      getLatestLedger: never,
      simulateTransaction: never,
      sendTransaction: never,
      getTransaction: never,
    } as unknown as never;

    const outcome = await submitFreeze({
      server,
      guard: GUARD,
      admin: adminKp,
      timeoutMs: 5,
    });

    assert.equal(outcome.kind, "error");
    assert.ok(outcome.error instanceof RpcTimeoutError);
    assert.equal(outcome.error.aborted, false);
    assert.equal(outcome.error.timeoutMs, 5);
  });

  it("leaves the administrative authorization behaviour untouched", async () => {
    const controller = new AbortController();
    const mockServer = createMockServer(adminKp.publicKey());

    const outcome = await submitFreeze({
      server: mockServer as never,
      guard: GUARD,
      admin: adminKp,
      pollIntervalMs: 1,
      signal: controller.signal,
      timeoutMs: 30_000,
    });

    assert.equal(outcome.kind, "allowed");
    assert.equal(
      outcome.kind === "allowed" ? outcome.submission.hash : undefined,
      "admin_tx_hash_123",
    );
  });
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("waitForAdminOp (issue #466)", () => {
  const adminKp = Keypair.random();

  async function submittedFreeze(): Promise<AdminOpOutcome> {
    const outcome = await submitFreeze({
      server: createMockServer(adminKp.publicKey()) as never,
      guard: GUARD,
      admin: adminKp,
      pollIntervalMs: 1,
    });
    assert.equal(outcome.kind, "allowed");
    return outcome as AdminOpOutcome;
  }

  it("brands each submit outcome and waits for the matching transaction hash", async () => {
    const outcome = await submittedFreeze();
    assert.ok(isAdminOpOutcome(outcome));

    const reads: string[] = [];
    const server = {
      getTransaction: async (hash: string) => {
        reads.push(hash);
        return {
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 1001,
          events: { contractEventsXdr: [] },
        };
      },
    } as unknown as never;

    const result = await waitForAdminOp(outcome, { server, timeoutMs: 1_000 });
    assert.deepEqual(reads, ["admin_tx_hash_123"]);
    assert.equal(result.status, "confirmed");
    assert.equal(result.transactionHash, "admin_tx_hash_123");
    assert.equal(result.ledger, 1001);
    assert.deepEqual(result.admin, {
      op: "freeze",
      guard: GUARD,
      transactionHash: "admin_tx_hash_123",
    });
  });

  it("polls without rebroadcasting and becomes confirmed after a pending read", async () => {
    const outcome = await submittedFreeze();
    const clock = new FakeClock();
    let reads = 0;
    let sends = 0;
    const server = {
      getTransaction: async () => {
        reads += 1;
        return reads === 1
          ? { status: rpc.Api.GetTransactionStatus.NOT_FOUND }
          : {
              status: rpc.Api.GetTransactionStatus.SUCCESS,
              ledger: 1002,
              events: { contractEventsXdr: [] },
            };
      },
      sendTransaction: async () => {
        sends += 1;
        throw new Error("waitForAdminOp must never rebroadcast");
      },
    } as unknown as never;

    const pendingWait = waitForAdminOp(outcome, {
      server,
      clock,
      timeoutMs: 1_000,
      pollIntervalMs: 100,
    });
    await settle();
    assert.equal(reads, 1);
    clock.advance(100);
    await settle();

    const result = await pendingWait;
    assert.equal(result.status, "confirmed");
    assert.equal(result.ledger, 1002);
    assert.equal(reads, 2);
    assert.equal(sends, 0);
  });

  it("returns pending when the confirmation budget expires", async () => {
    const outcome = await submittedFreeze();
    const clock = new FakeClock();
    let reads = 0;
    const server = {
      getTransaction: async () => {
        reads += 1;
        return { status: rpc.Api.GetTransactionStatus.NOT_FOUND };
      },
    } as unknown as never;

    const pendingWait = waitForAdminOp(outcome, {
      server,
      clock,
      timeoutMs: 1_000,
      pollIntervalMs: 100,
    });
    await settle();
    clock.advance(1_000);
    await settle();

    const result = await pendingWait;
    assert.equal(result.status, "pending");
    assert.match(result.detail, /not confirmed within 1000ms/);
    assert.equal(result.ledger, null);
    assert.ok(reads >= 1);
  });

  it("returns pending on abort without treating it as a failure", async () => {
    const outcome = await submittedFreeze();
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    const server = {
      getTransaction: async () => {
        reads += 1;
        return { status: rpc.Api.GetTransactionStatus.SUCCESS };
      },
    } as unknown as never;

    const result = await waitForAdminOp(outcome, { server, signal: controller.signal });
    assert.equal(result.status, "pending");
    assert.match(result.detail, /aborted/);
    assert.equal(reads, 0);
  });

  it("returns undetermined for an RPC error or an unrecognized status", async () => {
    const outcome = await submittedFreeze();
    const failing = {
      getTransaction: async () => {
        throw new Error("rpc offline");
      },
    } as unknown as never;
    const failedRead = await waitForAdminOp(outcome, { server: failing });
    assert.equal(failedRead.status, "undetermined");
    assert.match(failedRead.detail, /rpc offline/);

    const unknownStatus = {
      getTransaction: async () => ({ status: "FUTURE_STATUS" }),
    } as unknown as never;
    const unknown = await waitForAdminOp(outcome, { server: unknownStatus });
    assert.equal(unknown.status, "undetermined");
    assert.match(unknown.detail, /unrecognized status/);
  });

  it("fails fast for a non-admin or hashless outcome", async () => {
    const server = createMockServer(adminKp.publicKey()) as never;
    await assert.rejects(waitForAdminOp({} as AdminOpOutcome, { server }), (error: unknown) => {
      assert.ok(error instanceof InvalidInputError);
      assert.match(error.message, /admin_outcome/);
      return true;
    });

    const dryRun = await submitFreeze({
      server,
      guard: GUARD,
      admin: adminKp,
      dryRun: true,
      pollIntervalMs: 1,
    });
    assert.ok(isAdminOpOutcome(dryRun));
    await assert.rejects(waitForAdminOp(dryRun, { server }), (error: unknown) => {
      assert.ok(error instanceof InvalidInputError);
      assert.match(error.message, /transaction hash/);
      return true;
    });
  });
});

/** Additive audit metadata on every outcome arm (issue #464). */
describe("admin outcome metadata (issue #464)", () => {
  const adminKp = Keypair.random();

  it("reports the operation, target guard and canonical policy hash", async () => {
    const outcome = await submitSetPolicy({
      server: createMockServer(adminKp.publicKey()) as never,
      guard: GUARD,
      policy: TEST_POLICY,
      admin: adminKp,
      pollIntervalMs: 1,
    });

    assert.deepEqual(outcome.admin, {
      op: "set_policy",
      guard: GUARD,
      policyHash: policyHash(TEST_POLICY),
    });
    assert.match(outcome.admin.policyHash!, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(outcome.admin).includes(adminKp.secret()), false);
    assert.doesNotMatch(JSON.stringify(outcome.admin), /signature/i);
  });

  it("omits policyHash and newAgent for freeze and unfreeze", async () => {
    for (const submit of [submitFreeze, submitUnfreeze]) {
      const outcome: AdminInvokeOutcome = await submit({
        server: createMockServer(adminKp.publicKey()) as never,
        guard: GUARD,
        admin: adminKp,
        pollIntervalMs: 1,
      });
      assert.deepEqual(outcome.admin, {
        op: submit === submitFreeze ? "freeze" : "unfreeze",
        guard: GUARD,
      });
    }
  });

  it("reports only the public rotated agent key", async () => {
    const newAgent = Keypair.random();
    const outcome = await submitRotateAgentKey({
      server: createMockServer(adminKp.publicKey()) as never,
      guard: GUARD,
      newAgent,
      admin: adminKp,
      pollIntervalMs: 1,
    });

    assert.deepEqual(outcome.admin, {
      op: "rotate_agent_key",
      guard: GUARD,
      newAgent: newAgent.publicKey(),
    });
    assert.equal(outcome.admin.newAgent, newAgent.publicKey());
    assert.notEqual(outcome.admin.newAgent, newAgent.secret());
  });

  it("survives dry-run and error outcomes", async () => {
    const dryRun = await submitFreeze({
      server: createMockServer(adminKp.publicKey()) as never,
      guard: GUARD,
      admin: adminKp,
      dryRun: true,
      pollIntervalMs: 1,
    });
    assert.equal(dryRun.kind, "dry_run");
    assert.deepEqual(dryRun.admin, { op: "freeze", guard: GUARD });

    const controller = new AbortController();
    controller.abort();
    const failed = await submitSetPolicy({
      server: createMockServer(adminKp.publicKey()) as never,
      guard: GUARD,
      policy: TEST_POLICY,
      admin: adminKp,
      signal: controller.signal,
    });
    assert.equal(failed.kind, "error");
    assert.deepEqual(failed.admin, {
      op: "set_policy",
      guard: GUARD,
      policyHash: policyHash(TEST_POLICY),
    });
  });
});

/** Read-only policy preview (issue #465). */
describe("previewSetPolicy (issue #465)", () => {
  const adminKp = Keypair.random();

  function previewServer(
    current: PolicyConfig | null,
    validation: "valid" | "invalid" | "unavailable" = "valid",
  ) {
    const policyEntry =
      current === null ? null : { val: { contractData: { val: policyToScVal(current) } } };
    const windowEntry = { val: { contractData: { val: xdr.ScVal.scvMap([]) } } };
    let writes = 0;
    let simulations = 0;
    const server = {
      getLedgerEntries: async (..._keys: unknown[]) => {
        return {
          entries: [policyEntry, windowEntry].filter((e): e is NonNullable<typeof e> => e !== null),
        };
      },
      getContractData: async (_guard: unknown, key: xdr.ScVal) => {
        const name = scValToNative(key);
        if (name === "policy") return policyEntry;
        if (name === "window") return windowEntry;
        return null;
      },
      getAccount: async () => new Account(adminKp.publicKey(), "1"),
      simulateTransaction: async () => {
        simulations += 1;
        if (validation === "unavailable") return { error: "no validate_policy" };
        return {
          result: {
            retval:
              validation === "valid"
                ? xdr.ScVal.scvVec([xdr.ScVal.scvBool(true)])
                : xdr.ScVal.scvVec([
                    xdr.ScVal.scvBool(false),
                    xdr.ScVal.scvSymbol("AmountSign"),
                    xdr.ScVal.scvString("per_tx_cap must be non-negative"),
                  ]),
          },
          latestLedger: 10,
        };
      },
      sendTransaction: async () => {
        writes += 1;
        return { status: "PENDING", hash: "bad" };
      },
    } as unknown as never;
    return { server, writes: () => writes, simulations: () => simulations };
  }

  it("diffs a valid candidate and never signs or submits", async () => {
    const { server, writes, simulations } = previewServer(TEST_POLICY, "valid");
    const candidate = { ...TEST_POLICY, per_tx_cap: 2000n };
    const preview = await previewSetPolicy({
      server,
      guard: GUARD,
      policy: candidate,
      admin: adminKp,
    });

    assert.equal(preview.valid, true);
    assert.deepEqual(preview.failures, []);
    assert.equal(preview.policyHash, policyHash(candidate));
    assert.deepEqual(preview.current, TEST_POLICY);
    assert.ok(
      preview.diff.some(
        (change) =>
          change.field === "per_tx_cap" && change.before === 1000n && change.after === 2000n,
      ),
    );
    assert.equal(simulations(), 1);
    assert.equal(writes(), 0);
  });

  it("reports SDK, encoding and contract failures without throwing", async () => {
    const broken = { ...TEST_POLICY, per_tx_cap: -1n } as unknown as PolicyConfig;
    const { server } = previewServer(TEST_POLICY, "invalid");
    const preview = await previewSetPolicy({
      server,
      guard: GUARD,
      policy: broken,
      admin: adminKp,
    });

    assert.equal(preview.valid, false);
    assert.ok(preview.failures.some((failure) => failure.source === "sdk"));
    assert.ok(
      preview.failures.some(
        (failure) => failure.source === "contract" && failure.rule === "AmountSign",
      ),
    );
  });

  it("does not fail a preview when the on-chain validator is unavailable", async () => {
    const { server } = previewServer(TEST_POLICY, "unavailable");
    const preview = await previewSetPolicy({
      server,
      guard: GUARD,
      policy: TEST_POLICY,
      admin: adminKp,
    });

    assert.equal(preview.valid, true);
    assert.deepEqual(preview.diff, []);
  });
});
