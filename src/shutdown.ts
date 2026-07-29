import type { Logger } from 'pino';
import type { Db } from './types';

export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

/** The slice of `http.Server` the shutdown sequence uses. */
export interface ClosableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?: () => void;
}

export interface StoppablePoller {
  stop(): void;
}

export interface ShutdownDeps {
  server: ClosableServer;
  poller: StoppablePoller;
  cleanupTimer: NodeJS.Timeout;
  db: Db;
  logger: Logger;
  graceMs?: number;
  exit?: (code: number) => void;
}

export type ShutdownHandler = (signal: string) => Promise<void>;

/**
 * Resolves when the server has drained, or after `graceMs` — a keep-alive
 * connection would otherwise hold the close callback open indefinitely.
 */
function closeServer(server: ClosableServer, graceMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;

    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(done, graceMs);
    timer.unref();

    server.close(() => {
      done();
    });
    server.closeIdleConnections?.();
  });
}

export function createShutdownHandler(deps: ShutdownDeps): ShutdownHandler {
  const { server, poller, cleanupTimer, db } = deps;
  const graceMs = deps.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const exit = deps.exit ?? ((code: number): void => void process.exit(code));
  const log = deps.logger.child({ component: 'lifecycle' });

  let inProgress = false;

  const attempt = async (step: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      log.error({ err, step }, 'shutdown step failed');
    }
  };

  return async function shutdown(signal: string): Promise<void> {
    if (inProgress) {
      log.warn({ signal }, 'shutdown already in progress, ignoring signal');
      return;
    }
    inProgress = true;
    const startedAt = Date.now();

    await attempt('server.close', () => closeServer(server, graceMs));
    await attempt('poller.stop', () => {
      poller.stop();
    });
    await attempt('clearInterval', () => {
      clearInterval(cleanupTimer);
    });
    await attempt('db.close', () => {
      db.close();
    });

    log.info({ signal, durationMs: Date.now() - startedAt }, 'shutdown complete');
    exit(0);
  };
}
