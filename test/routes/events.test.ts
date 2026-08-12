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
import {
  clampLimit,
  DEFAULT_LIMIT,
  firstString,
  MAX_LIMIT,
  MIN_LIMIT,
} from '../../src/routes/events';
import type { EventRow } from '../../src/types';
import seed from '../golden/captured/events-seed.json';
import { makeDeps, type TestDeps } from '../helpers/deps';

const AUTH = `Basic ${Buffer.from('api:test-key', 'utf8').toString('base64')}`;
const HOST = 'localhost:3003';
const EVENTS_URL = `http://${HOST}/v3/example.com/events`;
const CURSOR_TOKEN = 'eyJ0IjoxNzUwMDAwMDAzLCJpZCI6ImV2dC0wMDAzIn0=';
const T1 = 'eyJ0IjoxNzUwMDAwMDAxLCJpZCI6ImV2dC0wMDAxIn0';
const T3 = 'eyJ0IjoxNzUwMDAwMDAzLCJpZCI6ImV2dC0wMDAzIn0';
const T4 = 'eyJ0IjoxNzUwMDAwMDA0LCJpZCI6ImV2dC0wMDA0In0';
const T7 = 'eyJ0IjoxNzUwMDAwMDA3LCJpZCI6ImV2dC0wMDA3In0';

