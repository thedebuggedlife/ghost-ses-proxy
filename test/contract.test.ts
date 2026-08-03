import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import type { Express } from 'express';
import type { Registry } from 'prom-client';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { throwForRecipients } = vi.hoisted(() => ({
  throwForRecipients: new Set<string>(),
}));

// D1 (design §5.1) needs a throw *before* the SES call, inside `runExclusive`'s
// callback. Every other assertion in this file uses the real implementation.
vi.mock('../src/mime', async () => {
  const actual =
    await vi.importActual<typeof import('../src/mime')>('../src/mime');
  return {
    ...actual,
    buildRawMime: (
      opts: import('../src/mime').MimeOptions,
      genBoundary?: () => string,
    ): string => {
      if (throwForRecipients.has(opts.to)) {
        throw new Error('induced failure before SES call');
      }
      return actual.buildRawMime(opts, genBoundary);
    },
  };
});

import { createApp } from '../src/app';
import { runCleanup } from '../src/cleanup';
import { loadConfig } from '../src/config';
import { mapSesEvent } from '../src/event-mapper';
import { SQS_PARSE_ERROR_REASONS } from '../src/metrics';
import { clampLimit } from '../src/routes/events';
import { TABLE_NAMES } from '../src/schema';
import { SqsPoller } from '../src/sqs-poller';
import { substituteVars } from '../src/template-vars';
import type { EventRow } from '../src/types';
import capturedSchema from './golden/captured/schema.json';
import eventsSeedJson from './golden/captured/events-seed.json';
import sendScenariosJson from './golden/captured/send-scenarios.json';
import suppressionsSeedJson from './golden/captured/suppressions-seed.json';
import capturedTemplateVars from './golden/captured/template-vars.json';
import d1Fixture from './golden/intent/d1-semaphore-release.json';
import d2Fixture from './golden/intent/d2-suppression-retention.json';
import d3Fixture from './golden/intent/d3-redelivery-dedupe.json';
import d4LimitFixture from './golden/intent/d4-limit-clamp.json';
import d4RepeatedFixture from './golden/intent/d4-repeated-query-param.json';
import d7Fixture from './golden/intent/d7-malformed-payload.json';
import {
  createSesStub,
  makeDeps,
  TEST_ENV,
  type SesStub,
  type TestDeps,
} from './helpers/deps';
import { rawSqsBody, sesEvent, sesFixtureNames } from './helpers/fixtures';
import { normalisedChildren } from './helpers/metrics';
import { normalize, normalizeValue } from './helpers/normalize';

// --- Fixture access ---------------------------------------------------------

const CAPTURED = join(__dirname, 'golden', 'captured');

const capturedFiles = readdirSync(CAPTURED);

function capturedText(name: string): string {
  return readFileSync(join(CAPTURED, name), 'utf8');
}

function capturedJson<T>(name: string): T {
  return JSON.parse(capturedText(name)) as T;
}

interface HttpFixture {
  _request: {
    method: string;
    path: string;
    auth: boolean;
    scenario?: string;
  };
  status: number;
  body: unknown;
}

const httpFixtures = (prefix: string): string[] =>
  capturedFiles.filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();

/** `mime-<scenario>-<index>.txt` — the index is always the trailing segment. */
const mimeFilesByScenario = new Map<string, string[]>();
for (const file of capturedFiles.filter((f) => f.startsWith('mime-')).sort()) {
  const match = /^mime-(.*)-(\d+)\.txt$/.exec(file);
  if (!match?.[1] || !match[2]) throw new Error(`unparsable MIME file: ${file}`);
  const list = mimeFilesByScenario.get(match[1]) ?? [];
  list[Number(match[2])] = file;
  mimeFilesByScenario.set(match[1], list);
}

interface SendScenario {
  sesBehaviour: string;
  fields: Record<string, string | string[]>;
}

const sendScenarios = sendScenariosJson as unknown as Record<
  string,
  SendScenario
>;

