/**
 * Unit tests for `waitForTransaction()` (issue #416).
 *
 * The helper exists so a `pending` outcome from `invoke()` can be resolved
 * without hand-rolled polling. These tests pin the four result arms and the
 * synchronous-input contract, using `FakeClock` so no test waits on real time.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Buffer } from "node:buffer";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { FakeClock } from "../../src/clock.ts";
import { InvalidInputError } from "../../src/errors.ts";
import { waitForTransaction, type WaitForTransactionResult } from "../../src/tx.ts";

const HASH = "ab".repeat(32);

function mockServer(status: () => unknown) {
  let polls = 0;
  const server = {
    get polls() {
      return polls;
    },
    async getTransaction() {
      polls += 1;
      return status();
    },
  } as unknown as rpc.Server & { polls: number };
  return server;
}

/**
 * Advance a FakeClock until the wait settles. The wait always registers a
 * bounded sleep, so ticking its poll interval is enough to drive it forward;
 * the microtask yield lets the loop register the next sleep after each tick.
 */
async function advanceUntilSettled(
  clock: FakeClock,
  pending: Promise<WaitForTransactionResult>,
  stepMs: number,
): Promise<WaitForTransactionResult> {
  let result: WaitForTransactionResult | undefined;
  // Track settlement with a flag: racing the promise directly against an
  // already-resolved promise would let the resolved one win every time.
  const tracked = pending.then((value) => {
    result = value;
  });
  for (let i = 0; i < 100; i++) {
    await Promise.race([tracked, new Promise((resolve) => setImmediate(resolve))]);
    if (result !== undefined) return result;
    clock.advance(stepMs);
  }
  throw new Error("waitForTransaction did not settle");
}

describe("waitForTransaction()", () => {
  it("returns confirmed with the ledger and contract events on SUCCESS", async () => {
    const server = mockServer(() => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 512,
      events: { contractEventsXdr: [xdr.ScVal.scvVoid()] },
    }));
    const result = await waitForTransaction({
      server,
      hash: HASH,
      timeoutMs: 1_000,
      clock: new FakeClock(),
    });

    assert.equal(result.kind, "confirmed");
    if (result.kind !== "confirmed") throw new Error("unreachable");
    assert.equal(result.hash, HASH);
    assert.equal(result.ledger, 512);
    assert.equal(result.events.length, 1);
    assert.equal(server.polls, 1);
  });

  it("returns failed, with the failure evidence, on a post-inclusion rejection", async () => {
    const server = mockServer(() => ({
      status: rpc.Api.GetTransactionStatus.FAILED,
      ledger: 513,
      resultXdr: "AAAAAA==",
      diagnosticEventsXdr: ["tx_bad_seq"],
    }));
    const result = await waitForTransaction({ server, hash: HASH, clock: new FakeClock() });

    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    assert.equal(result.ledger, 513);
    assert.equal(result.resultXdr, "AAAAAA==");
    assert.deepEqual(result.diagnosticEvents, ["tx_bad_seq"]);
    assert.match(result.detail, /failed after inclusion/);
  });

  it("returns pending (never throws) when the timeout elapses", async () => {
    const clock = new FakeClock(0);
    const server = mockServer(() => ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND }));

    const result = await advanceUntilSettled(
      clock,
      waitForTransaction({ server, hash: HASH, timeoutMs: 100, pollIntervalMs: 40, clock }),
      40,
    );

    assert.equal(result.kind, "pending");
    if (result.kind !== "pending") throw new Error("unreachable");
    assert.equal(result.reason, "timeout");
    assert.equal(result.hash, HASH);
    assert.match(result.detail, /not confirmed within 100ms/);
  });

  it("returns undetermined with the cause when the RPC call fails", async () => {
    const cause = new Error("rpc unavailable");
    const server = mockServer(() => {
      throw cause;
    });

    const result = await waitForTransaction({ server, hash: HASH, clock: new FakeClock() });

    assert.equal(result.kind, "undetermined");
    if (result.kind !== "undetermined") throw new Error("unreachable");
    assert.equal(result.cause, cause);
    assert.match(result.detail, /could not read transaction/);
  });

  it("ends promptly when the signal aborts mid-wait", async () => {
    const clock = new FakeClock(0);
    const server = mockServer(() => ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND }));
    const controller = new AbortController();

    const pending = waitForTransaction({
      server,
      hash: HASH,
      timeoutMs: 10_000,
      pollIntervalMs: 1_000,
      signal: controller.signal,
      clock,
    });
    // Let the first poll run and the wait settle into its poll sleep.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    const result = await pending;
    assert.equal(result.kind, "pending");
    if (result.kind !== "pending") throw new Error("unreachable");
    assert.equal(result.reason, "aborted");
  });

  it("returns immediately for an already-aborted signal without polling", async () => {
    const server = mockServer(() => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }));
    const result = await waitForTransaction({
      server,
      hash: HASH,
      signal: AbortSignal.abort(),
      clock: new FakeClock(),
    });

    assert.equal(result.kind, "pending");
    assert.equal(server.polls, 0);
  });

  it("throws only on invalid input, before any RPC", async () => {
    const server = mockServer(() => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }));

    await assert.rejects(
      waitForTransaction({ server, hash: "not-a-hash" }),
      (error: unknown) => error instanceof InvalidInputError && error.field === "hash",
    );
    await assert.rejects(
      waitForTransaction({ server, hash: HASH, timeoutMs: 0 }),
      (error: unknown) => error instanceof InvalidInputError && error.field === "timeoutMs",
    );
    await assert.rejects(
      waitForTransaction({ server, hash: HASH, pollIntervalMs: -1 }),
      (error: unknown) => error instanceof InvalidInputError && error.field === "pollIntervalMs",
    );
    await assert.rejects(
      waitForTransaction({ server: {} as rpc.Server, hash: HASH }),
      (error: unknown) => error instanceof InvalidInputError && error.field === "server",
    );
    assert.equal(server.polls, 0);
  });

  it("accepts an uppercase hash (hash shape, not casing, is what is validated)", async () => {
    const server = mockServer(() => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 1,
    }));
    const result = await waitForTransaction({
      server,
      hash: Buffer.from(HASH, "hex").toString("hex").toUpperCase(),
      clock: new FakeClock(),
    });
    assert.equal(result.kind, "confirmed");
  });
});
