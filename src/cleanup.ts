import type { Logger } from 'pino';
import { TABLE_NAMES } from './schema';
import type { Db, Metrics } from './types';

export const RETENTION_DAYS = 90;

export const DEFAULT_CLEANUP_INTERVAL_MS = 86_400_000;

type CleanupTable = Exclude<(typeof TABLE_NAMES)[number], 'suppressions'>;

/** D2 (design §5.2): suppressions are permanent, so they are not a cleanup target. */
export const CLEANUP_TABLES: readonly CleanupTable[] = TABLE_NAMES.filter(
  (table): table is CleanupTable => table !== 'suppressions',
);

export function runCleanup(db: Db, logger: Logger, metrics: Metrics): void {
  const log = logger.child({ component: 'db' });
  const deleted: Partial<Record<CleanupTable, number>> = {};

  try {
    for (const table of CLEANUP_TABLES) {
      const result = db.raw
        .prepare(
          `DELETE FROM ${table} WHERE created_at < datetime('now', '-${RETENTION_DAYS} days')`,
        )
        .run();
      deleted[table] = result.changes;
      metrics.dbCleanupDeletedRowsTotal.inc({ table }, result.changes);
    }
    metrics.dbCleanupRunsTotal.inc({ outcome: 'success' });
    log.info(
      { deleted, retentionDays: RETENTION_DAYS },
      'completed retention cleanup',
    );
  } catch (err) {
    metrics.dbCleanupRunsTotal.inc({ outcome: 'error' });
    log.error({ err, deleted }, 'retention cleanup failed');
  }
}

export function scheduleCleanup(
  db: Db,
  logger: Logger,
  metrics: Metrics,
  intervalMs: number = DEFAULT_CLEANUP_INTERVAL_MS,
): NodeJS.Timeout {
  return setInterval(() => {
    runCleanup(db, logger, metrics);
  }, intervalMs);
}
