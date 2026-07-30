import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { mockClient } from 'aws-sdk-client-mock';
import type { Registry } from 'prom-client';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SES_ERROR_TYPES } from '../src/metrics';
import { createSesClient } from '../src/ses-client';
import type { SesClient } from '../src/types';
import { makeDeps, type TestDeps } from './helpers/deps';

const sesMock = mockClient(SESClient);

const RAW = 'From: a@example.com\r\nTo: b@example.com\r\n\r\nhello';
const MESSAGE_ID = '0100000000000000-aaaa-bbbb-cccc-dddd-000000';

let deps: TestDeps;

function injectedClient(): SESClient {
  return new SESClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' },
  });
}

function makeClient(client?: SESClient): SesClient {
  return createSesClient(
    deps.config,
    { logger: deps.logger, metrics: deps.metrics },
    client,
  );
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
  register: Registry,
  name: string,
  labels: Record<string, string>,
): Promise<number | undefined> {
  const values = await metricValues(register, name);
  const match = values.find((entry) =>
    Object.entries(labels).every(([k, v]) => entry.labels[k] === v),
  );
  return match?.value;
}

async function durationCount(
  register: Registry,
  outcome: 'success' | 'error',
): Promise<number | undefined> {
  const name = 'ghost_ses_proxy_ses_send_duration_seconds';
  const values = await metricValues(register, name);
  return values.find(
    (entry) =>
      entry.metricName === `${name}_count` && entry.labels.outcome === outcome,
  )?.value;
}

function rejectWith(reason: unknown): void {
  sesMock
    .on(SendRawEmailCommand)
    .callsFake(() => Promise.reject(reason) as Promise<never>);
}

beforeEach(() => {
  sesMock.reset();
  deps = makeDeps();
});

afterEach(() => {
  if (deps.db.raw.open) deps.db.close();
});

afterAll(() => {
  sesMock.restore();
});