const eventsSeed = eventsSeedJson as unknown as EventRow[];
const suppressionsSeed = suppressionsSeedJson as unknown as {
  email: string;
  type: string;
  reason: string;
}[];

interface PragmaRow {
  [column: string]: unknown;
}

const schemaFixture = capturedSchema as unknown as Record<
  string,
  { table_info: PragmaRow[]; index_list: PragmaRow[] }
>;

const templateVarCases = capturedTemplateVars as unknown as Record<
  string,
  {
    input: { str: string; vars: Record<string, string> | null };
    output: string;
  }
>;

// --- Harness ----------------------------------------------------------------

const AUTH = `Basic ${Buffer.from('api:test-key', 'utf8').toString('base64')}`;

/**
 * Design Decision P8: `paging.next` is built from `req.headers.host` and is never
 * normalized (design §8.4), so every request must claim the host the capture used.
 */
const HOST = 'localhost:3003';

const openDeps: TestDeps[] = [];

function newDeps(overrides: Parameters<typeof makeDeps>[0] = {}): TestDeps {
  const deps = makeDeps(overrides);
  openDeps.push(deps);
  return deps;
}

function seedGolden(deps: TestDeps): void {
  for (const row of eventsSeed) deps.db.insertEvent(row);
  for (const row of suppressionsSeed) {
    deps.db.insertSuppression(row.email, row.type, row.reason);
  }
}

function pin(test: request.Test, auth: boolean): request.Test {
  const pinned = test.set('Host', HOST);
  return auth ? pinned.set('Authorization', AUTH) : pinned;
}

function post(
  app: Express,
  fields: Record<string, string | string[]>,
): request.Test {
  let req = pin(request(app).post('/v3/example.com/messages'), true);
  for (const [name, value] of Object.entries(fields)) {
    for (const single of Array.isArray(value) ? value : [value]) {
      req = req.field(name, single);
    }
  }
  return req;
}

interface MetricValue {
  labels: Record<string, string | number>;
  value: number;
}

async function metricValues(
  register: Registry,
  name: string,
): Promise<MetricValue[]> {
  const json = await register.getMetricsAsJSON();
  const metric = json.find((entry) => entry.name === name);
  return ((metric as { values?: unknown } | undefined)?.values ??
    []) as MetricValue[];
}

async function metricValue(
  register: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  const values = await metricValues(register, name);
  return values.find((entry) =>
    Object.entries(labels).every(([key, value]) => entry.labels[key] === value),
  )?.value;
}

const sqsMock = mockClient(SQSClient);

function injectedSqsClient(): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' },
  });
}

function queue(...bodies: string[]): void {
  sqsMock.on(ReceiveMessageCommand).resolves({
    Messages: bodies.map((Body, index) => ({
      MessageId: `msg-${index}`,
      ReceiptHandle: `receipt-${index}`,
      Body,
    })),
  });
}

beforeEach(() => {
  throwForRecipients.clear();
  sqsMock.reset();
  sqsMock.on(DeleteMessageCommand).resolves({});
});

afterEach(() => {
  for (const deps of openDeps.splice(0)) {
    if (deps.db.raw.open) deps.db.close();
  }
});

afterAll(() => {
  sqsMock.restore();
});

// --- 15.2  Non-HTTP captures ------------------------------------------------

describe('captured/event-map-*.json', () => {
  it.each(sesFixtureNames)(
    'mapSesEvent reproduces the captured output for %s',
    (name) => {
      const expected = capturedJson<unknown>(`event-map-${name}.json`);

      expect(normalizeValue(mapSesEvent(sesEvent(name)))).toEqual(expected);
    },
  );

  it('covers every captured event-map fixture', () => {
    expect(
      capturedFiles.filter((f) => f.startsWith('event-map-')).sort(),
    ).toEqual(sesFixtureNames.map((n) => `event-map-${n}.json`).sort());
  });
});

