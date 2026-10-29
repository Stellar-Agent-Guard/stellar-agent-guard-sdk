import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Semaphore } from "../../src/semaphore.ts";

describe("Semaphore", () => {
  it("rejects a non-positive or fractional limit", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => new Semaphore(bad), RangeError);
  });

  it("grants up to the limit, then queues first-in first-out", async () => {
    const semaphore = new Semaphore(2);
    const a = await semaphore.acquire();
    const b = await semaphore.acquire();
    assert.equal(semaphore.inFlight, 2);
    const order: string[] = [];
    const c = semaphore.acquire().then((release) => (order.push("c"), release));
    const d = semaphore.acquire().then((release) => (order.push("d"), release));
    await Promise.resolve();
    assert.equal(semaphore.queued, 2);
    a!();
    (await c)!();
    b!();
    (await d)!();
    assert.deepEqual(order, ["c", "d"]);
    assert.equal(semaphore.inFlight, 0);
  });

  it("release is idempotent", async () => {
    const semaphore = new Semaphore(1);
    const release = (await semaphore.acquire())!;
    release();
    release();
    assert.equal(semaphore.inFlight, 0);
    const first = await semaphore.acquire();
    assert.equal(semaphore.inFlight, 1);
    first!();
  });

  it("withdraws an aborted waiter without consuming a slot", async () => {
    const semaphore = new Semaphore(1);
    const held = (await semaphore.acquire())!;
    const controller = new AbortController();
    const waiting = semaphore.acquire(controller.signal);
    controller.abort();
    assert.equal(await waiting, null);
    assert.equal(semaphore.queued, 0);
    held();
    assert.equal(semaphore.inFlight, 0);
    assert.equal(await semaphore.acquire(AbortSignal.abort()), null);
  });
});
