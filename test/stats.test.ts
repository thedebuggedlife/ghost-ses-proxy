import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db';
import { createLogger } from '../src/logger';
import { createMetrics } from '../src/metrics';
import { attachDbGauges, createStats } from '../src/stats';
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
}

const open: Db[] = [];

function makeHarness(): Harness {
  const logger = createLogger(config, { write() {} });
  const register = new Registry();
  const metrics = createMetrics(register);
  const db = createDb(':memory:', logger, metrics);
  open.push(db);
  return { db, metrics, register };
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
  tags: null,
  ...overrides,
});

describe('createStats', () => {
  it('returns zero counts for an empty database', () => {
    const { db } = makeHarness();
    expect(createStats(db).getCounts(0)).toEqual({
      message_map: 0,
      recipient_emails: 0,
      events: 0,
      suppressions: 0,
    });
  });

  it('returns live counts for all four tables', () => {
    const { db } = makeHarness();
    db.insertMessageMap('<batch-1@example.com>', 'ghost-1', null);
    db.insertRecipientEmail('ses-1', '<batch-1@example.com>', 'a@e.com', null, null);
    db.insertRecipientEmail('ses-2', '<batch-1@example.com>', 'b@e.com', null, null);
    db.insertEvent(eventRow());
    db.insertSuppression('bounced@example.com', 'bounces', null);
    db.insertSuppression('spam@example.com', 'complaints', null);
    db.insertSuppression('third@example.com', 'bounces', null);

    expect(createStats(db).getCounts(0)).toEqual({
      message_map: 1,
      recipient_emails: 2,
      events: 1,
      suppressions: 3,
    });
  });

  it('serves the cached value within the TTL', () => {
    const { db } = makeHarness();
    const stats = createStats(db, 15_000);

    expect(stats.getCounts(1_000).message_map).toBe(0);
    db.insertMessageMap('<batch-1@example.com>', null, null);

    expect(stats.getCounts(1_000).message_map).toBe(0);
    expect(stats.getCounts(15_999).message_map).toBe(0);
  });

  it('recomputes once the TTL has elapsed', () => {
    const { db } = makeHarness();
    const stats = createStats(db, 15_000);

    expect(stats.getCounts(1_000).message_map).toBe(0);
    db.insertMessageMap('<batch-1@example.com>', null, null);

    expect(stats.getCounts(16_000).message_map).toBe(1);
  });

  it('caches from the recompute time, not the first call', () => {
    const { db } = makeHarness();
    const stats = createStats(db, 100);

    stats.getCounts(0);
    db.insertMessageMap('<batch-1@example.com>', null, null);
    expect(stats.getCounts(100).message_map).toBe(1);

    db.insertMessageMap('<batch-2@example.com>', null, null);
    expect(stats.getCounts(150).message_map).toBe(1);
    expect(stats.getCounts(200).message_map).toBe(2);
  });

  it('returns the identical cached object within the TTL', () => {
    const { db } = makeHarness();
    const stats = createStats(db, 15_000);
    expect(stats.getCounts(0)).toBe(stats.getCounts(1));
  });

  it('defaults `now` to the wall clock', () => {
    const { db } = makeHarness();
    const stats = createStats(db);
    db.insertMessageMap('<batch-1@example.com>', null, null);
    expect(stats.getCounts().message_map).toBe(1);
  });

  it('defaults to a 15-second TTL', () => {
    const { db } = makeHarness();
    const stats = createStats(db);

    stats.getCounts(0);
    db.insertMessageMap('<batch-1@example.com>', null, null);
    expect(stats.getCounts(14_999).message_map).toBe(0);
    expect(stats.getCounts(15_000).message_map).toBe(1);
  });
});

describe('attachDbGauges', () => {
  it('populates db_rows from the stats collector on scrape', async () => {
    const { db, metrics, register } = makeHarness();
    db.insertMessageMap('<batch-1@example.com>', null, null);
    db.insertRecipientEmail('ses-1', '<batch-1@example.com>', 'a@e.com', null, null);
    db.insertSuppression('bounced@example.com', 'bounces', null);

    attachDbGauges(metrics, createStats(db), db);

    const values = await labelledValues(register, 'ghost_ses_proxy_db_rows');
    expect(
      Object.fromEntries(values.map((v) => [v.labels.table, v.value])),
    ).toEqual({
      message_map: 1,
      recipient_emails: 1,
      events: 0,
      suppressions: 1,
    });
  });

  it('populates on scrape rather than eagerly, so no background timer is needed', async () => {
    const { db, metrics, register } = makeHarness();
    attachDbGauges(metrics, createStats(db, 0), db);

    // Values only exist because getMetricsAsJSON invokes collect(); a row
    // inserted between two scrapes therefore shows up without any push update.
    expect(await labelledValues(register, 'ghost_ses_proxy_db_rows')).toHaveLength(4);
    db.insertSuppression('bounced@example.com', 'bounces', null);
    const values = await labelledValues(register, 'ghost_ses_proxy_db_rows');
    expect(values.find((v) => v.labels.table === 'suppressions')?.value).toBe(1);
  });

  it('reflects new rows on a later scrape once the TTL has expired', async () => {
    const { db, metrics, register } = makeHarness();
    attachDbGauges(metrics, createStats(db, 0), db);

    await register.getMetricsAsJSON();
    db.insertMessageMap('<batch-1@example.com>', null, null);

    const values = await labelledValues(register, 'ghost_ses_proxy_db_rows');
    expect(values.find((v) => v.labels.table === 'message_map')?.value).toBe(1);
  });

  it('populates db_size_bytes as page_count × page_size', async () => {
    const { db, metrics, register } = makeHarness();
    attachDbGauges(metrics, createStats(db), db);

    const pageCount = Number(db.raw.pragma('page_count', { simple: true }));
    const pageSize = Number(db.raw.pragma('page_size', { simple: true }));
    expect(pageCount).toBeGreaterThan(0);

    const values = await labelledValues(
      register,
      'ghost_ses_proxy_db_size_bytes',
    );
    expect(values).toEqual([{ labels: {}, value: pageCount * pageSize }]);
  });

  it('db_size_bytes grows as the database does', async () => {
    const { db, metrics, register } = makeHarness();
    attachDbGauges(metrics, createStats(db), db);

    const before = (
      await labelledValues(register, 'ghost_ses_proxy_db_size_bytes')
    )[0]?.value;

    for (let i = 0; i < 2000; i += 1) {
      db.insertEvent(eventRow({ id: `evt-${i}`, recipient: `r${i}@e.com` }));
    }

    const after = (
      await labelledValues(register, 'ghost_ses_proxy_db_size_bytes')
    )[0]?.value;
    expect(after).toBeGreaterThan(before ?? 0);
  });
});
