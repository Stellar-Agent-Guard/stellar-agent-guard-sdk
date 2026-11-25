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
import { invokeMany } from "../../src/invoke.ts";
import { FeeCapExceededError } from "../../src/errors.ts";
import { FakeClock } from "../../src/clock.ts";
import { unsafeAccountAddress, unsafeContractAddress } from "../../src/policy.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");
const PASSPHRASE = "Test SDF Network ; September 2015";

function transferCall(amount = 100n) {
  return {
    contract: TOKEN,
    fn: "transfer",
    args: [
      new Address(GUARD).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
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
            xdr.ScVal.scvSymbol("guard_auth"),
            xdr.ScVal.scvSymbol("blocked"),
            xdr.ScVal.scvSymbol("limit_exceeded"),
          ],
          data: xdr.ScVal.scvVoid(),
        }),
      ),
    }),
  });
}

function makeMockServer(opts: {
  simulateResults?: Array<"ok" | "blocked">;
  onSend?: () => void;
  clock?: FakeClock;
  advanceMsOnSimulate?: number;
}) {
  const source = Keypair.random();
  const agent = Keypair.random();
  let simCount = 0;
  let sendCount = 0;
  const simQueue = [...(opts.simulateResults ?? [])];

  const server = {
    getAccount: async (pub: string) => new Account(pub, "1"),
    getLatestLedger: async () => ({ sequence: 100 }),
    simulateTransaction: async () => {
      simCount += 1;
      if (opts.clock && opts.advanceMsOnSimulate) {
        opts.clock.advance(opts.advanceMsOnSimulate);
      }
      // Every invoke() does 2 simulations: probe (odd) and enforced (even).
      const isEnforced = simCount % 2 === 0;
      if (isEnforced) {
        const next = simQueue.shift() ?? "ok";
        if (next === "blocked") {
          return {
            error: "HostError: Error(Contract, #1)",
            events: [blockedEventXdr()],
          };
        }
      }
      return probeSuccess();
    },
    sendTransaction: async () => {
      sendCount += 1;
      opts.onSend?.();
      return {
        status: "PENDING",
        hash: `hash-${sendCount}`,
      };
    },
    getTransaction: async (hash: string) => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      hash,
      ledger: 101,
      returnValue: xdr.ScVal.scvVoid(),
    }),
  } as unknown as rpc.Server;

  return { server, source, agent, getSendCount: () => sendCount };
}

