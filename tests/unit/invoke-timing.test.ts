import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  rpc,
  SorobanDataBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { invoke } from "../../src/invoke.ts";
import { FakeClock } from "../../src/clock.ts";
import { unsafeAccountAddress, unsafeContractAddress } from "../../src/policy.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");
const PASSPHRASE = "Test SDF Network ; September 2015";

function transferCall() {
  return {
    contract: TOKEN,
    fn: "transfer",
    args: [
      new Address(GUARD).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(100n, { type: "i128" }),
    ],
  };
}

function probeSuccess(): unknown {
  return {
    minResourceFee: "100",
    transactionData: new SorobanDataBuilder().build().toXDR(),
    result: {
      auth: [
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
            new xdr.SorobanAddressCredentials({
              address: new Address(GUARD).toScAddress(),
              nonce: BigInt(1),
              signatureExpirationLedger: 1,
              signature: xdr.ScVal.scvBytes(new Uint8Array(0)),
            }),
          ),
          rootInvocation: new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: new Address(TOKEN).toScAddress(),
                functionName: "transfer",
                args: [],
              }),
            ),
            subInvocations: [],
          }),
        }),
      ],
    },
  };
}

function blockedEventXdr(): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
      contractId: xdr.ContractId.fromXDR(new Address(GUARD).toBuffer()),
      type: xdr.ContractEventType.contract,
      body: xdr.ContractEventBody.v0(
        new xdr.ContractEventV0({
          topics: [
            xdr.ScVal.scvSymbol("event_auth_checked"),
            xdr.ScVal.scvSymbol("blocked"),
            xdr.ScVal.scvSymbol("limit_exceeded"),
          ],
          data: xdr.ScVal.scvVoid(),
        }),
      ),
    }),
  });
}

describe("invoke() normalised timing fields", () => {
  it("populates startedAt, submittedAt, confirmedAt, and durationMs on allowed", async () => {
    const clock = new FakeClock(1_000_000);
    const source = Keypair.random();
    const agent = Keypair.random();
    const server = {
      getAccount: async (pub: string) => new Account(pub, "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => {
        clock.advance(10);
        return probeSuccess();
      },
      sendTransaction: async () => {
        clock.advance(20);
        return { status: "PENDING", hash: "hash-allowed" };
      },
      getTransaction: async (hash: string) => {
        clock.advance(30);
        return {
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          hash,
          ledger: 101,
          returnValue: xdr.ScVal.scvVoid(),
        };
      },
    } as unknown as rpc.Server;

    const outcome = await invoke({
      server,
      source,
      call: transferCall(),
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent },
      pollIntervalMs: 0,
      clock,
    });

    assert.equal(outcome.kind, "allowed");
    assert.ok(outcome.timing);
    assert.equal(outcome.timing.startedAt, new Date(1_000_000).toISOString());
    assert.equal(outcome.timing.submittedAt, new Date(1_000_040).toISOString());
    assert.equal(outcome.timing.confirmedAt, new Date(1_000_070).toISOString());
    assert.equal(outcome.timing.durationMs, 70);
    assert.doesNotThrow(() => JSON.stringify(outcome.timing));
  });

  it("omits submittedAt and confirmedAt on pre-broadcast blocked", async () => {
    const clock = new FakeClock(2_000_000);
    const source = Keypair.random();
    const agent = Keypair.random();
    let simCount = 0;
    const server = {
      getAccount: async (pub: string) => new Account(pub, "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => {
        simCount += 1;
        clock.advance(15);
        if (simCount === 2) {
          return { error: "HostError: Error(Contract, #1)", events: [blockedEventXdr()] };
        }
        return probeSuccess();
      },
    } as unknown as rpc.Server;

    const outcome = await invoke({
      server,
      source,
      call: transferCall(),
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent },
      pollIntervalMs: 0,
      clock,
    });

    assert.equal(outcome.kind, "blocked");
    assert.ok(outcome.timing);
    assert.equal(outcome.timing.startedAt, new Date(2_000_000).toISOString());
    assert.equal(outcome.timing.submittedAt, undefined);
    assert.equal(outcome.timing.confirmedAt, undefined);
    assert.equal(outcome.timing.durationMs, 30);
    assert.doesNotThrow(() => JSON.stringify(outcome.timing));
  });

  it("populates startedAt, submittedAt, and durationMs (omits confirmedAt) on pending", async () => {
    const clock = new FakeClock(3_000_000);
    const source = Keypair.random();
    const agent = Keypair.random();
    const server = {
      getAccount: async (pub: string) => new Account(pub, "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => probeSuccess(),
      sendTransaction: async () => {
        clock.advance(25);
        return { status: "PENDING", hash: "hash-pending" };
      },
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND }),
    } as unknown as rpc.Server;

    const outcome = await invoke({
      server,
      source,
      call: transferCall(),
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent },
      pollAttempts: 1,
      pollIntervalMs: 0,
      clock,
    });

    assert.equal(outcome.kind, "pending");
    assert.ok(outcome.timing);
    assert.equal(outcome.timing.startedAt, new Date(3_000_000).toISOString());
    assert.equal(outcome.timing.submittedAt, new Date(3_000_025).toISOString());
    assert.equal(outcome.timing.confirmedAt, undefined);
    assert.equal(outcome.timing.durationMs, 25);
    assert.doesNotThrow(() => JSON.stringify(outcome.timing));
  });

  it("omits submittedAt and confirmedAt on pre-broadcast error", async () => {
    const clock = new FakeClock(4_000_000);
    const source = Keypair.random();
    const agent = Keypair.random();
    const controller = new AbortController();
    controller.abort();

    const server = {
      getAccount: async (pub: string) => new Account(pub, "1"),
    } as unknown as rpc.Server;

    const outcome = await invoke({
      server,
      source,
      call: transferCall(),
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent },
      signal: controller.signal,
      clock,
    });

    assert.equal(outcome.kind, "error");
    const timing =
      "timing" in outcome
        ? (outcome.timing as import("../../src/invoke.ts").InvokeTiming | undefined)
        : undefined;
    assert.ok(timing);
    assert.equal(timing.startedAt, new Date(4_000_000).toISOString());
    assert.equal(timing.submittedAt, undefined);
    assert.equal(timing.confirmedAt, undefined);
    assert.equal(timing.durationMs, 0);
    assert.doesNotThrow(() => JSON.stringify(timing));
  });
});
