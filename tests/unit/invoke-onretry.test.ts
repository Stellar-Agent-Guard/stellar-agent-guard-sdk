/**
 * Unit tests for `invoke()`'s `onRetry` hook (issue #415).
 *
 * Retry metadata is only attached to the terminal outcome, so a slow recovery
 * was indistinguishable from a hang. These tests pin the per-retry event: one
 * delivery per retry (never for the first attempt), the values matching the
 * outcome's own `retry.retries`, zero delay for fee bumps, and full isolation
 * of a throwing hook from the retry budget and outcome.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Address, Keypair, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { invoke, type InvokeParams, InvokeRetryError } from "../../src/invoke.ts";
import type { InvokeRetryEvent } from "../../src/retry.ts";
import { BroadcastError } from "../../src/tx.ts";
import { unsafeContractAddress } from "../../src/policy.ts";

const TOKEN = unsafeContractAddress(Address.contract(Buffer.alloc(32)).toString());
const PASSPHRASE = "Test SDF Network ; September 2015";
const FAST_POLL = { pollAttempts: 1, pollIntervalMs: 0 };

/** A successful simulation that needs no authorization. */
function successSimulation(minResourceFee = "500") {
  return {
    result: { auth: [] },
    transactionData: new SorobanDataBuilder(),
    minResourceFee,
    events: [],
  };
}

const staleRejection = () => ({
  status: "FAILED",
  hash: "stale",
  resultXdr: null,
  diagnosticEventsXdr: [
    "scecExceededLimit: operation byte-write resources exceeds amount specified",
  ],
});

const sequenceRejection = () => ({
  status: "FAILED",
  hash: "sequence",
  resultXdr: null,
  diagnosticEventsXdr: ["tx_bad_seq"],
});

function mockServer(options: {
  getTransaction: (hash: string) => unknown;
  send?: (hash: string, call: number) => unknown;
}) {
  let sends = 0;
  const server = {
    get sendCount() {
      return sends;
    },
    getAccount: async () => ({ sequenceNumber: () => "100" }),
    getLatestLedger: async () => ({ sequence: 1000 }),
    simulateTransaction: async () => successSimulation(),
    async sendTransaction() {
      sends += 1;
      if (options.send) return options.send(`tx-${sends}`, sends);
      return { status: "PENDING", hash: `tx-${sends}` };
    },
    async getTransaction(hash: string) {
      return options.getTransaction(hash);
    },
  } as unknown as rpc.Server & { sendCount: number };
  return server;
}

function params(server: rpc.Server, overrides: Partial<InvokeParams> = {}): InvokeParams {
  return {
    server,
    source: Keypair.random(),
    call: { contract: TOKEN, fn: "transfer", args: [] },
    networkPassphrase: PASSPHRASE,
    ...FAST_POLL,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 100,
      random: () => 0.5,
      sleep: async () => undefined,
    },
    ...overrides,
  };
}

function recorder() {
  const events: InvokeRetryEvent[] = [];
  return {
    events,
    callback(event: InvokeRetryEvent) {
      events.push(event);
    },
  };
}

const minFeeRejection = (hash: string) => ({
  status: "ERROR" as const,
  hash,
  errorResult: new xdr.TransactionResult({
    feeCharged: 0n,
    result: xdr.TransactionResultResult.txInsufficientFee(),
    ext: xdr.TransactionResultExt.v0(),
  }),
});

