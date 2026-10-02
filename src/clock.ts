/**
 * Clock abstraction for deterministic time control in testing.
 *
 * The Clock interface provides a minimal time abstraction:
 * - now(): Current time in milliseconds (compatible with Date.now())
 * - sleep(ms): Non-blocking delay, returns a promise
 *
 * This allows tests to inject a FakeClock for deterministic timing without
 * real wall-clock delays, making tests fast, reliable, and reproducible.
 *
 * Rationale:
 * Multiple modules (preflight cache TTLs, transaction polling, telemetry
 * intervals) depend on time. Without a centralized Clock abstraction, each
 * module invented its own time source (Date.now(), setTimeout, etc.),
 * forcing tests to use real sleeps (slow/flaky) or ad-hoc mocks. A Clock
 * interface threads a testable time source through all time-dependent logic.
 *
 * @example
 * ```ts
 * import { FakeClock, systemClock } from "stellar-agent-guard-sdk";
 *
 * // Production: no clock is injected, so the system clock is the default.
 * systemClock.now(); // real time
 *
 * // Tests: a FakeClock makes time-dependent code deterministic.
 * const clock = new FakeClock(0);
 * clock.advance(5_000); // one approximate ledger window later — instantly
 * console.log(clock.now()); // 5000
 * ```
 */

/** Minimal abstraction for time-dependent operations. */
export interface Clock {
  /** Current time in milliseconds (compatible with Date.now()). */
  now(): number;

  /** Non-blocking delay; returns a promise that resolves after ms milliseconds. */
  sleep(ms: number): Promise<void>;
}

/**
 * System clock: reads real time via Date.now() and delays via setTimeout.
 * Used by default when no clock is injected.
 */
export const systemClock: Clock = {
  now(): number {
    return Date.now();
  },

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

/**
 * Fake clock for deterministic testing.
 *
 * Allows tests to:
 * - Specify the initial time (default: 0)
 * - Advance time synchronously via .advance(ms)
 * - Control all time-dependent operations without real delays
 *
 * @example
 * ```ts
 * import { FakeClock } from "stellar-agent-guard-sdk";
 *
 * const clock = new FakeClock(1000); // start at t=1000ms
 * let settled = false;
 * const pending = clock.sleep(5000).then(() => { settled = true; });
 *
 * clock.advance(4999); // t=5999ms — one millisecond short of the due time
 * await Promise.resolve(); // flush microtasks
 * console.log(settled); // false — nothing settles before its due time
 *
 * clock.advance(1); // t=6000ms — the sleep is due
 * await pending; // settles now, with zero waiting in real time
 * console.log(clock.now()); // 6000
 * ```
 */
export class FakeClock implements Clock {
  private currentTime: number;
  private sleepQueue: Array<{ resolveAt: number; resolve: () => void }> = [];

  constructor(initialTimeMs: number = 0) {
    this.currentTime = initialTimeMs;
  }

  now(): number {
    return this.currentTime;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const resolveAt = this.currentTime + ms;
      this.sleepQueue.push({ resolveAt, resolve });
      // Sort to ensure we resolve in time order
      this.sleepQueue.sort((a, b) => a.resolveAt - b.resolveAt);
      // Immediately resolve any sleeps that should have finished
      this.resolvePendingSleeps();
    });
  }

  /**
   * Advance the fake clock by the given number of milliseconds.
   * Resolves all pending sleep promises that should complete by the new time.
   */
  advance(ms: number): void {
    this.currentTime += ms;
    this.resolvePendingSleeps();
  }

  /** Set the clock to an absolute time (in milliseconds). */
  setTime(timeMs: number): void {
    this.currentTime = timeMs;
    this.resolvePendingSleeps();
  }

  private resolvePendingSleeps(): void {
    // Drain all sleeps that should have completed by now
    const resolved: typeof this.sleepQueue = [];
    const remaining: typeof this.sleepQueue = [];

    for (const item of this.sleepQueue) {
      if (item.resolveAt <= this.currentTime) {
        resolved.push(item);
      } else {
        remaining.push(item);
      }
    }

    this.sleepQueue = remaining;

    // Resolve all completed sleeps
    for (const { resolve } of resolved) {
      resolve();
    }
  }
}
