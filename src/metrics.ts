import {
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
  type Registry,
} from 'prom-client';
import { getVersion } from './logger';
import type { Metrics } from './types';

const PREFIX = 'ghost_ses_proxy_';

export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30,
];
export const SEND_BATCH_RECIPIENT_BUCKETS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000,
];
export const SES_SEND_DURATION_BUCKETS = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
export const SQS_POLL_DURATION_BUCKETS = [
  0.01, 0.1, 0.5, 1, 5, 10, 20, 25, 30,
];
export const EVENT_LAG_BUCKETS = [
  1, 5, 10, 30, 60, 300, 900, 3600, 21600, 86400,
];

/**
 * Bounded `error_type` label values for `ses_errors_total`. Raw `err.name`
 * values from the AWS SDK are not a bounded set, so anything outside this
 * allowlist collapses to `other`.
 */
export const SES_ERROR_TYPES = [
  'Throttling',
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'ConfigurationSetDoesNotExistException',
  'AccountSendingPausedException',
  'LimitExceededException',
  'TimeoutError',
] as const;

export type SesErrorType = (typeof SES_ERROR_TYPES)[number] | 'other';

export function toSesErrorType(name: string | undefined | null): SesErrorType {
  const match = SES_ERROR_TYPES.find((known) => known === name);
  return match ?? 'other';
}

