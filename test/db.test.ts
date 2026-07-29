import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db';
import { createLogger } from '../src/logger';
import { createMetrics } from '../src/metrics';
import { INDEX_NAMES, TABLE_NAMES } from '../src/schema';
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
  return { db, metrics, register, lines };
}

afterEach(() => {
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

describe('createDb — schema', () => {
  it('creates all four tables', () => {
    const { db } = makeHarness();
    const names = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const table of TABLE_NAMES) expect(names).toContain(table);
  });

  it('creates all five indexes', () => {
    const { db } = makeHarness();
    const names = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const index of INDEX_NAMES) expect(names).toContain(index);
    expect(INDEX_NAMES).toHaveLength(5);
  });

  it('applies the schema idempotently on an already-populated database', () => {
    const { db, metrics } = makeHarness();
    db.insertMessageMap('batch-1', 'ghost-1', '["bulk-email"]');

    const logger = createLogger(config, { write() {} });
    expect(() => createDb(':memory:', logger, metrics)).not.toThrow();
  });

  it('sets busy_timeout', () => {
    const { db } = makeHarness();
    expect(db.raw.pragma('busy_timeout', { simple: true })).toBe(5000);
  });
});

describe('createDb — INSERT OR IGNORE deduplication', () => {
  it('dedupes message_map on batch_message_id', () => {
    const { db } = makeHarness();
    db.insertMessageMap('batch-1', 'ghost-1', '["a"]');
    db.insertMessageMap('batch-1', 'ghost-2', '["b"]');

    const rows = db.raw.prepare('SELECT * FROM message_map').all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { ghost_email_id: string }).ghost_email_id).toBe('ghost-1');
  });

  it('dedupes recipient_emails on ses_message_id', () => {
    const { db } = makeHarness();
    db.insertRecipientEmail('ses-1', 'batch-1', 'alice@example.com', 'ghost-1', null);
    db.insertRecipientEmail('ses-1', 'batch-2', 'bob@example.com', 'ghost-2', null);

    const rows = db.raw.prepare('SELECT * FROM recipient_emails').all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { recipient: string }).recipient).toBe('alice@example.com');
  });

  it('dedupes events on id — the D3 redelivery guard', () => {
    const { db } = makeHarness();
    db.insertEvent(eventRow());
    db.insertEvent(eventRow({ recipient: 'someone-else@example.com' }));

    const rows = db.raw.prepare('SELECT * FROM events').all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { recipient: string }).recipient).toBe('alice@example.com');
  });

  it('stores every column of an event row', () => {
    const { db } = makeHarness();
    const row = eventRow({
      event_type: 'failed',
      severity: 'permanent',
      delivery_status_code: 607,
      delivery_status_message: 'smtp; 550 mailbox unavailable',
      delivery_status_enhanced: '5.1.1',
    });
    db.insertEvent(row);

    const stored = db.raw.prepare('SELECT * FROM events WHERE id = ?').get('evt-0001');
    expect(stored).toMatchObject(row);
  });

  it('dedupes suppressions on (email, type) but allows the same email under another type', () => {
    const { db } = makeHarness();
    db.insertSuppression('bounced@example.com', 'bounces', 'hard bounce');
    db.insertSuppression('bounced@example.com', 'bounces', 'again');
    db.insertSuppression('bounced@example.com', 'complaints', 'complaint');

    const rows = db.raw
      .prepare('SELECT * FROM suppressions ORDER BY id')
      .all() as { type: string; reason: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.reason).toBe('hard bounce');
    expect(rows.map((r) => r.type)).toEqual(['bounces', 'complaints']);
  });
});

