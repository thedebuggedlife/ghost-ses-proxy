import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
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
  vi,
} from 'vitest';

const { throwForRecipients } = vi.hoisted(() => ({
  throwForRecipients: new Set<string>(),
}));

// The D1 regression needs a throw *before* the SES call, inside `runExclusive`'s
// callback. Everything else delegates to the real implementation.
vi.mock('../../src/mime', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/mime')>('../../src/mime');
  return {
    ...actual,
    buildRawMime: (
      opts: import('../../src/mime').MimeOptions,
      genBoundary?: () => string,
    ): string => {
      if (throwForRecipients.has(opts.to)) {
        throw new Error('induced failure before SES call');
      }
      return actual.buildRawMime(opts, genBoundary);
    },
  };
});

import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { RECIPIENT_OUTCOMES, SEND_OUTCOMES } from '../../src/metrics';
import {
  listField,
  scalarField,
  stripUnsubscribePlaceholder,
} from '../../src/routes/send-email';
import scenarios from '../golden/captured/send-scenarios.json';
import {
  createSesStub,
  makeDeps,
  TEST_ENV,
  type SesStub,
  type TestDeps,
} from '../helpers/deps';
import { normalisedChildren } from '../helpers/metrics';

const AUTH = `Basic ${Buffer.from('api:test-key', 'utf8').toString('base64')}`;
const CAPTURED = join(__dirname, '..', 'golden', 'captured');

type Fields = Record<string, string | string[]>;

// One listening socket for the whole file, delegating to whichever app the
// current test built. Passing the Express app to supertest instead binds a
// fresh ephemeral server per call, which is what makes these tests hang
// intermittently.
let currentApp: Express;
let server: Server;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        currentApp(req, res);
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

/** Routes the shared socket at `app` and returns a supertest agent for it. */
function serve(app: Express): request.Agent {
  currentApp = app;
  return request(server);
}

function post(app: Express, fields: Fields): request.Test {
  let req = serve(app)
    .post('/v3/example.com/messages')
    .set('Authorization', AUTH);

  for (const [name, value] of Object.entries(fields)) {
    for (const single of Array.isArray(value) ? value : [value]) {
      req = req.field(name, single);
    }
  }
  return req;
}

/** Same substitutions as `scripts/normalize.cjs` for the values a MIME body carries. */
function normalizeMime(raw: string): string {
  return raw
    .replace(/----=_Part_[0-9a-f]{32}/g, '----=_Part_<BOUNDARY>')
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      '<BATCH_UUID>',
    );
}

function capturedMime(name: string): string {
  return readFileSync(join(CAPTURED, `mime-${name}.txt`), 'utf8');
}

interface CountRow {
  c: number;
}

