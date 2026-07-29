import { Registry } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLEANUP_TABLES,
  RETENTION_DAYS,
  runCleanup,
  scheduleCleanup,
} from '../src/cleanup';
import { createDb } from '../src/db';
import { createLogger } from '../src/logger';
import { createMetrics } from '../src/metrics';
import { TABLE_NAMES } from '../src/schema';
import type { Config, Db, EventRow, Metrics } from '../src/types';

const config: Config = {
  port: 3003,
  awsAccessKeyId: 'AKIAFAKE',
  awsSecretAccessKey: 'secret',
  awsRegion: 'us-east-1',
  sesConfigurationSet: 'ghost-ses-proxy',
  sqsQueueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/fake',
  proxyApiKey: 'test-key',
  mailgunDomain: 'example.com',
  logLevel: 'trace',
  sendConcurrency: 10,
  dbPath: ':memory:',
};

interface Harness {
  db: Db;
  metrics: Metrics;
  register: Registry;
  logger: ReturnType<typeof createLogger>;
  lines: Record<string, unknown>[];
}

const open: Db[] = [];

function makeHarness(): Harness {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(config, {
    write(chunk: string) {
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  });
  const register = new Registry();
  const metrics = createMetrics(register);
  const db = createDb(':memory:', logger, metrics);
  open.push(db);
  return { db, metrics, register, logger, lines };
}

afterEach(() => {
  vi.useRealTimers();
  for (const db of open.splice(0)) {
    if (db.raw.open) db.close();
  }
});

async function labelledValues(
  register: Registry,
  name: string,
): Promise<{ labels: Record<string, string | number>; value: number }[]> {
  const json = await register.getMetricsAsJSON();
  const metric = json.find((entry) => entry.name === name);
  const values = (metric as { values?: unknown } | undefined)?.values;
  return (values ?? []) as {
    labels: Record<string, string | number>;
    value: number;
  }[];
}

const eventRow = (overrides: Partial<EventRow> = {}): EventRow => ({
  id: 'evt-0001',
  event_type: 'delivered',
  severity: null,
  recipient: 'alice@example.com',
  timestamp: 1750000001,
  message_id: '<batch-1@example.com>',
  email_id: 'ghost-1',
  delivery_status_code: null,
  delivery_status_message: null,
  delivery_status_enhanced: '',
  tags: '["bulk-email"]',
  ...overrides,
});

/**
 * Seeds the eight rows of `test/golden/intent/d2-suppression-retention.json`:
 * one 200-day-old and one 30-day-old row in each of the four tables.
 */
function seedAgedRows(db: Db): void {
  db.insertMessageMap('<old-batch@example.com>', 'ghost-old', null);
  db.insertMessageMap('<new-batch@example.com>', 'ghost-new', null);
  db.insertRecipientEmail(
    '010001912a3b4c5d-0000000000000010-000000',
    '<old-batch@example.com>',
    'old@example.com',
    'ghost-old',
    null,
  );
  db.insertRecipientEmail(
    '010001912a3b4c5d-0000000000000011-000000',
    '<new-batch@example.com>',
    'new@example.com',
    'ghost-new',
    null,
  );
  db.insertEvent(eventRow({ id: 'evt-old-0001' }));
  db.insertEvent(eventRow({ id: 'evt-new-0001' }));
  db.insertSuppression('ancient-bounce@example.com', 'bounces', 'hard bounce');
  db.insertSuppression(
    'recent-complaint@example.com',
    'complaints',
    'spam report',
  );

  const backdate = (table: string, column: string, key: string, days: number) =>
    db.raw
      .prepare(
        `UPDATE ${table} SET created_at = datetime('now', '-${days} days') WHERE ${column} = ?`,
      )
      .run(key);

  backdate('message_map', 'batch_message_id', '<old-batch@example.com>', 200);
  backdate('message_map', 'batch_message_id', '<new-batch@example.com>', 30);
  backdate(
    'recipient_emails',
    'ses_message_id',
    '010001912a3b4c5d-0000000000000010-000000',
    200,
  );
  backdate(
    'recipient_emails',
    'ses_message_id',
    '010001912a3b4c5d-0000000000000011-000000',
    30,
  );
  backdate('events', 'id', 'evt-old-0001', 200);
  backdate('events', 'id', 'evt-new-0001', 30);
  backdate('suppressions', 'email', 'ancient-bounce@example.com', 200);
  backdate('suppressions', 'email', 'recent-complaint@example.com', 30);
}

const keysIn = (db: Db, table: string, column: string): string[] =>
  db.raw
    .prepare(`SELECT ${column} AS k FROM ${table} ORDER BY ${column}`)
    .all()
    .map((row) => (row as { k: string }).k);

describe('CLEANUP_TABLES', () => {
  it('excludes suppressions and keeps the other three (D2)', () => {
    expect([...CLEANUP_TABLES]).toEqual([
      'message_map',
      'recipient_emails',
      'events',
    ]);
    expect(CLEANUP_TABLES).not.toContain('suppressions');
    expect(TABLE_NAMES).toContain('suppressions');
  });

  it('retains rows for 90 days', () => {
    expect(RETENTION_DAYS).toBe(90);
  });
});

describe('runCleanup', () => {
  it('deletes 200-day-old rows from the three ephemeral tables', () => {
    const { db, logger, metrics } = makeHarness();
    seedAgedRows(db);

    runCleanup(db, logger, metrics);

    expect(keysIn(db, 'message_map', 'batch_message_id')).toEqual([
      '<new-batch@example.com>',
    ]);
    expect(keysIn(db, 'recipient_emails', 'ses_message_id')).toEqual([
      '010001912a3b4c5d-0000000000000011-000000',
    ]);
    expect(keysIn(db, 'events', 'id')).toEqual(['evt-new-0001']);
  });

  it('D2 regression: a 200-day-old suppression survives', () => {
    const { db, logger, metrics } = makeHarness();
    seedAgedRows(db);

    runCleanup(db, logger, metrics);

    expect(keysIn(db, 'suppressions', 'email')).toEqual([
      'ancient-bounce@example.com',
      'recent-complaint@example.com',
    ]);
  });

  it('D2 regression: the suppressions row count is unchanged', () => {
    const { db, logger, metrics } = makeHarness();
    seedAgedRows(db);
    const before = keysIn(db, 'suppressions', 'email').length;

    runCleanup(db, logger, metrics);
    runCleanup(db, logger, metrics);

    expect(keysIn(db, 'suppressions', 'email')).toHaveLength(before);
  });

  it('D2 regression: no db_cleanup_deleted_rows_total series exists for suppressions', async () => {
    const { db, logger, metrics, register } = makeHarness();
    seedAgedRows(db);

    runCleanup(db, logger, metrics);

    const values = await labelledValues(
      register,
      'ghost_ses_proxy_db_cleanup_deleted_rows_total',
    );
    expect(values.map((v) => v.labels.table)).toEqual([
      'message_map',
      'recipient_emails',
      'events',
    ]);
    expect(values.find((v) => v.labels.table === 'suppressions')).toBeUndefined();
  });

  it('leaves 30-day-old rows in every table', () => {
    const { db, logger, metrics } = makeHarness();
    seedAgedRows(db);

    runCleanup(db, logger, metrics);

    expect(keysIn(db, 'message_map', 'batch_message_id')).toContain(
      '<new-batch@example.com>',
    );
    expect(keysIn(db, 'recipient_emails', 'ses_message_id')).toContain(
      '010001912a3b4c5d-0000000000000011-000000',
    );
    expect(keysIn(db, 'events', 'id')).toContain('evt-new-0001');
    expect(keysIn(db, 'suppressions', 'email')).toContain(
      'recent-complaint@example.com',
    );
  });

  it('records deleted counts per table', async () => {
    const { db, logger, metrics, register } = makeHarness();
    seedAgedRows(db);

    runCleanup(db, logger, metrics);

    const values = await labelledValues(
      register,
      'ghost_ses_proxy_db_cleanup_deleted_rows_total',
    );
    expect(
      Object.fromEntries(values.map((v) => [v.labels.table, v.value])),
    ).toEqual({ message_map: 1, recipient_emails: 1, events: 1 });
  });

  it('records outcome="success" once per run', async () => {
    const { db, logger, metrics, register } = makeHarness();
    seedAgedRows(db);

    runCleanup(db, logger, metrics);
    const after1 = await labelledValues(
      register,
      'ghost_ses_proxy_db_cleanup_runs_total',
    );
    expect(after1).toEqual([{ labels: { outcome: 'success' }, value: 1 }]);

    runCleanup(db, logger, metrics);
    const after2 = await labelledValues(
      register,
      'ghost_ses_proxy_db_cleanup_runs_total',
    );
    expect(after2).toEqual([{ labels: { outcome: 'success' }, value: 2 }]);
  });

  it('records a zero delta when nothing is old enough', async () => {
    const { db, logger, metrics, register } = makeHarness();
    db.insertMessageMap('<fresh@example.com>', null, null);

    runCleanup(db, logger, metrics);

    const values = await labelledValues(
      register,
      'ghost_ses_proxy_db_cleanup_deleted_rows_total',
    );
    expect(
      Object.fromEntries(values.map((v) => [v.labels.table, v.value])),
    ).toEqual({ message_map: 0, recipient_emails: 0, events: 0 });
    expect(keysIn(db, 'message_map', 'batch_message_id')).toEqual([
      '<fresh@example.com>',
    ]);
  });

  it('logs the per-table deltas at info with component=db', () => {
    const { db, logger, metrics, lines } = makeHarness();
    seedAgedRows(db);

    runCleanup(db, logger, metrics);

    const line = lines.find((l) => l.msg === 'completed retention cleanup');
    expect(line).toBeDefined();
    expect(line?.component).toBe('db');
    expect(line?.level).toBe('info');
    expect(line?.deleted).toEqual({
      message_map: 1,
      recipient_emails: 1,
      events: 1,
    });
    expect(line?.retentionDays).toBe(90);
  });

  it('records outcome="error" and does not throw when a statement fails', async () => {
    const { db, logger, metrics, register, lines } = makeHarness();
    seedAgedRows(db);
    db.raw.exec('DROP TABLE events');

    expect(() => runCleanup(db, logger, metrics)).not.toThrow();

    expect(
      await labelledValues(register, 'ghost_ses_proxy_db_cleanup_runs_total'),
    ).toEqual([{ labels: { outcome: 'error' }, value: 1 }]);

    const line = lines.find((l) => l.msg === 'retention cleanup failed');
    expect(line?.level).toBe('error');
    expect(line?.component).toBe('db');
  });

  it('keeps the deletions it completed before a failure', async () => {
    const { db, logger, metrics, register } = makeHarness();
    seedAgedRows(db);
    db.raw.exec('DROP TABLE events');

    runCleanup(db, logger, metrics);

    expect(keysIn(db, 'message_map', 'batch_message_id')).toEqual([
      '<new-batch@example.com>',
    ]);
    const values = await labelledValues(
      register,
      'ghost_ses_proxy_db_cleanup_deleted_rows_total',
    );
    expect(
      Object.fromEntries(values.map((v) => [v.labels.table, v.value])),
    ).toEqual({ message_map: 1, recipient_emails: 1 });
  });
});

describe('scheduleCleanup', () => {
  it('D6 stays pinned: nothing runs at startup', async () => {
    vi.useFakeTimers();
    const { db, logger, metrics, register } = makeHarness();
    seedAgedRows(db);

    const timer = scheduleCleanup(db, logger, metrics, 1000);

    expect(keysIn(db, 'message_map', 'batch_message_id')).toHaveLength(2);
    expect(
      await labelledValues(register, 'ghost_ses_proxy_db_cleanup_runs_total'),
    ).toEqual([]);
    clearInterval(timer);
  });

  it('runs cleanup after the interval elapses, with its arguments intact', async () => {
    vi.useFakeTimers();
    const { db, logger, metrics, register } = makeHarness();
    seedAgedRows(db);

    const timer = scheduleCleanup(db, logger, metrics, 1000);
    vi.advanceTimersByTime(1000);

    // Rows actually disappearing is what proves db/logger/metrics were passed
    // through rather than the callback being `setInterval(runCleanup, ms)`.
    expect(keysIn(db, 'message_map', 'batch_message_id')).toEqual([
      '<new-batch@example.com>',
    ]);
    expect(
      await labelledValues(register, 'ghost_ses_proxy_db_cleanup_runs_total'),
    ).toEqual([{ labels: { outcome: 'success' }, value: 1 }]);
    clearInterval(timer);
  });

  it('repeats on every interval', async () => {
    vi.useFakeTimers();
    const { db, logger, metrics, register } = makeHarness();

    const timer = scheduleCleanup(db, logger, metrics, 1000);
    vi.advanceTimersByTime(3000);

    expect(
      await labelledValues(register, 'ghost_ses_proxy_db_cleanup_runs_total'),
    ).toEqual([{ labels: { outcome: 'success' }, value: 3 }]);
    clearInterval(timer);
  });

  it('stops when the returned handle is cleared', async () => {
    vi.useFakeTimers();
    const { db, logger, metrics, register } = makeHarness();

    const timer = scheduleCleanup(db, logger, metrics, 1000);
    vi.advanceTimersByTime(1000);
    clearInterval(timer);
    vi.advanceTimersByTime(10_000);

    expect(
      await labelledValues(register, 'ghost_ses_proxy_db_cleanup_runs_total'),
    ).toEqual([{ labels: { outcome: 'success' }, value: 1 }]);
  });

  it('defaults to a 24-hour interval', async () => {
    vi.useFakeTimers();
    const { db, logger, metrics, register } = makeHarness();

    const timer = scheduleCleanup(db, logger, metrics);
    vi.advanceTimersByTime(86_399_999);
    expect(
      await labelledValues(register, 'ghost_ses_proxy_db_cleanup_runs_total'),
    ).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(
      await labelledValues(register, 'ghost_ses_proxy_db_cleanup_runs_total'),
    ).toEqual([{ labels: { outcome: 'success' }, value: 1 }]);
    clearInterval(timer);
  });
});
