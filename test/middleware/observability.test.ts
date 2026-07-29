import express, {
  type ErrorRequestHandler,
  type Express,
  type Router,
} from 'express';
import type { Registry } from 'prom-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthMiddleware } from '../../src/middleware/auth';
import {
  ACCESS_LOG_IGNORED_PATHS,
  UNMATCHED_ROUTE,
  createHttpLogger,
  createHttpMetrics,
  requestPath,
  routeLabel,
  serializeRequest,
  serializeResponse,
} from '../../src/middleware/observability';
import { makeDeps, type TestDeps } from '../helpers/deps';

const API_KEY = 'test-key';
const AUTH = `Basic ${Buffer.from(`api:${API_KEY}`, 'utf8').toString('base64')}`;
const SUBSCRIBER = 'alice@example.com';

type MetricJson = Awaited<ReturnType<Registry['getMetricsAsJSON']>>[number];
type MetricValues = MetricJson['values'];

const REQUESTS_TOTAL = 'ghost_ses_proxy_http_requests_total';
const DURATION_SECONDS = 'ghost_ses_proxy_http_request_duration_seconds';

function buildApp(deps: TestDeps): Express {
  const app = express();
  app.use(createHttpLogger(deps));
  app.use(createHttpMetrics(deps));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.get('/metrics', (_req, res) => {
    res.status(200).type('text/plain').send('# metrics');
  });
  app.get('/boom', () => {
    throw new Error('boom');
  });

  const v3: Router = express.Router();
  v3.use(createAuthMiddleware(deps.config));
  v3.post('/:domain/messages', (_req, res) => {
    res.status(200).json({ message: 'Queued. Thank you.' });
  });
  v3.delete('/:domain/:type/:email', (req, res) => {
    res.status(200).json({ address: req.params['email'] });
  });
  v3.get('/:domain/boom', () => {
    throw new Error('boom');
  });
  app.use('/v3', v3);

  const onError: ErrorRequestHandler = (_err, _req, res, _next) => {
    res.status(500).json({ message: 'Internal server error' });
  };
  app.use(onError);

  return app;
}

async function valuesOf(deps: TestDeps, name: string): Promise<MetricValues> {
  const json = await deps.register.getMetricsAsJSON();
  return json.find((metric) => metric.name === name)?.values ?? [];
}

async function requestLabels(deps: TestDeps): Promise<Record<string, unknown>[]> {
  const values = await valuesOf(deps, REQUESTS_TOTAL);
  return values.map((value) => value.labels as Record<string, unknown>);
}

function accessLogs(deps: TestDeps): Record<string, unknown>[] {
  return deps.logs().filter((line) => line['responseTime'] !== undefined);
}

let deps: TestDeps;
let app: Express;

beforeEach(() => {
  deps = makeDeps();
  app = buildApp(deps);
});

afterEach(() => {
  if (deps.db.raw.open) deps.db.close();
});

describe('routeLabel', () => {
  it('joins baseUrl and the route template', () => {
    const req = {
      baseUrl: '/v3',
      route: { path: '/:domain/messages' },
    } as unknown as Parameters<typeof routeLabel>[0];
    expect(routeLabel(req)).toBe('/v3/:domain/messages');
  });

  it('treats a missing baseUrl as empty', () => {
    const req = {
      route: { path: '/health' },
    } as unknown as Parameters<typeof routeLabel>[0];
    expect(routeLabel(req)).toBe('/health');
  });

  it('returns "unmatched" when no route was resolved', () => {
    const req = { baseUrl: '' } as unknown as Parameters<typeof routeLabel>[0];
    expect(routeLabel(req)).toBe(UNMATCHED_ROUTE);
  });

  it('returns "unmatched" when route.path is not a string', () => {
    const req = {
      route: { path: /^\/x$/ },
    } as unknown as Parameters<typeof routeLabel>[0];
    expect(routeLabel(req)).toBe(UNMATCHED_ROUTE);
  });
});

