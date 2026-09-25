/**
 * Unit tests for the autonomous invoke() pipeline and fee-bump retry.
 *
 * Exercises the end-to-end flow with a mock RPC server to verify:
 *  - Test 1: fee bump succeeds after initial min-fee rejection
 *  - Test 2: fee bump remains too cheap and exhausts budget returning BroadcastError
 *  - Test 3: policy block during re-simulation prevents subsequent broadcast
 *  - Regression tests for non-fee errors, policy blocks, and stale ledger retries
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Address,
  Keypair,
  SorobanDataBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { BroadcastError } from "../../src/tx.ts";
import { invoke } from "../../src/invoke.ts";

const CONTRACT_ID = Address.contract(Buffer.alloc(32)).toString();
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const FAST_POLL = { pollAttempts: 5, pollIntervalMs: 0 };

function createBlockedSimulationResponse(reason: string) {
  return {
    error: `HostError: Error(Contract, #${reason})`,
    events: [
      {
        event: {
          contractId: CONTRACT_ID,
          type: "contract",
          body: {
            v0: {
              topics: [
                xdr.ScVal.scvSymbol("event_auth_checked"),
                xdr.ScVal.scvSymbol("blocked"),
                xdr.ScVal.scvSymbol(reason),
              ],
              data: xdr.ScVal.scvVoid(),
            },
          },
        },
      },
    ],
  };
}

function createSuccessSimulationResponse(minResourceFee = "500") {
  return {
    result: { auth: [] },
    transactionData: new SorobanDataBuilder(),
    minResourceFee,
    events: [],
  };
}

function createMinFeeErrorResponse(hash: string) {
  return {
    status: "ERROR" as const,
    hash,
    errorResult: new xdr.TransactionResult({
      feeCharged: 0n,
      result: xdr.TransactionResultResult.txInsufficientFee(),
      ext: xdr.TransactionResultExt.v0(),
    }),
  };
}

describe("invoke() fee-bump retry lifecycle", () => {
  it("Test 1 — fee bump succeeds: re-prepares, re-simulates, and succeeds on second broadcast", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const getAccountCalls: string[] = [];
    const simulateCalls: xdr.Transaction[] = [];
    const sendCalls: xdr.Transaction[] = [];

    const mockServer = {
      getAccount: async (pubKey: string) => {
        getAccountCalls.push(pubKey);
        return { sequenceNumber: () => (seq++).toString() };
      },
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async (tx: xdr.Transaction) => {
        simulateCalls.push(tx);
        return createSuccessSimulationResponse("500");
      },
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        if (sendCalls.length === 1) {
          return createMinFeeErrorResponse("hash-attempt-1");
        }
        return {
          status: "PENDING" as const,
          hash: "hash-attempt-2",
        };
      },
      getTransaction: async (hash: string) => ({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 1001,
        hash,
        events: { contractEventsXdr: [] },
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: NETWORK_PASSPHRASE,
      pollOptions: FAST_POLL,
    });

    // Normal success result is returned
    assert.equal(outcome.kind, "allowed");
    assert.equal(outcome.submission.status, rpc.Api.GetTransactionStatus.SUCCESS);
    assert.equal(outcome.submission.hash, "hash-attempt-2");

    // Exactly two attempts: no unnecessary 3rd attempt
    assert.equal(sendCalls.length, 2);
    // Transaction was re-prepared (fresh account sequence read)
    assert.equal(getAccountCalls.length, 2);
    // Discovery + enforced simulation ran for each attempt (4 simulations total)
    assert.equal(simulateCalls.length, 4);

    // Fee was bumped:
    // Attempt 1 fee: 100 inclusion + 500 resource = 600
    // Attempt 2 fee: 200 inclusion + 500 resource = 700
    const fee1 = sendCalls[0]?.fee;
    const fee2 = sendCalls[1]?.fee;
    assert.ok(fee1 !== undefined && fee2 !== undefined);
    assert.ok(Number(fee2) > Number(fee1), `expected bumped fee (${fee2}) to exceed initial fee (${fee1})`);
    assert.equal(String(fee1), "600");
    assert.equal(String(fee2), "700");
  });

  it("Test 2 — fee bump remains too cheap: exhausts retry budget and returns typed BroadcastError", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];
    const getAccountCalls: string[] = [];

    const mockServer = {
      getAccount: async (pubKey: string) => {
        getAccountCalls.push(pubKey);
        return { sequenceNumber: () => (seq++).toString() };
      },
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => createSuccessSimulationResponse("500"),
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        return createMinFeeErrorResponse(`hash-attempt-${sendCalls.length}`);
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 1001,
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: NETWORK_PASSPHRASE,
      feeBump: { maxAttempts: 3, feeMultiplier: 2 },
      pollOptions: FAST_POLL,
    });

    // Budget exhausted: returns typed BroadcastError
    assert.ok(outcome instanceof BroadcastError);
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.attempts, 3);
    // Attempt 1: inclusion 100 + 500 = 600
    // Attempt 2: inclusion 200 + 500 = 700
    // Attempt 3: inclusion 400 + 500 = 900
    assert.equal(outcome.lastFee, 900n);
    assert.equal(sendCalls.length, 3);
    assert.equal(getAccountCalls.length, 3);
    assert.match(outcome.message, /minimum fee not met after 3 attempt\(s\)/);
  });

  it("Test 3 — policy changes after fee bump: re-simulation block prevents broadcast", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];
    let simCallCount = 0;

    const mockServer = {
      getAccount: async () => ({ sequenceNumber: () => (seq++).toString() }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => {
        simCallCount++;
        // Attempt 1: sim 1 (probe) and sim 2 (enforce) both pass
        // Attempt 2: sim 3 (probe) passes, but sim 4 (enforced re-simulation) blocks!
        if (simCallCount < 4) {
          return createSuccessSimulationResponse("500");
        }
        return createBlockedSimulationResponse("per_tx_cap_exceeded");
      },
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        // Attempt 1 broadcast fails with min-fee
        return createMinFeeErrorResponse("hash-attempt-1");
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 1001,
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: NETWORK_PASSPHRASE,
      pollOptions: FAST_POLL,
    });

    // Guard policy block MUST be surfaced
    assert.equal(outcome.kind, "blocked");
    if (outcome.kind === "blocked") {
      assert.equal(outcome.reason, "per_tx_cap_exceeded");
    }

    // CRITICAL: Broadcast MUST NOT occur after the policy block
    // Only 1 broadcast occurred (from attempt 1 before fee bump)
    assert.equal(sendCalls.length, 1);
    // Re-simulation did run (4 simulations total: 2 in attempt 1, 2 in attempt 2)
    assert.equal(simCallCount, 4);
  });

  it("Regression: successful transaction without fee errors broadcasts once and returns allowed", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];

    const mockServer = {
      getAccount: async () => ({ sequenceNumber: () => (seq++).toString() }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => createSuccessSimulationResponse("500"),
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        return { status: "PENDING" as const, hash: "tx-ok" };
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 1002,
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: NETWORK_PASSPHRASE,
      pollOptions: FAST_POLL,
    });

    assert.equal(outcome.kind, "allowed");
    assert.equal(sendCalls.length, 1);
  });

  it("Regression: non-fee broadcast error does not trigger fee bumping", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];

    const mockServer = {
      getAccount: async () => ({ sequenceNumber: () => (seq++).toString() }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => createSuccessSimulationResponse("500"),
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        return {
          status: "ERROR" as const,
          hash: "bad-auth-hash",
          errorResult: new xdr.TransactionResult({
            feeCharged: 0n,
            result: xdr.TransactionResultResult.txBadAuth(),
            ext: xdr.TransactionResultExt.v0(),
          }),
        };
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 1001,
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: NETWORK_PASSPHRASE,
      pollOptions: FAST_POLL,
    });

    assert.equal(outcome.kind, "error");
    assert.ok(!(outcome instanceof BroadcastError));
    // No retry for non-fee error
    assert.equal(sendCalls.length, 1);
  });

  it("Regression: initial policy block never attempts broadcast", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];
    let simCallCount = 0;

    const mockServer = {
      getAccount: async () => ({ sequenceNumber: () => (seq++).toString() }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => {
        simCallCount++;
        if (simCallCount === 1) {
          // Probe succeeds in recording mode
          return createSuccessSimulationResponse("500");
        }
        // Enforced simulation blocks
        return createBlockedSimulationResponse("admin_frozen");
      },
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        return { status: "PENDING" as const, hash: "unreachable" };
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 1001,
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: NETWORK_PASSPHRASE,
      pollOptions: FAST_POLL,
    });

    assert.equal(outcome.kind, "blocked");
    assert.equal(sendCalls.length, 0);
  });

  it("Regression: stale-ledger resource failure coordinates within the same retry envelope", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];

    const mockServer = {
      getAccount: async () => ({ sequenceNumber: () => (seq++).toString() }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => createSuccessSimulationResponse("500"),
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        return { status: "PENDING" as const, hash: `stale-tx-${sendCalls.length}` };
      },
      getTransaction: async (hash: string) => {
        if (hash === "stale-tx-1") {
          return {
            status: rpc.Api.GetTransactionStatus.FAILED,
            ledger: 1001,
            resultXdr: null,
            diagnosticEventsXdr: [
              {
                body: {
                  v0: {
                    topics: ["error", { type: "system", code: 5, value: "scecExceededLimit" }],
                    data: ["operation byte-write resources exceeds amount specified"],
                  },
                },
              },
            ],
          };
        }
        return {
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 1002,
        };
      },
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: NETWORK_PASSPHRASE,
      pollOptions: FAST_POLL,
    });

    assert.equal(outcome.kind, "allowed");
    assert.equal(sendCalls.length, 2);
  });
});
