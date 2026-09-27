/**
 * Unit tests for invoke() pipeline observability (`onStep`, issue #57).
 *
 * The mock server drives the real pipeline — probe simulation, signing pass,
 * enforced simulation, broadcast — with no network, and a recorder collects
 * the events `onStep` receives. The default no-callback path is pinned too:
 * the whole point of the hook is that omitting it changes nothing.
 *
 * Timing assertions avoid wall-clock fragility in both directions: durations
 * are checked for the contract's shape (a finite, non-negative number on
 * ok/fail, always 0 on start), never against a real sleep, and every test that
 * reaches the broadcast poll uses the test runner's mocked timers so the
 * pipeline's built-in 3s poll interval never slows (or flakes) the suite.
 * Retry indexing is checked against the pipeline's one built-in
 * stale-ledger re-run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Account, Address, Keypair, nativeToScVal, rpc, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { invoke } from "../../src/invoke.ts";
import { TRACE_STEP_NAMES, type TraceStepName } from "../../src/trace.ts";
import type { InvokeStepEvent } from "../../src/invoke.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
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

/** A successful simulation response that asks for the guard's authorization. */
function probeSuccess(): unknown {
  return {
    minResourceFee: "100",
    // Real RPC responses carry the soroban data as XDR; the string form is
    // what `assembleFromSimulation`'s constructor branch handles natively.
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
          // The invocation itself is irrelevant here: the pipeline re-signs the
          // guard entry from its own parameters and never reads this one.
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

/** A guard refusal on the enforced simulation, in the contract's own vocabulary. */
function blockedEnforcement(): unknown {
  return {
    error: "blocked",
    events: [
      {
        event: {
          contractId: GUARD,
          body: {
            v0: {
              topics: [
                xdr.ScVal.scvSymbol("event_auth_checked"),
                xdr.ScVal.scvSymbol("blocked"),
                xdr.ScVal.scvSymbol("per_tx_cap_exceeded"),
              ],
              data: xdr.ScVal.scvVoid(),
            },
          },
        },
      },
    ],
  };
}

interface MockServerOptions {
  /** Overrides every simulation (probe and enforced). */
  simulate?: (call: number) => unknown;
  /** Overrides only the enforced simulation (the 2nd one per attempt). */
  enforced?: (attempt: number) => unknown;
  /** Overrides sendTransaction. */
  send?: () => unknown;
  /** Overrides getTransaction (post-broadcast polling). */
  getTransaction?: () => unknown;
}

/**
 * A mock rpc.Server shaped for the invoke pipeline. Simulations are counted so
 * retry tests can assert that instrumentation added no extra attempts, and the
 * caller can override individual responses.
 */
function createMockServer(options: MockServerOptions = {}) {
  let simulations = 0;
  let sends = 0;
  const mock = {
    get simulationCount() {
      return simulations;
    },
    get sendCount() {
      return sends;
    },
    async getAccount() {
      return new Account(Keypair.random().publicKey(), "100");
    },
    async getLatestLedger() {
      return { sequence: 1000 };
    },
    async simulateTransaction() {
      const call = ++simulations;
      if (options.simulate) return options.simulate(call);
      // Odd calls are the discovery probe; even calls are the enforced run.
      if (call % 2 === 0 && options.enforced) return options.enforced(Math.floor(call / 2) - 1);
      return probeSuccess();
    },
    async sendTransaction() {
      sends += 1;
      if (options.send) return options.send();
      return { status: "PENDING", hash: "0".repeat(64) };
    },
    async getTransaction() {
      if (options.getTransaction) return options.getTransaction();
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42 };
    },
  } as unknown as rpc.Server & { simulationCount: number; sendCount: number };
  return mock;
}

function makeParams(
  server: rpc.Server,
  overrides: Partial<Parameters<typeof invoke>[0]> = {},
): Parameters<typeof invoke>[0] {
  return {
    server,
    source: Keypair.random(),
    call: transferCall(),
    networkPassphrase: PASSPHRASE,
    guardAuth: { guard: GUARD, agent: Keypair.random() },
    ...overrides,
  };
}

/** Recorder for onStep events. */
function recorder() {
  const events: InvokeStepEvent[] = [];
  return {
    events,
    callback(step: InvokeStepEvent) {
      events.push(step);
    },
  };
}

/**
 * Walk a broadcast-reaching invoke through the pipeline's poll sleeps under
 * mocked timers. `submitAndPoll` sleeps 3s before each poll, so ticking 3s at
 * a time fires exactly one poll per attempt; yielding between ticks lets the
 * pipeline's awaited RPC mock callbacks run, and the bounded loop ends as soon
 * as `invoke` has settled.
 */
async function drainWithMockedTimers(
  timers: { tick: (ms: number) => void },
  pending: Promise<unknown>,
): Promise<void> {
  const settled = () =>
    Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      Promise.resolve(false),
    ]);
  await Promise.resolve(); // let the pipeline reach its first timer
  for (let i = 0; i < 20; i++) {
    timers.tick(3_000);
    if (await settled()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The event sequence a fully successful, non-retried invoke must produce. */
const SUCCESSFUL_ATTEMPT: Array<[TraceStepName, InvokeStepEvent["status"]]> = [
  ["probe", "start"],
  ["probe", "ok"],
  ["sign", "start"],
  ["sign", "ok"],
  ["simulate", "start"],
  ["simulate", "ok"],
  ["broadcast", "start"],
  ["broadcast", "ok"],
];

describe("invoke() onStep: pipeline order", () => {
  it("emits start→ok for each stage in pipeline order on a successful invoke", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer();
    const { events, callback } = recorder();

    const pending = invoke(makeParams(server, { onStep: callback }));
    await drainWithMockedTimers(t.mock.timers, pending);
    const outcome = await pending;

    assert.equal(outcome.kind, "allowed");
    assert.deepEqual(
      events.map((event) => [event.name, event.status]),
      SUCCESSFUL_ATTEMPT,
    );
    assert.deepEqual(events.map((event) => event.attempt), [0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("emits no broadcast events on a dry run", async () => {
    const server = createMockServer();
    const { events, callback } = recorder();

    const outcome = await invoke(makeParams(server, { dryRun: true, onStep: callback }));

    assert.equal(outcome.kind, "error");
    assert.deepEqual(events.map((event) => [event.name, event.status]), [
      ["probe", "start"],
      ["probe", "ok"],
      ["sign", "start"],
      ["sign", "ok"],
      ["simulate", "start"],
      ["simulate", "ok"],
    ]);
  });

  it("emits a fail event for the simulate stage on a guard block, with no ok for it", async () => {
    const server = createMockServer({ enforced: () => blockedEnforcement() });
    const { events, callback } = recorder();

    const outcome = await invoke(makeParams(server, { onStep: callback }));

    assert.equal(outcome.kind, "blocked");
    const simulateEvents = events.filter((event) => event.name === "simulate");
    assert.deepEqual(
      simulateEvents.map((event) => event.status),
      ["start", "fail"],
    );
    // Nothing after the failed enforced simulation: no broadcast was attempted.
    assert.equal(events.at(-1)?.name, "simulate");
    assert.equal(events.at(-1)?.status, "fail");
    assert.equal(events.some((event) => event.name === "broadcast"), false);
  });

  it("reports failures that happen during the probe stage", async () => {
    const server = createMockServer({ simulate: () => ({ error: "HostError: trap" }) });
    const { events, callback } = recorder();

    const outcome = await invoke(makeParams(server, { onStep: callback }));

    assert.equal(outcome.kind, "error");
    const probeEvents = events.filter((event) => event.name === "probe");
    assert.deepEqual(
      probeEvents.map((event) => event.status),
      ["start", "fail"],
    );
    assert.equal(events.some((event) => event.name === "sign"), false);
  });
});

describe("invoke() onStep: durationMs", () => {
  it("is 0 on start and a finite non-negative number on ok/fail", async () => {
    const server = createMockServer({ enforced: () => blockedEnforcement() });
    const { events, callback } = recorder();

    await invoke(makeParams(server, { onStep: callback }));

    for (const event of events) {
      if (event.status === "start") {
        assert.equal(event.durationMs, 0, `${event.name} start must carry durationMs 0`);
      } else {
        assert.ok(
          Number.isFinite(event.durationMs) && event.durationMs >= 0,
          `${event.name} ${event.status} must carry a finite non-negative durationMs`,
        );
      }
    }
  });
});

describe("invoke() onStep: original error identity", () => {
  it("rethrows the exact error object a stage threw", async () => {
    const boom = new Error("rpc connection reset");
    const server = createMockServer({
      simulate: () => {
        throw boom;
      },
    });

    await assert.rejects(invoke(makeParams(server)), (error: unknown) => error === boom);
  });

  it("rethrows the original error when the fail callback also throws", async () => {
    const boom = new Error("rpc connection reset");
    const server = createMockServer({
      simulate: () => {
        throw boom;
      },
    });

    await assert.rejects(
      invoke(
        makeParams(server, {
          onStep: (step) => {
            if (step.status === "fail") throw new Error("callback exploded");
          },
        }),
      ),
      (error: unknown) => error === boom,
    );
  });
});

describe("invoke() onStep: callback exceptions are isolated", () => {
  it("does not turn a successful pipeline into a failure when onStep always throws", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer();

    const pending = invoke(
      makeParams(server, {
        onStep: () => {
          throw new Error("consumer bug");
        },
      }),
    );
    await drainWithMockedTimers(t.mock.timers, pending);
    const outcome = await pending;

    assert.equal(outcome.kind, "allowed");
    // The pipeline itself ran to completion regardless of the callback.
    assert.equal(server.simulationCount, 2);
  });

  it("emits every event anyway: the throwing callback is called for all stages", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer();
    let calls = 0;
    const pending = invoke(
      makeParams(server, {
        onStep: () => {
          calls += 1;
          throw new Error("consumer bug");
        },
      }),
    );
    await drainWithMockedTimers(t.mock.timers, pending);
    await pending;

    assert.equal(calls, SUCCESSFUL_ATTEMPT.length);
  });
});

describe("invoke() onStep: retries", () => {
  /** A post-inclusion stale-ledger resource rejection, from the recorded real failure. */
  const staleRejection = (): unknown => ({
    status: "FAILED",
    hash: "1".repeat(64),
    errorResult: null,
    resultXdr: "AAAAAAAAURj/////AAAAAQAAAAAAAAAY/////QAAAAA=",
    diagnosticEventsXdr: [
      {
        body: {
          v0: {
            topics: ["error", { type: "system", code: 5, value: "scecExceededLimit" }],
            data: ["operation byte-write resources exceeds amount specified", "724", "652"],
          },
        },
      },
    ],
  });

  function staleServer() {
    let sends = 0;
    return createMockServer({
      send: () => {
        sends += 1;
        // Every attempt is included, then rejected as stale.
        return { status: "PENDING", hash: `${sends}`.padStart(64, "0") };
      },
      getTransaction: staleRejection,
    });
  }

  it("emits per-attempt events with the attempt index on the stale-ledger retry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = staleServer();
    const { events, callback } = recorder();

    const pending = invoke(makeParams(server, { onStep: callback }));
    await drainWithMockedTimers(t.mock.timers, pending);
    const outcome = await pending;

    assert.equal(outcome.kind, "error");
    assert.match(outcome.kind === "error" ? outcome.detail : "", /retried after a stale-ledger/);

    // Every attempt runs the full pipeline; on this server every broadcast is
    // included and then rejected as stale, so both attempts end broadcast:fail
    // — and the retry (attempt 1) is exactly one more full pass, nothing else.
    const attemptEvents = (attempt: number) =>
      SUCCESSFUL_ATTEMPT.map(([name, status]) =>
        name === "broadcast" && status === "ok"
          ? `broadcast:fail:a${attempt}`
          : `${name}:${status}:a${attempt}`,
      );
    assert.deepEqual(
      events.map((event) => `${event.name}:${event.status}:a${event.attempt}`),
      [...attemptEvents(0), ...attemptEvents(1)],
    );
  });

  it("does not change the number of pipeline attempts (2 simulations per attempt, 2 attempts)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = staleServer();

    const pending = invoke(makeParams(server, { onStep: recorder().callback }));
    await drainWithMockedTimers(t.mock.timers, pending);
    await pending;

    // Exactly one retry: 2 simulations + 2 broadcasts per attempt pair.
    assert.equal(server.simulationCount, 4);
    assert.equal(server.sendCount, 2);
  });

  it("does not retry a broadcast failure that is not a stale-ledger rejection", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer({
      getTransaction: () => ({
        status: "FAILED",
        hash: "2".repeat(64),
        resultXdr: null,
        diagnosticEventsXdr: [],
      }),
    });
    const { events, callback } = recorder();

    const pending = invoke(makeParams(server, { onStep: callback }));
    await drainWithMockedTimers(t.mock.timers, pending);
    const outcome = await pending;

    assert.equal(outcome.kind, "error");
    assert.equal(server.simulationCount, 2);
    const attempts = new Set(events.map((event) => event.attempt));
    assert.deepEqual([...attempts].sort(), [0]);
  });
});