describe("invokeMany()", () => {
  it("returns empty results and zeroed summary for empty calls", async () => {
    const { server, source, agent } = makeMockServer({});
    const res = await invokeMany({
      server,
      source,
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent },
      pollIntervalMs: 1,
      calls: [],
    });

    assert.deepEqual(res.results, []);
    assert.deepEqual(res.summary, {
      total: 0,
      completed: 0,
      skipped: 0,
      allowed: 0,
      blocked: 0,
      pending: 0,
      error: 0,
      dryRun: 0,
      stopped: false,
    });
  });

  it("executes calls sequentially, preserves input order, and summarizes outcomes", async () => {
    const { server, source, agent, getSendCount } = makeMockServer({
      simulateResults: ["ok", "ok"],
    });

    const res = await invokeMany({
      server,
      source,
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent },
      pollIntervalMs: 1,
      calls: [{ call: transferCall(10n) }, { call: transferCall(20n) }],
    });

    assert.equal(getSendCount(), 2);
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0]?.index, 0);
    assert.equal(res.results[0]?.status, "completed");
    assert.equal(
      res.results[0]?.outcome && "kind" in res.results[0].outcome && res.results[0].outcome.kind,
      "allowed",
    );
    assert.equal(res.results[1]?.index, 1);
    assert.equal(res.results[1]?.status, "completed");
    assert.equal(
      res.results[1]?.outcome && "kind" in res.results[1].outcome && res.results[1].outcome.kind,
      "allowed",
    );
    assert.deepEqual(res.summary, {
      total: 2,
      completed: 2,
      skipped: 0,
      allowed: 2,
      blocked: 0,
      pending: 0,
      error: 0,
      dryRun: 0,
      stopped: false,
    });
  });

  it("stops on first blocked call by default and prevents later calls from broadcasting", async () => {
    const { server, source, agent, getSendCount } = makeMockServer({
      simulateResults: ["ok", "blocked", "ok"],
    });

    const res = await invokeMany({
      server,
      source,
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent },
      pollIntervalMs: 1,
      calls: [
        { call: transferCall(10n) },
        { call: transferCall(20n) },
        { call: transferCall(30n) },
      ],
    });

    assert.equal(getSendCount(), 1);
    assert.equal(res.results[0]?.status, "completed");
    assert.equal(res.results[1]?.status, "completed");
    assert.equal(
      res.results[1]?.outcome && "kind" in res.results[1].outcome && res.results[1].outcome.kind,
      "blocked",
    );
    assert.equal(res.results[2]?.status, "skipped");
    assert.equal(res.results[2]?.skippedReason, "stopped_on_blocked");
    assert.equal(res.summary.stopped, true);
    assert.equal(res.summary.stopReason, "blocked");
    assert.equal(res.summary.allowed, 1);
    assert.equal(res.summary.blocked, 1);
    assert.equal(res.summary.skipped, 1);
  });

  it("continues after a blocked call when stopOnBlocked is false", async () => {
    const { server, source, agent, getSendCount } = makeMockServer({
      simulateResults: ["blocked", "ok"],
    });

    const res = await invokeMany({
      server,
      source,
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent },
      pollIntervalMs: 1,
      stopOnBlocked: false,
      calls: [{ call: transferCall(10n) }, { call: transferCall(20n) }],
    });

    assert.equal(getSendCount(), 1);
    assert.equal(res.results[0]?.status, "completed");
    assert.equal(res.results[1]?.status, "completed");
    assert.equal(res.summary.stopped, false);
    assert.equal(res.summary.blocked, 1);
    assert.equal(res.summary.allowed, 1);
    assert.equal(res.summary.skipped, 0);
  });

  it("respects a shared deadlineMs across the whole run", async () => {
    const clock = new FakeClock(1_000);
    const { server, source, agent, getSendCount } = makeMockServer({
      simulateResults: ["ok", "ok"],
      clock,
      advanceMsOnSimulate: 60,
    });

    const res = await invokeMany({
      server,
      source,
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent },
      pollIntervalMs: 1,
      clock,
      deadlineMs: 150,
      calls: [{ call: transferCall(10n) }, { call: transferCall(20n) }],
    });

    // First call runs 2 simulations (120ms); second call sees deadline expired (120 < 150? No, 120ms elapsed, remaining 30ms, then 2nd call's first sim advances 60ms -> expires!).
    // Either way, at most 1 broadcast happens and the run stops on deadline_exceeded or returns timeout error.
    assert.ok(getSendCount() <= 1);
    assert.equal(res.results.length, 2);
  });

  it("forwards AbortSignal and skips calls when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { server, source, agent, getSendCount } = makeMockServer({});

    const res = await invokeMany({
      server,
      source,
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent },
      pollIntervalMs: 1,
      signal: controller.signal,
      calls: [{ call: transferCall(10n) }],
    });

    assert.equal(getSendCount(), 0);
    assert.equal(res.results[0]?.status, "skipped");
    assert.equal(res.results[0]?.skippedReason, "aborted");
    assert.equal(res.summary.stopped, true);
    assert.equal(res.summary.stopReason, "aborted");
  });

  it("forwards maxFeeStroops fee ceiling to each call", async () => {
    const { server, source, agent, getSendCount } = makeMockServer({});

    const res = await invokeMany({
      server,
      source,
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent },
      pollIntervalMs: 1,
      maxFeeStroops: 1n,
      calls: [{ call: transferCall(10n) }],
    });

    assert.equal(getSendCount(), 0);
    assert.equal(res.results[0]?.status, "completed");
    const outcome = res.results[0]?.outcome;
    assert.ok(outcome && "kind" in outcome && outcome.kind === "error");
    assert.ok(outcome.error instanceof FeeCapExceededError);
  });
});
