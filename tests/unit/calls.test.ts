/**
 * SAC transfer builders: argument positions are asserted element-by-element
 * against SPEC §6.2.
 *
 * `transfer` is `[from, to, amount]`; `transfer_from` is
 * `[from, spender, to, amount]`. The two layouts differ in the middle, which is
 * exactly the confusion these builders exist to remove, so every position is
 * pinned individually instead of comparing whole arrays (a swapped pair would
 * still compare "different" without saying which position moved).
 *
 * If SPEC §6.2 changes, update `src/calls.ts` and this test together.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, scValToNative, type xdr } from "@stellar/stellar-sdk";
import {
  SAC_TRANSFER_FROM_METHOD,
  SAC_TRANSFER_METHOD,
  sacTransfer,
  sacTransferFrom,
  type SacAmount,
} from "../../src/calls.ts";
import type { ContractCall } from "../../src/tx.ts";

const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const FROM = Keypair.random().publicKey();
const SPENDER = Keypair.random().publicKey();
const TO = Keypair.random().publicKey();

/**
 * Read arg `index` as a definite `ScVal` so the position assertions below are
 * type-safe under `noUncheckedIndexedAccess` — a missing arg should fail the
 * test loudly, not silently widen to `undefined`.
 */
function argAt(call: ContractCall, index: number): xdr.ScVal {
  const value = call.args[index];
  assert.ok(value !== undefined, `expected an argument at position ${index}`);
  return value;
}

describe("SAC call builders (SPEC §6.2)", () => {
  it("sacTransfer places [from, to, amount]", () => {
    const call = sacTransfer(TOKEN, FROM, TO, 1_000n);

    assert.equal(call.contract, TOKEN);
    assert.equal(call.fn, SAC_TRANSFER_METHOD);
    assert.equal(call.args.length, 3);
    assert.equal(scValToNative(argAt(call, 0)), FROM);
    assert.equal(scValToNative(argAt(call, 1)), TO);
    assert.equal(scValToNative(argAt(call, 2)), 1_000n);
  });

  it("sacTransferFrom places [from, spender, to, amount]", () => {
    const call = sacTransferFrom(TOKEN, FROM, SPENDER, TO, 250n);

    assert.equal(call.contract, TOKEN);
    assert.equal(call.fn, SAC_TRANSFER_FROM_METHOD);
    assert.equal(call.args.length, 4);
    assert.equal(scValToNative(argAt(call, 0)), FROM);
    assert.equal(scValToNative(argAt(call, 1)), SPENDER);
    assert.equal(scValToNative(argAt(call, 2)), TO);
    assert.equal(scValToNative(argAt(call, 3)), 250n);
  });

  it("keeps the amount in the position extractTransferAmount reads", () => {
    // `transfer`      -> amount at index 2
    // `transfer_from` -> amount at index 3
    assert.equal(scValToNative(argAt(sacTransfer(TOKEN, FROM, TO, 7n), 2)), 7n);
    assert.equal(scValToNative(argAt(sacTransferFrom(TOKEN, FROM, SPENDER, TO, 7n), 3)), 7n);
  });

  it("normalizes string and bigint amounts to the same i128 ScVal", () => {
    for (const amount of ["1000", 1_000n] as SacAmount[]) {
      const call = sacTransfer(TOKEN, FROM, TO, amount);
      assert.equal(argAt(call, 2).type, "scvI128");
      assert.equal(scValToNative(argAt(call, 2)), 1_000n);
    }
  });

  it("rejects a token id that is not a C... StrKey", () => {
    assert.throws(() => sacTransfer(FROM, FROM, TO, 1n), /token must be a valid/);
  });
});
