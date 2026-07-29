import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import type { Registry } from 'prom-client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POLL_ERROR_BACKOFF_MS,
  POLL_MAX_MESSAGES,
  POLL_WAIT_TIME_SECONDS,
  SqsPoller,
  eventId,
  parseSqsBody,
} from '../src/sqs-poller';
import type { EventRow } from '../src/types';
import d3Fixture from './golden/intent/d3-redelivery-dedupe.json';
import d7Fixture from './golden/intent/d7-malformed-payload.json';
import { makeDeps, type TestDeps } from './helpers/deps';
import {
  rawSqsBody,
  sesEvent,
  snsEnvelope,
  snsSqsBody,
  withoutEventBlock,
} from './helpers/fixtures';

const sqsMock = mockClient(SQSClient);

let deps: TestDeps;
let poller: SqsPoller;

function injectedClient(): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' },
  });
}

/** Every poll returns the same message set — which is exactly an SQS redelivery. */
function queue(...bodies: string[]): void {
  sqsMock.on(ReceiveMessageCommand).resolves({
    Messages: bodies.map((Body, index) => ({
      MessageId: `msg-${index}`,
      ReceiptHandle: `receipt-${index}`,
      Body,
    })),
  });
}

interface MetricValue {
  labels: Record<string, string | number>;
  value: number;
  metricName?: string;
}

async function metricValues(
  register: Registry,
  name: string,
): Promise<MetricValue[]> {
  const json = await register.getMetricsAsJSON();
  const metric = json.find((entry) => entry.name === name);
  const values = (metric as { values?: unknown } | undefined)?.values;
  return (values ?? []) as MetricValue[];
}

async function counterValue(
  name: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  const values = await metricValues(deps.register, name);
  return values.find((entry) =>
    Object.entries(labels).every(([key, value]) => entry.labels[key] === value),
  )?.value;
}

async function histogramCount(name: string): Promise<number | undefined> {
  const values = await metricValues(deps.register, name);
  return values.find((entry) => entry.metricName === `${name}_count`)?.value;
}

function eventRows(): EventRow[] {
  return deps.db.raw
    .prepare('SELECT * FROM events ORDER BY recipient')
    .all() as EventRow[];
}

function suppressionRows(): { email: string; type: string; reason: string }[] {
  return deps.db.raw.prepare('SELECT * FROM suppressions').all() as {
    email: string;
    type: string;
    reason: string;
  }[];
}

function deleteCalls(): number {
  return sqsMock.commandCalls(DeleteMessageCommand).length;
}

function receiveCalls(): number {
  return sqsMock.commandCalls(ReceiveMessageCommand).length;
}

function logsWith(msg: string): Record<string, unknown>[] {
  return deps.logs().filter((line) => line['msg'] === msg);
}

beforeEach(() => {
  sqsMock.reset();
  sqsMock.on(DeleteMessageCommand).resolves({});
  deps = makeDeps();
  poller = new SqsPoller(deps, injectedClient());
});

afterEach(() => {
  poller.stop();
  vi.useRealTimers();
  if (deps.db.raw.open) deps.db.close();
});

afterAll(() => {
  sqsMock.restore();
});

describe('parseSqsBody', () => {
  it('unwraps an SNS notification envelope', () => {
    const parsed = parseSqsBody(snsSqsBody('delivery'));
    expect(parsed?.eventType).toBe('Delivery');
  });

  it('returns a raw SES event unchanged', () => {
    expect(parseSqsBody(rawSqsBody('open'))?.eventType).toBe('Open');
  });

  it('returns null for a JSON object that is not an SES event', () => {
    expect(parseSqsBody('{"foo":"bar"}')).toBeNull();
  });

  it('returns null for a JSON scalar', () => {
    expect(parseSqsBody('42')).toBeNull();
    expect(parseSqsBody('null')).toBeNull();
  });

  it('returns null for an SNS envelope carrying a non-SES message', () => {
    expect(parseSqsBody(JSON.stringify(snsEnvelope({ foo: 'bar' })))).toBeNull();
  });

  it('ignores an SNS envelope whose Message is not a string', () => {
    const body = JSON.stringify({ Type: 'Notification', Message: { a: 1 } });
    expect(parseSqsBody(body)).toBeNull();
  });

  it('throws on invalid JSON', () => {
    expect(() => parseSqsBody('not json')).toThrow();
  });

  it('throws when the SNS Message is invalid JSON', () => {
    const body = JSON.stringify({ Type: 'Notification', Message: 'not json' });
    expect(() => parseSqsBody(body)).toThrow();
  });
});

