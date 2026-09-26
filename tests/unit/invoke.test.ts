/** Deterministic coverage for the per-account invoke queue. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Account, Keypair, rpc, SorobanDataBuilder } from "@stellar/stellar-sdk";
import { invoke } from "../../src/invoke.ts";

const CONTRACT = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const NETWORK = "Test SDF Network ; September 2015";

describe("invoke sequence reservation", () => {
  it("retries a sequence collision once after refreshing the account sequence", async () => {
    const source = Keypair.random();
    const sentSequences: string[] = [];
    let sends = 0;
    const simulation = {
      transactionData: new SorobanDataBuilder().setResources(1, 0, 0).build(),
      minResourceFee: "1",
      result: { auth: [] },
    };
    const server = {
      getAccount: async () => new Account(source.publicKey(), "7"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => simulation,
      sendTransaction: async (transaction: { sequence: string }) => {
        sentSequences.push(transaction.sequence);
        sends += 1;
        return sends === 1
          ? { status: "ERROR", hash: "bad-seq", errorResult: { code: "tx_bad_seq" } }
          : { status: "PENDING", hash: "good-seq" };
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 101,
        events: { contractEventsXdr: [] },
      }),
    } as unknown as rpc.Server;

    const outcome = await invoke({
      server,
      source,
      call: { contract: CONTRACT, fn: "transfer", args: [] },
      networkPassphrase: NETWORK,
    });

    assert.equal(outcome.kind, "allowed");
    assert.deepEqual(sentSequences, ["8", "9"]);
  });

  it("serializes concurrent calls and gives each transaction a distinct sequence", async () => {
    const source = Keypair.random();
    const sequences: string[] = [];
    let simulationsStarted = 0;
    let releaseFirst!: () => void;
    const firstSimulation = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const simulation = {
      transactionData: new SorobanDataBuilder().setResources(1, 0, 0).build(),
      minResourceFee: "1",
      result: { auth: [] },
    };
    const server = {
      getAccount: async () => new Account(source.publicKey(), "7"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async (transaction: { sequence: string }) => {
        sequences.push(transaction.sequence);
        simulationsStarted += 1;
        if (simulationsStarted === 1) await firstSimulation;
        return simulation;
      },
    } as unknown as rpc.Server;

    const first = invoke({
      server,
      source,
      call: { contract: CONTRACT, fn: "transfer", args: [] },
      networkPassphrase: NETWORK,
      dryRun: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = invoke({
      server,
      source,
      call: { contract: CONTRACT, fn: "transfer", args: [] },
      networkPassphrase: NETWORK,
      dryRun: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The second invoke must still be waiting behind the first one's queue.
    assert.equal(simulationsStarted, 1);
    releaseFirst();
    const outcomes = await Promise.all([first, second]);

    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["error", "error"]);
    // TransactionBuilder consumes the base account sequence and emits base + 1.
    assert.deepEqual(sequences, ["8", "8", "9", "9"]);
  });
});