describe('requestPath', () => {
  it('strips the query string', () => {
    expect(requestPath('/v3/example.com/events?limit=3')).toBe(
      '/v3/example.com/events',
    );
  });

  it('returns the path unchanged when there is no query string', () => {
    expect(requestPath('/health')).toBe('/health');
  });

  it('returns an empty string for an undefined url', () => {
    expect(requestPath(undefined)).toBe('');
  });
});

describe('serializers', () => {
  it('emits only method and url, preferring originalUrl', () => {
    const req = {
      method: 'DELETE',
      url: '/example.com/bounces/a%40b.com',
      originalUrl: '/v3/example.com/bounces/a%40b.com',
      baseUrl: '/v3',
      route: { path: '/:domain/:type/:email' },
      headers: { authorization: AUTH },
    } as unknown as Parameters<typeof serializeRequest>[0];

    expect(serializeRequest(req)).toEqual({
      method: 'DELETE',
      url: '/v3/example.com/bounces/a%40b.com',
    });
  });

  it('falls back to url when originalUrl is absent', () => {
    const req = {
      method: 'GET',
      url: '/health',
    } as unknown as Parameters<typeof serializeRequest>[0];
    expect(serializeRequest(req).url).toBe('/health');
  });

  it('falls back to an empty string when neither url is present', () => {
    const req = { method: 'GET' } as unknown as Parameters<
      typeof serializeRequest
    >[0];
    expect(serializeRequest(req).url).toBe('');
  });

  it('emits only the status code for a response', () => {
    const res = { statusCode: 204, getHeaders: () => ({}) } as unknown as Parameters<
      typeof serializeResponse
    >[0];
    expect(serializeResponse(res)).toEqual({ statusCode: 204 });
  });
});

describe('createHttpMetrics', () => {
  it('records the counter and histogram with method, route and status_code', async () => {
    await request(app).get('/health').expect(200);

    expect(await requestLabels(deps)).toEqual([
      { method: 'GET', route: '/health', status_code: '200' },
    ]);

    const durations = await valuesOf(deps, DURATION_SECONDS);
    const count = durations.find(
      (value) =>
        (value as { metricName?: string }).metricName ===
        `${DURATION_SECONDS}_count`,
    );
    expect(count?.value).toBe(1);
    expect(count?.labels).toEqual({
      method: 'GET',
      route: '/health',
      status_code: '200',
    });
  });

  it('labels the route with the Express template, not the raw path', async () => {
    await request(app)
      .delete(`/v3/example.com/bounces/${encodeURIComponent(SUBSCRIBER)}`)
      .set('Authorization', AUTH)
      .expect(200);

    expect(await requestLabels(deps)).toEqual([
      {
        method: 'DELETE',
        route: '/v3/:domain/:type/:email',
        status_code: '200',
      },
    ]);
  });

  it('never lets a subscriber address reach a metric label', async () => {
    await request(app)
      .delete(`/v3/example.com/bounces/${encodeURIComponent(SUBSCRIBER)}`)
      .set('Authorization', AUTH)
      .expect(200);

    const json = await deps.register.getMetricsAsJSON();
    const labelValues = json.flatMap((metric) =>
      metric.values.flatMap((value) =>
        Object.values(value.labels as Record<string, unknown>).map(String),
      ),
    );

    expect(labelValues.length).toBeGreaterThan(0);
    for (const value of labelValues) {
      expect(value).not.toContain('@');
      expect(value).not.toContain('alice');
    }
  });

  it('labels an unmatched path "unmatched"', async () => {
    await request(app).get('/nope').expect(404);

    expect(await requestLabels(deps)).toEqual([
      { method: 'GET', route: UNMATCHED_ROUTE, status_code: '404' },
    ]);
  });

  it('labels a pre-routing 401 "unmatched"', async () => {
    await request(app).post('/v3/example.com/messages').expect(401);

    expect(await requestLabels(deps)).toEqual([
      { method: 'POST', route: UNMATCHED_ROUTE, status_code: '401' },
    ]);
  });

  it('counts /health and /metrics even though they are not access-logged', async () => {
    await request(app).get('/health').expect(200);
    await request(app).get('/metrics').expect(200);

    const labels = await requestLabels(deps);
    expect(labels.map((label) => label['route']).sort()).toEqual([
      '/health',
      '/metrics',
    ]);
    expect(ACCESS_LOG_IGNORED_PATHS.has('/health')).toBe(true);
    expect(ACCESS_LOG_IGNORED_PATHS.has('/metrics')).toBe(true);
  });

  it('accumulates repeated requests on one series', async () => {
    await request(app).get('/health').expect(200);
    await request(app).get('/health').expect(200);

    const values = await valuesOf(deps, REQUESTS_TOTAL);
    expect(values).toHaveLength(1);
    expect(values[0]?.value).toBe(2);
  });

  it('records a 500 with the route template', async () => {
    await request(app).get('/boom').expect(500);

    expect(await requestLabels(deps)).toEqual([
      { method: 'GET', route: '/boom', status_code: '500' },
    ]);
  });

  // Express restores `req.baseUrl` to '' while unwinding to the error handler,
  // but leaves `req.route` set, so a throwing route inside a mounted router
  // loses its mount prefix. Still a bounded template with no PII.
  it('loses the mount prefix when a route inside a mounted router throws', async () => {
    await request(app)
      .get('/v3/example.com/boom')
      .set('Authorization', AUTH)
      .expect(500);

    expect(await requestLabels(deps)).toEqual([
      { method: 'GET', route: '/:domain/boom', status_code: '500' },
    ]);
  });
});