interface EventsBody {
  items: {
    id: string;
    event: string;
    timestamp: number;
    recipient: string;
    severity?: string;
    'delivery-status'?: Record<string, unknown>;
  }[];
  paging: { next: string; previous: string; first: string; last: string };
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

describe('GET /v3/:domain/events', () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = makeDeps();
    for (const row of seed as EventRow[]) deps.db.insertEvent(row);
    app = createApp(deps);
  });

  afterEach(() => {
    deps.db.close();
  });

  async function get(path: string): Promise<{ status: number; body: EventsBody }> {
    const res = await request(server)
      .get(path)
      .set('Authorization', AUTH)
      .set('Host', HOST);
    return { status: res.status, body: res.body as EventsBody };
  }

  const ids = (body: EventsBody): string[] => body.items.map((item) => item.id);

  it('returns Mailgun-shaped items and absolute paging URLs', async () => {
    const { status, body } = await get('/v3/example.com/events');

    expect(status).toBe(200);
    expect(ids(body)).toEqual([
      'evt-0001',
      'evt-0002',
      'evt-0003',
      'evt-0004',
      'evt-0005',
      'evt-0006',
      'evt-0007',
    ]);
    expect(body.paging).toEqual({
      next: `${EVENTS_URL}/${T7}`,
      previous: 'http://localhost:3003/v3/example.com/events',
      first: 'http://localhost:3003/v3/example.com/events',
      last: 'http://localhost:3003/v3/example.com/events',
    });
    expect(body.items[0]).toEqual({
      id: 'evt-0001',
      event: 'delivered',
      timestamp: 1750000001,
      recipient: 'alice@example.com',
      message: {
        headers: {
          'message-id': '11111111-1111-4111-8111-111111111111@example.com',
        },
      },
      'user-variables': { 'email-id': '650000000000000000000001' },
      'delivery-status': {
        code: 250,
        message: 'OK',
        description: '',
        'enhanced-code': '',
      },
    });
  });

  it('omits severity and delivery-status when the columns are null', async () => {
    const { body } = await get('/v3/example.com/events');
    const opened = body.items[1];

    expect(opened).toEqual({
      id: 'evt-0002',
      event: 'opened',
      timestamp: 1750000002,
      recipient: 'bob@example.com',
      message: {
        headers: {
          'message-id': '11111111-1111-4111-8111-111111111111@example.com',
        },
      },
      'user-variables': { 'email-id': '650000000000000000000001' },
    });
  });

  it('includes severity only when the column is non-null', async () => {
    const { body } = await get('/v3/example.com/events');

    expect(
      body.items
        .filter((item) => item.severity !== undefined)
        .map((item) => [item.id, item.severity]),
    ).toEqual([
      ['evt-0003', 'permanent'],
      ['evt-0004', 'temporary'],
    ]);
  });

  it('falls back to an empty string for a blank email-id', async () => {
    const { body } = await get('/v3/example.com/events?event=delivered');

    expect(body.items.map((item) => item.id)).toEqual(['evt-0001', 'evt-0005']);
    expect(body.items[1]).toMatchObject({
      'user-variables': { 'email-id': '' },
    });
  });

  it('falls back to empty strings for null message_id and status message', async () => {
    deps.db.insertEvent({
      id: 'evt-0008',
      event_type: 'failed',
      severity: 'permanent',
      recipient: 'heidi@example.com',
      timestamp: 1750000008,
      message_id: null,
      email_id: null,
      delivery_status_code: 550,
      delivery_status_message: null,
      delivery_status_enhanced: null,
      tags: null,
    });

    const { body } = await get('/v3/example.com/events?begin=1750000008');

    expect(body.items).toEqual([
      {
        id: 'evt-0008',
        event: 'failed',
        timestamp: 1750000008,
        recipient: 'heidi@example.com',
        message: { headers: { 'message-id': '' } },
        'user-variables': { 'email-id': '' },
        severity: 'permanent',
        'delivery-status': {
          code: 550,
          message: '',
          description: '',
          'enhanced-code': '',
        },
      },
    ]);
  });

  it('filters on a single event type', async () => {
    const { body } = await get('/v3/example.com/events?event=failed');

    expect(ids(body)).toEqual(['evt-0003', 'evt-0004']);
  });

  it('filters on "a OR b"', async () => {
    const { body } = await get(
      '/v3/example.com/events?event=delivered%20OR%20opened',
    );

    expect(ids(body)).toEqual(['evt-0001', 'evt-0002', 'evt-0005']);
  });

  it('filters on "x AND y" tags', async () => {
    const { body } = await get(
      '/v3/example.com/events?tags=bulk-email%20AND%20ghost-email',
    );

    expect(ids(body)).toEqual(['evt-0001', 'evt-0003', 'evt-0007']);
  });

  it('filters on a single tag', async () => {
    const { body } = await get('/v3/example.com/events?tags=ghost-email');

    expect(ids(body)).toEqual(['evt-0001', 'evt-0003', 'evt-0004', 'evt-0007']);
  });

  it('bounds the results with begin and end', async () => {
    const { body } = await get(
      '/v3/example.com/events?begin=1750000003&end=1750000005',
    );

    expect(ids(body)).toEqual(['evt-0003', 'evt-0004', 'evt-0005']);
  });

  it('combines event, tags and range filters', async () => {
    const { body } = await get(
      '/v3/example.com/events?event=delivered&tags=bulk-email&begin=1750000002',
    );

    expect(ids(body)).toEqual(['evt-0005']);
  });

  it('emits a working next cursor and continues on the second page', async () => {
    const first = await get('/v3/example.com/events?limit=3');

    expect(ids(first.body)).toEqual(['evt-0001', 'evt-0002', 'evt-0003']);
    expect(first.body.paging.next).toBe(`${EVENTS_URL}/${T3}`);
    expect(first.body.paging.previous).toBe(
      'http://localhost:3003/v3/example.com/events?limit=3',
    );
    expect(first.body.paging.first).toBe(
      'http://localhost:3003/v3/example.com/events?limit=3',
    );
    expect(first.body.paging.last).toBe(
      'http://localhost:3003/v3/example.com/events?limit=3',
    );

    const cursorPath = new URL(first.body.paging.next).pathname;
    const second = await get(cursorPath);

    expect(ids(second.body)).toEqual([
      'evt-0004',
      'evt-0005',
      'evt-0006',
      'evt-0007',
    ]);
    expect(second.body.paging.next).toBe(`${EVENTS_URL}/${T7}`);
    expect(second.body.paging.previous).toBe(
      'http://localhost:3003/v3/example.com/events',
    );
    expect(second.body.paging.first).toBe(
      'http://localhost:3003/v3/example.com/events',
    );
    expect(second.body.paging.last).toBe(
      'http://localhost:3003/v3/example.com/events',
    );
    expect(
      ids(first.body).filter((id) => ids(second.body).includes(id)),
    ).toEqual([]);
  });

  it('does not carry the limit forward into the cursor URL', async () => {
    const { body } = await get('/v3/example.com/events?limit=3');

    expect(body.paging.next).not.toContain('limit');
  });

  it('honours x-forwarded-proto in all paging URLs', async () => {
    const res = await request(server)
      .get('/v3/example.com/events?limit=3')
      .set('Authorization', AUTH)
      .set('Host', HOST)
      .set('X-Forwarded-Proto', 'https');

    const { paging } = res.body as EventsBody;

    expect(paging.next).toBe(
      `https://localhost:3003/v3/example.com/events/${T3}`,
    );
    expect(paging.previous).toBe(
      'https://localhost:3003/v3/example.com/events?limit=3',
    );
    expect(paging.first).toBe(
      'https://localhost:3003/v3/example.com/events?limit=3',
    );
    expect(paging.last).toBe(
      'https://localhost:3003/v3/example.com/events?limit=3',
    );
  });

  it('takes the first hop of a comma-joined x-forwarded-proto', async () => {
    const res = await request(server)
      .get('/v3/example.com/events?limit=3')
      .set('Authorization', AUTH)
      .set('Host', HOST)
      .set('X-Forwarded-Proto', 'https, http');

    const { paging } = res.body as EventsBody;

    for (const value of Object.values(paging)) {
      expect(value.startsWith('https://')).toBe(true);
      expect(() => new URL(value)).not.toThrow();
    }
    expect(paging.next).toBe(
      `https://localhost:3003/v3/example.com/events/${T3}`,
    );
  });

  it('every paging value survives new URL() — mailgun.js 10.x parsePage', async () => {
    const responses = await Promise.all([
      get('/v3/example.com/events'),
      get('/v3/example.com/events?limit=3'),
      get(`/v3/example.com/events/${CURSOR_TOKEN}`),
      get('/v3/example.com/events?event=nonexistent'),
    ]);

    for (const { status, body } of responses) {
      expect(status).toBe(200);
      for (const value of Object.values(body.paging)) {
        expect(() => new URL(value)).not.toThrow();
      }
    }
    expect(responses[3].body.items).toEqual([]);
  });

  it('returns a cursor over its own last row as a short page next on a token request', async () => {
    const { body } = await get(`/v3/example.com/events/${CURSOR_TOKEN}`);

    expect(body.items).toHaveLength(4);
    expect(body.paging.next).toBe(`${EVENTS_URL}/${T7}`);
  });

  it('drops the page token from previous, first and last', async () => {
    const { body } = await get(`/v3/example.com/events/${CURSOR_TOKEN}`);

    expect(body.paging.previous).toBe(EVENTS_URL);
    expect(body.paging.first).toBe(EVENTS_URL);
    expect(body.paging.last).toBe(EVENTS_URL);
  });

  it('keeps the query string in previous, first and last but not in the cursor next', async () => {
    const { body } = await get('/v3/example.com/events?event=failed');

    expect(body.paging).toEqual({
      next: `${EVENTS_URL}/${T4}`,
      previous: `${EVENTS_URL}?event=failed`,
      first: `${EVENTS_URL}?event=failed`,
      last: `${EVENTS_URL}?event=failed`,
    });
  });

  it('returns 400 for an invalid page token', async () => {
    const { status, body } = await get(
      '/v3/example.com/events/invalid-page-token',
    );

    expect(status).toBe(400);
    expect(body).toEqual({ message: 'Invalid page token' });
  });

  it('requires authentication', async () => {
    const res = await request(server).get('/v3/example.com/events');

    expect(res.status).toBe(401);
  });

  describe('D4 — repeated query parameters must not 500', () => {
    it('honours the first ?event= value', async () => {
      const { status, body } = await get(
        '/v3/example.com/events?event=delivered&event=opened',
      );

      expect(status).toBe(200);
      expect(ids(body)).toEqual(['evt-0001', 'evt-0005']);
    });

    it('honours the first ?tags= value', async () => {
      const { status, body } = await get(
        '/v3/example.com/events?tags=bulk-email&tags=ghost-email',
      );

      expect(status).toBe(200);
      expect(ids(body)).toEqual([
        'evt-0001',
        'evt-0002',
        'evt-0003',
        'evt-0005',
        'evt-0007',
      ]);
    });

    it('keeps " OR " splitting inside the first value', async () => {
      const { status, body } = await get(
        '/v3/example.com/events?event=delivered%20OR%20opened&event=failed',
      );

      expect(status).toBe(200);
      expect(ids(body)).toEqual(['evt-0001', 'evt-0002', 'evt-0005']);
    });

    it('applies no filter when the first repeated value is empty', async () => {
      const { status, body } = await get(
        '/v3/example.com/events?event=&event=opened',
      );

      expect(status).toBe(200);
      expect(body.items).toHaveLength(7);
    });

    it('takes the first repeated ?begin= value', async () => {
      const { status, body } = await get(
        '/v3/example.com/events?begin=1750000006&begin=1750000001',
      );

      expect(status).toBe(200);
      expect(ids(body)).toEqual(['evt-0006', 'evt-0007']);
    });

    it('takes the first repeated ?end= value', async () => {
      const { body } = await get(
        '/v3/example.com/events?end=1750000002&end=1750000007',
      );

      expect(ids(body)).toEqual(['evt-0001', 'evt-0002']);
    });

    it('takes the first repeated ?limit= value', async () => {
      const { body } = await get('/v3/example.com/events?limit=2&limit=6');

      expect(ids(body)).toEqual(['evt-0001', 'evt-0002']);
    });
  });

  describe('D4 — limit is clamped to [1, 1000]', () => {
    it('clamps a limit above the maximum', async () => {
      const { status, body } = await get('/v3/example.com/events?limit=99999999');

      expect(status).toBe(200);
      expect(body.items).toHaveLength(7);
      expect(body.paging.next).toBe(`${EVENTS_URL}/${T7}`);
    });

    it('accepts the maximum verbatim', async () => {
      const { body } = await get('/v3/example.com/events?limit=1000');

      expect(body.items).toHaveLength(7);
      expect(body.paging.next).toBe(`${EVENTS_URL}/${T7}`);
    });

    it('clamps limit=0 up to 1', async () => {
      const { body } = await get('/v3/example.com/events?limit=0');

      expect(ids(body)).toEqual(['evt-0001']);
      expect(body.paging.next).toBe(`${EVENTS_URL}/${T1}`);
    });

    it('clamps a negative limit up to 1', async () => {
      const { body } = await get('/v3/example.com/events?limit=-5');

      expect(ids(body)).toEqual(['evt-0001']);
      expect(body.paging.next).toBe(`${EVENTS_URL}/${T1}`);
    });

    it('falls back to the 300 default for a non-numeric limit', async () => {
      const { body } = await get('/v3/example.com/events?limit=abc');

      expect(body.items).toHaveLength(7);
      expect(body.paging.next).toBe(`${EVENTS_URL}/${T7}`);
    });
  });
});

