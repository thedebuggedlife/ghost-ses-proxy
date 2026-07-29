import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { createAuthMiddleware } from '../../src/middleware/auth';
import type { Config, Db } from '../../src/types';
import { makeDeps, TEST_ENV } from '../helpers/deps';

const open: Db[] = [];

function basic(value: string): string {
  return `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;
}

function appFor(config: Config): Express {
  const app = express();
  app.use('/v3', createAuthMiddleware(config));
  app.get('/v3/example.com/events', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

let config: Config;
let app: Express;

beforeEach(() => {
  const deps = makeDeps();
  open.push(deps.db);
  config = deps.config;
  app = appFor(config);
});

afterEach(() => {
  for (const db of open.splice(0)) {
    if (db.raw.open) db.close();
  }
});

describe('createAuthMiddleware', () => {
  it('passes a valid Basic api:<key> credential through', async () => {
    const res = await request(app)
      .get('/v3/example.com/events')
      .set('Authorization', basic(`api:${config.proxyApiKey}`));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('ignores the username and checks only the password', async () => {
    const res = await request(app)
      .get('/v3/example.com/events')
      .set('Authorization', basic(`anyone:${config.proxyApiKey}`));

    expect(res.status).toBe(200);
  });

  it('rejects a missing Authorization header', async () => {
    const res = await request(app).get('/v3/example.com/events');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized: missing credentials' });
  });

  it('rejects a non-Basic scheme', async () => {
    const res = await request(app)
      .get('/v3/example.com/events')
      .set('Authorization', `Bearer ${config.proxyApiKey}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized: missing credentials' });
  });

  it('rejects a lowercase basic scheme', async () => {
    const res = await request(app)
      .get('/v3/example.com/events')
      .set('Authorization', basic(`api:${config.proxyApiKey}`).toLowerCase());

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized: missing credentials' });
  });

  it('rejects malformed base64, which decodes leniently to a value with no colon', async () => {
    const res = await request(app)
      .get('/v3/example.com/events')
      .set('Authorization', 'Basic !!!!not base64!!!!');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized: invalid credentials' });
  });

  it('rejects a credential with no colon', async () => {
    const res = await request(app)
      .get('/v3/example.com/events')
      .set('Authorization', basic('apinocolon'));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized: invalid credentials' });
  });

  it('rejects a bare Basic scheme, whose trailing space HTTP strips in transit', async () => {
    const res = await request(app)
      .get('/v3/example.com/events')
      .set('Authorization', 'Basic ');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized: missing credentials' });
  });

  it('rejects a credential that decodes to an empty string', async () => {
    const res = await request(app)
      .get('/v3/example.com/events')
      .set('Authorization', 'Basic ====');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized: invalid credentials' });
  });

  it('rejects a wrong API key', async () => {
    const res = await request(app)
      .get('/v3/example.com/events')
      .set('Authorization', basic('api:not-the-key'));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized: invalid API key' });
  });

  it('rejects an empty password', async () => {
    const res = await request(app)
      .get('/v3/example.com/events')
      .set('Authorization', basic('api:'));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized: invalid API key' });
  });

  it('accepts an API key containing colons', async () => {
    const deps = makeDeps({
      config: loadConfig({ ...TEST_ENV, PROXY_API_KEY: 'k:e:y' }),
    });
    open.push(deps.db);

    const res = await request(appFor(deps.config))
      .get('/v3/example.com/events')
      .set('Authorization', basic('api:k:e:y'));

    expect(res.status).toBe(200);
  });

  it('does not guard paths outside the mount point', async () => {
    const unguarded = express();
    unguarded.use('/v3', createAuthMiddleware(config));
    unguarded.get('/health', (_req, res) => {
      res.status(200).json({ status: 'ok' });
    });

    const res = await request(unguarded).get('/health');

    expect(res.status).toBe(200);
  });
});