describe('SqsPoller.pollOnce', () => {
  it('long-polls the configured queue', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({});

    await poller.pollOnce();

    const input = sqsMock.commandCalls(ReceiveMessageCommand)[0]?.args[0]?.input;
    expect(input).toMatchObject({
      QueueUrl: deps.config.sqsQueueUrl,
      WaitTimeSeconds: POLL_WAIT_TIME_SECONDS,
      MaxNumberOfMessages: POLL_MAX_MESSAGES,
    });
  });

  it('records a successful empty poll without touching the message metrics', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({});

    await poller.pollOnce();

    expect(await counterValue('ghost_ses_proxy_sqs_polls_total', {
      outcome: 'success',
    })).toBe(1);
    expect(
      await counterValue('ghost_ses_proxy_sqs_messages_received_total'),
    ).toBe(0);
    expect(deleteCalls()).toBe(0);
    expect(await histogramCount('ghost_ses_proxy_sqs_poll_duration_seconds')).toBe(1);
  });

  it('advances sqs_last_poll_timestamp_seconds on success', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({});
    const before = Date.now() / 1000;

    await poller.pollOnce();

    const value = await counterValue(
      'ghost_ses_proxy_sqs_last_poll_timestamp_seconds',
    );
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now() / 1000);
  });

  it('stores a raw SES event and deletes the message', async () => {
    queue(rawSqsBody('delivery'));

    await poller.pollOnce();

    const rows = eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'delivered',
      severity: null,
      recipient: 'alice@example.com',
      timestamp: 1784548805,
      message_id: '44444444-4444-4444-8444-444444444444@example.com',
      email_id: '650000000000000000000009',
      delivery_status_code: 250,
      delivery_status_message: 'OK',
      tags: '[]',
    });
    expect(deleteCalls()).toBe(1);
    expect(
      sqsMock.commandCalls(DeleteMessageCommand)[0]?.args[0]?.input,
    ).toMatchObject({
      QueueUrl: deps.config.sqsQueueUrl,
      ReceiptHandle: 'receipt-0',
    });
  });

  it('stores an SNS-enveloped event identically to a raw one', async () => {
    queue(snsSqsBody('delivery'));

    await poller.pollOnce();

    expect(eventRows()).toHaveLength(1);
    expect(eventRows()[0]?.recipient).toBe('alice@example.com');
    expect(deleteCalls()).toBe(1);
  });

  it('fans a multi-recipient delivery out into one row per recipient', async () => {
    queue(rawSqsBody('delivery-multi-recipient'));

    await poller.pollOnce();

    expect(eventRows().map((row) => row.recipient)).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
    expect(new Set(eventRows().map((row) => row.id)).size).toBe(2);
  });

  it('processes every message in a batch and counts them all as received', async () => {
    queue(rawSqsBody('delivery'), rawSqsBody('open'));

    await poller.pollOnce();

    expect(eventRows()).toHaveLength(2);
    expect(deleteCalls()).toBe(2);
    expect(
      await counterValue('ghost_ses_proxy_sqs_messages_received_total'),
    ).toBe(2);
    expect(
      await counterValue('ghost_ses_proxy_sqs_messages_deleted_total', {
        outcome: 'success',
      }),
    ).toBe(2);
  });

  it('records events_stored_total with severity "none" when severity is null', async () => {
    queue(rawSqsBody('delivery'));

    await poller.pollOnce();

    expect(
      await counterValue('ghost_ses_proxy_events_stored_total', {
        event_type: 'delivered',
        severity: 'none',
      }),
    ).toBe(1);
  });

  it('records the real severity for a permanent bounce', async () => {
    queue(rawSqsBody('bounce-permanent'));

    await poller.pollOnce();

    expect(
      await counterValue('ghost_ses_proxy_events_stored_total', {
        event_type: 'failed',
        severity: 'permanent',
      }),
    ).toBe(1);
  });

  it('observes event_lag_seconds once per stored event', async () => {
    queue(rawSqsBody('delivery-multi-recipient'));

    await poller.pollOnce();

    expect(await histogramCount('ghost_ses_proxy_event_lag_seconds')).toBe(2);
  });

  it('logs the stored batch with the sqs component', async () => {
    queue(rawSqsBody('delivery'));

    await poller.pollOnce();

    expect(logsWith('stored SES events')[0]).toMatchObject({
      component: 'sqs',
      sesEventType: 'Delivery',
      sesMessageId: '010001912a3b4c5d-0000000000000001-000000',
      storedCount: 1,
    });
    expect(logsWith('stored event')[0]).toMatchObject({
      component: 'sqs',
      eventType: 'delivered',
      recipient: 'alice@example.com',
      ghostEmailId: '650000000000000000000009',
    });
  });
});

