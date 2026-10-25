/**
 * A small FIFO counting semaphore with abortable waits.
 *
 * Internal to the SDK (not exported from the package entry point): it exists so
 * `PreFlightInterceptor` can bound how many simulations are in flight at once.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<{ grant: () => void; cancelled: boolean }> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`semaphore limit must be a positive integer, received ${limit}`);
    }
    this.available = limit;
  }

  /** Slots currently held. */
  get inFlight(): number {
    return this.limit - this.available;
  }

  /** Callers waiting for a slot. */
  get queued(): number {
    return this.waiters.filter((waiter) => !waiter.cancelled).length;
  }

  /**
   * Wait for a slot and resolve with its release function (idempotent).
   *
   * If `signal` aborts while queued, the waiter is withdrawn and the promise
   * resolves with `null`: it never takes a slot, so an abandoned caller cannot
   * consume capacity later.
   */
  acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      const waiter = {
        cancelled: false,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(this.releaser());
        },
      };
      const onAbort = () => {
        waiter.cancelled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.grant();
      else this.available += 1;
    };
  }
}