describe('createSesClient', () => {
  describe('sendRawEmail', () => {
    it('returns the MessageId SES responded with', async () => {
      sesMock.on(SendRawEmailCommand).resolves({ MessageId: MESSAGE_ID });

      await expect(makeClient(injectedClient()).sendRawEmail(RAW)).resolves.toEqual({
        messageId: MESSAGE_ID,
      });
    });

    it('returns an undefined messageId when SES omits it', async () => {
      sesMock.on(SendRawEmailCommand).resolves({});

      await expect(makeClient(injectedClient()).sendRawEmail(RAW)).resolves.toEqual({
        messageId: undefined,
      });
    });

    it('sends the raw message as bytes with the configuration set name', async () => {
      sesMock.on(SendRawEmailCommand).resolves({ MessageId: MESSAGE_ID });

      await makeClient(injectedClient()).sendRawEmail(RAW, 'ghost-ses-proxy');

      const calls = sesMock.commandCalls(SendRawEmailCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]?.args[0]?.input;
      expect(input?.ConfigurationSetName).toBe('ghost-ses-proxy');
      expect(Buffer.from(input?.RawMessage?.Data ?? []).toString('utf8')).toBe(
        RAW,
      );
    });

    it('omits ConfigurationSetName when none is given', async () => {
      sesMock.on(SendRawEmailCommand).resolves({ MessageId: MESSAGE_ID });

      await makeClient(injectedClient()).sendRawEmail(RAW);

      expect(
        sesMock.commandCalls(SendRawEmailCommand)[0]?.args[0]?.input
          .ConfigurationSetName,
      ).toBeUndefined();
    });

    it('accepts a Uint8Array raw message', async () => {
      sesMock.on(SendRawEmailCommand).resolves({ MessageId: MESSAGE_ID });

      await makeClient(injectedClient()).sendRawEmail(
        new TextEncoder().encode(RAW),
      );

      const input = sesMock.commandCalls(SendRawEmailCommand)[0]?.args[0]?.input;
      expect(Buffer.from(input?.RawMessage?.Data ?? []).toString('utf8')).toBe(
        RAW,
      );
    });

    it('constructs its own SESClient when none is injected', async () => {
      sesMock.on(SendRawEmailCommand).resolves({ MessageId: MESSAGE_ID });

      await expect(makeClient().sendRawEmail(RAW)).resolves.toEqual({
        messageId: MESSAGE_ID,
      });
    });

    it('propagates the rejection to the caller unchanged', async () => {
      const err = new Error('SES unavailable');
      err.name = 'Throttling';
      rejectWith(err);

      await expect(makeClient(injectedClient()).sendRawEmail(RAW)).rejects.toBe(
        err,
      );
    });
  });

  describe('metrics', () => {
    it('records the duration histogram with outcome="success"', async () => {
      sesMock.on(SendRawEmailCommand).resolves({ MessageId: MESSAGE_ID });

      await makeClient(injectedClient()).sendRawEmail(RAW);

      expect(await durationCount(deps.register, 'success')).toBe(1);
      expect(await durationCount(deps.register, 'error')).toBeUndefined();
    });

    it('records the duration histogram with outcome="error"', async () => {
      rejectWith(new Error('boom'));

      await expect(
        makeClient(injectedClient()).sendRawEmail(RAW),
      ).rejects.toThrow('boom');

      expect(await durationCount(deps.register, 'error')).toBe(1);
      expect(await durationCount(deps.register, 'success')).toBeUndefined();
    });

    it.each(SES_ERROR_TYPES)(
      'maps the SES error name %s to its own error_type',
      async (name) => {
        const err = new Error('nope');
        err.name = name;
        rejectWith(err);

        await expect(
          makeClient(injectedClient()).sendRawEmail(RAW),
        ).rejects.toThrow('nope');

        expect(
          await counterValue(deps.register, 'ghost_ses_proxy_ses_errors_total', {
            error_type: name,
          }),
        ).toBe(1);
      },
    );

    it('collapses an unlisted error name to other', async () => {
      const err = new Error('nope');
      err.name = 'SomeBrandNewSdkError';
      rejectWith(err);

      await expect(
        makeClient(injectedClient()).sendRawEmail(RAW),
      ).rejects.toThrow('nope');

      expect(
        await counterValue(deps.register, 'ghost_ses_proxy_ses_errors_total', {
          error_type: 'other',
        }),
      ).toBe(1);
    });

    it('collapses a rejection reason with a non-string name to other', async () => {
      rejectWith({ name: 42 });

      await expect(
        makeClient(injectedClient()).sendRawEmail(RAW),
      ).rejects.toEqual({ name: 42 });

      expect(
        await counterValue(deps.register, 'ghost_ses_proxy_ses_errors_total', {
          error_type: 'other',
        }),
      ).toBe(1);
    });

    it('collapses a null rejection reason to other', async () => {
      rejectWith(null);

      await expect(
        makeClient(injectedClient()).sendRawEmail(RAW),
      ).rejects.toBeNull();

      expect(
        await counterValue(deps.register, 'ghost_ses_proxy_ses_errors_total', {
          error_type: 'other',
        }),
      ).toBe(1);
    });
  });

  describe('logging', () => {
    it('logs at debug on success with the ses component and context', async () => {
      sesMock.on(SendRawEmailCommand).resolves({ MessageId: MESSAGE_ID });

      await makeClient(injectedClient()).sendRawEmail(RAW, 'ghost-ses-proxy', {
        reqId: 'req-1',
        batchId: 'batch-1',
        recipient: 'alice@example.com',
      });

      const line = deps.logs().at(-1);
      expect(line).toMatchObject({
        level: 'debug',
        component: 'ses',
        reqId: 'req-1',
        batchId: 'batch-1',
        recipient: 'alice@example.com',
        sesMessageId: MESSAGE_ID,
      });
      expect(typeof line?.durationMs).toBe('number');
    });

    it('logs at error on failure with the error type and serialized error', async () => {
      const err = new Error('SES unavailable');
      err.name = 'Throttling';
      rejectWith(err);

      await expect(
        makeClient(injectedClient()).sendRawEmail(RAW, undefined, {
          recipient: 'bob@example.com',
        }),
      ).rejects.toBe(err);

      const line = deps.logs().at(-1);
      expect(line).toMatchObject({
        level: 'error',
        component: 'ses',
        recipient: 'bob@example.com',
        errorType: 'Throttling',
      });
      expect(line?.err).toMatchObject({
        type: 'Error',
        message: 'SES unavailable',
      });
    });
  });

  describe('destroy', () => {
    it('destroys the underlying client', () => {
      const client = injectedClient();
      const spy = vi.spyOn(client, 'destroy');

      makeClient(client).destroy();

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
