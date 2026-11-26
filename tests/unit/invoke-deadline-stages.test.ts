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
import { invoke, RpcTimeoutError } from "../../src/invoke.ts";
import { FakeClock } from "../../src/clock.ts";
import { unsafeAccountAddress, unsafeContractAddress } from "../../src/policy.ts";
import type { AgentSigner } from "../../src/tx.ts";

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

type Stage = "probe" | "sign" | "simulate" | "poll";

interface StageCase {
  name: string;
  expireAt: Stage;
  advanceMs: number;
  expectBroadcast: boolean;
}

const CASES: StageCase[] = [
  {
    name: "expires during probe (before sign)",
    expireAt: "probe",
    advanceMs: 6_000,
    expectBroadcast: false,
  },
  {
    name: "expires exactly at probe boundary",
    expireAt: "probe",
    advanceMs: 5_000,
    expectBroadcast: false,
  },
  {
    name: "expires during sign (before enforced simulate)",
    expireAt: "sign",
    advanceMs: 6_000,
    expectBroadcast: false,
  },
  {
    name: "expires exactly at sign boundary",
    expireAt: "sign",
    advanceMs: 5_000,
    expectBroadcast: false,
  },
  {
    name: "expires during enforced simulate (before broadcast)",
    expireAt: "simulate",
    advanceMs: 6_000,
    expectBroadcast: false,
  },
  {
    name: "expires exactly at simulate boundary",
    expireAt: "simulate",
    advanceMs: 5_000,
    expectBroadcast: false,
  },
  {
    name: "expires during poll (after broadcast)",
    expireAt: "poll",
    advanceMs: 6_000,
    expectBroadcast: true,
  },
];

describe("invoke() stage-by-stage deadline expiry with FakeClock", () => {
  for (const tc of CASES) {
    it(tc.name, async () => {
      const clock = new FakeClock(1_000);
      const source = Keypair.random();
      const agentKp = Keypair.random();
      let simCount = 0;
      let sendCount = 0;
      const submittedHashes: Array<string | null> = [];

      const agent: AgentSigner = {
        publicKey: agentKp.publicKey(),
        signDigest: async (digest: Uint8Array) => {
          if (tc.expireAt === "sign") {
            clock.advance(tc.advanceMs);
          }
          return agentKp.sign(Buffer.from(digest));
        },
      };

      const server = {
        getAccount: async (pub: string) => new Account(pub, "1"),
        getLatestLedger: async () => ({ sequence: 100 }),
        simulateTransaction: async () => {
          simCount += 1;
          if (simCount === 1 && tc.expireAt === "probe") {
            clock.advance(tc.advanceMs);
          }
          if (simCount === 2 && tc.expireAt === "simulate") {
            clock.advance(tc.advanceMs);
          }
          return probeSuccess();
        },
        sendTransaction: async () => {
          sendCount += 1;
          return { status: "PENDING", hash: `hash-${sendCount}` };
        },
        getTransaction: async () => {
          if (tc.expireAt === "poll") {
            clock.advance(tc.advanceMs);
          }
          return { status: rpc.Api.GetTransactionStatus.NOT_FOUND };
        },
      } as unknown as rpc.Server;

      const outcome = await invoke({
        server,
        source,
        call: transferCall(),
        networkPassphrase: PASSPHRASE,
        guardAuth: { guard: GUARD, agent },
        deadlineMs: 5_000,
        pollAttempts: 2,
        pollIntervalMs: 0,
        clock,
        onSubmitted: (ev) => submittedHashes.push(ev.hash),
      });

      assert.equal(outcome.kind, "error");
      assert.ok(outcome.error instanceof RpcTimeoutError);
      assert.equal(outcome.error.deadline, true);

      if (tc.expectBroadcast) {
        assert.equal(sendCount, 1);
        assert.deepEqual(submittedHashes, ["hash-1"]);
      } else {
        assert.equal(sendCount, 0);
        assert.deepEqual(submittedHashes, []);
      }
    });
  }
});
