/**
 * Unit tests for the retry boundary in the autonomous invoke() pipeline.
 *
 * The RPC is mocked, but the tests still drive the real transaction-building and
 * signing path. That matters here: a retry is only safe if it builds a fresh
 * transaction and reruns both simulations, not if it blindly submits the first
 * resource declaration again.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Address, Keypair, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { InvokeRetryError, invoke } from "../../src/invoke.ts";

const CONTRACT_ID = Address.contract(Buffer.alloc(32)).toString();
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const FAST_POLL = { pollAttempts: 1, pollIntervalMs: 0 };

const staleDiagnosticEvent = {
  body: {
    v0: {
      topics: ["error", { type: "system", code: 5, value: "scecExceededLimit" }],
      data: ["operation byte-write resources exceeds amount specified", "724", "652"],
    },
  },
};

function successSimulation() {
  return {
    result: { auth: [] },
    transactionData: new SorobanDataBuilder().setResources(1_000, 100, 200),
    minResourceFee: "500",
    events: [],
  };
}

function invalidInputSimulation() {
  return { error: "HostError: invalid_input", events: [] };
}

function staleTransaction() {
  return {
    status: rpc.Api.GetTransactionStatus.FAILED,
    ledger: 1001,
    resultXdr: null,
    diagnosticEventsXdr: [staleDiagnosticEvent],
  };
}

function successfulTransaction() {
  return {
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    ledger: 1002,
    events: { contractEventsXdr: [] },
  };
}

function makeServer(options: {
  simulate: (call: number) => unknown;
  send: (call: number, transaction: xdr.Transaction) => unknown;
  getTransaction: (hash: string) => unknown;
}) {
  let sequence = 100n;
  let simulateCalls = 0;
  let getAccountCalls = 0;
  let sendCalls = 0;
  const sentTransactions: xdr.Transaction[] = [];

  const server = {
    getAccount: async (_publicKey: string) => {
      getAccountCalls += 1;
      return { sequenceNumber: () => (sequence++).toString() };
    },
    getLatestLedger: async () => ({ sequence: 1000 }),
    simulateTransaction: async (_transaction: xdr.Transaction) => {
      simulateCalls += 1;
      return options.simulate(simulateCalls);
    },
    sendTransaction: async (transaction: xdr.Transaction) => {
      sendCalls += 1;
      sentTransactions.push(transaction);
      return options.send(sendCalls, transaction);
    },
    getTransaction: async (hash: string) => options.getTransaction(hash),
  };

  return {
    server: server as unknown as rpc.Server,
    get simulateCalls() {
      return simulateCalls;
    },
    get getAccountCalls() {
      return getAccountCalls;
    },
    get sendCalls() {
      return sendCalls;
    },
    sentTransactions,
  };
}

function baseParams(server: rpc.Server) {
  return {
    server,
    source: Keypair.random(),
    call: { contract: CONTRACT_ID, fn: "transfer", args: [] },
    networkPassphrase: NETWORK_PASSPHRASE,
    pollOptions: FAST_POLL,
  };
}

describe("invoke() stale-ledger retry", () => {
  it("uses full jitter and reruns the complete simulation pipeline on each retry", async () => {
    const delays: number[] = [];
    const randomValues = [0.25, 0.75];
    let randomCall = 0;
    const rpcMock = makeServer({
      simulate: () => successSimulation(),
      send: (call) => ({ status: "PENDING" as const, hash: `tx-${call}` }),
      getTransaction: (hash) => (hash === "tx-3" ? successfulTransaction() : staleTransaction()),
    });

    const outcome = await invoke({
      ...baseParams(rpcMock.server),
      retry: {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 250,
        random: () => randomValues[randomCall++] ?? 0,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    });

    assert.equal(outcome.kind, "allowed");
    assert.equal(rpcMock.sendCalls, 3);
    assert.equal(rpcMock.getAccountCalls, 3);
    // Probe + enforced simulation for each of the three attempts.
    assert.equal(rpcMock.simulateCalls, 6);
    assert.deepEqual(delays, [25, 150]);
  });

  it("does not sleep after a single configured attempt", async () => {
    let sleeps = 0;
    const rpcMock = makeServer({
      simulate: () => successSimulation(),
      send: () => ({ status: "PENDING" as const, hash: "single-attempt" }),
      getTransaction: () => staleTransaction(),
    });

    const outcome = await invoke({
      ...baseParams(rpcMock.server),
      retry: {
        maxAttempts: 1,
        sleep: async () => {
          sleeps += 1;
        },
      },
    });

    assert.ok(outcome instanceof InvokeRetryError);
    assert.equal(outcome.attempts, 1);
    assert.equal(sleeps, 0);
    assert.equal(rpcMock.sendCalls, 1);
    assert.equal(rpcMock.simulateCalls, 2);
  });

  it("returns a typed error with the final attempt count and cause when exhausted", async () => {
    const delays: number[] = [];
    const rpcMock = makeServer({
      simulate: () => successSimulation(),
      send: (call) => ({ status: "PENDING" as const, hash: `stale-${call}` }),
      getTransaction: () => staleTransaction(),
    });

    const outcome = await invoke({
      ...baseParams(rpcMock.server),
      retry: {
        maxAttempts: 3,
        baseDelayMs: 100,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        random: () => 0.5,
      },
    });

    assert.ok(outcome instanceof InvokeRetryError);
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.attempts, 3);
    assert.equal(outcome.lastCause, "stale_ledger_resource_limit");
    assert.equal(outcome.cause, "stale_ledger_resource_limit");
    assert.match(outcome.message, /retry budget exhausted after 3 attempt/);
    assert.deepEqual(delays, [50, 100]);
    assert.equal(rpcMock.sendCalls, 3);
    assert.equal(rpcMock.simulateCalls, 6);
  });

  it("fails fast for invalid input without sleeping or broadcasting", async () => {
    let sleeps = 0;
    const rpcMock = makeServer({
      simulate: () => invalidInputSimulation(),
      send: () => ({ status: "PENDING" as const, hash: "must-not-send" }),
      getTransaction: () => successfulTransaction(),
    });

    const outcome = await invoke({
      ...baseParams(rpcMock.server),
      retry: {
        maxAttempts: 3,
        sleep: async () => {
          sleeps += 1;
        },
      },
    });

    assert.equal(outcome.kind, "error");
    assert.equal(outcome.cause, "undetermined");
    assert.equal(rpcMock.sendCalls, 0);
    assert.equal(rpcMock.simulateCalls, 1);
    assert.equal(sleeps, 0);
  });

  it("does not sleep again when a retry discovers a non-retryable failure", async () => {
    const delays: number[] = [];
    const rpcMock = makeServer({
      simulate: (call) => (call >= 3 ? invalidInputSimulation() : successSimulation()),
      send: (call) => ({ status: "PENDING" as const, hash: `tx-${call}` }),
      getTransaction: (hash) => (hash === "tx-1" ? staleTransaction() : successfulTransaction()),
    });

    const outcome = await invoke({
      ...baseParams(rpcMock.server),
      retry: {
        maxAttempts: 3,
        baseDelayMs: 10,
        random: () => 0.5,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    });

    assert.equal(outcome.kind, "error");
    assert.equal(outcome.cause, "undetermined");
    assert.deepEqual(delays, [5]);
    assert.equal(rpcMock.sendCalls, 1);
    assert.equal(rpcMock.simulateCalls, 3);
  });
});
