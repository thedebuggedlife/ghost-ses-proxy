/**
 * FIFO concurrency limiter.
 *
 * `runExclusive` is the only supported entry point for callers: its `try/finally`
 * is the D1 fix, releasing the slot even when the callback throws before it ever
 * reaches the SES call.
 */
export class Semaphore {
  readonly max: number;

  private current = 0;

  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
  }

  /** Slots currently held. */
  get inFlight(): number {
    return this.current;
  }

  /** Callers waiting for a slot. */
  get queueDepth(): number {
    return this.waiters.length;
  }

  acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    this.current--;
    const next = this.waiters.shift();
    if (next) {
      this.current++;
      next();
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