describe('captured/template-vars.json', () => {
  it.each(Object.keys(templateVarCases))(
    'substituteVars reproduces the captured output for %s',
    (name) => {
      const testCase = templateVarCases[name];
      if (!testCase) throw new Error(`unknown template-vars case: ${name}`);

      expect(
        normalize(substituteVars(testCase.input.str, testCase.input.vars)),
      ).toBe(testCase.output);
    },
  );
});

describe('captured/schema.json', () => {
  it.each(TABLE_NAMES)(
    'the %s table matches the captured PRAGMAs',
    (table) => {
      const deps = newDeps();
      const expected = schemaFixture[table];

      expect(deps.db.raw.prepare(`PRAGMA table_info(${table})`).all()).toEqual(
        expected?.table_info,
      );
      expect(deps.db.raw.prepare(`PRAGMA index_list(${table})`).all()).toEqual(
        expected?.index_list,
      );
    },
  );
});

// --- 15.3  HTTP captures ----------------------------------------------------

describe('captured/http-health.json', () => {
  it('reproduces the captured body against the seed the capture used', async () => {
    const fixture = capturedJson<
      HttpFixture & {
        _precondition: { expectedCounts: Record<string, number> };
      }
    >('http-health.json');

    // The capture recorded /health before any send scenario ran, so the database
    // must hold the two seeds and nothing else (critique finding 7).
    const deps = newDeps();
    seedGolden(deps);
    expect(fixture._precondition.expectedCounts).toEqual({
      message_map: 0,
      recipient_emails: 0,
      events: eventsSeed.length,
      suppressions: suppressionsSeed.length,
    });

    const res = await pin(
      request(createApp(deps)).get(fixture._request.path),
      fixture._request.auth,
    );

    expect(res.status).toBe(fixture.status);
    expect(res.body).toEqual(fixture.body);
  });
});

describe('captured/http-events-*.json', () => {
  it.each(httpFixtures('http-events-'))('reproduces %s', async (file) => {
    const fixture = capturedJson<HttpFixture>(file);
    const deps = newDeps();
    seedGolden(deps);

    const res = await pin(
      request(createApp(deps)).get(fixture._request.path),
      fixture._request.auth,
    );

    expect(res.status).toBe(fixture.status);
    expect(normalizeValue(res.body)).toEqual(fixture.body);
  });
});

describe('captured/http-suppression-*.json', () => {
  it('reproduces every captured suppression response, in capture order', async () => {
    const deps = newDeps();
    seedGolden(deps);
    const app = createApp(deps);

    // Order is load-bearing: the capture deleted the seeded bounce first, so the
    // `+`-literal request that follows asserts path decoding, not deletion.
    for (const file of [
      'http-suppression-bounces-encoded.json',
      'http-suppression-plus-literal.json',
      'http-suppression-complaints.json',
      'http-suppression-unknown-type.json',
    ]) {
      const fixture = capturedJson<HttpFixture>(file);

      const res = await pin(
        request(app).delete(fixture._request.path),
        fixture._request.auth,
      );

      expect({ file, status: res.status, body: res.body }).toEqual({
        file,
        status: fixture.status,
        body: fixture.body,
      });
    }
  });

  it('covers every captured suppression fixture', () => {
    expect(httpFixtures('http-suppression-')).toEqual([
      'http-suppression-bounces-encoded.json',
      'http-suppression-complaints.json',
      'http-suppression-plus-literal.json',
      'http-suppression-unknown-type.json',
    ]);
  });
});

