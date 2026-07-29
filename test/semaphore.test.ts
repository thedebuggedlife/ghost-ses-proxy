import { describe, expect, it } from 'vitest';
import { Semaphore } from '../src/semaphore';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe('Semaphore', () => {
  it('exposes max and starts empty', () => {
    const s = new Semaphore(3);
    expect(s.max).toBe(3);
    expect(s.inFlight).toBe(0);
    expect(s.queueDepth).toBe(0);
  });

  it('resolves acquire immediately while below max', async () => {
    const s = new Semaphore(2);
    await s.acquire();
    expect(s.inFlight).toBe(1);
    await s.acquire();
    expect(s.inFlight).toBe(2);
    expect(s.queueDepth).toBe(0);
  });

  it('queues acquires beyond max', async () => {
    const s = new Semaphore(1);
    await s.acquire();
    let granted = false;
    const queued = s.acquire().then(() => {
      granted = true;
    });

    await flush();
    expect(granted).toBe(false);
    expect(s.inFlight).toBe(1);
    expect(s.queueDepth).toBe(1);

    s.release();
    await queued;
    expect(granted).toBe(true);
    expect(s.inFlight).toBe(1);
    expect(s.queueDepth).toBe(0);
  });

  it('hands a released slot to waiters in FIFO order', async () => {
    const s = new Semaphore(1);
    await s.acquire();

    const order: number[] = [];
    const first = s.acquire().then(() => order.push(1));
    const second = s.acquire().then(() => order.push(2));
    const third = s.acquire().then(() => order.push(3));
    expect(s.queueDepth).toBe(3);

    s.release();
    await first;
    s.release();
    await second;
    s.release();
    await third;
    s.release();

    expect(order).toEqual([1, 2, 3]);
    expect(s.inFlight).toBe(0);
    expect(s.queueDepth).toBe(0);
  });

  it('drops inFlight back to zero when a released slot has no waiter', async () => {
    const s = new Semaphore(2);
    await s.acquire();
    s.release();
    expect(s.inFlight).toBe(0);
  });

  it('caps concurrency at max across a burst', async () => {
    const s = new Semaphore(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let concurrent = 0;
    let peak = 0;

    const runs = gates.map((gate) =>
      s.runExclusive(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await gate.promise;
        concurrent--;
      }),
    );

    await flush();
    expect(s.inFlight).toBe(2);
    expect(s.queueDepth).toBe(2);

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);

    expect(peak).toBe(2);
    expect(s.inFlight).toBe(0);
    expect(s.queueDepth).toBe(0);
  });

  it('runExclusive returns the callback value and releases on resolve', async () => {
    const s = new Semaphore(1);
    await expect(s.runExclusive(async () => 'value')).resolves.toBe('value');
    expect(s.inFlight).toBe(0);
    expect(s.queueDepth).toBe(0);
  });

  it('runs queued callbacks in FIFO order', async () => {
    const s = new Semaphore(1);
    const order: number[] = [];
    const gate = deferred();

    const runs = [
      s.runExclusive(async () => {
        order.push(0);
        await gate.promise;
      }),
      s.runExclusive(async () => {
        order.push(1);
      }),
      s.runExclusive(async () => {
        order.push(2);
      }),
    ];

    await flush();
    expect(order).toEqual([0]);
    gate.resolve();
    await Promise.all(runs);

    expect(order).toEqual([0, 1, 2]);
  });

  it('releases the slot when the callback rejects (D1 regression)', async () => {
    const s = new Semaphore(1);

    await expect(
      s.runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(s.inFlight).toBe(0);
    expect(s.queueDepth).toBe(0);
    await expect(s.runExclusive(async () => 'still works')).resolves.toBe(
      'still works',
    );
  });

  it('releases the slot when the callback throws synchronously (D1 regression)', async () => {
    const s = new Semaphore(1);

    await expect(
      s.runExclusive((): Promise<never> => {
        throw new Error('sync boom');
      }),
    ).rejects.toThrow('sync boom');

    expect(s.inFlight).toBe(0);
    await expect(s.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it('does not wedge after max consecutive failures (D1 regression)', async () => {
    const max = 3;
    const s = new Semaphore(max);

    for (let i = 0; i < max; i++) {
      await expect(
        s.runExclusive(async () => {
          throw new Error('failure ' + String(i));
        }),
      ).rejects.toThrow('failure ' + String(i));
    }

    expect(s.inFlight).toBe(0);

    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => s.runExclusive(async () => n)),
    );
    expect(results).toEqual([1, 2, 3, 4]);
    expect(s.inFlight).toBe(0);
    expect(s.queueDepth).toBe(0);
  });

  it('hands the slot to a waiter even when the holder throws', async () => {
    const s = new Semaphore(1);
    const gate = deferred();
    const order: string[] = [];

    const failing = s.runExclusive(async () => {
      order.push('failing');
      await gate.promise;
      throw new Error('nope');
    });
    const queued = s.runExclusive(async () => {
      order.push('queued');
    });

    await flush();
    expect(s.queueDepth).toBe(1);

    gate.resolve();
    await expect(failing).rejects.toThrow('nope');
    await queued;

    expect(order).toEqual(['failing', 'queued']);
    expect(s.inFlight).toBe(0);
  });
});
