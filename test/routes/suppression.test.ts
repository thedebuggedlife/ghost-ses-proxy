import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { makeDeps, type TestDeps } from '../helpers/deps';

const AUTH = `Basic ${Buffer.from('api:test-key', 'utf8').toString('base64')}`;

interface CountRow {
  c: number;
}

describe('DELETE /v3/:domain/:type/:email', () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = makeDeps();
    deps.db.insertSuppression('bounced+tag@example.com', 'bounces', 'hard bounce');
    deps.db.insertSuppression('complainer@example.com', 'complaints', null);
    deps.db.insertSuppression('unsub@example.com', 'unsubscribes', null);
  });

  afterEach(() => {
    deps.db.close();
  });

  function suppressionCount(): number {
    return (
      deps.db.raw.prepare<unknown[], CountRow>(
        'SELECT COUNT(*) as c FROM suppressions',
      ).get() as CountRow
    ).c;
  }

  async function removedCounts(): Promise<
    { labels: Record<string, string | number>; value: number }[]
  > {
    const json = await deps.register.getMetricsAsJSON();
    const metric = json.find(
      (entry) => entry.name === 'ghost_ses_proxy_suppressions_removed_total',
    );
    const values = (metric as { values?: unknown } | undefined)?.values;
    return (values ?? []) as {
      labels: Record<string, string | number>;
      value: number;
    }[];
  }

  it('deletes the row and returns the Mailgun body', async () => {
    const res = await request(createApp(deps))
      .delete('/v3/example.com/complaints/complainer%40example.com')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Address has been removed',
      value: '',
      address: 'complainer@example.com',
    });
    expect(suppressionCount()).toBe(2);
  });

  it('accepts every valid suppression type', async () => {
    const app = createApp(deps);

    for (const [type, email] of [
      ['bounces', 'bounced%2Btag%40example.com'],
      ['complaints', 'complainer%40example.com'],
      ['unsubscribes', 'unsub%40example.com'],
    ] as const) {
      const res = await request(app)
        .delete(`/v3/example.com/${type}/${email}`)
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
    }

    expect(suppressionCount()).toBe(0);
  });

  it('returns 404 with the exact message for an unknown type', async () => {
    const res = await request(createApp(deps))
      .delete('/v3/example.com/unsubscribed/complainer%40example.com')
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      message: 'Unknown suppression type: unsubscribed',
    });
    expect(suppressionCount()).toBe(3);
  });

  it('does not count an unknown type in suppressions_removed_total', async () => {
    await request(createApp(deps))
      .delete('/v3/example.com/unsubscribed/complainer%40example.com')
      .set('Authorization', AUTH);

    expect(await removedCounts()).toEqual([]);
  });

  it('decodes a %40-encoded address', async () => {
    const res = await request(createApp(deps))
      .delete('/v3/example.com/bounces/bounced%2Btag%40example.com')
      .set('Authorization', AUTH);

    expect(res.body).toMatchObject({ address: 'bounced+tag@example.com' });
    expect(suppressionCount()).toBe(2);
  });

  it('treats a literal + in the path as a plus, not a space', async () => {
    const res = await request(createApp(deps))
      .delete('/v3/example.com/bounces/bounced+tag%40example.com')
      .set('Authorization', AUTH);

    expect(res.body).toMatchObject({ address: 'bounced+tag@example.com' });
    expect(suppressionCount()).toBe(2);
  });

  it('decodes a double-encoded address a second time', async () => {
    const res = await request(createApp(deps))
      .delete('/v3/example.com/bounces/bounced%252Btag%2540example.com')
      .set('Authorization', AUTH);

    expect(res.body).toMatchObject({ address: 'bounced+tag@example.com' });
    expect(suppressionCount()).toBe(2);
  });

  it('returns 200 when the address was never suppressed', async () => {
    const res = await request(createApp(deps))
      .delete('/v3/example.com/bounces/nobody%40example.com')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Address has been removed',
      value: '',
      address: 'nobody@example.com',
    });
    expect(suppressionCount()).toBe(3);
  });

  it('counts rows actually removed, not delete requests', async () => {
    const app = createApp(deps);

    await request(app)
      .delete('/v3/example.com/bounces/bounced%2Btag%40example.com')
      .set('Authorization', AUTH);
    // Never suppressed — returns 200, but removes nothing, so it must not count.
    await request(app)
      .delete('/v3/example.com/bounces/nobody%40example.com')
      .set('Authorization', AUTH);
    await request(app)
      .delete('/v3/example.com/complaints/complainer%40example.com')
      .set('Authorization', AUTH);

    expect(await removedCounts()).toEqual([
      { labels: { type: 'bounces' }, value: 1 },
      { labels: { type: 'complaints' }, value: 1 },
    ]);
  });

  it('does not create a series when nothing was removed', async () => {
    await request(createApp(deps))
      .delete('/v3/example.com/bounces/nobody%40example.com')
      .set('Authorization', AUTH);

    expect(await removedCounts()).toEqual([]);
  });

  it('logs the removal with component and recipient', async () => {
    await request(createApp(deps))
      .delete('/v3/example.com/complaints/complainer%40example.com')
      .set('Authorization', AUTH);

    expect(
      deps.logs().filter((line) => line['component'] === 'suppression'),
    ).toMatchObject([
      {
        component: 'suppression',
        recipient: 'complainer@example.com',
        type: 'complaints',
        msg: 'suppression removed',
      },
    ]);
  });

  it('requires authentication', async () => {
    const res = await request(createApp(deps)).delete(
      '/v3/example.com/complaints/complainer%40example.com',
    );

    expect(res.status).toBe(401);
    expect(suppressionCount()).toBe(3);
  });

  it('labels the HTTP metric with the route template, never the address', async () => {
    await request(createApp(deps))
      .delete('/v3/example.com/complaints/complainer%40example.com')
      .set('Authorization', AUTH);

    const json = await deps.register.getMetricsAsJSON();
    const values =
      json.find((metric) => metric.name === 'ghost_ses_proxy_http_requests_total')
        ?.values ?? [];

    expect(values.map((value) => value.labels)).toEqual([
      {
        method: 'DELETE',
        route: '/v3/:domain/:type/:email',
        status_code: '200',
      },
    ]);
    expect(JSON.stringify(values)).not.toContain('complainer');
  });
});