describe('captured/http-send-*.json', () => {
  it.each(httpFixtures('http-send-'))(
    'reproduces the response and raw MIME for %s',
    async (file) => {
      const fixture = capturedJson<HttpFixture>(file);
      const name = fixture._request.scenario;
      if (!name) throw new Error(`${file} has no _request.scenario`);
      const scenario = sendScenarios[name];
      if (!scenario) throw new Error(`unknown send scenario: ${name}`);

      const ses = createSesStub();
      if (scenario.sesBehaviour === 'fail') {
        ses.respond = () => Promise.reject(new Error('SES unavailable'));
      }
      const deps = newDeps({ ses });

      const res = await post(createApp(deps), scenario.fields);

      expect(res.status).toBe(fixture.status);
      expect(normalizeValue(res.body)).toEqual(fixture.body);

      // The captured MIME is the output of the whole pipeline (busboy parse →
      // substituteVars → placeholder stripping → h:* collection →
      // X-Ghost-Email-Id → buildRawMime), so it is asserted the same way.
      const mimeFiles = mimeFilesByScenario.get(name) ?? [];
      expect(ses.calls).toHaveLength(mimeFiles.length);
      mimeFiles.forEach((mimeFile, index) => {
        expect(normalize(ses.calls[index]?.rawMessage ?? '')).toBe(
          capturedText(mimeFile),
        );
      });
    },
  );

  it('covers every captured MIME fixture', () => {
    const covered = httpFixtures('http-send-').map(
      (file) => capturedJson<HttpFixture>(file)._request.scenario,
    );
    for (const scenario of mimeFilesByScenario.keys()) {
      expect(covered).toContain(scenario);
    }
  });
});

// --- 15.4  Intent fixtures --------------------------------------------------

describe('intent/d1-semaphore-release.json (D1)', () => {
  const scenario = d1Fixture.scenario;
  const fields = scenario.request.fields as Record<string, string | string[]>;

  function d1Deps(): TestDeps {
    return newDeps({
      config: loadConfig({
        ...TEST_ENV,
        SEND_CONCURRENCY: String(scenario.sendConcurrency),
      }),
    });
  }

  it('completes as partial with 200, releases the slot, and keeps serving', async () => {
    const deps = d1Deps();
    const app = createApp(deps);
    throwForRecipients.add(scenario.inducedFailure.recipient);

    const res = await post(app, fields);

    expect(res.status).toBe(d1Fixture.expected.status);
    expect(normalizeValue(res.body)).toEqual(d1Fixture.expected.body);
    expect(
      await metricValue(deps.register, 'ghost_ses_proxy_send_batches_total', {
        outcome: d1Fixture.expected.outcome,
      }),
    ).toBe(1);
    expect(
      await metricValue(deps.register, 'ghost_ses_proxy_send_recipients_total', {
        outcome: 'sent',
      }),
    ).toBe(d1Fixture.expected.recipients.succeeded);
    expect(
      await metricValue(deps.register, 'ghost_ses_proxy_send_recipients_total', {
        outcome: 'failed',
      }),
    ).toBe(d1Fixture.expected.recipients.failed);
    expect(
      await metricValue(deps.register, 'ghost_ses_proxy_send_in_flight'),
    ).toBe(0);

    // A leaked slot cannot hide behind spare capacity if the follow-up send is
    // repeated sendConcurrency times.
    throwForRecipients.clear();
    for (
      let attempt = 0;
      attempt < d1Fixture.expected.subsequentSendSucceeds.repeatCount;
      attempt += 1
    ) {
      const followUp = await post(app, fields);
      expect(followUp.status).toBe(
        d1Fixture.expected.subsequentSendSucceeds.status,
      );
    }
    expect(
      await metricValue(deps.register, 'ghost_ses_proxy_send_batches_total', {
        outcome: d1Fixture.expected.subsequentSendSucceeds.outcome,
      }),
    ).toBe(d1Fixture.expected.subsequentSendSucceeds.repeatCount);
  });

  it('keeps the failure shape when every recipient throws', async () => {
    const deps = d1Deps();
    const ses = deps.ses as SesStub;
    for (const recipient of scenario.request.fields.to) {
      throwForRecipients.add(recipient);
    }

    const res = await post(createApp(deps), fields);

    expect(res.status).toBe(d1Fixture.allRecipientsThrow.expected.status);
    expect(res.body).toEqual(d1Fixture.allRecipientsThrow.expected.body);
    expect(
      await metricValue(deps.register, 'ghost_ses_proxy_send_batches_total', {
        outcome: d1Fixture.allRecipientsThrow.expected.outcome,
      }),
    ).toBe(1);
    expect(
      await metricValue(deps.register, 'ghost_ses_proxy_send_in_flight'),
    ).toBe(0);
    expect(ses.calls).toHaveLength(0);
  });
});