describe("invoke() onRetry hook", () => {
  it("fires once per retry, never for the first attempt, matching retry.retries", async () => {
    const server = mockServer({
      getTransaction: (hash) =>
        hash === "tx-1"
          ? staleRejection()
          : { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 9 },
    });
    const { events, callback } = recorder();

    const outcome = await invoke(params(server, { onRetry: callback }));

    assert.equal(outcome.kind, "allowed");
    assert.ok(outcome.retry);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      attempt: 1,
      failure: "stale_ledger_resource_limit",
      cause: "stale_ledger_resource_limit",
      delayMs: 50,
      nextAttempt: 2,
      stage: "broadcast",
    });
    // The hook and the terminal metadata describe the same retries, in order.
    assert.deepEqual(
      events.map(({ attempt, failure, cause, delayMs }) => ({ attempt, failure, cause, delayMs })),
      outcome.retry.retries,
    );
  });

  it("reports sequence-collision retries in order across attempts", async () => {
    const server = mockServer({
      getTransaction: (hash) =>
        hash === "tx-3"
          ? { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 10 }
          : sequenceRejection(),
      send: (hash) => ({ status: "PENDING", hash }),
    });
    const { events, callback } = recorder();

    const outcome = await invoke(params(server, { onRetry: callback }));

    assert.equal(outcome.kind, "allowed");
    assert.ok(outcome.retry);
    assert.deepEqual(
      events.map((event) => [event.attempt, event.nextAttempt, event.failure]),
      [
        [1, 2, "sequence_number_collision"],
        [2, 3, "sequence_number_collision"],
      ],
    );
    assert.deepEqual(
      events.map(({ attempt, failure, cause, delayMs }) => ({ attempt, failure, cause, delayMs })),
      outcome.retry.retries,
    );
  });

  it("reports delayMs: 0 for a fee-bump retry", async () => {
    let sends = 0;
    const server = {
      getAccount: async () => ({ sequenceNumber: () => "100" }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => successSimulation(),
      sendTransaction: async () => {
        sends += 1;
        return sends === 1 ? minFeeRejection("fee-1") : { status: "PENDING", hash: "fee-2" };
      },
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 11 }),
    } as unknown as rpc.Server;
    const { events, callback } = recorder();

    const outcome = await invoke(
      params(server, { onRetry: callback, feeBump: { maxAttempts: 2, feeMultiplier: 2 } }),
    );

    assert.equal(outcome.kind, "allowed");
    assert.ok(outcome.retry);
    assert.deepEqual(events, [
      {
        attempt: 1,
        failure: "min_fee",
        cause: "undetermined",
        delayMs: 0,
        nextAttempt: 2,
        stage: "broadcast",
      },
    ]);
    assert.deepEqual(
      events.map(({ attempt, failure, cause, delayMs }) => ({ attempt, failure, cause, delayMs })),
      outcome.retry.retries,
    );
  });

  it("does not fire the hook when the first attempt succeeds", async () => {
    const server = mockServer({
      getTransaction: () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 12 }),
    });
    const { events, callback } = recorder();

    const outcome = await invoke(params(server, { onRetry: callback }));

    assert.equal(outcome.kind, "allowed");
    assert.equal(events.length, 0);
  });

  it("isolates a throwing hook: same outcome, same retry budget", async () => {
    const makeServer = () =>
      mockServer({
        getTransaction: (hash) =>
          hash === "tx-1"
            ? staleRejection()
            : { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 13 },
      });

    const quiet = await invoke(params(makeServer()));
    const withThrower = await invoke(
      params(makeServer(), {
        onRetry: () => {
          throw new Error("consumer bug");
        },
      }),
    );

    assert.equal(quiet.kind, "allowed");
    assert.equal(withThrower.kind, "allowed");
    assert.deepEqual(withThrower.retry, quiet.retry);
  });

  it("isolates a throwing hook when the retry budget is exhausted", async () => {
    const server = mockServer({ getTransaction: staleRejection });

    const outcome = await invoke(
      params(server, {
        retry: {
          maxAttempts: 2,
          baseDelayMs: 100,
          random: () => 0.5,
          sleep: async () => undefined,
        },
        onRetry: () => {
          throw new Error("consumer bug");
        },
      }),
    );

    assert.ok(outcome instanceof InvokeRetryError);
    assert.equal(outcome.retry.attempts, 2);
    assert.equal(outcome.retry.retries.length, 1);
    assert.equal(outcome.retry.terminalFailure, "stale_ledger_resource_limit");
  });

  it("does not affect fee-bump exhaustion", async () => {
    const server = {
      getAccount: async () => ({ sequenceNumber: () => "100" }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => successSimulation(),
      sendTransaction: async () => minFeeRejection("fee-n"),
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 14 }),
    } as unknown as rpc.Server;

    const outcome = await invoke(
      params(server, {
        feeBump: { maxAttempts: 2, feeMultiplier: 2 },
        onRetry: () => {
          throw new Error("consumer bug");
        },
      }),
    );

    assert.ok(outcome instanceof BroadcastError);
    assert.ok(outcome.retry);
    assert.equal(outcome.retry.attempts, 2);
    assert.equal(outcome.retry.exhausted, true);
  });
});
