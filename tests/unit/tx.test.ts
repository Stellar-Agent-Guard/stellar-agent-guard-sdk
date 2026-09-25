/**
 * Unit tests for transaction-layer helpers.
 *
 * The classifier tested here decides whether a post-inclusion failure is worth
 * re-simulating. It was written after a real, reproducible failure: a transfer
 * that passed enforcement and was included, then rejected by core with
 * `scecExceededLimit` because the simulation had priced the gas against a
 * ledger snapshot one write behind. Classifying that as "not our problem" would
 * make the SDK intermittently fail; classifying a genuine guard block as
 * retryable would be worse, so both directions are pinned here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SorobanDataBuilder } from "@stellar/stellar-sdk";
import {
  BroadcastError,
  describeSimulationResources,
  isMinimumFeeBroadcastFailure,
  isStaleLedgerResourceFailure,
} from "../../src/tx.ts";

/** The real failure payload from the live testnet run, trimmed. */
const staleLedgerFailure = {
  resultXdr: "AAAAAAAAURj/////AAAAAQAAAAAAAAAY/////QAAAAA=",
  resultCode: "unknown",
  message: "transaction failed after inclusion",
  diagnosticEvents: [
    {
      body: {
        v0: {
          topics: [
            "error",
            { type: "system", code: 5, value: "scecExceededLimit" },
          ],
          data: ["operation byte-write resources exceeds amount specified", "724", "652"],
        },
      },
    },
  ],
};

const guardBlockFailure = {
  resultXdr: null,
  resultCode: "invokeHostFunctionResult=trap",
  message: "transaction failed after inclusion",
  diagnosticEvents: [
    {
      body: {
        v0: {
          topics: ["event_auth_checked", "blocked", "per_tx_cap_exceeded"],
          data: {},
        },
      },
    },
  ],
};

describe("isStaleLedgerResourceFailure", () => {
  it("recognises the real scecExceededLimit rejection", () => {
    assert.equal(isStaleLedgerResourceFailure(staleLedgerFailure), true);
  });

  it("recognises a stale declaration when only the message matches", () => {
    assert.equal(
      isStaleLedgerResourceFailure({
        resultXdr: null,
        resultCode: null,
        message: "operation byte-write resources exceeds amount specified",
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("recognises an insufficient refundable resource fee", () => {
    assert.equal(
      isStaleLedgerResourceFailure({
        resultXdr: null,
        resultCode: null,
        message: "insufficient refundable fee",
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("does NOT treat a guard block as retryable", () => {
    assert.equal(isStaleLedgerResourceFailure(guardBlockFailure), false);
  });

  it("does not retry an ordinary failure", () => {
    assert.equal(
      isStaleLedgerResourceFailure({
        resultXdr: null,
        resultCode: "tx_bad_seq",
        message: "transaction failed after inclusion",
        diagnosticEvents: [],
      }),
      false,
    );
  });
});

describe("describeSimulationResources", () => {
  it("reports the declared resources and footprint size", () => {
    const data = new SorobanDataBuilder().setResources(1000, 200, 300);
    const text = describeSimulationResources({ transactionData: data, minResourceFee: "42" }, null);
    assert.match(text, /instructions: 1000/);
    assert.match(text, /disk_read_bytes: 200/);
    assert.match(text, /write_bytes: 300/);
    assert.match(text, /minResourceFee: 42/);
  });

  it("names each guard storage key and whether it is declared read-write", () => {
    const guard = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
    const data = new SorobanDataBuilder().setResources(1, 2, 3);
    const text = describeSimulationResources({ transactionData: data, minResourceFee: "0" }, guard);
    assert.match(text, /guard key Policy: NOT in the footprint/);
    assert.match(text, /guard key Window: NOT in the footprint/);
  });

  it("explains a simulation error instead of printing empty numbers", () => {
    const text = describeSimulationResources({ error: "HostError: boom" }, null);
    assert.match(text, /simulation error/);
    assert.match(text, /boom/);
  });
});

describe("isMinimumFeeBroadcastFailure", () => {
  it("recognises structured result=txInsufficientFee", () => {
    assert.equal(
      isMinimumFeeBroadcastFailure({
        resultXdr: null,
        resultCode: "result=txInsufficientFee",
        message: '{"status":"ERROR"}',
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("recognises tx_insufficient_fee in the failure message", () => {
    assert.equal(
      isMinimumFeeBroadcastFailure({
        resultXdr: null,
        resultCode: null,
        message: '{"result":"tx_insufficient_fee"}',
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("recognises tx too cheap in the failure message", () => {
    assert.equal(
      isMinimumFeeBroadcastFailure({
        resultXdr: null,
        resultCode: null,
        message: "transaction rejected: tx too cheap for current ledger",
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("recognises min-fee in the failure message", () => {
    assert.equal(
      isMinimumFeeBroadcastFailure({
        resultXdr: null,
        resultCode: null,
        message: "fee 100 below min-fee 250",
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("does not treat stale-ledger resource failure as a minimum-fee failure", () => {
    assert.equal(isMinimumFeeBroadcastFailure(staleLedgerFailure), false);
  });

  it("does not treat a guard block as a minimum-fee failure", () => {
    assert.equal(isMinimumFeeBroadcastFailure(guardBlockFailure), false);
  });

  it("does not treat an unrelated failure (e.g. bad seq) as a minimum-fee failure", () => {
    assert.equal(
      isMinimumFeeBroadcastFailure({
        resultXdr: null,
        resultCode: "tx_bad_seq",
        message: "sequence mismatch",
        diagnosticEvents: [],
      }),
      false,
    );
  });
});

describe("BroadcastError", () => {
  it("formats message with attempt count and last fee", () => {
    const error = new BroadcastError({
      attempts: 3,
      lastFee: 400n,
      failure: {
        resultXdr: null,
        resultCode: "result=txInsufficientFee",
        message: "tx too cheap",
        diagnosticEvents: [],
      },
    });

    assert.equal(error.name, "BroadcastError");
    assert.equal(error.kind, "error");
    assert.equal(error.attempts, 3);
    assert.equal(error.lastFee, 400n);
    assert.equal(error.error, error);
    assert.match(error.message, /3 attempt\(s\)/);
    assert.match(error.message, /400 stroops/);
    assert.ok(error instanceof Error);
  });
});