describe('intent/d2-suppression-retention.json (D2)', () => {
  const KEY_COLUMN: Record<string, string> = {
    message_map: 'batch_message_id',
    recipient_emails: 'ses_message_id',
    events: 'id',
    suppressions: 'email',
  };

  function seedRetention(deps: TestDeps): void {
    for (const row of d2Fixture.seed.rows) {
      const key = row.key as Record<string, string | undefined>;
      switch (row.table) {
        case 'message_map':
          deps.db.insertMessageMap(
            String(key['batch_message_id']),
            'ghost-retention',
            null,
          );
          break;
        case 'recipient_emails':
          deps.db.insertRecipientEmail(
            String(key['ses_message_id']),
            '<retention@example.com>',
            'retention@example.com',
            'ghost-retention',
            null,
          );
          break;
        case 'events':
          deps.db.insertEvent({
            id: String(key['id']),
            event_type: 'delivered',
            severity: null,
            recipient: 'retention@example.com',
            timestamp: 1750000000,
            message_id: null,
            email_id: null,
            delivery_status_code: null,
            delivery_status_message: null,
            delivery_status_enhanced: null,
            tags: '[]',
          });
          break;
        default:
          deps.db.insertSuppression(
            String(key['email']),
            String(key['type']),
            'seeded for retention',
          );
      }

      const column = KEY_COLUMN[row.table];
      deps.db.raw
        .prepare(
          `UPDATE ${row.table} SET created_at = datetime('now', '-${row.ageDays} days') WHERE ${column} = ?`,
        )
        .run(String(key[column ?? '']));
    }
  }

  function keysIn(deps: TestDeps, table: string): string[] {
    const column = KEY_COLUMN[table];
    return deps.db.raw
      .prepare(`SELECT ${column} AS k FROM ${table} ORDER BY ${column}`)
      .all()
      .map((row) => (row as { k: string }).k);
  }

  it('purges the three ephemeral tables and never touches suppressions', async () => {
    const deps = newDeps();
    seedRetention(deps);
    const before = keysIn(deps, 'suppressions').length;

    runCleanup(deps.db, deps.logger, deps.metrics);

    const expected = d2Fixture.expected.afterRunCleanup as Record<
      string,
      { deleted: string[]; survives: string[] }
    >;
    for (const table of TABLE_NAMES) {
      const rows = keysIn(deps, table);
      expect({ table, rows }).toEqual({
        table,
        rows: [...(expected[table]?.survives ?? [])].sort(),
      });
      for (const deleted of expected[table]?.deleted ?? []) {
        expect(rows).not.toContain(deleted);
      }
    }
    expect(keysIn(deps, 'suppressions')).toHaveLength(before);

    expect(
      await metricValue(deps.register, 'ghost_ses_proxy_db_cleanup_runs_total', {
        outcome: 'success',
      }),
    ).toBe(1);
    for (const table of ['message_map', 'recipient_emails', 'events']) {
      expect(
        await metricValue(
          deps.register,
          'ghost_ses_proxy_db_cleanup_deleted_rows_total',
          { table },
        ),
      ).toBe(1);
    }
    // Stronger than "the row survives": suppressions must not be a cleanup target
    // at all, so no series may carry that label.
    expect(
      await metricValue(
        deps.register,
        'ghost_ses_proxy_db_cleanup_deleted_rows_total',
        { table: 'suppressions' },
      ),
    ).toBeUndefined();
  });
});

