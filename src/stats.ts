import type { Statement } from 'better-sqlite3';
import { TABLE_NAMES } from './schema';
import type { Db, Metrics, Stats, TableCounts } from './types';

export const DEFAULT_STATS_TTL_MS = 15_000;

/** prom-client sets `collect` on every metric instance but does not declare it on the class. */
interface Collectable {
  collect: () => void;
}

export function createStats(db: Db, ttlMs: number = DEFAULT_STATS_TTL_MS): Stats {
  const statements = {} as Record<keyof TableCounts, Statement<[]>>;
  for (const table of TABLE_NAMES) {
    statements[table] = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
  }

  let cache: { at: number; counts: TableCounts } | null = null;

  return {
    getCounts(now: number = Date.now()): TableCounts {
      if (cache && now - cache.at < ttlMs) return cache.counts;

      const counts = {} as TableCounts;
      for (const table of TABLE_NAMES) {
        counts[table] = (statements[table].get() as { n: number }).n;
      }
      cache = { at: now, counts };
      return counts;
    },
  };
}

export function attachDbGauges(metrics: Metrics, stats: Stats, db: Db): void {
  const { dbRows, dbSizeBytes } = metrics;

  (dbRows as unknown as Collectable).collect = () => {
    const counts = stats.getCounts();
    for (const table of TABLE_NAMES) dbRows.set({ table }, counts[table]);
  };

  (dbSizeBytes as unknown as Collectable).collect = () => {
    const pageCount = Number(db.raw.pragma('page_count', { simple: true }));
    const pageSize = Number(db.raw.pragma('page_size', { simple: true }));
    dbSizeBytes.set(pageCount * pageSize);
  };
}