describe('SqsPoller correlation', () => {
  const SES_MESSAGE_ID = '010001912a3b4c5d-0000000000000001-000000';

  it('prefers the stored batch id, ghost email id and tags when a row matches', async () => {
    deps.db.insertRecipientEmail(
      SES_MESSAGE_ID,
      '<batch-1@example.com>',
      'alice@example.com',
      'ghost-from-db',
      '["bulk-email","newsletter"]',
    );
    queue(rawSqsBody('delivery'));

    await poller.pollOnce();

    expect(eventRows()[0]).toMatchObject({
      message_id: 'batch-1@example.com',
      email_id: 'ghost-from-db',
      tags: '["bulk-email","newsletter"]',
    });
    expect(
      await counterValue('ghost_ses_proxy_event_correlation_total', {
        result: 'matched',
      }),
    ).toBe(1);
  });

  it('falls back to the header ghost email id when the matched row has none', async () => {
    deps.db.insertRecipientEmail(
      SES_MESSAGE_ID,
      '<batch-1@example.com>',
      'alice@example.com',
      null,
      null,
    );
    queue(rawSqsBody('delivery'));

    await poller.pollOnce();

    expect(eventRows()[0]).toMatchObject({
      email_id: '650000000000000000000009',
      tags: '[]',
    });
  });

  it('counts an event with no matching row as unmatched', async () => {
    queue(rawSqsBody('delivery'));

    await poller.pollOnce();

    expect(
      await counterValue('ghost_ses_proxy_event_correlation_total', {
        result: 'unmatched',
      }),
    ).toBe(1);
  });

  it('stores a null message_id when neither the row nor the headers carry one', async () => {
    const event = sesEvent('delivery');
    if (event.mail) event.mail.headers = [];
    queue(JSON.stringify(event));

    await poller.pollOnce();

    expect(eventRows()[0]).toMatchObject({ message_id: null, email_id: null });
  });

  it('counts an event carrying no ses_message_id as unmatched', async () => {
    const event = sesEvent('delivery');
    delete event.mail?.messageId;
    queue(JSON.stringify(event));

    await poller.pollOnce();

    expect(eventRows()).toHaveLength(1);
    expect(
      await counterValue('ghost_ses_proxy_event_correlation_total', {
        result: 'unmatched',
      }),
    ).toBe(1);
  });
});