describe("invoke() without onStep: default behavior unchanged", () => {
  it("returns the same outcome with no callback supplied", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer();

    const pending = invoke(makeParams(server));
    await drainWithMockedTimers(t.mock.timers, pending);
    const outcome = await pending;

    assert.equal(outcome.kind, "allowed");
    if (outcome.kind === "allowed") {
      assert.equal(outcome.submission.status, "SUCCESS");
    }
  });

  it("still returns blocked verdicts with no callback supplied", async () => {
    const server = createMockServer({ enforced: () => blockedEnforcement() });

    const outcome = await invoke(makeParams(server));

    assert.equal(outcome.kind, "blocked");
    if (outcome.kind === "blocked") {
      assert.equal(outcome.reason, "per_tx_cap_exceeded");
    }
  });

  it("still rethrows stage errors with no callback supplied", async () => {
    const boom = new Error("rpc connection reset");
    const server = createMockServer({
      simulate: () => {
        throw boom;
      },
    });

    await assert.rejects(invoke(makeParams(server)), (error: unknown) => error === boom);
  });
});

describe("invoke() onStep: shared step vocabulary", () => {
  it("only ever emits step names from the shared TRACE_STEP_NAMES list", async () => {
    const server = createMockServer({ enforced: () => blockedEnforcement() });
    const { events, callback } = recorder();

    await invoke(makeParams(server, { onStep: callback }));

    // Drift detection: a stage added to the pipeline without extending the
    // shared vocabulary (or a hand-rolled name) fails here, because the type
    // alone would silently accept a second list.
    const seen = new Set(events.map((event) => event.name));
    for (const name of seen) {
      assert.ok(
        (TRACE_STEP_NAMES as readonly string[]).includes(name),
        `step '${name}' is not part of the shared trace vocabulary`,
      );
    }
    // And the vocabulary covers exactly the stages the pipeline can emit.
    assert.deepEqual([...TRACE_STEP_NAMES].sort(), ["broadcast", "probe", "sign", "simulate"]);
  });
});
