import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Counter, Gauge, Histogram, Registry } from 'prom-client';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface Config {
  port: number;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
  sesConfigurationSet: string;
  sqsQueueUrl: string;
  proxyApiKey: string;
  mailgunDomain: string;
  logLevel: LogLevel;
  sendConcurrency: number;
  dbPath: string;
}

export interface TableCounts {
  message_map: number;
  recipient_emails: number;
  events: number;
  suppressions: number;
}

export interface Stats {
  getCounts(now?: number): TableCounts;
}

export type SuppressionType = 'bounces' | 'complaints' | 'unsubscribes';

export interface NormalizedEvent {
  event_type: string;
  severity: string | null;
  recipient: string;
  timestamp: number;
  ses_message_id: string | null;
  ghost_email_id: string | null;
  batch_message_id: string | null;
  delivery_status_code: number | null;
  delivery_status_message: string | null;
  delivery_status_enhanced: string;
  is_suppression: boolean;
  suppression_type: SuppressionType | null;
  suppression_reason: string | null;
}

export interface SesHeader {
  name?: string;
  value?: string;
}

export interface SesMail {
  messageId?: string;
  timestamp?: string;
  destination?: string[];
  headers?: SesHeader[];
}

export interface SesBouncedRecipient {
  emailAddress?: string;
  diagnosticCode?: string;
}

export interface SesComplainedRecipient {
  emailAddress?: string;
}

export interface SesEvent {
  eventType?: string;
  mail?: SesMail;
  delivery?: { timestamp?: string; recipients?: string[] };
  bounce?: {
    timestamp?: string;
    bounceType?: string;
    bouncedRecipients?: SesBouncedRecipient[];
  };
  complaint?: {
    timestamp?: string;
    arrivalDate?: string;
    complainedRecipients?: SesComplainedRecipient[];
  };
  open?: { timestamp?: string };
  click?: { timestamp?: string };
  reject?: { reason?: string };
}

export interface MessageMapRow {
  batch_message_id: string;
  ghost_email_id: string | null;
  tags: string | null;
  created_at: string;
}

export interface RecipientEmailRow {
  ses_message_id: string;
  batch_message_id: string;
  recipient: string;
  ghost_email_id: string | null;
  tags: string | null;
  created_at: string;
}

export interface EventRow {
  id: string;
  event_type: string;
  severity: string | null;
  recipient: string;
  timestamp: number;
  message_id: string | null;
  email_id: string | null;
  delivery_status_code: number | null;
  delivery_status_message: string | null;
  delivery_status_enhanced: string | null;
  tags: string | null;
}

/** Statement names used as the bounded `operation` label on `db_errors_total`. */
export type DbOperation =
  | 'insertMessageMap'
  | 'insertRecipientEmail'
  | 'insertEvent'
  | 'insertSuppression'
  | 'deleteSuppression'
  | 'lookupRecipientEmail';

export interface Db {
  raw: Database;
  insertMessageMap(
    batchMessageId: string,
    ghostEmailId: string | null,
    tags: string | null,
  ): void;
  insertRecipientEmail(
    sesMessageId: string,
    batchMessageId: string,
    recipient: string,
    ghostEmailId: string | null,
    tags: string | null,
  ): void;
  insertEvent(row: EventRow): void;
  insertSuppression(email: string, type: string, reason: string | null): void;
  deleteSuppression(email: string, type: string): number;
  lookupRecipientEmail(sesMessageId: string): RecipientEmailRow | undefined;
  close(): void;
}

export interface SendRawEmailResult {
  messageId: string | undefined;
}

/** Correlation fields the send path passes through to the `component: 'ses'` log lines. */
export interface SesSendContext {
  reqId?: string;
  batchId?: string;
  recipient?: string;
}

export interface SesClient {
  sendRawEmail(
    rawMessage: string | Uint8Array,
    configurationSetName?: string,
    context?: SesSendContext,
  ): Promise<SendRawEmailResult>;
  destroy(): void;
}

export interface Metrics {
  register: Registry;

  // §4.1 HTTP
  httpRequestsTotal: Counter<'method' | 'route' | 'status_code'>;
  httpRequestDurationSeconds: Histogram<'method' | 'route' | 'status_code'>;

  // §4.2 Send path
  sendBatchesTotal: Counter<'outcome'>;
  sendRecipientsTotal: Counter<'outcome'>;
  sendBatchRecipients: Histogram<string>;
  sesSendDurationSeconds: Histogram<'outcome'>;
  sesErrorsTotal: Counter<'error_type'>;
  sendInFlight: Gauge<string>;
  sendQueueDepth: Gauge<string>;

  // §4.3 SQS poller and events
  sqsPollsTotal: Counter<'outcome'>;
  sqsPollDurationSeconds: Histogram<string>;
  sqsMessagesReceivedTotal: Counter<string>;
  sqsMessagesDeletedTotal: Counter<'outcome'>;
  sqsParseErrorsTotal: Counter<'reason'>;
  sqsLastPollTimestampSeconds: Gauge<string>;
  eventsStoredTotal: Counter<'event_type' | 'severity'>;
  eventsSkippedTotal: Counter<'ses_event_type'>;
  eventCorrelationTotal: Counter<'result'>;
  eventLagSeconds: Histogram<string>;

  // §4.4 Suppressions
  suppressionsRecordedTotal: Counter<'type'>;
  suppressionsRemovedTotal: Counter<'type'>;

  // §4.5 Database and build
  dbRows: Gauge<'table'>;
  dbSizeBytes: Gauge<string>;
  dbErrorsTotal: Counter<'operation'>;
  dbCleanupRunsTotal: Counter<'outcome'>;
  dbCleanupDeletedRowsTotal: Counter<'table'>;
  buildInfo: Gauge<'version' | 'node_version'>;
}

export interface Deps {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  db: Db;
  ses: SesClient;
}