describe('SqsPoller suppressions', () => {
  it.each([
    ['bounce-permanent', 'carol@example.com', 'bounces', 'Permanent bounce'],
    ['complaint', 'grace@example.com', 'complaints', 'Spam complaint'],
    ['reject', 'heidi@example.com', 'bounces', 'Rejected by SES'],
  ] as const)(
    'records a suppression for %s',
    async (fixture, email, type, reason) => {
      queue(rawSqsBody(fixture));

      await poller.pollOnce();

      expect(suppressionRows()).toHaveLength(1);
      expect(suppressionRows()[0]).toMatchObject({ email, type, reason });
      expect(
        await counterValue('ghost_ses_proxy_suppressions_recorded_total', {
          type,
        }),
      ).toBe(1);
    },
  );

  it('does not suppress a transient bounce', async () => {
    queue(rawSqsBody('bounce-transient'));

    await poller.pollOnce();

    expect(eventRows()).toHaveLength(1);
    expect(suppressionRows()).toHaveLength(0);
  });
});

describe('SqsPoller parse errors', () => {
  it('deletes a message whose body is not JSON and counts invalid_json', async () => {
    queue('this is not json');

    await poller.pollOnce();

    expect(
      await counterValue('ghost_ses_proxy_sqs_parse_errors_total', {
        reason: 'invalid_json',
      }),
    ).toBe(1);
    expect(eventRows()).toHaveLength(0);
    expect(deleteCalls()).toBe(1);
    expect(await counterValue('ghost_ses_proxy_sqs_polls_total', {
      outcome: 'success',
    })).toBe(1);
  });

  it('deletes a message with an unrecognized shape and counts unrecognized_format', async () => {
    queue(JSON.stringify({ foo: 'bar' }));

    await poller.pollOnce();

    expect(
      await counterValue('ghost_ses_proxy_sqs_parse_errors_total', {
        reason: 'unrecognized_format',
      }),
    ).toBe(1);
    expect(deleteCalls()).toBe(1);
  });

  it('counts an SNS envelope carrying a non-SES message as unrecognized_format', async () => {
    queue(JSON.stringify(snsEnvelope({ foo: 'bar' })));

    await poller.pollOnce();

    expect(
      await counterValue('ghost_ses_proxy_sqs_parse_errors_total', {
        reason: 'unrecognized_format',
      }),
    ).toBe(1);
  });

  it('treats a message with no body as invalid_json', async () => {
    sqsMock
      .on(ReceiveMessageCommand)
      .resolves({ Messages: [{ MessageId: 'm', ReceiptHandle: 'r' }] });

    await poller.pollOnce();

    expect(
      await counterValue('ghost_ses_proxy_sqs_parse_errors_total', {
        reason: 'invalid_json',
      }),
    ).toBe(1);
    expect(deleteCalls()).toBe(1);
  });
});

describe('SqsPoller skip path', () => {
  it.each(['send', 'delivery-delay'] as const)(
    'counts %s as a skipped event type',
    async (fixture) => {
      const type = fixture === 'send' ? 'Send' : 'DeliveryDelay';
      queue(rawSqsBody(fixture));

      await poller.pollOnce();

      expect(
        await counterValue('ghost_ses_proxy_events_skipped_total', {
          ses_event_type: type,
        }),
      ).toBe(1);
      expect(eventRows()).toHaveLength(0);
      expect(deleteCalls()).toBe(1);
      expect(
        await counterValue('ghost_ses_proxy_sqs_parse_errors_total'),
      ).toBeUndefined();
    },
  );

  it('collapses an unrecognized SES event type to the "other" label', async () => {
    queue(rawSqsBody('unknown-type'));

    await poller.pollOnce();

    expect(
      await counterValue('ghost_ses_proxy_events_skipped_total', {
        ses_event_type: 'other',
      }),
    ).toBe(1);
    expect(
      await counterValue('ghost_ses_proxy_sqs_parse_errors_total'),
    ).toBeUndefined();
    expect(deleteCalls()).toBe(1);
  });
});