describe('intent/d3-redelivery-dedupe.json (D3)', () => {
  it('inserts no second row when the identical message is redelivered', async () => {
    const deps = newDeps();
    const poller = new SqsPoller(deps, injectedSqsClient());
    queue(JSON.stringify(d3Fixture.sesEvent));

    await poller.pollOnce();
    const afterFirst = deps.db.raw.prepare('SELECT id FROM events').all();
    await poller.pollOnce();
    const afterRedelivery = deps.db.raw.prepare('SELECT id FROM events').all();
    poller.stop();

    expect(afterFirst).toEqual([
      { id: d3Fixture.expected.afterFirstDelivery.eventIds[0] },
    ]);
    expect(afterRedelivery).toHaveLength(
      d3Fixture.expected.afterRedeliveryOfTheIdenticalMessage.eventsRowCount,
    );
    expect(
      (afterRedelivery as { id: string }[]).map((row) => row.id),
    ).toEqual(
      d3Fixture.expected.afterRedeliveryOfTheIdenticalMessage.eventIds,
    );
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(
      d3Fixture.expected.afterRedeliveryOfTheIdenticalMessage
        .deleteMessageCalls,
    );
  });
});

interface QueryCase {
  name: string;
  request: { path: string };
  expected: { status: number; itemIds: string[]; pagingNext: string };
}

interface EventsBody {
  items: { id: string }[];
  paging: { next: string };
}

async function getEvents(
  deps: TestDeps,
  path: string,
): Promise<{ status: number; body: EventsBody }> {
  const res = await pin(request(createApp(deps)).get(path), true);
  return { status: res.status, body: res.body as EventsBody };
}

describe('intent/d4-repeated-query-param.json (D4)', () => {
  it.each(d4RepeatedFixture.cases as QueryCase[])(
    'honors the first value for $name',
    async (testCase) => {
      const deps = newDeps();
      seedGolden(deps);

      const { status, body } = await getEvents(deps, testCase.request.path);

      expect(status).toBe(testCase.expected.status);
      expect(status).not.toBe(d4RepeatedFixture.mustNotHappen.status);
      expect(body.items.map((item) => item.id)).toEqual(
        testCase.expected.itemIds,
      );
      expect(body.paging.next).toBe(testCase.expected.pagingNext);
    },
  );
});

describe('intent/d4-limit-clamp.json (D4)', () => {
  it.each(
    d4LimitFixture.cases as (QueryCase & {
      expected: { effectiveLimit: number };
    })[],
  )('clamps limit for $name', async (testCase) => {
    const deps = newDeps();
    seedGolden(deps);

    // The seed is smaller than every clamped bound, so the response alone cannot
    // distinguish 1000 from 999 — the clamp itself has to be asserted.
    const raw = new URL(
      testCase.request.path,
      'http://localhost:3003',
    ).searchParams.get('limit');
    expect(clampLimit(raw ?? '')).toBe(testCase.expected.effectiveLimit);

    const { status, body } = await getEvents(deps, testCase.request.path);

    expect(status).toBe(testCase.expected.status);
    expect(body.items.map((item) => item.id)).toEqual(testCase.expected.itemIds);
    expect(body.paging.next).toBe(testCase.expected.pagingNext);
  });
});

