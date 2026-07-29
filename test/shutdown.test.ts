import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger';
import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  createShutdownHandler,
  type ClosableServer,
  type ShutdownDeps,
} from '../src/shutdown';
import type { Db } from '../src/types';

interface Harness {
  deps: ShutdownDeps;
  order: string[];
  lines: Record<string, unknown>[];
  exitCodes: number[];
}

interface HarnessOptions {
  serverClose?: (callback: (err?: Error) => void) => void;
  pollerStop?: () => void;
  dbClose?: () => void;
  graceMs?: number;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const order: string[] = [];
  const lines: Record<string, unknown>[] = [];
  const exitCodes: number[] = [];

  const logger = createLogger(
    { logLevel: 'trace' },
    {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      },
    },
  );

  const server: ClosableServer = {
    close(callback?: (err?: Error) => void) {
      order.push('server.close');
      const cb = callback ?? ((): void => undefined);
      if (options.serverClose) options.serverClose(cb);
      else cb();
      return server;
    },
    closeIdleConnections() {
      order.push('server.closeIdleConnections');
    },
  };

  const db = {
    close() {
      order.push('db.close');
      options.dbClose?.();
    },
  } as unknown as Db;

  const timer = setInterval(() => undefined, 60_000);
  timer.unref();

  const deps: ShutdownDeps = {
    server,
    poller: {
      stop() {
        order.push('poller.stop');
        options.pollerStop?.();
      },
    },
    cleanupTimer: timer,
    db,
    logger,
    exit(code) {
      exitCodes.push(code);
    },
  };
  if (options.graceMs !== undefined) deps.graceMs = options.graceMs;

  return { deps, order, lines, exitCodes };
}

/** Records the call while still clearing for real, so no interval outlives the test. */
function spyOnClearInterval(order: string[]): ReturnType<typeof vi.spyOn> {
  const real = globalThis.clearInterval;
  return vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
    timer: NodeJS.Timeout,
  ) => {
    order.push('clearInterval');
    real(timer);
  }) as typeof clearInterval);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createShutdownHandler', () => {
  it('runs every step in the specified order and exits 0', async () => {
    const { deps, order, lines, exitCodes } = makeHarness();
    const clearIntervalSpy = spyOnClearInterval(order);

    await createShutdownHandler(deps)('SIGTERM');

    expect(
      order.filter((step) => step !== 'server.closeIdleConnections'),
    ).toEqual(['server.close', 'poller.stop', 'clearInterval', 'db.close']);
    expect(clearIntervalSpy).toHaveBeenCalledWith(deps.cleanupTimer);
    expect(exitCodes).toEqual([0]);

    const completed = lines.filter((line) => line.msg === 'shutdown complete');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      level: 'info',
      component: 'lifecycle',
      signal: 'SIGTERM',
    });
    expect(typeof completed[0]?.durationMs).toBe('number');
  });

  it('closes idle connections so a keep-alive socket cannot hold the close open', async () => {
    const { deps, order } = makeHarness();

    await createShutdownHandler(deps)('SIGTERM');

    expect(order).toContain('server.closeIdleConnections');
  });

  it('works when the server does not expose closeIdleConnections', async () => {
    const { deps, order, exitCodes } = makeHarness();
    deps.server = {
      close(callback) {
        order.push('server.close');
        callback?.();
      },
    };

    await createShutdownHandler(deps)('SIGTERM');

    expect(order).not.toContain('server.closeIdleConnections');
    expect(order).toEqual(['server.close', 'poller.stop', 'db.close']);
    expect(exitCodes).toEqual([0]);
  });

  it('ignores a second signal instead of running the sequence twice', async () => {
    const { deps, order, lines, exitCodes } = makeHarness();
    const shutdown = createShutdownHandler(deps);

    await shutdown('SIGTERM');
    await shutdown('SIGINT');

    expect(order.filter((step) => step === 'db.close')).toHaveLength(1);
    expect(exitCodes).toEqual([0]);
    expect(
      lines.filter(
        (line) => line.msg === 'shutdown already in progress, ignoring signal',
      ),
    ).toMatchObject([{ level: 'warn', signal: 'SIGINT' }]);
  });

  it('ignores a second signal that arrives while the first is still draining', async () => {
    let release: (() => void) | undefined;
    const { deps, order } = makeHarness({
      serverClose: (callback) => {
        release = callback;
      },
    });
    const shutdown = createShutdownHandler(deps);

    const first = shutdown('SIGTERM');
    await shutdown('SIGINT');
    expect(order).toEqual(['server.close', 'server.closeIdleConnections']);

    release?.();
    await first;

    expect(order.filter((step) => step === 'server.close')).toHaveLength(1);
    expect(order).toContain('db.close');
  });

  it('continues through the remaining steps when server.close throws', async () => {
    const { deps, order, lines, exitCodes } = makeHarness({
      serverClose: () => {
        throw new Error('close exploded');
      },
    });

    await createShutdownHandler(deps)('SIGTERM');

    expect(order).toEqual(['server.close', 'poller.stop', 'db.close']);
    expect(exitCodes).toEqual([0]);
    expect(lines.find((line) => line.msg === 'shutdown step failed')).toMatchObject(
      { level: 'error', step: 'server.close' },
    );
  });

  it('continues through the remaining steps when poller.stop and db.close throw', async () => {
    const { deps, order, lines, exitCodes } = makeHarness({
      pollerStop: () => {
        throw new Error('stop exploded');
      },
      dbClose: () => {
        throw new Error('close exploded');
      },
    });

    await createShutdownHandler(deps)('SIGTERM');

    expect(order).toEqual([
      'server.close',
      'server.closeIdleConnections',
      'poller.stop',
      'db.close',
    ]);
    expect(exitCodes).toEqual([0]);
    expect(
      lines
        .filter((line) => line.msg === 'shutdown step failed')
        .map((line) => line.step),
    ).toEqual(['poller.stop', 'db.close']);
  });

  it('is unaffected by a server that invokes its close callback more than once', async () => {
    const { deps, order, exitCodes } = makeHarness({
      serverClose: (callback) => {
        callback();
        callback();
      },
    });

    await createShutdownHandler(deps)('SIGTERM');

    expect(order.filter((step) => step === 'db.close')).toHaveLength(1);
    expect(exitCodes).toEqual([0]);
  });

  it('gives up waiting on the server after the grace period', async () => {
    const { deps, order, exitCodes } = makeHarness({
      graceMs: 20,
      serverClose: () => {
        // never calls back — a connection that will not drain
      },
    });

    const startedAt = Date.now();
    await createShutdownHandler(deps)('SIGTERM');

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
    expect(order).toContain('db.close');
    expect(exitCodes).toEqual([0]);
  });

  it('defaults to process.exit and the documented grace period', async () => {
    const { deps, order } = makeHarness();
    delete deps.exit;
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await createShutdownHandler(deps)('SIGTERM');

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(order).toContain('db.close');
    expect(DEFAULT_SHUTDOWN_GRACE_MS).toBe(10_000);
  });
});