describe('SqsPoller malformed payloads (D7)', () => {
  it.each([
    ['delivery', 'delivery'],
    ['bounce-permanent', 'bounce'],
    ['complaint', 'complaint'],
  ] as const)(
    'counts %s with no %s block as malformed_payload and deletes it',
    async (fixture, block) => {
      queue(JSON.stringify(withoutEventBlock(fixture, block)));

      await expect(poller.pollOnce()).resolves.toBeUndefined();

      expect(
        await counterValue('ghost_ses_proxy_sqs_parse_errors_total', {
          reason: 'malformed_payload',
        }),
      ).toBe(1);
      expect(eventRows()).toHaveLength(0);
      expect(suppressionRows()).toHaveLength(0);
      expect(deleteCalls()).toBe(1);
      expect(
        await counterValue('ghost_ses_proxy_events_skipped_total'),
      ).toBeUndefined();
      expect(await counterValue('ghost_ses_proxy_sqs_polls_total', {
        outcome: 'success',
      })).toBe(1);
    },
  );

  it('behaves identically for an SNS-enveloped malformed payload', async () => {
    queue(JSON.stringify(snsEnvelope(withoutEventBlock('delivery', 'delivery'))));

    await poller.pollOnce();

    expect(
      await counterValue('ghost_ses_proxy_sqs_parse_errors_total', {
        reason: 'malformed_payload',
      }),
    ).toBe(1);
    expect(deleteCalls()).toBe(1);
  });

  it('warns with the SES event type and message id', async () => {
    queue(JSON.stringify(withoutEventBlock('delivery', 'delivery')));

    await poller.pollOnce();

    const line = deps
      .logs()
      .find((entry) => entry['level'] === 'warn' && entry['sesEventType']);
    expect(line).toMatchObject({
      component: 'sqs',
      sesEventType: 'Delivery',
      sesMessageId: '010001912a3b4c5d-0000000000000001-000000',
    });
  });

  it.each(d7Fixture.mapSesEventReturnsEmpty)(
    'stores nothing for the $name intent fixture',
    async ({ sesEvent: payload }) => {
      queue(JSON.stringify(payload));

      await poller.pollOnce();

      expect(eventRows()).toHaveLength(0);
      expect(
        await counterValue('ghost_ses_proxy_sqs_parse_errors_total', {
          reason: 'malformed_payload',
        }),
      ).toBe(1);
      expect(deleteCalls()).toBe(1);
    },
  );
});

describe('SqsPoller redelivery (D3)', () => {
  it('inserts no second row when the identical message is redelivered', async () => {
    queue(JSON.stringify(d3Fixture.sesEvent));

    await poller.pollOnce();
    const first = eventRows();
    await poller.pollOnce();
    const second = eventRows();

    expect(first).toHaveLength(
      d3Fixture.expected.afterFirstDelivery.eventsRowCount,
    );
    expect(second).toHaveLength(
      d3Fixture.expected.afterRedeliveryOfTheIdenticalMessage.eventsRowCount,
    );
    expect(second.map((row) => row.id)).toEqual(
      d3Fixture.expected.afterRedeliveryOfTheIdenticalMessage.eventIds,
    );
    expect(deleteCalls()).toBe(
      d3Fixture.expected.afterRedeliveryOfTheIdenticalMessage
        .deleteMessageCalls,
    );
    expect(await counterValue('ghost_ses_proxy_sqs_polls_total', {
      outcome: 'success',
    })).toBe(2);
  });

  it('derives the id from ses_message_id, event type, recipient and timestamp', () => {
    const base = {
      event_type: 'delivered',
      severity: null,
      recipient: 'dana@example.com',
      timestamp: 1784548805,
      ses_message_id: '010001912a3b4c5d-0000000000000003-000000',
      ghost_email_id: null,
      batch_message_id: null,
      delivery_status_code: null,
      delivery_status_message: null,
      delivery_status_enhanced: '',
      is_suppression: false,
      suppression_type: null,
      suppression_reason: null,
    } as const;

    expect(eventId(base)).toBe(d3Fixture.expected.eventId);
    expect(eventId({ ...base, recipient: 'other@example.com' })).not.toBe(
      d3Fixture.expected.eventId,
    );
    expect(eventId({ ...base, ses_message_id: null })).not.toBe(
      d3Fixture.expected.eventId,
    );
  });
});