describe('createHttpLogger', () => {
  it('writes one access-log line carrying the trimmed fields', async () => {
    await request(app)
      .post('/v3/example.com/messages?x=1')
      .set('Authorization', AUTH)
      .expect(200);

    const lines = accessLogs(deps);
    expect(lines).toHaveLength(1);
    const line = lines[0] as Record<string, unknown>;

    expect(line['component']).toBe('http');
    expect(line['level']).toBe('info');
    expect(line['req']).toEqual({
      method: 'POST',
      url: '/v3/example.com/messages?x=1',
    });
    expect(line['route']).toBe('/v3/:domain/messages');
    expect(line['res']).toEqual({ statusCode: 200 });
    expect(typeof line['responseTime']).toBe('number');
  });

  it('labels the log line with the route template on the error path too', async () => {
    await request(app).get('/boom').expect(500);

    const lines = accessLogs(deps);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['route']).toBe('/boom');
  });

  it('labels an unrouted log line "unmatched"', async () => {
    await request(app).get('/nope').expect(404);
    expect(accessLogs(deps)[0]?.['route']).toBe(UNMATCHED_ROUTE);
  });

  it('stamps every line with a fresh UUID reqId', async () => {
    await request(app).get('/nope').expect(404);
    await request(app).get('/nope').expect(404);

    const ids = accessLogs(deps).map((line) => line['reqId']);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('suppresses access logs for /health and /metrics but not other paths', async () => {
    await request(app).get('/health').expect(200);
    await request(app).get('/metrics').expect(200);
    expect(accessLogs(deps)).toHaveLength(0);

    await request(app).get('/nope').expect(404);
    expect(accessLogs(deps)).toHaveLength(1);
  });

  it('still suppresses /health when it carries a query string', async () => {
    await request(app).get('/health?verbose=1').expect(200);
    expect(accessLogs(deps)).toHaveLength(0);
  });

  it('maps 4xx to warn and 5xx to error', async () => {
    await request(app).get('/nope').expect(404);
    await request(app).post('/v3/example.com/messages').expect(401);
    await request(app).get('/boom').expect(500);

    expect(accessLogs(deps).map((line) => line['level'])).toEqual([
      'warn',
      'warn',
      'error',
    ]);
  });

  it('never emits the authorization header', async () => {
    await request(app)
      .delete(`/v3/example.com/bounces/${encodeURIComponent(SUBSCRIBER)}`)
      .set('Authorization', AUTH)
      .set('Cookie', 'session=secret')
      .expect(200);

    const serialized = JSON.stringify(deps.logs());
    expect(accessLogs(deps)).toHaveLength(1);
    expect(serialized).not.toContain(AUTH);
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('session=secret');
  });
});
