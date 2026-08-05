import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { createApp } from '../../src/app';
import { makeDeps, type TestDeps } from '../helpers/deps';

const AUTH = `Basic ${Buffer.from('api:test-key', 'utf8').toString('base64')}`;

describe('GET /health', () => {
  let deps: TestDeps;
  let app: Express;

  // One listening socket for the whole file, delegating to whichever app the
  // current test built. Passing the Express app to supertest instead binds a
  // fresh ephemeral server per call, which is what makes these tests hang
  // intermittently.
  let server: Server;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = createServer((req, res) => {
          app(req, res);
        });
        server.listen(0, resolve);
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  beforeEach(() => {
    deps = makeDeps();
    app = createApp(deps);
  });

  afterEach(() => {
    deps.db.close();
  });

  function seed(): void {
    deps.db.insertMessageMap('batch-1', 'ghost-1', '["bulk-email"]');
    deps.db.insertMessageMap('batch-2', null, null);
    deps.db.insertRecipientEmail(
      'ses-1',
      'batch-1',
      'alice@example.com',
      'ghost-1',
      '["bulk-email"]',
    );
    deps.db.insertEvent({
      id: 'evt-0001',
      event_type: 'delivered',
      severity: null,
      recipient: 'alice@example.com',
      timestamp: 1_750_000_001,
      message_id: 'batch-1@example.com',
      email_id: 'ghost-1',
      delivery_status_code: null,
      delivery_status_message: null,
      delivery_status_enhanced: null,
      tags: '["bulk-email"]',
    });
    deps.db.insertSuppression('bounced@example.com', 'bounces', 'hard bounce');
    deps.db.insertSuppression('complainer@example.com', 'complaints', null);
    deps.db.insertSuppression('unsub@example.com', 'unsubscribes', null);
  }

  it('returns 200 with the exact { status, tables } shape', async () => {
    const res = await request(server).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      tables: {
        message_map: 0,
        recipient_emails: 0,
        events: 0,
        suppressions: 0,
      },
    });
  });

  it('carries exactly the four table keys, in schema order', async () => {
    const res = await request(server).get('/health');

    expect(Object.keys(res.body as object)).toEqual(['status', 'tables']);
    expect(Object.keys((res.body as { tables: object }).tables)).toEqual([
      'message_map',
      'recipient_emails',
      'events',
      'suppressions',
    ]);
  });

  it('reports counts that reflect the database', async () => {
    seed();

    const res = await request(server).get('/health');

    expect(res.body).toEqual({
      status: 'ok',
      tables: {
        message_map: 2,
        recipient_emails: 1,
        events: 1,
        suppressions: 3,
      },
    });
  });

  it('responds as JSON', async () => {
    const res = await request(server).get('/health');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('is served without an Authorization header', async () => {
    const anonymous = await request(server).get('/health');
    const authenticated = await request(server)
      .get('/health')
      .set('Authorization', AUTH);

    expect(anonymous.status).toBe(200);
    expect(authenticated.status).toBe(200);
    expect(anonymous.body).toEqual(authenticated.body);
  });

  it('is served even when the Authorization header is invalid', async () => {
    const res = await request(server)
      .get('/health')
      .set('Authorization', 'Basic bm9wZTpub3Bl');

    expect(res.status).toBe(200);
  });

  it('serves the counts through the cached stats collector', async () => {
    await request(server).get('/health');

    seed();
    const res = await request(server).get('/health');

    expect(res.body).toEqual({
      status: 'ok',
      tables: {
        message_map: 0,
        recipient_emails: 0,
        events: 0,
        suppressions: 0,
      },
    });
  });

  it('counts the request in the HTTP metrics with the route template', async () => {
    await request(server).get('/health');

    const json = await deps.register.getMetricsAsJSON();
    const values =
      json.find((metric) => metric.name === 'ghost_ses_proxy_http_requests_total')
        ?.values ?? [];

    expect(values.map((value) => value.labels)).toEqual([
      { method: 'GET', route: '/health', status_code: '200' },
    ]);
  });

  it('writes no access-log line', async () => {
    await request(server).get('/health');

    expect(deps.logs().filter((line) => line['responseTime'] !== undefined)).toEqual(
      [],
    );
  });
});