export function createMetrics(register: Registry): Metrics {
  collectDefaultMetrics({ register });

  const metrics: Metrics = {
    register,

    // §4.1 HTTP
    httpRequestsTotal: new Counter({
      name: `${PREFIX}http_requests_total`,
      help: 'Total HTTP requests handled, by method, route template and status code.',
      labelNames: ['method', 'route', 'status_code'],
      registers: [register],
    }),
    httpRequestDurationSeconds: new Histogram({
      name: `${PREFIX}http_request_duration_seconds`,
      help: 'HTTP request duration in seconds.',
      labelNames: ['method', 'route', 'status_code'],
      buckets: HTTP_DURATION_BUCKETS,
      registers: [register],
    }),

    // §4.2 Send path
    sendBatchesTotal: new Counter({
      name: `${PREFIX}send_batches_total`,
      help: 'Newsletter send batches by outcome (success|partial|failure|rejected).',
      labelNames: ['outcome'],
      registers: [register],
    }),
    sendRecipientsTotal: new Counter({
      name: `${PREFIX}send_recipients_total`,
      help: 'Individual recipients by send outcome (sent|failed).',
      labelNames: ['outcome'],
      registers: [register],
    }),
    sendBatchRecipients: new Histogram({
      name: `${PREFIX}send_batch_recipients`,
      help: 'Number of recipients per send batch.',
      buckets: SEND_BATCH_RECIPIENT_BUCKETS,
      registers: [register],
    }),
    sesSendDurationSeconds: new Histogram({
      name: `${PREFIX}ses_send_duration_seconds`,
      help: 'Per-recipient SES SendRawEmail latency in seconds.',
      labelNames: ['outcome'],
      buckets: SES_SEND_DURATION_BUCKETS,
      registers: [register],
    }),
    sesErrorsTotal: new Counter({
      name: `${PREFIX}ses_errors_total`,
      help: 'SES send errors by allowlisted error type.',
      labelNames: ['error_type'],
      registers: [register],
    }),
    sendInFlight: new Gauge({
      name: `${PREFIX}send_in_flight`,
      help: 'Semaphore slots currently held by in-flight sends (D1 canary).',
      registers: [register],
    }),
    sendQueueDepth: new Gauge({
      name: `${PREFIX}send_queue_depth`,
      help: 'Senders waiting on a semaphore slot.',
      registers: [register],
    }),

    // §4.3 SQS poller and events
    sqsPollsTotal: new Counter({
      name: `${PREFIX}sqs_polls_total`,
      help: 'SQS receive-message polls by outcome (success|error).',
      labelNames: ['outcome'],
      registers: [register],
    }),
    sqsPollDurationSeconds: new Histogram({
      name: `${PREFIX}sqs_poll_duration_seconds`,
      help: 'Duration of a single SQS poll cycle in seconds.',
      buckets: SQS_POLL_DURATION_BUCKETS,
      registers: [register],
    }),
    sqsMessagesReceivedTotal: new Counter({
      name: `${PREFIX}sqs_messages_received_total`,
      help: 'SQS messages received.',
      registers: [register],
    }),
    sqsMessagesDeletedTotal: new Counter({
      name: `${PREFIX}sqs_messages_deleted_total`,
      help: 'SQS message deletions by outcome (success|error).',
      labelNames: ['outcome'],
      registers: [register],
    }),
    sqsParseErrorsTotal: new Counter({
      name: `${PREFIX}sqs_parse_errors_total`,
      help: 'Unparseable SQS payloads by reason (invalid_json|unrecognized_format|malformed_payload).',
      labelNames: ['reason'],
      registers: [register],
    }),
    sqsLastPollTimestampSeconds: new Gauge({
      name: `${PREFIX}sqs_last_poll_timestamp_seconds`,
      help: 'Unix timestamp of the last successful SQS poll.',
      registers: [register],
    }),
    eventsStoredTotal: new Counter({
      name: `${PREFIX}events_stored_total`,
      help: 'Normalized events stored, by event type and severity.',
      labelNames: ['event_type', 'severity'],
      registers: [register],
    }),
    eventsSkippedTotal: new Counter({
      name: `${PREFIX}events_skipped_total`,
      help: 'SES events deliberately not stored, by raw SES event type.',
      labelNames: ['ses_event_type'],
      registers: [register],
    }),
    eventCorrelationTotal: new Counter({
      name: `${PREFIX}event_correlation_total`,
      help: 'Event correlation against recipient_emails (matched|unmatched).',
      labelNames: ['result'],
      registers: [register],
    }),
    eventLagSeconds: new Histogram({
      name: `${PREFIX}event_lag_seconds`,
      help: 'Seconds between the SES event timestamp and its insertion.',
      buckets: EVENT_LAG_BUCKETS,
      registers: [register],
    }),

    // §4.4 Suppressions
    suppressionsRecordedTotal: new Counter({
      name: `${PREFIX}suppressions_recorded_total`,
      help: 'Suppression rows recorded, by type (bounces|complaints|unsubscribes).',
      labelNames: ['type'],
      registers: [register],
    }),
    suppressionsRemovedTotal: new Counter({
      name: `${PREFIX}suppressions_removed_total`,
      help: 'Suppression rows removed, by type.',
      labelNames: ['type'],
      registers: [register],
    }),

    // §4.5 Database and build
    dbRows: new Gauge({
      name: `${PREFIX}db_rows`,
      help: 'Row count per table.',
      labelNames: ['table'],
      registers: [register],
    }),
    dbSizeBytes: new Gauge({
      name: `${PREFIX}db_size_bytes`,
      help: 'On-disk size of the SQLite database in bytes.',
      registers: [register],
    }),
    dbErrorsTotal: new Counter({
      name: `${PREFIX}db_errors_total`,
      help: 'Failing database statements by operation.',
      labelNames: ['operation'],
      registers: [register],
    }),
    dbCleanupRunsTotal: new Counter({
      name: `${PREFIX}db_cleanup_runs_total`,
      help: 'Retention cleanup runs by outcome (success|error).',
      labelNames: ['outcome'],
      registers: [register],
    }),
    dbCleanupDeletedRowsTotal: new Counter({
      name: `${PREFIX}db_cleanup_deleted_rows_total`,
      help: 'Rows deleted by retention cleanup, per table.',
      labelNames: ['table'],
      registers: [register],
    }),
    buildInfo: new Gauge({
      name: `${PREFIX}build_info`,
      help: 'Build information; always 1, carries version labels.',
      labelNames: ['version', 'node_version'],
      registers: [register],
    }),
  };

  metrics.buildInfo.set(
    { version: getVersion(), node_version: process.version },
    1,
  );

  return metrics;
}
