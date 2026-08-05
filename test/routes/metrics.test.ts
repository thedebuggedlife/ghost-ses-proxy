import { createServer, type Server } from 'node:http';
import express, { type Express } from 'express';
import { Gauge } from 'prom-client';
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
import { ZERO_INIT_SPEC } from '../../src/metrics';
import { createMetricsRoute } from '../../src/routes/metrics';
import { makeDeps, type TestDeps } from '../helpers/deps';

const AUTH = `Basic ${Buffer.from('api:test-key', 'utf8').toString('base64')}`;

function metricNames(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('# TYPE '))
    .map((line) => line.split(' ')[2] ?? '');
}

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

describe('GET /metrics', () => {
  beforeEach(() => {
    deps = makeDeps();
    app = createApp(deps);
  });

  afterEach(() => {
    deps.db.close();
  });

  it("returns 200 with prom-client's content type", async () => {
    const res = await request(server).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(deps.register.contentType);
  });

  it('returns a body that parses as the Prometheus exposition format', async () => {
    const res = await request(server).get('/metrics');
    const lines = res.text.split('\n').filter((line) => line.length > 0);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^(# (HELP|TYPE|EOF) \S+|[a-zA-Z_:][a-zA-Z0-9_:]*[{ ])/);
    }
    expect(metricNames(res.text).length).toBeGreaterThan(0);
  });

  it('exposes the application metrics under the ghost_ses_proxy_ prefix', async () => {
    const res = await request(server).get('/metrics');
    const names = metricNames(res.text);

    expect(names).toContain('ghost_ses_proxy_http_requests_total');
    expect(names).toContain('ghost_ses_proxy_send_batches_total');
    expect(names).toContain('ghost_ses_proxy_sqs_last_poll_timestamp_seconds');
    expect(names).toContain('ghost_ses_proxy_build_info');
  });

  it('exposes db_rows, which proves attachDbGauges ran', async () => {
    deps.db.insertMessageMap('batch-1', null, null);

    const res = await request(server).get('/metrics');

    expect(metricNames(res.text)).toContain('ghost_ses_proxy_db_rows');
    expect(res.text).toContain(
      'ghost_ses_proxy_db_rows{table="message_map"} 1',
    );
    expect(metricNames(res.text)).toContain('ghost_ses_proxy_db_size_bytes');
  });

  it('exposes the default process/nodejs metrics unprefixed', async () => {
    const res = await request(server).get('/metrics');
    const names = metricNames(res.text);

    expect(names).toContain('process_cpu_seconds_total');
    expect(names).toContain('nodejs_eventloop_lag_seconds');
    expect(names.some((name) => name.startsWith('ghost_ses_proxy_process_'))).toBe(
      false,
    );
  });

  it('is served without an Authorization header', async () => {
    const anonymous = await request(server).get('/metrics');
    const authenticated = await request(server)
      .get('/metrics')
      .set('Authorization', AUTH);

    expect(anonymous.status).toBe(200);
    expect(authenticated.status).toBe(200);
  });

  it('is served even when the Authorization header is invalid', async () => {
    const res = await request(server)
      .get('/metrics')
      .set('Authorization', 'Basic bm9wZTpub3Bl');

    expect(res.status).toBe(200);
  });

  it('reads from the injected registry, not the global default', async () => {
    const res = await request(server).get('/metrics');
    const otherDeps = makeDeps();
    otherDeps.metrics.sendBatchesTotal.inc({ outcome: 'success' });

    expect(res.text).not.toContain(
      'ghost_ses_proxy_send_batches_total{outcome="success"} 1',
    );
    otherDeps.db.close();
  });

  it('writes no access-log line', async () => {
    await request(server).get('/metrics');

    expect(deps.logs().filter((line) => line['responseTime'] !== undefined)).toEqual(
      [],
    );
  });

  it('exposes the issue #8 series at 0 on a cold app, before any traffic', async () => {
    const res = await request(server).get('/metrics');

    expect(res.text).toContain(
      'ghost_ses_proxy_send_batches_total{outcome="failure"} 0',
    );
    expect(res.text).toContain(
      'ghost_ses_proxy_send_batches_total{outcome="partial"} 0',
    );
    expect(res.text).toContain(
      'ghost_ses_proxy_suppressions_recorded_total{type="bounces"} 0',
    );
  });

  it('exposes every zero-initialised child at 0 on a cold app', async () => {
    const res = await request(server).get('/metrics');

    for (const { name, label, values } of ZERO_INIT_SPEC) {
      for (const value of values) {
        expect(res.text).toContain(`${name}{${label}="${value}"} 0`);
      }
    }
  });

  it('forwards a collection failure to the error handler', async () => {
    const register = deps.metrics.register;
    new Gauge({
      name: 'broken_gauge',
      help: 'always throws while collecting',
      registers: [register],
      collect() {
        throw new Error('collect failed');
      },
    });

    const bare = express();
    bare.get('/metrics', createMetricsRoute(register));
    app = bare;
    const res = await request(server).get('/metrics');

    expect(res.status).toBe(500);
    register.removeSingleMetric('broken_gauge');
  });
});
