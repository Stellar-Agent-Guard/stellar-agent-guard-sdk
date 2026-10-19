/**
 * Unit tests for the heartbeat scheduler (issue #120).
 *
 * Time is injected (`now` / `wait`), never the wall clock: the scheduler is
 * driven by a controllable fake so "three beats" is exact rather than flaky.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  HeartbeatIntervalError,
  startHeartbeat,
  type HeartbeatBeat,
  type HeartbeatOptions,
} from "../../src/heartbeat.ts";
import type { PolicyConfig } from "../../src/policy.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A deterministic clock. `wait` registers a deadline; `tick` resolves the
 * earliest pending wait, advancing time to its deadline. It honours the abort
 * signal so a mid-wait `stop()` wakes the loop instead of deadlocking it.
 */
function fakeClock() {
  let t = 0;
  const waiters: Array<{ deadline: number; resolve: () => void }> = [];
  const now = () => t;
  const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const entry = {
        deadline: t + Math.max(0, ms),
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(entry);
    });
  return {
    now,
    wait,
    get time() {
      return t;
    },
    get pending() {
      return waiters.length;
    },
    advanceTo(value: number) {
      t = value;
    },
    /** Resolve the earliest pending wait, advancing time to its deadline. */
    async tick(): Promise<void> {
      if (waiters.length === 0) {
        await flush();
        return;
      }
      waiters.sort((a, b) => a.deadline - b.deadline);
      const next = waiters.shift()!;
      t = Math.max(t, next.deadline);
      next.resolve();
      await flush();
    },
  };
}

function baseOptions(overrides: Partial<HeartbeatOptions> = {}): HeartbeatOptions {
  const clock = fakeClock();
  return {
    guard: GUARD,
    signer: Keypair.random(),
    intervalMs: 1000,
    now: clock.now,
    wait: clock.wait,
    submit: async () => ({}),
    ...overrides,
  };
}

describe("startHeartbeat", () => {
  it("fires three beats deterministically on the injected clock", async () => {
    const clock = fakeClock();
    const beats: HeartbeatBeat[] = [];
    let submissions = 0;

    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        submit: async () => {
          submissions += 1;
          return {};
        },
        onBeat: (beat) => beats.push(beat),
      }),
    );

    assert.equal(submissions, 0, "nothing beats before the loop is driven");
    await clock.tick();
    assert.equal(submissions, 1, "the first beat fires immediately");
    await clock.tick();
    assert.equal(submissions, 2);
    await clock.tick();
    assert.equal(submissions, 3);

    assert.deepEqual(
      beats.map((beat) => beat.at),
      [0, 1000, 2000],
    );
    assert.equal(handle.lastBeatAt, 2000);
    await handle.stop();
  });

  it("stops cleanly and never submits after stop(), even mid-flight", async () => {
    const clock = fakeClock();
    let submissions = 0;
    let release: (() => void) | null = null;

    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        submit: () => {
          submissions += 1;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      }),
    );

    await clock.tick(); // first beat starts and stays in flight
    assert.equal(submissions, 1);

    const stopping = handle.stop(); // stop arrives while the beat is in flight
    release!();
    await stopping;

    assert.equal(handle.stopped, true);
    assert.equal(submissions, 1, "no submission may follow stop()");

    // Even if time keeps moving, the loop is gone.
    await clock.tick();
    await clock.tick();
    assert.equal(submissions, 1);
  });

  it("is stopped immediately when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const handle = await startHeartbeat(baseOptions({ signal: controller.signal }));
    assert.equal(handle.stopped, true);
    assert.equal(handle.lastBeatAt, null);
    await handle.stop();
  });

  it("stops when the abort signal fires", async () => {
    const controller = new AbortController();
    let submissions = 0;
    await startHeartbeat(
      baseOptions({
        signal: controller.signal,
        submit: async () => {
          submissions += 1;
          return {};
        },
      }),
    );
    controller.abort();
    await flush();
    await flush();
    const before = submissions;
    await flush();
    assert.equal(submissions, before, "no beats after abort");
  });

  it("counts and reports lateness beyond maxSkewMs", async () => {
    const clock = fakeClock();
    const beats: HeartbeatBeat[] = [];

    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        maxSkewMs: 100,
        onBeat: (beat) => beats.push(beat),
      }),
    );

    await clock.tick(); // first beat on time (deadline 0)
    assert.equal(beats[0]!.lateMs, 0);
    assert.equal(handle.missedBeats, 0);

    // The second beat is due at t=1000, but the clock has stalled to 5000.
    clock.advanceTo(5000);
    await clock.tick();

    assert.equal(beats[1]!.at, 5000);
    assert.equal(beats[1]!.lateMs, 4000);
    assert.equal(handle.missedBeats, 1, "a beat past maxSkewMs counts as missed");

    await handle.stop();
  });

  it("routes submission failures to onError instead of an unhandled rejection", async () => {
    const clock = fakeClock();
    const errors: unknown[] = [];

    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        submit: async () => {
          throw new Error("rpc down");
        },
        onError: (error) => errors.push(error),
      }),
    );

    await clock.tick();
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, "rpc down");
    assert.equal(handle.lastBeatAt, null, "a failed beat is not a beat");

    await handle.stop();
  });

  it("skips a duplicate beat within the same wall-clock second", async () => {
    const clock = fakeClock();
    let submissions = 0;

    const handle = await startHeartbeat(
      baseOptions({
        intervalMs: 400,
        now: clock.now,
        wait: clock.wait,
        submit: async () => {
          submissions += 1;
          return {};
        },
      }),
    );

    await clock.tick(); // t=0  → beat (second 0)
    assert.equal(submissions, 1);
    await clock.tick(); // t=400 → skipped (still second 0)
    assert.equal(submissions, 1);
    await clock.tick(); // t=800 → skipped (still second 0)
    assert.equal(submissions, 1);
    await clock.tick(); // t=1200 → beat (second 1)
    assert.equal(submissions, 2);

    await handle.stop();
  });

  it("passes a caller-supplied ledger through to onBeat", async () => {
    const clock = fakeClock();
    const beats: HeartbeatBeat[] = [];
    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        submit: async () => ({ ledger: 4_700_123 }),
        onBeat: (beat) => beats.push(beat),
      }),
    );
    await clock.tick();
    assert.equal(beats[0]!.ledger, 4_700_123);
    await handle.stop();
  });

  it("rejects a non-positive interval", async () => {
    await assert.rejects(
      startHeartbeat(baseOptions({ intervalMs: 0 })),
      RangeError,
    );
  });

  it("reports the default-submission misconfiguration through onError", async () => {
    const clock = fakeClock();
    const errors: unknown[] = [];
    // No `submit` and no `server`: the default submission cannot run, and the
    // failure must surface via onError rather than as a rejection.
    const handle = await startHeartbeat({
      guard: GUARD,
      signer: Keypair.random(),
      intervalMs: 1000,
      now: clock.now,
      wait: clock.wait,
      onError: (error) => errors.push(error),
    });
    await clock.tick();
    assert.equal(errors.length, 1);
    assert.match(String((errors[0] as Error).message), /needs `server`/);
    await handle.stop();
  });
});