describe('SqsPoller failures', () => {
  it('counts a failed delete without failing the poll', async () => {
    sqsMock.reset();
    sqsMock.on(DeleteMessageCommand).rejects(new Error('receipt expired'));
    queue(rawSqsBody('delivery'));

    await poller.pollOnce();

    expect(eventRows()).toHaveLength(1);
    expect(
      await counterValue('ghost_ses_proxy_sqs_messages_deleted_total', {
        outcome: 'error',
      }),
    ).toBe(1);
    expect(await counterValue('ghost_ses_proxy_sqs_polls_total', {
      outcome: 'success',
    })).toBe(1);
  });

  it('counts a failed receive and rethrows so the loop can back off', async () => {
    sqsMock.on(ReceiveMessageCommand).rejects(new Error('network down'));

    await expect(poller.pollOnce()).rejects.toThrow('network down');

    expect(await counterValue('ghost_ses_proxy_sqs_polls_total', {
      outcome: 'error',
    })).toBe(1);
    expect(await histogramCount('ghost_ses_proxy_sqs_poll_duration_seconds')).toBe(1);
    expect(
      await counterValue('ghost_ses_proxy_sqs_last_poll_timestamp_seconds'),
    ).toBe(0);
    expect(logsWith('SQS poll failed')[0]).toMatchObject({
      level: 'error',
      component: 'sqs',
    });
  });

  it('propagates a database failure so the message is not deleted', async () => {
    queue(rawSqsBody('delivery'));
    vi.spyOn(deps.db, 'insertEvent').mockImplementation(() => {
      throw new Error('database is locked');
    });

    await expect(poller.pollOnce()).rejects.toThrow('database is locked');

    expect(deleteCalls()).toBe(0);
    expect(await counterValue('ghost_ses_proxy_sqs_polls_total', {
      outcome: 'error',
    })).toBe(1);
  });
});

describe('SqsPoller start/stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('polls repeatedly until stopped', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({});

    poller.start();
    expect(receiveCalls()).toBe(0);

    await vi.advanceTimersToNextTimerAsync();
    const afterFirst = receiveCalls();
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersToNextTimerAsync();
    expect(receiveCalls()).toBeGreaterThan(afterFirst);

    poller.stop();
    expect(vi.getTimerCount()).toBe(0);
    const afterStop = receiveCalls();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(receiveCalls()).toBe(afterStop);
  });

  it('backs off after a poll error and keeps the loop alive', async () => {
    sqsMock.on(ReceiveMessageCommand).rejects(new Error('network down'));

    poller.start();
    await vi.advanceTimersToNextTimerAsync();
    expect(receiveCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(POLL_ERROR_BACKOFF_MS - 1);
    expect(receiveCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(receiveCalls()).toBe(2);
    expect(await counterValue('ghost_ses_proxy_sqs_polls_total', {
      outcome: 'error',
    })).toBe(2);
  });

  it('is idempotent: a second start does not add a second loop', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({});

    poller.start();
    poller.start();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersToNextTimerAsync();
    expect(vi.getTimerCount()).toBe(1);

    poller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops cleanly while a poll is in flight', async () => {
    let release: (() => void) | undefined;
    sqsMock.on(ReceiveMessageCommand).callsFake(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({});
          };
        }),
    );

    poller.start();
    await vi.advanceTimersToNextTimerAsync();
    expect(receiveCalls()).toBe(1);

    poller.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(receiveCalls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() before start() is a no-op', () => {
    expect(() => {
      poller.stop();
    }).not.toThrow();
    expect(logsWith('SQS poller stopped')).toHaveLength(0);
  });

  it('logs the queue url on start', () => {
    poller.start();

    expect(logsWith('SQS poller started')[0]).toMatchObject({
      component: 'sqs',
      queueUrl: deps.config.sqsQueueUrl,
    });
  });
});

describe('SqsPoller client construction', () => {
  it('constructs its own SQSClient when none is injected', async () => {
    queue(rawSqsBody('delivery'));

    await new SqsPoller(deps).pollOnce();

    expect(eventRows()).toHaveLength(1);
    expect(deleteCalls()).toBe(1);
  });
});
