import { Registry } from 'prom-client';
import type { AppDeps } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createDb } from '../../src/db';
import { createLogger } from '../../src/logger';
import { createMetrics } from '../../src/metrics';
import { attachDbGauges, createStats } from '../../src/stats';
import type {
  SendRawEmailResult,
  SesClient,
  SesSendContext,
} from '../../src/types';

export const TEST_ENV: NodeJS.ProcessEnv = {
  AWS_ACCESS_KEY_ID: 'AKIAFAKE',
  AWS_SECRET_ACCESS_KEY: 'fake-secret',
  AWS_REGION: 'us-east-1',
  SES_CONFIGURATION_SET: 'ghost-ses-proxy',
  SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/fake',
  PROXY_API_KEY: 'test-key',
  MAILGUN_DOMAIN: 'example.com',
  PORT: '3003',
  SEND_CONCURRENCY: '10',
  LOG_LEVEL: 'trace',
  DB_PATH: ':memory:',
};

export interface SesStubCall {
  rawMessage: string;
  configurationSetName: string | undefined;
  context: SesSendContext | undefined;
}

export interface SesStub extends SesClient {
  readonly calls: SesStubCall[];
  /** Replace to simulate failures or per-recipient behaviour. */
  respond: (call: SesStubCall, index: number) => Promise<SendRawEmailResult>;
  destroyed: boolean;
}

export const STUB_SES_MESSAGE_ID =
  '0100000000000000-11111111-2222-3333-4444-555555555555-000000';

export function createSesStub(): SesStub {
  const stub: SesStub = {
    calls: [],
    destroyed: false,
    respond: () => Promise.resolve({ messageId: STUB_SES_MESSAGE_ID }),
    sendRawEmail(rawMessage, configurationSetName, context) {
      const call: SesStubCall = {
        rawMessage:
          typeof rawMessage === 'string'
            ? rawMessage
            : Buffer.from(rawMessage).toString('utf8'),
        configurationSetName,
        context,
      };
      stub.calls.push(call);
      return stub.respond(call, stub.calls.length - 1);
    },
    destroy() {
      stub.destroyed = true;
    },
  };
  return stub;
}

export type { AppDeps };

export type TestDeps = AppDeps & {
  logs: () => Record<string, unknown>[];
  register: Registry;
};

export function makeDeps(overrides: Partial<AppDeps> = {}): TestDeps {
  const lines: Record<string, unknown>[] = [];

  const config = overrides.config ?? loadConfig({ ...TEST_ENV });
  const logger =
    overrides.logger ??
    createLogger(config, {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      },
    });
  const metrics = overrides.metrics ?? createMetrics(new Registry());
  const db = overrides.db ?? createDb(config.dbPath, logger, metrics);
  const ses = overrides.ses ?? createSesStub();
  const stats = overrides.stats ?? createStats(db);

  attachDbGauges(metrics, stats, db);

  return {
    config,
    logger,
    metrics,
    db,
    ses,
    stats,
    register: metrics.register,
    logs: () => lines,
  };
}
