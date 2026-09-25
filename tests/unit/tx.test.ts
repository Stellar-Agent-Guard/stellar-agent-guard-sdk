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
import { Keypair, SorobanDataBuilder } from "@stellar/stellar-sdk";
import { ContractResponseError } from "../../src/errors.ts";
import {
  describeSimulationResources,
  isStaleLedgerResourceFailure,
  parseSimulationResourceFee,
  verifyAgentSignature,
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

describe("parseSimulationResourceFee", () => {
  it("accepts exact non-negative u64 values across SDK representations", () => {
    assert.equal(parseSimulationResourceFee("0"), 0n);
    assert.equal(parseSimulationResourceFee("42"), 42n);
    assert.equal(parseSimulationResourceFee(42), 42n);
    assert.equal(parseSimulationResourceFee(42n), 42n);
    assert.equal(parseSimulationResourceFee((2n ** 64n - 1n).toString()), 2n ** 64n - 1n);
  });

  it("rejects missing, malformed, negative, unsafe, and out-of-range fees", () => {
    for (const value of [undefined, null, "", "not-a-fee", "1.5", Number.MAX_SAFE_INTEGER + 1, -1, -1n, "-1", 2n ** 64n]) {
      assert.throws(
        () => parseSimulationResourceFee(value),
        (error: unknown) => {
          assert.ok(error instanceof ContractResponseError);
          assert.equal(error.field, "minResourceFee");
          return true;
        },
      );
    }
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

describe("verifyAgentSignature", () => {
  const payload = Buffer.alloc(32, 7);
  const agent = Keypair.random();
  const signature = agent.sign(payload);

  it("accepts the exact payload/signature pair for strkey and raw public keys", () => {
    assert.equal(verifyAgentSignature(agent.publicKey(), payload, signature), true);
    assert.equal(verifyAgentSignature(agent.rawPublicKey(), payload, signature), true);
  });

  it("rejects a signature made by a different registered key", () => {
    assert.equal(verifyAgentSignature(Keypair.random().publicKey(), payload, signature), false);
  });

  it("rejects a one-bit payload mutation without rehashing the payload", () => {
    const mutated = Buffer.from(payload);
    mutated[0] = mutated[0]! ^ 1;
    assert.equal(verifyAgentSignature(agent.publicKey(), mutated, signature), false);
  });

  it("rejects payloads that are not the 32-byte host auth digest", () => {
    for (const size of [0, 1, 31, 33, 64]) {
      const signature = agent.sign(Buffer.alloc(size, 9));
      assert.equal(
        verifyAgentSignature(agent.publicKey(), Buffer.alloc(size, 9), signature),
        false,
      );
    }
  });

  it("returns false for empty, truncated, and oversized signatures", () => {
    assert.equal(verifyAgentSignature(agent.publicKey(), payload, new Uint8Array()), false);
    assert.equal(verifyAgentSignature(agent.publicKey(), payload, signature.subarray(0, 63)), false);
    const oversized = Buffer.alloc(65);
    oversized.set(signature);
    assert.equal(verifyAgentSignature(agent.publicKey(), payload, oversized), false);
  });

  it("returns false for malformed or wrong-length raw public keys", () => {
    assert.equal(verifyAgentSignature("not-a-stellar-key", payload, signature), false);
    assert.equal(verifyAgentSignature(new Uint8Array(31), payload, signature), false);
  });

  it("does not accept a SEP-53 message signature for a raw host digest", () => {
    const messageSignature = agent.signMessage("diagnostic only");
    assert.equal(verifyAgentSignature(agent.publicKey(), payload, messageSignature), false);
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