describe("startHeartbeat grace validation", () => {
  it("throws before starting when the interval exceeds grace/3", async () => {
    await assert.rejects(
      startHeartbeat(baseOptions({ intervalMs: 20_000, graceSecs: 30 })),
      HeartbeatIntervalError,
    );
  });

  it("accepts an interval within grace/3", async () => {
    const handle = await startHeartbeat(baseOptions({ intervalMs: 5_000, graceSecs: 30 }));
    await handle.stop();
  });

  it("validates against a policy read from the chain", async () => {
    const policy = { dms_grace_secs: 30n } as PolicyConfig;
    await assert.rejects(
      startHeartbeat(
        baseOptions({ intervalMs: 20_000, readPolicy: async () => policy }),
      ),
      HeartbeatIntervalError,
    );
  });

  it("warns and starts when the policy is unreadable", async () => {
    const warnings: string[] = [];
    const handle = await startHeartbeat(
      baseOptions({
        intervalMs: 20_000,
        readPolicy: async () => null,
        onWarning: (message) => warnings.push(message),
      }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /interval <= grace\/3 check/);
    await handle.stop();
  });

  it("warns and starts when the policy read rejects", async () => {
    const warnings: string[] = [];
    const handle = await startHeartbeat(
      baseOptions({
        intervalMs: 20_000,
        readPolicy: async () => {
          throw new Error("rpc unavailable");
        },
        onWarning: (message) => warnings.push(message),
      }),
    );
    assert.equal(warnings.length, 1);
    await handle.stop();
  });

  it("does not constrain the interval when the dead-man switch is off", async () => {
    // dms_grace_secs == 0 disables the switch, so any interval is safe.
    const policy = { dms_grace_secs: 0n } as PolicyConfig;
    const handle = await startHeartbeat(
      baseOptions({ intervalMs: 20_000, readPolicy: async () => policy }),
    );
    await handle.stop();
  });
});
