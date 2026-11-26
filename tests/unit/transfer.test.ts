/**
 * Unit tests for the SAC transfer helpers (issue #410).
 *
 * The encoded call is the contract: these tests pin the argument order and the
 * exact `i128` amount against the manual `nativeToScVal` examples, and pin the
 * synchronous rejection of invalid addresses and lossy amounts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Address, nativeToScVal, rpc, scValToNative } from "@stellar/stellar-sdk";
import { InvalidInputError } from "../../src/errors.ts";
import {
  isContractAddress,
  isStrKeyAddress,
  type ContractAddress,
  type StrKeyAddress,
} from "../../src/policy.ts";
import type { PreFlightConfigInput } from "../../src/preflight.ts";
import {
  checkTransfer,
  checkTransferFrom,
  buildTransferCall,
  buildTransferFromCall,
} from "../../src/transfer.ts";

const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB" as ContractAddress;
const AGENT_ACCOUNT = "GDUYKWVFLVISVOM5FK5KTBA446VQQ7NBRRFMLNLKLISKL26LJGKUVRHT" as StrKeyAddress;
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH" as StrKeyAddress;

function xdrHex(value: { toXDR: () => Uint8Array }): string {
  return Buffer.from(value.toXDR()).toString("hex");
}

/** A config whose RPC is never reached: the check is bounded out up front. */
const NO_RPC_CONFIG = { server: {} as rpc.Server } as unknown as PreFlightConfigInput;

describe("buildTransferCall", () => {
  it("produces the same call shape as the manual transfer example", () => {
    const call = buildTransferCall({
      token: TOKEN,
      from: AGENT_ACCOUNT,
      to: RECIPIENT,
      amount: 1_001n,
    });

    const manual = [
      nativeToScVal(AGENT_ACCOUNT, { type: "address" }),
      nativeToScVal(RECIPIENT, { type: "address" }),
      nativeToScVal(1_001n, { type: "i128" }),
    ];

    assert.equal(call.contract, TOKEN);
    assert.equal(call.fn, "transfer");
    assert.deepEqual(call.args.map(xdrHex), manual.map(xdrHex));
    // Argument order: [from, to, amount].
    assert.equal(scValToNative(call.args[0]!), AGENT_ACCOUNT);
    assert.equal(scValToNative(call.args[1]!), RECIPIENT);
    assert.equal(scValToNative(call.args[2]!), 1_001n);
  });

  it("encodes the full i128 range without rounding", () => {
    const max = 2n ** 127n - 1n;
    const call = buildTransferCall({
      token: TOKEN,
      from: AGENT_ACCOUNT,
      to: RECIPIENT,
      amount: max,
    });
    assert.equal(scValToNative(call.args[2]!), max);
  });

  it("accepts a safe-integer number but rejects a lossy one", () => {
    const call = buildTransferCall({
      token: TOKEN,
      from: AGENT_ACCOUNT,
      to: RECIPIENT,
      amount: 42,
    });
    assert.equal(scValToNative(call.args[2]!), 42n);

    assert.throws(
      () =>
        buildTransferCall({
          token: TOKEN,
          from: AGENT_ACCOUNT,
          to: RECIPIENT,
          amount: Number.MAX_SAFE_INTEGER + 1,
        }),
      (error: unknown) => error instanceof InvalidInputError && error.field === "amount",
    );
    assert.throws(
      () =>
        buildTransferCall({
          token: TOKEN,
          from: AGENT_ACCOUNT,
          to: RECIPIENT,
          amount: 1.5,
        }),
      (error: unknown) => error instanceof InvalidInputError && error.field === "amount",
    );
  });

  it("rejects a negative amount and an out-of-range i128", () => {
    for (const amount of [-1n, -(2n ** 127n), 2n ** 127n]) {
      assert.throws(
        () => buildTransferCall({ token: TOKEN, from: AGENT_ACCOUNT, to: RECIPIENT, amount }),
        (error: unknown) => error instanceof InvalidInputError && error.field === "amount",
      );
    }
  });

  it("rejects invalid addresses synchronously, before any RPC", () => {
    assert.throws(
      () =>
        buildTransferCall({
          token: "not-a-contract" as ContractAddress,
          from: AGENT_ACCOUNT,
          to: RECIPIENT,
          amount: 1n,
        }),
      (error: unknown) => error instanceof InvalidInputError && error.field === "token",
    );
    assert.throws(
      () =>
        buildTransferCall({
          token: TOKEN,
          from: "GABC" as StrKeyAddress,
          to: RECIPIENT,
          amount: 1n,
        }),
      (error: unknown) => error instanceof InvalidInputError && error.field === "from",
    );
    assert.throws(
      () =>
        buildTransferCall({
          token: TOKEN,
          from: AGENT_ACCOUNT,
          to: AGENT_ACCOUNT.replace("G", "S") as StrKeyAddress,
          amount: 1n,
        }),
      (error: unknown) => error instanceof InvalidInputError && error.field === "to",
    );
  });
});