describe('firstString', () => {
  it('returns a string parameter unchanged', () => {
    expect(firstString('delivered')).toBe('delivered');
  });

  it('returns the first element of an array parameter', () => {
    expect(firstString(['delivered', 'opened'])).toBe('delivered');
  });

  it('returns an empty string for an empty array', () => {
    expect(firstString([])).toBe('');
  });

  it('stringifies a non-string first element', () => {
    expect(firstString([5, 9])).toBe('5');
  });

  it('returns an empty string for undefined and for a nested object', () => {
    expect(firstString(undefined)).toBe('');
    expect(firstString({ nested: 'value' })).toBe('');
  });
});

describe('clampLimit', () => {
  it('defaults when the value does not parse', () => {
    expect(clampLimit('')).toBe(DEFAULT_LIMIT);
    expect(clampLimit('abc')).toBe(DEFAULT_LIMIT);
  });

  it('clamps to the bounds', () => {
    expect(clampLimit('0')).toBe(MIN_LIMIT);
    expect(clampLimit('-5')).toBe(MIN_LIMIT);
    expect(clampLimit('99999999')).toBe(MAX_LIMIT);
    expect(clampLimit('1000')).toBe(MAX_LIMIT);
  });

  it('passes an in-range value through', () => {
    expect(clampLimit('42')).toBe(42);
  });
});
