import { Registry, register as globalRegister } from 'prom-client';
import { describe, expect, it } from 'vitest';
import {
  HTTP_DURATION_BUCKETS,
  SEND_BATCH_RECIPIENT_BUCKETS,
  SES_ERROR_TYPES,
  createMetrics,
  toSesErrorType,
} from '../src/metrics';
import type { Metrics } from '../src/types';
import pkg from '../package.json';

interface CatalogEntry {
  property: keyof Metrics;
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  labelNames: string[];
}

/**
 * The full application catalog from design §4.1–§4.5, written out literally so
 * a later phase cannot quietly drop, rename, or relabel a metric.
 */
const CATALOG: CatalogEntry[] = [
  // §4.1 HTTP
  {
    property: 'httpRequestsTotal',
    name: 'ghost_ses_proxy_http_requests_total',
    type: 'counter',
    labelNames: ['method', 'route', 'status_code'],
  },
  {
    property: 'httpRequestDurationSeconds',
    name: 'ghost_ses_proxy_http_request_duration_seconds',
    type: 'histogram',
    labelNames: ['method', 'route', 'status_code'],
  },

  // §4.2 Send path
  {
    property: 'sendBatchesTotal',
    name: 'ghost_ses_proxy_send_batches_total',
    type: 'counter',
    labelNames: ['outcome'],
  },
  {
    property: 'sendRecipientsTotal',
    name: 'ghost_ses_proxy_send_recipients_total',
    type: 'counter',
    labelNames: ['outcome'],
  },
  {
    property: 'sendBatchRecipients',
    name: 'ghost_ses_proxy_send_batch_recipients',
    type: 'histogram',
    labelNames: [],
  },
  {
    property: 'sesSendDurationSeconds',
    name: 'ghost_ses_proxy_ses_send_duration_seconds',
    type: 'histogram',
    labelNames: ['outcome'],
  },
  {
    property: 'sesErrorsTotal',
    name: 'ghost_ses_proxy_ses_errors_total',
    type: 'counter',
    labelNames: ['error_type'],
  },
  {
    property: 'sendInFlight',
    name: 'ghost_ses_proxy_send_in_flight',
    type: 'gauge',
    labelNames: [],
  },
  {
    property: 'sendQueueDepth',
    name: 'ghost_ses_proxy_send_queue_depth',
    type: 'gauge',
    labelNames: [],
  },

  // §4.3 SQS poller and events
  {
    property: 'sqsPollsTotal',
    name: 'ghost_ses_proxy_sqs_polls_total',
    type: 'counter',
    labelNames: ['outcome'],
  },
  {
    property: 'sqsPollDurationSeconds',
    name: 'ghost_ses_proxy_sqs_poll_duration_seconds',
    type: 'histogram',
    labelNames: [],
  },
  {
    property: 'sqsMessagesReceivedTotal',
    name: 'ghost_ses_proxy_sqs_messages_received_total',
    type: 'counter',
    labelNames: [],
  },
  {
    property: 'sqsMessagesDeletedTotal',
    name: 'ghost_ses_proxy_sqs_messages_deleted_total',
    type: 'counter',
    labelNames: ['outcome'],
  },
  {
    property: 'sqsParseErrorsTotal',
    name: 'ghost_ses_proxy_sqs_parse_errors_total',
    type: 'counter',
    labelNames: ['reason'],
  },
  {
    property: 'sqsLastPollTimestampSeconds',
    name: 'ghost_ses_proxy_sqs_last_poll_timestamp_seconds',
    type: 'gauge',
    labelNames: [],
  },
  {
    property: 'eventsStoredTotal',
    name: 'ghost_ses_proxy_events_stored_total',
    type: 'counter',
    labelNames: ['event_type', 'severity'],
  },
  {
    property: 'eventsSkippedTotal',
    name: 'ghost_ses_proxy_events_skipped_total',
    type: 'counter',
    labelNames: ['ses_event_type'],
  },
  {
    property: 'eventCorrelationTotal',
    name: 'ghost_ses_proxy_event_correlation_total',
    type: 'counter',
    labelNames: ['result'],
  },
  {
    property: 'eventLagSeconds',
    name: 'ghost_ses_proxy_event_lag_seconds',
    type: 'histogram',
    labelNames: [],
  },

  // §4.4 Suppressions
  {
    property: 'suppressionsRecordedTotal',
    name: 'ghost_ses_proxy_suppressions_recorded_total',
    type: 'counter',
    labelNames: ['type'],
  },
  {
    property: 'suppressionsRemovedTotal',
    name: 'ghost_ses_proxy_suppressions_removed_total',
    type: 'counter',
    labelNames: ['type'],
  },

  // §4.5 Database and build
  {
    property: 'dbRows',
    name: 'ghost_ses_proxy_db_rows',
    type: 'gauge',
    labelNames: ['table'],
  },
  {
    property: 'dbSizeBytes',
    name: 'ghost_ses_proxy_db_size_bytes',
    type: 'gauge',
    labelNames: [],
  },
  {
    property: 'dbErrorsTotal',
    name: 'ghost_ses_proxy_db_errors_total',
    type: 'counter',
    labelNames: ['operation'],
  },
  {
    property: 'dbCleanupRunsTotal',
    name: 'ghost_ses_proxy_db_cleanup_runs_total',
    type: 'counter',
    labelNames: ['outcome'],
  },
  {
    property: 'dbCleanupDeletedRowsTotal',
    name: 'ghost_ses_proxy_db_cleanup_deleted_rows_total',
    type: 'counter',
    labelNames: ['table'],
  },
  {
    property: 'buildInfo',
    name: 'ghost_ses_proxy_build_info',
    type: 'gauge',
    labelNames: ['version', 'node_version'],
  },
];