describe('intent/d7-malformed-payload.json (D7)', () => {
  it.each(d7Fixture.mapSesEventReturnsEmpty)(
    'mapSesEvent returns [] for $name instead of throwing',
    (testCase) => {
      expect(mapSesEvent(testCase.sesEvent)).toEqual(testCase.expected);
    },
  );

  const envelopes = [
    ['raw', (event: unknown): string => JSON.stringify(event)],
    [
      'SNS-enveloped',
      (event: unknown): string =>
        JSON.stringify({
          Type: 'Notification',
          MessageId: 'sns-00000000-0000-0000-0000-000000000000',
          TopicArn: 'arn:aws:sns:us-east-1:000000000000:ghost-ses-proxy-events',
          Message: JSON.stringify(event),
        }),
    ],
  ] as const;

  it.each(envelopes)(
    'the poller deletes and counts a %s malformed payload',
    async (_label, encode) => {
      const payload = d7Fixture.mapSesEventReturnsEmpty[0]?.sesEvent;
      const deps = newDeps();
      const poller = new SqsPoller(deps, injectedSqsClient());
      queue(encode(payload));

      await expect(poller.pollOnce()).resolves.toBeUndefined();
      poller.stop();

      const expected = d7Fixture.pollerBehavior.expected;
      expect(deps.db.raw.prepare('SELECT * FROM events').all()).toHaveLength(
        expected.eventsRowsInserted,
      );
      expect(
        deps.db.raw.prepare('SELECT * FROM suppressions').all(),
      ).toHaveLength(expected.suppressionsRowsInserted);
      expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(
        expected.deleteMessageCalls,
      );
      expect(
        await metricValue(
          deps.register,
          'ghost_ses_proxy_sqs_parse_errors_total',
          { reason: 'malformed_payload' },
        ),
      ).toBe(1);
      expect(
        await metricValue(
          deps.register,
          'ghost_ses_proxy_sqs_messages_deleted_total',
          { outcome: 'success' },
        ),
      ).toBe(1);
      expect(
        await metricValue(deps.register, 'ghost_ses_proxy_sqs_polls_total', {
          outcome: 'success',
        }),
      ).toBe(1);
      // A malformed payload is a parse error, never a skip — the two must not
      // share a denominator (design §5.5).
      expect(
        await metricValues(deps.register, 'ghost_ses_proxy_events_skipped_total'),
      ).toEqual([]);
      expect(
        await metricValues(deps.register, 'ghost_ses_proxy_events_stored_total'),
      ).toEqual([]);

      const warnings = deps
        .logs()
        .filter(
          (line) =>
            line['level'] === d7Fixture.pollerBehavior.expected.log.level &&
            line['component'] === d7Fixture.pollerBehavior.expected.log.component,
        );
      expect(warnings).toHaveLength(1);
      for (const field of d7Fixture.pollerBehavior.expected.log.fields) {
        expect(warnings[0]?.[field]).toBeDefined();
      }
    },
  );

  it.each(d7Fixture.contrastWithTheSkipPath.cases)(
    'counts $sesEventType as a skip, not a parse error',
    async (testCase) => {
      const deps = newDeps();
      const poller = new SqsPoller(deps, injectedSqsClient());
      const base = sesEvent('delivery');
      queue(
        JSON.stringify({ ...base, eventType: testCase.sesEventType }),
      );

      await poller.pollOnce();
      poller.stop();

      const label = /ses_event_type="([^"]+)"/.exec(testCase.metric)?.[1];
      expect(
        await metricValue(
          deps.register,
          'ghost_ses_proxy_events_skipped_total',
          { ses_event_type: String(label) },
        ),
      ).toBe(1);
      expect(
        await normalisedChildren(
          deps.register,
          'ghost_ses_proxy_sqs_parse_errors_total',
          'reason',
          SQS_PARSE_ERROR_REASONS,
        ),
      ).toEqual({
        invalid_json: 0,
        unrecognized_format: 0,
        malformed_payload: 0,
      });
      expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);
    },
  );
});

describe('issue #8: zero-initialised counters transition 0 -> 1', () => {
  it('moves suppressions_recorded_total{type="bounces"} from 0 to 1', async () => {
    const deps = newDeps();
    const poller = new SqsPoller(deps, injectedSqsClient());

    expect(
      await metricValue(
        deps.register,
        'ghost_ses_proxy_suppressions_recorded_total',
        { type: 'bounces' },
      ),
    ).toBe(0);

    queue(rawSqsBody('bounce-permanent'));
    await poller.pollOnce();
    poller.stop();

    expect(
      await metricValue(
        deps.register,
        'ghost_ses_proxy_suppressions_recorded_total',
        { type: 'bounces' },
      ),
    ).toBe(1);
  });
});
