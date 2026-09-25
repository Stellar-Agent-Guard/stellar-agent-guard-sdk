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
import { describeSimulationResources, isSequenceNumberFailure, isStaleLedgerResourceFailure } from "../../src/tx.ts";

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

describe("isSequenceNumberFailure", () => {
  it("recognises tx_bad_seq from the RPC error result", () => {
    assert.equal(
      isSequenceNumberFailure({
        resultXdr: null,
        resultCode: null,
        message: JSON.stringify({ code: "tx_bad_seq" }),
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("recognises a prose sequence mismatch", () => {
    assert.equal(
      isSequenceNumberFailure({
        resultXdr: null,
        resultCode: null,
        message: "transaction sequence number is too low",
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("does not classify an unrelated submission failure as a sequence error", () => {
    assert.equal(
      isSequenceNumberFailure({
        resultXdr: null,
        resultCode: "tx_insufficient_fee",
        message: "insufficient fee",
        diagnosticEvents: [],
      }),
      false,
    );
  });
});

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
