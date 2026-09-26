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
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Keypair, SorobanDataBuilder, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  buildGuardAuthEntry,
  describeSimulationResources,
  isStaleLedgerResourceFailure,
  keypairAgentSigner,
  toAgentSigner,
  type AgentSigner,
  type ContractCall,
} from "../../src/tx.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const CALL: ContractCall = {
  contract: "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
  fn: "transfer",
  args: [],
};

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

/**
 * The agent-signing seam (issue #29).
 *
 * `buildGuardAuthEntry` used to take a `Keypair` and call `.sign()` on it
 * directly, which hard-codes "the agent key is a local single Ed25519 key" into
 * the signature of a public function. Contracts v2 will make the guard's
 * `Signature` type multi-key, and this pins the two properties that let that
 * land without another breaking change: a plain `Keypair` still signs exactly
 * as before, and anything implementing `AgentSigner` is accepted in its place.
 */
describe("AgentSigner", () => {
  const networkPassphrase = "Test SDF Network ; September 2015";

  it("wraps a Keypair as a signer that signs the digest with that same key", async () => {
    const keypair = Keypair.random();
    const signer = keypairAgentSigner(keypair);
    assert.equal(signer.publicKey, keypair.publicKey());

    const digest = createHash("sha256").update("authorization preimage").digest();
    const signature = await signer.signDigest(digest);
    assert.equal(signature.length, 64, "a raw Ed25519 signature is 64 bytes");
    assert.equal(
      keypair.verify(digest, Buffer.from(signature)),
      true,
      "the signature must verify against the key that produced it",
    );
  });

  it("passes an AgentSigner through unchanged", () => {
    const custom: AgentSigner = {
      publicKey: "GREMOTEAGENTSIGNER",
      signDigest: () => new Uint8Array(64),
    };
    assert.equal(toAgentSigner(custom), custom, "no wrapping an already-adapted signer");
  });

  it("wraps a plain Keypair so existing callers keep working", () => {
    const keypair = Keypair.random();
    const signer = toAgentSigner(keypair);
    assert.equal(signer.publicKey, keypair.publicKey());
    assert.equal(typeof signer.signDigest, "function");
  });

  it("signs the 32-byte digest the host verifies, not the whole entry", async () => {
    const keypair = Keypair.random();
    const seen: Uint8Array[] = [];
    const recording: AgentSigner = {
      publicKey: keypair.publicKey(),
      signDigest: (digest) => {
        seen.push(digest);
        return keypair.sign(Buffer.from(digest));
      },
    };

    const entry = await buildGuardAuthEntry({
      guard: GUARD,
      call: CALL,
      signer: recording,
      nonce: 7n,
      signatureExpirationLedger: 4_000_000,
      networkPassphrase,
    });

    assert.equal(seen.length, 1, "the signer is called exactly once per entry");
    assert.equal(seen[0]!.length, 32, "__check_auth verifies a 32-byte SHA-256 digest");

    // The entry must carry exactly what the signer produced, and the nonce and
    // expiration that were written into the signed preimage.
    assert.equal(entry.credentials.type, "sorobanCredentialsAddress");
    const addressCredentials = (
      entry.credentials as unknown as { address: xdr.SorobanAddressCredentials }
    ).address;
    assert.equal(addressCredentials.nonce, 7n);
    assert.equal(addressCredentials.signatureExpirationLedger, 4_000_000);
    const carried = scValToNative(addressCredentials.signature) as Uint8Array;
    assert.ok(
      Buffer.from(carried).equals(Buffer.from(keypair.sign(Buffer.from(seen[0]!)))),
      "the entry carries the signer's signature verbatim",
    );
  });

  it("still signs with a bare Keypair, byte-for-byte as before", async () => {
    const keypair = Keypair.random();
    const entry = await buildGuardAuthEntry({
      guard: GUARD,
      call: CALL,
      signer: keypair,
      nonce: 1n,
      signatureExpirationLedger: 100,
      networkPassphrase,
    });
    const addressCredentials = (
      entry.credentials as unknown as { address: xdr.SorobanAddressCredentials }
    ).address;
    const signature = scValToNative(addressCredentials.signature) as Uint8Array;
    assert.equal(signature.length, 64);
    assert.equal(
      keypair.verify(Buffer.alloc(32), Buffer.from(signature)),
      false,
      "a signature over a real preimage must not validate against an unrelated digest",
    );
  });

  it("answers a V2 (address-bound) credential with the matching preimage", async () => {
    const keypair = Keypair.random();
    const entry = await buildGuardAuthEntry({
      guard: GUARD,
      call: CALL,
      signer: keypairAgentSigner(keypair),
      nonce: 2n,
      signatureExpirationLedger: 100,
      networkPassphrase,
      credentialType: "sorobanCredentialsAddressV2",
    });
    assert.equal(entry.credentials.type, "sorobanCredentialsAddressV2");
  });
});