describe('POST /v3/:domain/messages', () => {
  let deps: TestDeps;
  let ses: SesStub;
  let app: Express;

  beforeEach(() => {
    throwForRecipients.clear();
    ses = createSesStub();
    ses.respond = (_call, index) =>
      Promise.resolve({ messageId: `ses-message-${index}` });
    deps = makeDeps({ ses });
    app = createApp(deps);
  });

  afterEach(() => {
    deps.db.close();
  });

  function count(table: string): number {
    return (
      deps.db.raw
        .prepare<unknown[], CountRow>(`SELECT COUNT(*) AS c FROM ${table}`)
        .get() as CountRow
    ).c;
  }

  async function metricValues(
    name: string,
  ): Promise<{ labels: Record<string, string | number>; value: number }[]> {
    const json = await deps.register.getMetricsAsJSON();
    const values = json.find((metric) => metric.name === name)?.values ?? [];
    return values as {
      labels: Record<string, string | number>;
      value: number;
    }[];
  }

  async function batchOutcomes(): Promise<Record<string, number>> {
    return normalisedChildren(
      deps.register,
      'ghost_ses_proxy_send_batches_total',
      'outcome',
      SEND_OUTCOMES,
    );
  }

  async function recipientOutcomes(): Promise<Record<string, number>> {
    return normalisedChildren(
      deps.register,
      'ghost_ses_proxy_send_recipients_total',
      'outcome',
      RECIPIENT_OUTCOMES,
    );
  }

  async function gaugeValue(name: string): Promise<number> {
    const values = await metricValues(name);
    return values[0]?.value ?? 0;
  }

  describe('field helpers', () => {
    it('scalarField reads the first value of a repeated field', () => {
      expect(scalarField('a')).toBe('a');
      expect(scalarField(['a', 'b'])).toBe('a');
      expect(scalarField([])).toBe('');
      expect(scalarField(undefined)).toBe('');
    });

    it('listField normalizes a scalar to a single-element array', () => {
      expect(listField(['a', 'b'])).toEqual(['a', 'b']);
      expect(listField('a')).toEqual(['a']);
      expect(listField(undefined)).toEqual([]);
    });

    it('stripUnsubscribePlaceholder removes the placeholder and its comma', () => {
      expect(
        stripUnsubscribePlaceholder('<https://x/u>, <%tag_unsubscribe_email%>'),
      ).toBe('<https://x/u>');
      expect(
        stripUnsubscribePlaceholder('<%tag_unsubscribe_email%>, <https://x/u>'),
      ).toBe('<https://x/u>');
      expect(stripUnsubscribePlaceholder('<https://x/u>')).toBe('<https://x/u>');
    });
  });

  describe('happy path', () => {
    it('returns the Mailgun body and records the batch', async () => {
      const res = await post(app, scenarios.canonical.fields);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: expect.stringMatching(
          /^<[0-9a-f-]{36}@example\.com>$/,
        ) as unknown as string,
        message: 'Queued. Thank you.',
      });
      expect(count('message_map')).toBe(1);
      expect(count('recipient_emails')).toBe(2);
    });

    it('stores the batch and per-recipient correlation rows', async () => {
      const res = await post(app, scenarios.canonical.fields);
      const batchMessageId = (res.body as { id: string }).id;

      const batch = deps.db.raw
        .prepare('SELECT * FROM message_map WHERE batch_message_id = ?')
        .get(batchMessageId);
      expect(batch).toMatchObject({
        ghost_email_id: '650000000000000000000001',
        tags: '["bulk-email","ghost-email"]',
      });

      const rows = deps.db.raw
        .prepare('SELECT * FROM recipient_emails ORDER BY recipient')
        .all();
      expect(rows).toMatchObject([
        {
          recipient: 'alice@example.com',
          batch_message_id: batchMessageId,
          ghost_email_id: '650000000000000000000001',
          tags: '["bulk-email","ghost-email"]',
        },
        { recipient: 'bob@example.com', batch_message_id: batchMessageId },
      ]);
    });

    it('passes the configuration set and correlation context to SES', async () => {
      await post(app, scenarios.canonical.fields);

      expect(ses.calls).toHaveLength(2);
      expect(ses.calls[0]?.configurationSetName).toBe('ghost-ses-proxy');
      expect(ses.calls[0]?.context).toMatchObject({
        recipient: 'alice@example.com',
        batchId: expect.stringMatching(
          /^[0-9a-f-]{36}@example\.com$/,
        ) as unknown as string,
        reqId: expect.any(String) as unknown as string,
      });
    });

    it('counts the batch as success and both recipients as sent', async () => {
      await post(app, scenarios.canonical.fields);

      expect(await batchOutcomes()).toEqual({
        success: 1,
        partial: 0,
        failure: 0,
        rejected: 0,
      });
      expect(await recipientOutcomes()).toEqual({ sent: 2, failed: 0 });
    });

    it('observes the batch size histogram once per batch', async () => {
      await post(app, scenarios.canonical.fields);

      const exposition = await deps.register.metrics();
      expect(exposition).toContain('ghost_ses_proxy_send_batch_recipients_sum 2');
      expect(exposition).toContain(
        'ghost_ses_proxy_send_batch_recipients_count 1',
      );
    });

    it('logs the batch outcome with the design §3 field schema', async () => {
      await post(app, scenarios.canonical.fields);

      const batchLines = deps
        .logs()
        .filter(
          (line) => line['component'] === 'send' && line['msg'] === 'sent batch',
        );
      expect(batchLines).toMatchObject([
        {
          component: 'send',
          ghostEmailId: '650000000000000000000001',
          recipientCount: 2,
          succeeded: 2,
          failed: 0,
        },
      ]);
      expect(batchLines[0]?.['reqId']).toEqual(expect.any(String));
      expect(batchLines[0]?.['batchId']).not.toContain('<');
    });

    it('logs a debug line per recipient', async () => {
      await post(app, scenarios.canonical.fields);

      expect(
        deps
          .logs()
          .filter((line) => line['msg'] === 'sent to recipient')
          .map((line) => line['recipient']),
      ).toEqual(['alice@example.com', 'bob@example.com']);
    });

    it('labels the HTTP metric with the route template', async () => {
      await post(app, scenarios.canonical.fields);

      expect(
        (await metricValues('ghost_ses_proxy_http_requests_total')).map(
          (entry) => entry.labels,
        ),
      ).toEqual([
        { method: 'POST', route: '/v3/:domain/messages', status_code: '200' },
      ]);
    });

    it('requires authentication', async () => {
      const res = await serve(app)
        .post('/v3/example.com/messages')
        .field('from', 'a@example.com');

      expect(res.status).toBe(401);
      expect(ses.calls).toHaveLength(0);
    });
  });

  describe('raw MIME', () => {
    it('reproduces the captured canonical messages, one per recipient', async () => {
      await post(app, scenarios.canonical.fields);

      expect(normalizeMime(ses.calls[0]?.rawMessage ?? '')).toBe(
        capturedMime('canonical-0'),
      );
      expect(normalizeMime(ses.calls[1]?.rawMessage ?? '')).toBe(
        capturedMime('canonical-1'),
      );
    });

    it('substitutes recipient variables differently per message', async () => {
      await post(app, scenarios.canonical.fields);

      const [alice, bob] = ses.calls.map((call) => call.rawMessage);
      expect(alice).not.toBe(bob);
      expect(alice).toContain(
        'List-Unsubscribe: <https://example.com/unsubscribe/alice>',
      );
      expect(bob).toContain(
        'List-Unsubscribe: <https://example.com/unsubscribe/bob>',
      );
    });

    it.each([
      ['no-text', 'no-text-0'],
      ['no-html', 'no-html-0'],
      ['custom-headers', 'custom-headers-0'],
      ['utf8', 'utf8-0'],
    ] as const)('reproduces the captured %s message', async (scenario, file) => {
      await post(app, scenarios[scenario].fields);

      expect(normalizeMime(ses.calls[0]?.rawMessage ?? '')).toBe(
        capturedMime(file),
      );
    });

    it('omits X-Ghost-Email-Id when v:email-id is absent', async () => {
      await post(app, {
        from: 'newsletter@example.com',
        subject: 'No ghost id',
        to: ['alice@example.com'],
        text: 'body',
      });

      expect(ses.calls[0]?.rawMessage).not.toContain('X-Ghost-Email-Id');
    });

    it('strips the unsubscribe placeholder and the comma it leaves behind', async () => {
      await post(app, {
        from: 'newsletter@example.com',
        subject: 'Unsub',
        to: ['alice@example.com'],
        text: 'body',
        'h:List-Unsubscribe': '<https://example.com/u>, <%tag_unsubscribe_email%>',
      });

      expect(ses.calls[0]?.rawMessage).toContain(
        'List-Unsubscribe: <https://example.com/u>\r\n',
      );
    });
  });

  describe('validation', () => {
    it.each(['missing-from'] as const)(
      'rejects the captured %s scenario with 400',
      async (scenario) => {
        const res = await post(app, scenarios[scenario].fields);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          message: 'Missing required fields: from, subject, to',
        });
      },
    );

    it.each([
      ['subject', { from: 'a@example.com', to: ['x@example.com'] }],
      ['to', { from: 'a@example.com', subject: 'Hi' }],
    ] as [string, Fields][])(
      'rejects a request with no %s',
      async (_name, fields) => {
        const res = await post(app, fields);

        expect(res.status).toBe(400);
        expect(ses.calls).toHaveLength(0);
        expect(count('message_map')).toBe(0);
      },
    );

    it('rejects malformed recipient-variables JSON', async () => {
      const res = await post(
        app,
        scenarios['malformed-recipient-variables'].fields,
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: 'Invalid recipient-variables JSON' });
      expect(count('message_map')).toBe(0);
    });

    it('counts both validation failures as rejected batches', async () => {
      await post(app, scenarios['missing-from'].fields);
      await post(app, scenarios['malformed-recipient-variables'].fields);

      expect(await batchOutcomes()).toEqual({
        success: 0,
        partial: 0,
        failure: 0,
        rejected: 2,
      });
      expect(await recipientOutcomes()).toEqual({ sent: 0, failed: 0 });
    });

    it('returns 500 without incrementing any send_batches_total outcome when the body is not multipart', async () => {
      const res = await serve(app)
        .post('/v3/example.com/messages')
        .set('Authorization', AUTH)
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(res.status).toBe(500);
      expect((res.body as { message: string }).message).toMatch(
        /^Internal server error: /,
      );
      expect(await batchOutcomes()).toEqual({
        success: 0,
        partial: 0,
        failure: 0,
        rejected: 0,
      });
    });

    it('returns 500 and increments no batch outcome when the batch insert fails', async () => {
      deps.db.insertMessageMap = () => {
        throw new Error('database is locked');
      };

      const res = await post(app, scenarios.canonical.fields);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        message: 'Internal server error: database is locked',
      });
      expect(await batchOutcomes()).toEqual({
        success: 0,
        partial: 0,
        failure: 0,
        rejected: 0,
      });
    });
  });

  describe('SES failures', () => {
    it('reproduces the captured all-recipients-fail response', async () => {
      ses.respond = () => Promise.reject(new Error('SES unavailable'));

      const res = await post(app, scenarios['all-recipients-fail'].fields);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        message: 'Failed to send to all recipients',
        errors: [
          { recipient: 'alice@example.com', error: 'SES unavailable' },
          { recipient: 'bob@example.com', error: 'SES unavailable' },
        ],
      });
      expect(await batchOutcomes()).toEqual({
        success: 0,
        partial: 0,
        failure: 1,
        rejected: 0,
      });
      expect(count('recipient_emails')).toBe(0);
    });

    it('returns 200 and counts a partial batch when one recipient fails', async () => {
      ses.respond = (call, index) =>
        call.context?.recipient === 'bob@example.com'
          ? Promise.reject(new Error('SES unavailable'))
          : Promise.resolve({ messageId: `ses-message-${index}` });

      const res = await post(app, scenarios.canonical.fields);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ message: 'Queued. Thank you.' });
      expect(await batchOutcomes()).toEqual({
        success: 0,
        partial: 1,
        failure: 0,
        rejected: 0,
      });
      expect(await recipientOutcomes()).toEqual({ sent: 1, failed: 1 });
      expect(count('recipient_emails')).toBe(1);
    });

    it('counts a recipient whose send returns no MessageId as failed', async () => {
      ses.respond = () => Promise.resolve({ messageId: undefined });

      const res = await post(app, scenarios['no-text'].fields);

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({
        errors: [
          {
            recipient: 'alice@example.com',
            error: 'SES returned no MessageId',
          },
        ],
      });
    });

    it('logs the failing recipient at error level', async () => {
      ses.respond = () => Promise.reject(new Error('SES unavailable'));

      await post(app, scenarios['all-recipients-fail'].fields);

      expect(
        deps
          .logs()
          .filter((line) => line['msg'] === 'failed to send to recipient')
          .map((line) => line['recipient']),
      ).toEqual(['alice@example.com', 'bob@example.com']);
    });
  });

  describe('concurrency', () => {
    it('never exceeds SEND_CONCURRENCY in flight', async () => {
      const concurrentDeps = makeDeps({
        ses,
        config: loadConfig({ ...TEST_ENV, SEND_CONCURRENCY: '2' }),
      });
      const concurrentApp = createApp(concurrentDeps);

      let inFlight = 0;
      let observedMax = 0;
      ses.respond = (_call, index) =>
        new Promise((resolve) => {
          inFlight += 1;
          observedMax = Math.max(observedMax, inFlight);
          setImmediate(() => {
            inFlight -= 1;
            resolve({ messageId: `ses-message-${index}` });
          });
        });

      const res = await post(concurrentApp, {
        from: 'newsletter@example.com',
        subject: 'Fan out',
        to: [
          'a@example.com',
          'b@example.com',
          'c@example.com',
          'd@example.com',
          'e@example.com',
          'f@example.com',
        ],
        text: 'body',
      });

      expect(res.status).toBe(200);
      expect(ses.calls).toHaveLength(6);
      expect(observedMax).toBe(2);
      concurrentDeps.db.close();
    });
  });

  // design §5.1 / test/golden/intent/d1-semaphore-release.json
  describe('D1 — a throw before the SES call must not wedge the semaphore', () => {
    let d1Deps: TestDeps;
    let d1App: Express;

    beforeEach(() => {
      d1Deps = makeDeps({
        ses,
        config: loadConfig({ ...TEST_ENV, SEND_CONCURRENCY: '2' }),
      });
      d1App = createApp(d1Deps);
    });

    afterEach(() => {
      d1Deps.db.close();
    });

    const fields: Fields = {
      from: 'Newsletter <newsletter@example.com>',
      subject: 'Weekly digest',
      to: ['alice@example.com', 'bob@example.com'],
      html: '<p>Hello</p>',
      text: 'Hello',
    };

    async function d1BatchOutcomes(): Promise<Record<string, number>> {
      return normalisedChildren(
        d1Deps.register,
        'ghost_ses_proxy_send_batches_total',
        'outcome',
        SEND_OUTCOMES,
      );
    }

    async function d1Gauge(name: string): Promise<number> {
      const json = await d1Deps.register.getMetricsAsJSON();
      return json.find((metric) => metric.name === name)?.values[0]?.value ?? 0;
    }

    it('completes as partial with 200 and releases the slot', async () => {
      throwForRecipients.add('alice@example.com');

      const res = await serve(d1App)
        .post('/v3/example.com/messages')
        .set('Authorization', AUTH)
        .field('from', String(fields['from']))
        .field('subject', String(fields['subject']))
        .field('to', 'alice@example.com')
        .field('to', 'bob@example.com')
        .field('html', String(fields['html']))
        .field('text', String(fields['text']));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: expect.stringMatching(
          /^<[0-9a-f-]{36}@example\.com>$/,
        ) as unknown as string,
        message: 'Queued. Thank you.',
      });
      expect(await d1BatchOutcomes()).toEqual({
        success: 0,
        partial: 1,
        failure: 0,
        rejected: 0,
      });
      expect(await d1Gauge('ghost_ses_proxy_send_in_flight')).toBe(0);
      expect(await d1Gauge('ghost_ses_proxy_send_queue_depth')).toBe(0);

      const recipients = d1Deps.db.raw
        .prepare('SELECT recipient FROM recipient_emails')
        .all();
      expect(recipients).toEqual([{ recipient: 'bob@example.com' }]);
    });

    it('still answers subsequent sends after the throw', async () => {
      throwForRecipients.add('alice@example.com');
      await post(d1App, fields);
      throwForRecipients.clear();

      // Repeated sendConcurrency times so a leaked slot cannot hide behind spare capacity.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await post(d1App, {
          from: 'newsletter@example.com',
          subject: `Follow-up ${attempt}`,
          to: ['alice@example.com', 'bob@example.com'],
          text: 'Hello',
        });
        expect(res.status).toBe(200);
      }

      expect(await d1BatchOutcomes()).toEqual({
        success: 2,
        partial: 1,
        failure: 0,
        rejected: 0,
      });
      expect(await d1Gauge('ghost_ses_proxy_send_in_flight')).toBe(0);
    });

    it('returns the failure shape when every recipient throws', async () => {
      throwForRecipients.add('alice@example.com');
      throwForRecipients.add('bob@example.com');

      const res = await post(d1App, fields);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        message: 'Failed to send to all recipients',
        errors: [
          {
            recipient: 'alice@example.com',
            error: 'induced failure before SES call',
          },
          {
            recipient: 'bob@example.com',
            error: 'induced failure before SES call',
          },
        ],
      });
      expect(await d1BatchOutcomes()).toEqual({
        success: 0,
        partial: 0,
        failure: 1,
        rejected: 0,
      });
      expect(await d1Gauge('ghost_ses_proxy_send_in_flight')).toBe(0);
      expect(ses.calls).toHaveLength(0);
    });
  });

  it('reports zero in-flight sends when idle', async () => {
    expect(await gaugeValue('ghost_ses_proxy_send_in_flight')).toBe(0);
    expect(await gaugeValue('ghost_ses_proxy_send_queue_depth')).toBe(0);
  });
});
