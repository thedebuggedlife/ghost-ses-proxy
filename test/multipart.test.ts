import { createServer, type Server } from 'node:http';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ARRAY_FIELDS, parseFormData } from '../src/multipart';

function makeApp(): Express {
  const app = express();
  app.post('/', (req, res) => {
    void parseFormData(req).then(
      (fields) => {
        res.json({ ok: true, fields });
      },
      (err: Error) => {
        res.status(400).json({ ok: false, message: err.message });
      },
    );
  });
  return app;
}

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
  app = makeApp();
});

describe('parseFormData', () => {
  it('exposes the repeated-field allowlist', () => {
    expect([...ARRAY_FIELDS].sort()).toEqual(['o:tag', 'to']);
  });

  it('returns single fields as strings', async () => {
    const res = await request(server)
      .post('/')
      .field('from', 'newsletter@example.com')
      .field('subject', 'Weekly digest')
      .field('html', '<p>hi</p>');

    expect(res.status).toBe(200);
    expect(res.body.fields).toMatchObject({
      from: 'newsletter@example.com',
      subject: 'Weekly digest',
      html: '<p>hi</p>',
    });
  });

  it('accumulates repeated to and o:tag fields as arrays', async () => {
    const res = await request(server)
      .post('/')
      .field('from', 'newsletter@example.com')
      .field('to', 'alice@example.com')
      .field('to', 'bob@example.com')
      .field('o:tag', 'bulk-email')
      .field('o:tag', 'ghost-email');

    expect(res.status).toBe(200);
    expect(res.body.fields.to).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
    expect(res.body.fields['o:tag']).toEqual(['bulk-email', 'ghost-email']);
  });

  it('yields a one-element array for a single to field', async () => {
    const res = await request(server)
      .post('/')
      .field('to', 'alice@example.com');

    expect(res.body.fields.to).toEqual(['alice@example.com']);
  });

  it('omits allowlisted fields entirely when they never appear', async () => {
    const res = await request(server).post('/').field('subject', 'no tags');

    expect(res.body.fields).not.toHaveProperty('to');
    expect(res.body.fields).not.toHaveProperty('o:tag');
  });

  it('keeps the last value for a repeated non-allowlisted field', async () => {
    const res = await request(server)
      .post('/')
      .field('subject', 'first')
      .field('subject', 'second');

    expect(res.body.fields.subject).toBe('second');
  });

  it('passes h:* and v:* fields through as strings', async () => {
    const res = await request(server)
      .post('/')
      .field('h:Reply-To', 'reply@example.com')
      .field('h:List-Unsubscribe', '<https://example.com/unsub>')
      .field('v:email-id', '650000000000000000000001');

    expect(res.body.fields).toMatchObject({
      'h:Reply-To': 'reply@example.com',
      'h:List-Unsubscribe': '<https://example.com/unsub>',
      'v:email-id': '650000000000000000000001',
    });
  });

  it('resolves an empty object for a body with no fields', async () => {
    const res = await request(server)
      .post('/')
      .set('Content-Type', 'multipart/form-data; boundary=EMPTY')
      .send('--EMPTY--\r\n');

    expect(res.status).toBe(200);
    expect(res.body.fields).toEqual({});
  });

  it('preserves UTF-8 field values', async () => {
    const res = await request(server)
      .post('/')
      .field('subject', 'Résumé — 日本語');

    expect(res.body.fields.subject).toBe('Résumé — 日本語');
  });

  it('rejects an unsupported content type', async () => {
    const res = await request(server)
      .post('/')
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^Invalid multipart form-data: /);
  });

  it('rejects a multipart content type with no boundary', async () => {
    const res = await request(server)
      .post('/')
      .set('Content-Type', 'multipart/form-data')
      .send('nothing');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^Invalid multipart form-data: /);
  });

  it('rejects when busboy errors on a truncated body', async () => {
    const res = await request(server)
      .post('/')
      .set('Content-Type', 'multipart/form-data; boundary=TRUNC')
      .send('--TRUNC\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue');

    expect(res.status).toBe(400);
    expect(res.body.message).toBeTruthy();
  });
});