describe("buildTransferFromCall", () => {
  it("encodes [spender, from, to, amount] in that order", () => {
    const call = buildTransferFromCall({
      token: TOKEN,
      spender: RECIPIENT,
      from: AGENT_ACCOUNT,
      to: RECIPIENT,
      amount: 7n,
    });

    assert.equal(call.fn, "transfer_from");
    assert.deepEqual(
      call.args.map((arg) => scValToNative(arg)),
      [RECIPIENT, AGENT_ACCOUNT, RECIPIENT, 7n],
    );
    assert.deepEqual(
      call.args.map(xdrHex),
      [
        nativeToScVal(RECIPIENT, { type: "address" }),
        nativeToScVal(AGENT_ACCOUNT, { type: "address" }),
        nativeToScVal(RECIPIENT, { type: "address" }),
        nativeToScVal(7n, { type: "i128" }),
      ].map(xdrHex),
    );
  });

  it("rejects an invalid spender", () => {
    assert.throws(
      () =>
        buildTransferFromCall({
          token: TOKEN,
          spender: "spender" as StrKeyAddress,
          from: AGENT_ACCOUNT,
          to: RECIPIENT,
          amount: 7n,
        }),
      (error: unknown) => error instanceof InvalidInputError && error.field === "spender",
    );
  });
});

describe("checkTransfer / checkTransferFrom", () => {
  it("return the interceptor's decision shape without throwing", async () => {
    // An already-aborted signal makes check() answer before any RPC, which
    // proves the helpers route through the ordinary pre-flight path.
    const signal = AbortSignal.abort();
    const transfer = await checkTransfer(
      NO_RPC_CONFIG,
      { token: TOKEN, from: AGENT_ACCOUNT, to: RECIPIENT, amount: 1n },
      { signal },
    );
    assert.equal(transfer.kind, "undetermined");
    assert.equal(transfer.allowed, false);

    const transferFrom = await checkTransferFrom(
      NO_RPC_CONFIG,
      { token: TOKEN, spender: RECIPIENT, from: AGENT_ACCOUNT, to: RECIPIENT, amount: 1n },
      { signal },
    );
    assert.equal(transferFrom.kind, "undetermined");
  });

  it("throw synchronously on invalid input, like the builders", () => {
    assert.throws(
      () =>
        checkTransfer(NO_RPC_CONFIG, {
          token: TOKEN,
          from: "bad" as StrKeyAddress,
          to: RECIPIENT,
          amount: 1n,
        }),
      (error: unknown) => error instanceof InvalidInputError,
    );
  });
});

describe("address guards used by the helpers", () => {
  it("accepts G and C addresses for transfer parties and only C for the token", () => {
    assert.equal(isStrKeyAddress(AGENT_ACCOUNT), true);
    assert.equal(isStrKeyAddress(TOKEN), true);
    assert.equal(isContractAddress(TOKEN), true);
    assert.equal(isContractAddress(AGENT_ACCOUNT), false);
    assert.equal(new Address(TOKEN).toString(), TOKEN);
  });
});
