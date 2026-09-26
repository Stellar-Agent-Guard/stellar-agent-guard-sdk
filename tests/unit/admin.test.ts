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
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  agentPubkeyToScVal,
  buildFreezeCall,
  buildRotateAgentKeyCall,
  buildSetPolicyCall,
  buildUnfreezeCall,
  submitFreeze,
  submitRotateAgentKey,
  submitSetPolicy,
  submitUnfreeze,
} from "../../src/admin.ts";
import { policyToScVal, type PolicyConfig } from "../../src/policy.ts";
import type { AdminSigner } from "../../src/tx.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const RECIPIENT = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

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

  it("rejects invalid public key shapes", () => {
    assert.throws(() => agentPubkeyToScVal("invalid_key"), /invalid agent public key format/);
    assert.throws(() => agentPubkeyToScVal(new Uint8Array(16)), /byte length must be 32/);
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