describe('createDb — reads and deletes', () => {
  it('round-trips a recipient_emails row', () => {
    const { db } = makeHarness();
    db.insertRecipientEmail(
      'ses-1',
      'batch-1',
      'alice@example.com',
      'ghost-1',
      '["bulk-email"]',
    );

    const row = db.lookupRecipientEmail('ses-1');
    expect(row).toMatchObject({
      ses_message_id: 'ses-1',
      batch_message_id: 'batch-1',
      recipient: 'alice@example.com',
      ghost_email_id: 'ghost-1',
      tags: '["bulk-email"]',
    });
    expect(row?.created_at).toEqual(expect.any(String));
  });

  it('returns undefined for an unknown ses_message_id', () => {
    const { db } = makeHarness();
    expect(db.lookupRecipientEmail('missing')).toBeUndefined();
  });

  it('returns the number of suppression rows deleted', () => {
    const { db } = makeHarness();
    db.insertSuppression('bounced@example.com', 'bounces', null);

    expect(db.deleteSuppression('bounced@example.com', 'bounces')).toBe(1);
    expect(db.deleteSuppression('bounced@example.com', 'bounces')).toBe(0);
    expect(db.deleteSuppression('never-seen@example.com', 'complaints')).toBe(0);
  });
});

describe('createDb — close', () => {
  it('releases the handle', () => {
    const { db } = makeHarness();
    expect(db.raw.open).toBe(true);

    db.close();

    expect(db.raw.open).toBe(false);
    expect(() => db.insertMessageMap('batch-1', null, null)).toThrow(
      /database connection is not open/i,
    );
  });
});

describe('createDb — statement failures', () => {
  it('counts, logs and rethrows a failing statement with a bounded operation label', async () => {
    const { db, register, lines } = makeHarness();
    db.raw.exec('DROP TABLE events');

    expect(() => db.insertEvent(eventRow())).toThrow(/no such table: events/);

    const values = await labelledValues(register, 'ghost_ses_proxy_db_errors_total');
    expect(values).toHaveLength(1);
    expect(values[0]?.labels).toEqual({ operation: 'insertEvent' });
    expect(values[0]?.value).toBe(1);

    const errorLine = lines.find((line) => line.level === 'error');
    expect(errorLine).toMatchObject({
      component: 'db',
      operation: 'insertEvent',
      msg: 'database statement failed',
    });
    expect(errorLine?.err).toBeTruthy();
  });

  it('labels a failing read with its own operation', async () => {
    const { db, register } = makeHarness();
    db.raw.exec('DROP TABLE recipient_emails');

    expect(() => db.lookupRecipientEmail('ses-1')).toThrow();

    const values = await labelledValues(register, 'ghost_ses_proxy_db_errors_total');
    expect(values.map((v) => v.labels.operation)).toEqual(['lookupRecipientEmail']);
  });

  it('does not count a constraint violation — INSERT OR IGNORE swallows it', async () => {
    const { db, register } = makeHarness();

    expect(() =>
      db.insertRecipientEmail(
        'ses-1',
        'batch-1',
        null as unknown as string,
        null,
        null,
      ),
    ).not.toThrow();

    expect(db.raw.prepare('SELECT * FROM recipient_emails').all()).toHaveLength(0);
    expect(
      await labelledValues(register, 'ghost_ses_proxy_db_errors_total'),
    ).toHaveLength(0);
  });

  it('draws the operation label only from the bounded statement set', async () => {
    const { db, register } = makeHarness();
    db.raw.exec('DROP TABLE suppressions');

    expect(() => db.insertSuppression('a@example.com', 'bounces', null)).toThrow();
    expect(() => db.deleteSuppression('a@example.com', 'bounces')).toThrow();

    const values = await labelledValues(register, 'ghost_ses_proxy_db_errors_total');
    expect(new Set(values.map((v) => v.labels.operation))).toEqual(
      new Set(['insertSuppression', 'deleteSuppression']),
    );
  });

  it('does not increment db_errors_total on success', async () => {
    const { db, register } = makeHarness();
    db.insertMessageMap('batch-1', 'ghost-1', null);
    db.insertSuppression('a@example.com', 'bounces', null);
    db.deleteSuppression('a@example.com', 'bounces');

    expect(
      await labelledValues(register, 'ghost_ses_proxy_db_errors_total'),
    ).toHaveLength(0);
  });
});