/** `labelNames` and `upperBounds` are runtime fields prom-client does not type. */
interface MetricInternals {
  name: string;
  labelNames: string[];
  upperBounds?: number[];
}

function internals(register: Registry, name: string): MetricInternals {
  const metric = register.getSingleMetric(name);
  expect(metric, `metric ${name} is not registered`).toBeDefined();
  return metric as unknown as MetricInternals;
}

function appMetricNames(json: { name: string }[]): string[] {
  return json
    .map((m) => m.name)
    .filter((n) => n.startsWith('ghost_ses_proxy_'))
    .sort();
}

describe('createMetrics — catalog', () => {
  it.each(CATALOG)('registers $name as a $type', async (entry) => {
    const register = new Registry();
    const metrics = createMetrics(register);

    const metric = internals(register, entry.name);
    expect(metric.labelNames).toEqual(entry.labelNames);

    const json = await register.getMetricsAsJSON();
    expect(json.find((m) => m.name === entry.name)?.type).toBe(entry.type);

    expect((metrics[entry.property] as unknown as MetricInternals).name).toBe(
      entry.name,
    );
  });

  it('registers exactly the catalog and nothing else', async () => {
    const register = new Registry();
    createMetrics(register);

    const json = await register.getMetricsAsJSON();
    expect(appMetricNames(json)).toEqual(CATALOG.map((e) => e.name).sort());
  });

  it('covers the design §4 section counts', () => {
    expect(CATALOG).toHaveLength(27);
  });

  it('exposes the injected registry', () => {
    const register = new Registry();
    expect(createMetrics(register).register).toBe(register);
  });
});

describe('createMetrics — histogram buckets', () => {
  it('uses the design §4.1 buckets for HTTP duration', () => {
    const register = new Registry();
    createMetrics(register);

    expect(
      internals(register, 'ghost_ses_proxy_http_request_duration_seconds')
        .upperBounds,
    ).toEqual(HTTP_DURATION_BUCKETS);
    expect(HTTP_DURATION_BUCKETS).toEqual([
      0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30,
    ]);
  });

  it('uses the design §4.2 buckets for batch recipient counts', () => {
    const register = new Registry();
    createMetrics(register);

    expect(
      internals(register, 'ghost_ses_proxy_send_batch_recipients').upperBounds,
    ).toEqual(SEND_BATCH_RECIPIENT_BUCKETS);
    expect(SEND_BATCH_RECIPIENT_BUCKETS).toEqual([
      1, 5, 10, 25, 50, 100, 250, 500, 1000,
    ]);
  });
});

describe('createMetrics — default metrics', () => {
  it('collects default process and nodejs metrics unprefixed', async () => {
    const register = new Registry();
    createMetrics(register);

    const names = (await register.getMetricsAsJSON()).map((m) => m.name);
    expect(names).toContain('process_cpu_seconds_total');
    expect(names).toContain('nodejs_eventloop_lag_seconds');
    expect(names.some((n) => n.startsWith('ghost_ses_proxy_process_'))).toBe(
      false,
    );
    expect(names.some((n) => n.startsWith('ghost_ses_proxy_nodejs_'))).toBe(
      false,
    );
  });
});

describe('createMetrics — build_info', () => {
  it('is 1 and carries version and node_version labels', async () => {
    const register = new Registry();
    createMetrics(register);

    const json = await register.getMetricsAsJSON();
    const values = json.find(
      (m) => m.name === 'ghost_ses_proxy_build_info',
    )?.values;

    expect(values).toHaveLength(1);
    expect(values?.[0]?.value).toBe(1);
    expect(values?.[0]?.labels).toEqual({
      version: pkg.version,
      node_version: process.version,
    });
  });
});

describe('createMetrics — registry isolation', () => {
  it('does not collide when called twice on separate registries', async () => {
    const a = new Registry();
    const b = new Registry();

    const metricsA = createMetrics(a);
    const metricsB = createMetrics(b);

    metricsA.sendBatchesTotal.inc({ outcome: 'success' }, 3);
    metricsB.sendBatchesTotal.inc({ outcome: 'success' }, 7);

    const valueOf = async (register: Registry): Promise<number | undefined> => {
      const json = await register.getMetricsAsJSON();
      return json.find((m) => m.name === 'ghost_ses_proxy_send_batches_total')
        ?.values[0]?.value;
    };

    expect(await valueOf(a)).toBe(3);
    expect(await valueOf(b)).toBe(7);
  });

  it('never touches the prom-client global default registry', async () => {
    createMetrics(new Registry());

    expect(appMetricNames(await globalRegister.getMetricsAsJSON())).toEqual([]);
  });
});

describe('toSesErrorType', () => {
  it.each(SES_ERROR_TYPES)('passes %s through the allowlist', (name) => {
    expect(toSesErrorType(name)).toBe(name);
  });

  it('collapses unknown, undefined and null names to other', () => {
    expect(toSesErrorType('SomeBrandNewSdkError')).toBe('other');
    expect(toSesErrorType(undefined)).toBe('other');
    expect(toSesErrorType(null)).toBe('other');
    expect(toSesErrorType('')).toBe('other');
  });

  it('allowlists exactly the design §4.2 error types', () => {
    expect([...SES_ERROR_TYPES]).toEqual([
      'Throttling',
      'MessageRejected',
      'MailFromDomainNotVerifiedException',
      'ConfigurationSetDoesNotExistException',
      'AccountSendingPausedException',
      'LimitExceededException',
      'TimeoutError',
    ]);
  });
});
