/**
 * Network-free invoke pipeline tests.
 *
 * The fake server exercises the real transaction builders and XDR signing path;
 * only the JSON-RPC boundary is replaced. In particular, dry-run safety is
 * asserted at that boundary by making both `sendTransaction` and
 * `getTransaction` fail loudly if reached.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Account,
  Address,
  Keypair,
  SorobanDataBuilder,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  BroadcastError,
  ContractResponseError,
  SigningError,
  SimulationError,
} from "../../src/errors.ts";
import { invoke, type InvokeParams } from "../../src/invoke.ts";
import { CostPreChecker } from "../../src/cost.ts";
import { PreFlightInterceptor } from "../../src/preflight.ts";

const NETWORK = "Test SDF Network ; September 2015";
const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

function simulationSuccess(resourceFee: unknown = "777", auth: xdr.SorobanAuthorizationEntry[] = []): object {
  return {
    transactionData: new SorobanDataBuilder().setResources(10, 20, 30).build(),
    minResourceFee: resourceFee,
    result: { auth },
    events: [],
  };
}

function simulationWithoutResourceFee(): object {
  const response = simulationSuccess() as { minResourceFee?: unknown };
  delete response.minResourceFee;
  return response;
}

function blockedDiagnosticEvent(): object {
  return {
    event: {
      body: {
        v0: {
          topics: ["event_auth_checked", "blocked", "per_tx_cap_exceeded"].map((topic) =>
            xdr.ScVal.scvSymbol(topic),
          ),
          data: xdr.ScVal.scvVoid(),
        },
      },
    },
  };
}

function blockedSimulation(): object {
  return {
    error: "HostError: Error(Auth, InvalidAction)",
    events: [blockedDiagnosticEvent()],
  };
}

interface MockServer {
  server: rpc.Server;
  simulateCalls: number;
  sendCalls: number;
  pollCalls: number;
  simulatedTransactions: Transaction[];
}

function mockServer(
  replies: Array<object | Error>,
  send: () => unknown = () => {
    throw new Error("dry-run must not call sendTransaction");
  },
  poll: () => unknown = () => {
    throw new Error("dry-run must not call getTransaction");
  },
): MockServer {
  const counts = { simulateCalls: 0, sendCalls: 0, pollCalls: 0 };
  const simulatedTransactions: Transaction[] = [];
  const server = {
    async getAccount(publicKey: string): Promise<Account> {
      return new Account(publicKey, "17");
    },
    async getLatestLedger(): Promise<{ sequence: number }> {
      return { sequence: 100 };
    },
    async simulateTransaction(transaction: Transaction): Promise<object> {
      counts.simulateCalls += 1;
      simulatedTransactions.push(transaction);
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`unexpected simulation #${counts.simulateCalls}`);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async sendTransaction(): Promise<unknown> {
      counts.sendCalls += 1;
      return send();
    },
    async getTransaction(): Promise<unknown> {
      counts.pollCalls += 1;
      return poll();
    },
  } as unknown as rpc.Server;
  return {
    server,
    get simulateCalls() {
      return counts.simulateCalls;
    },
    get sendCalls() {
      return counts.sendCalls;
    },
    get pollCalls() {
      return counts.pollCalls;
    },
    simulatedTransactions,
  };
}

function baseParams(server: rpc.Server, source: Keypair, agent: Keypair): InvokeParams {
  return {
    server,
    source,
    networkPassphrase: NETWORK,
    guardAuth: { guard: GUARD, agent },
    call: { contract: TOKEN, fn: "noop", args: [] },
  };
}

function dryParams(
  server: rpc.Server,
  source: Keypair,
  agent: Keypair,
): InvokeParams & { dryRun: true } {
  return { ...baseParams(server, source, agent), dryRun: true };
}

function requiredAddressAuth(address: string): xdr.SorobanAuthorizationEntry {
  const invocation = new xdr.InvokeContractArgs({
    contractAddress: new Address(TOKEN).toScAddress(),
    functionName: "noop",
    args: [],
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: 1n,
        signatureExpirationLedger: 110,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invocation),
      subInvocations: [],
    }),
  });
}

describe("invoke dry run", () => {
  it("returns the complete five-stage trace and fees without send or poll RPCs", async () => {
    const source = Keypair.random();
    const agent = Keypair.random();
    const mock = mockServer([simulationSuccess("777"), simulationSuccess("777")]);

    const result = await invoke(dryParams(mock.server, source, agent));

    assert.equal(result.kind, "dry_run");
    assert.equal(result.admissible, true);
    assert.equal(result.verdict, "admissible");
    assert.equal(result.error, null);
    assert.deepEqual(result.fees, {
      resourceFeeStroops: 777n,
      inclusionFeeStroops: 100n,
      totalFeeStroops: 877n,
    });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(
      result.steps.map((step) => step.name),
      ["probe", "sign", "simulate", "verdict", "fees"],
    );
    for (const step of result.steps) {
      assert.equal(step.ok, true);
      assert.ok(Number.isFinite(step.durationMs));
      assert.ok(step.durationMs >= 0);
    }
    assert.equal(mock.simulateCalls, 2);
    assert.equal(mock.sendCalls, 0);
    assert.equal(mock.pollCalls, 0);
    assert.ok(!("submission" in result));
    assert.ok(!("txHash" in result));
  });

  it("signs and attaches real guard authorization in the enforced dry-run simulation", async () => {
    const source = Keypair.random();
    const agent = Keypair.random();
    const guardAuth = requiredAddressAuth(GUARD);
    const mock = mockServer([
      simulationSuccess("777", [guardAuth]),
      simulationSuccess("777"),
    ]);

    const result = await invoke(dryParams(mock.server, source, agent));

    assert.equal(result.admissible, true);
    assert.equal(mock.simulateCalls, 2);
    assert.equal(mock.sendCalls, 0);
    assert.equal(mock.pollCalls, 0);

    const enforcedTransaction = mock.simulatedTransactions[1]!;
    const envelope = enforcedTransaction.toEnvelope() as unknown as {
      v1: {
        tx: {
          operations: Array<{
            body: { invokeHostFunctionOp?: { auth: xdr.SorobanAuthorizationEntry[] } };
          }>;
        };
      };
    };
    const hostOperation = envelope.v1.tx.operations[0]!.body.invokeHostFunctionOp!;
    const signedEntry = hostOperation.auth[0]!;
    assert.equal(signedEntry.credentials.type, "sorobanCredentialsAddress");
    const credentials = signedEntry.credentials.address!;
    assert.equal(Address.fromScAddress(credentials.address).toString(), GUARD);
    const signature = scValToNative(credentials.signature);
    assert.ok(signature instanceof Uint8Array);
    assert.equal(signature.length, 64);
  });

  it("returns a blocked verdict, reason, diagnostics, and zero charged fees", async () => {
    const source = Keypair.random();
    const agent = Keypair.random();
    const mock = mockServer([simulationSuccess(), blockedSimulation()]);

    const result = await invoke(dryParams(mock.server, source, agent));

    assert.equal(result.kind, "dry_run");
    assert.equal(result.admissible, false);
    assert.equal(result.verdict, "blocked");
    assert.equal(result.reason, "per_tx_cap_exceeded");
    assert.equal(result.error, null);
    assert.match(result.detail ?? "", /InvalidAction/);
    assert.equal(result.diagnostics.length, 1);
    assert.deepEqual(result.fees, {
      resourceFeeStroops: 0n,
      inclusionFeeStroops: 0n,
      totalFeeStroops: 0n,
    });
    assert.equal(mock.sendCalls, 0);
    assert.equal(mock.pollCalls, 0);
  });

  it("returns a typed undetermined result and partial trace for a technical simulation failure", async () => {
    const source = Keypair.random();
    const agent = Keypair.random();
    const mock = mockServer([simulationSuccess(), { error: "HostError: contract trap" }]);

    const result = await invoke(dryParams(mock.server, source, agent));

    assert.equal(result.verdict, "undetermined");
    assert.ok(result.error instanceof SimulationError);
    assert.equal(result.error.stage, "simulate");
    assert.deepEqual(
      result.steps.map((step) => [step.name, step.ok]),
      [
        ["probe", true],
        ["sign", true],
        ["simulate", false],
        ["verdict", false],
        ["fees", true],
      ],
    );
    assert.equal(mock.sendCalls, 0);
  });

  it("retains the original probe failure cause in an undetermined result", async () => {
    const source = Keypair.random();
    const agent = Keypair.random();
    const cause = new Error("RPC unavailable");
    const mock = mockServer([cause]);

    const result = await invoke(dryParams(mock.server, source, agent));

    assert.equal(result.verdict, "undetermined");
    assert.ok(result.error instanceof SimulationError);
    assert.equal(result.error.stage, "probe");
    assert.equal(result.error.cause, cause);
    assert.deepEqual(
      result.steps.map((step) => step.name),
      ["probe", "verdict", "fees"],
    );
    assert.equal(result.steps[0]?.ok, false);
    assert.equal(mock.sendCalls, 0);
  });

  it("fails closed when the enforced simulation fee is missing, negative, or malformed", async () => {
    const invalidFees: Array<() => object> = [
      () => simulationWithoutResourceFee(),
      () => simulationSuccess("-1"),
      () => simulationSuccess("not-a-fee"),
      () => simulationSuccess(2n ** 64n),
    ];

    for (const response of invalidFees) {
      const source = Keypair.random();
      const agent = Keypair.random();
      const mock = mockServer([response(), response()]);
      const result = await invoke(dryParams(mock.server, source, agent));

      assert.equal(result.verdict, "undetermined");
      assert.ok(result.error instanceof ContractResponseError);
      assert.equal(result.error.field, "minResourceFee");
      assert.equal(result.fees.totalFeeStroops, 0n);
      assert.equal(result.steps.at(-1)?.ok, false);
      assert.equal(mock.sendCalls, 0);
    }
  });

  it("keeps preflight and cost checks fail-closed on invalid simulation fees", async () => {
    const invalidFees: Array<() => object> = [
      () => simulationWithoutResourceFee(),
      () => simulationSuccess("-1"),
      () => simulationSuccess("not-a-fee"),
    ];

    for (const response of invalidFees) {
      const source = Keypair.random();
      const agent = Keypair.random();
      const mock = mockServer([response(), response(), response(), response()]);
      const config = {
        server: mock.server,
        networkPassphrase: NETWORK,
        guard: GUARD,
        agent,
        source,
      };
      const interceptor = new PreFlightInterceptor(config);
      const call = baseParams(mock.server, source, agent).call;

      const decision = await interceptor.check(call);
      assert.equal(decision.kind, "undetermined");
      assert.ok(decision.error instanceof ContractResponseError);

      const cost = await new CostPreChecker({ interceptor }).check(call);
      assert.equal(cost.kind, "undetermined");
      assert.equal(cost.totalFeeStroops, 0n);
      assert.equal(mock.sendCalls, 0);
    }
  });
});

describe("invoke typed failures", () => {
  it("returns ContractResponseError for malformed required-authorization payloads", async () => {
    const responses = [
      { ...simulationSuccess(), result: { auth: null } },
      { ...simulationSuccess(), result: { auth: [null] } },
      { ...simulationSuccess(), result: { auth: [{}] } },
    ];

    for (const response of responses) {
      const source = Keypair.random();
      const agent = Keypair.random();
      const mock = mockServer([response]);
      const result = await invoke(dryParams(mock.server, source, agent));

      assert.equal(result.verdict, "undetermined");
      assert.ok(result.error instanceof ContractResponseError);
      assert.match(result.error.field, /^result\.auth/);
      assert.deepEqual(
        result.steps.map((step) => [step.name, step.ok]),
        [
          ["probe", true],
          ["sign", false],
          ["verdict", false],
          ["fees", true],
        ],
      );
      assert.equal(mock.sendCalls, 0);
    }
  });

  it("returns SigningError when required authorization has no matching key", async () => {
    const source = Keypair.random();
    const agent = Keypair.random();
    const required = Keypair.random();
    const auth = requiredAddressAuth(required.publicKey());
    const mock = mockServer([simulationSuccess("0", [auth])]);
    const result = await invoke(baseParams(mock.server, source, agent));

    assert.equal(result.kind, "error");
    assert.ok(result.error instanceof SigningError);
    assert.equal(result.error.address, required.publicKey());
    assert.equal(mock.simulateCalls, 1);
    assert.equal(mock.sendCalls, 0);
  });

  it("returns BroadcastError when the real assembly path reaches a failed send", async () => {
    const source = Keypair.random();
    const agent = Keypair.random();
    const transport = new Error("send transport failed");
    const mock = mockServer([simulationSuccess("555"), simulationSuccess("555")], () => {
      throw transport;
    });
    const result = await invoke(baseParams(mock.server, source, agent));

    assert.equal(result.kind, "error");
    assert.ok(result.error instanceof BroadcastError);
    assert.equal(result.error.cause, transport);
    assert.equal(mock.simulateCalls, 2);
    assert.equal(mock.sendCalls, 1);
    assert.equal(mock.pollCalls, 0);
  });

  it("preserves a post-inclusion guard block as a charged blocked outcome", async () => {
    const source = Keypair.random();
    const agent = Keypair.random();
    const hash = "b".repeat(64);
    const mock = mockServer(
      [simulationSuccess("555"), simulationSuccess("555")],
      () => ({ status: "PENDING", hash }),
      () => ({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 101,
        resultXdr: null,
        diagnosticEventsXdr: [blockedDiagnosticEvent()],
      }),
    );

    const result = await invoke(baseParams(mock.server, source, agent));

    assert.equal(result.kind, "blocked");
    assert.equal(result.reason, "per_tx_cap_exceeded");
    assert.equal(result.transactionHash, hash);
    assert.equal(result.charged, true);
    assert.equal(result.diagnosticEvents.length, 1);
    assert.equal(mock.simulateCalls, 2);
    assert.equal(mock.sendCalls, 1);
    assert.equal(mock.pollCalls, 1);
  });
});
