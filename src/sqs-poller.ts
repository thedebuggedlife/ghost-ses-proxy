import { createHash } from 'node:crypto';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { Logger } from 'pino';
import {
  isRecognizedSesEventType,
  isSkippedSesEventType,
  mapSesEvent,
} from './event-mapper';
import type { Deps, NormalizedEvent, SesEvent } from './types';

export const POLL_WAIT_TIME_SECONDS = 20;
export const POLL_MAX_MESSAGES = 10;
export const POLL_ERROR_BACKOFF_MS = 5000;

export type SqsPollerDeps = Pick<Deps, 'config' | 'logger' | 'metrics' | 'db'>;

/** D3 (design §5.3): a content-derived id, so the existing `INSERT OR IGNORE` dedupes a redelivery. */
export function eventId(event: NormalizedEvent): string {
  return createHash('sha256')
    .update(
      [
        event.ses_message_id ?? '',
        event.event_type,
        event.recipient,
        String(event.timestamp),
      ].join(' '),
    )
    .digest('hex')
    .slice(0, 32);
}

/** An SES event whose `eventType` has been checked, so the poller never has to re-narrow it. */
export type ParsedSesEvent = SesEvent & { eventType: string };

function isSesEvent(value: unknown): value is ParsedSesEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SesEvent).eventType === 'string'
  );
}

interface SnsEnvelope {
  Type?: unknown;
  Message?: unknown;
}

/** Throws only on invalid JSON; returns `null` for anything that is not a recognizable SES event. */
export function parseSqsBody(body: string): ParsedSesEvent | null {
  const parsed: unknown = JSON.parse(body);

  if (typeof parsed !== 'object' || parsed === null) return null;

  const envelope = parsed as SnsEnvelope;
  if (envelope.Type === 'Notification' && typeof envelope.Message === 'string') {
    const inner: unknown = JSON.parse(envelope.Message);
    return isSesEvent(inner) ? inner : null;
  }

  return isSesEvent(parsed) ? parsed : null;
}

function stripAngleBrackets(value: string | null): string | null {
  if (!value) return value;
  return value.replace(/^</, '').replace(/>$/, '');
}

export class SqsPoller {
  private readonly log: Logger;
  private readonly client: SQSClient;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: SqsPollerDeps,
    client?: SQSClient,
  ) {
    this.log = deps.logger.child({ component: 'sqs' });
    this.client =
      client ??
      new SQSClient({
        region: deps.config.awsRegion,
        credentials: {
          accessKeyId: deps.config.awsAccessKeyId,
          secretAccessKey: deps.config.awsSecretAccessKey,
        },
      });
  }

  async pollOnce(): Promise<void> {
    const { metrics } = this.deps;
    const startedAt = performance.now();

    try {
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.deps.config.sqsQueueUrl,
          WaitTimeSeconds: POLL_WAIT_TIME_SECONDS,
          MaxNumberOfMessages: POLL_MAX_MESSAGES,
        }),
      );

      const messages = response.Messages ?? [];
      if (messages.length > 0) {
        metrics.sqsMessagesReceivedTotal.inc(messages.length);
        this.log.info({ messageCount: messages.length }, 'received SQS messages');
        for (const message of messages) {
          await this.processMessage(message);
        }
      }

      metrics.sqsPollsTotal.inc({ outcome: 'success' });
      metrics.sqsLastPollTimestampSeconds.set(Date.now() / 1000);
      metrics.sqsPollDurationSeconds.observe(
        (performance.now() - startedAt) / 1000,
      );
    } catch (err) {
      metrics.sqsPollsTotal.inc({ outcome: 'error' });
      metrics.sqsPollDurationSeconds.observe(
        (performance.now() - startedAt) / 1000,
      );
      this.log.error({ err }, 'SQS poll failed');
      throw err;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log.info(
      { queueUrl: this.deps.config.sqsQueueUrl },
      'SQS poller started',
    );
    this.scheduleNext(0);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.log.info('SQS poller stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runIteration();
    }, delayMs);
  }

  private async runIteration(): Promise<void> {
    try {
      await this.pollOnce();
      this.scheduleNext(0);
    } catch {
      // Already logged and counted by pollOnce; a poll failure must never exit the loop.
      this.scheduleNext(POLL_ERROR_BACKOFF_MS);
    }
  }

  private async processMessage(message: Message): Promise<void> {
    const { metrics } = this.deps;

    let sesEvent: ParsedSesEvent | null;
    try {
      sesEvent = parseSqsBody(message.Body ?? '');
    } catch (err) {
      metrics.sqsParseErrorsTotal.inc({ reason: 'invalid_json' });
      this.log.warn({ err }, 'failed to parse SQS message body');
      await this.deleteMessage(message.ReceiptHandle);
      return;
    }

    if (!sesEvent) {
      metrics.sqsParseErrorsTotal.inc({ reason: 'unrecognized_format' });
      this.log.warn('unrecognized SQS message format');
      await this.deleteMessage(message.ReceiptHandle);
      return;
    }

    const sesEventType = sesEvent.eventType;
    const sesMessageId = sesEvent.mail?.messageId ?? null;

    if (isSkippedSesEventType(sesEventType)) {
      metrics.eventsSkippedTotal.inc({ ses_event_type: sesEventType });
      this.log.debug({ sesEventType, sesMessageId }, 'skipped SES event type');
      await this.deleteMessage(message.ReceiptHandle);
      return;
    }

    const normalized = mapSesEvent(sesEvent);

    if (normalized.length === 0) {
      if (isRecognizedSesEventType(sesEventType)) {
        // D7 (design §5.5): a defect in the input, deliberately not a skip.
        metrics.sqsParseErrorsTotal.inc({ reason: 'malformed_payload' });
        this.log.warn(
          { sesEventType, sesMessageId },
          'malformed SES payload: recognized event type produced no events',
        );
      } else {
        // P10: an unbounded label fed by third-party JSON collapses to `other`.
        metrics.eventsSkippedTotal.inc({ ses_event_type: 'other' });
        this.log.debug(
          { sesEventType, sesMessageId },
          'skipped unrecognized SES event type',
        );
      }
      await this.deleteMessage(message.ReceiptHandle);
      return;
    }

    for (const event of normalized) {
      this.storeEvent(event, sesEventType);
    }
    this.log.info(
      { sesEventType, sesMessageId, storedCount: normalized.length },
      'stored SES events',
    );

    await this.deleteMessage(message.ReceiptHandle);
  }

  private storeEvent(event: NormalizedEvent, sesEventType: string): void {
    const { db, metrics } = this.deps;

    let batchMessageId = event.batch_message_id;
    let ghostEmailId = event.ghost_email_id;
    let tags: string | null = null;

    const row = event.ses_message_id
      ? db.lookupRecipientEmail(event.ses_message_id)
      : undefined;

    if (row) {
      batchMessageId = stripAngleBrackets(row.batch_message_id);
      ghostEmailId = row.ghost_email_id || ghostEmailId;
      tags = row.tags;
      metrics.eventCorrelationTotal.inc({ result: 'matched' });
    } else {
      // P10: an event with no ses_message_id gets no lookup at all, but still
      // belongs in the correlation denominator (design §4.7).
      metrics.eventCorrelationTotal.inc({ result: 'unmatched' });
    }

    db.insertEvent({
      id: eventId(event),
      event_type: event.event_type,
      severity: event.severity,
      recipient: event.recipient,
      timestamp: event.timestamp,
      message_id: stripAngleBrackets(batchMessageId),
      email_id: ghostEmailId,
      delivery_status_code: event.delivery_status_code,
      delivery_status_message: event.delivery_status_message,
      delivery_status_enhanced: event.delivery_status_enhanced,
      tags: tags || '[]',
    });

    metrics.eventsStoredTotal.inc({
      event_type: event.event_type,
      severity: event.severity ?? 'none',
    });
    metrics.eventLagSeconds.observe(
      Math.max(0, Date.now() / 1000 - event.timestamp),
    );

    if (event.is_suppression && event.suppression_type) {
      db.insertSuppression(
        event.recipient,
        event.suppression_type,
        event.suppression_reason,
      );
      metrics.suppressionsRecordedTotal.inc({ type: event.suppression_type });
      this.log.info(
        {
          recipient: event.recipient,
          suppressionType: event.suppression_type,
          sesMessageId: event.ses_message_id,
        },
        'suppression recorded',
      );
    }

    this.log.debug(
      {
        sesEventType,
        eventType: event.event_type,
        recipient: event.recipient,
        sesMessageId: event.ses_message_id,
        ghostEmailId,
      },
      'stored event',
    );
  }

  private async deleteMessage(receiptHandle: string | undefined): Promise<void> {
    const { metrics } = this.deps;
    try {
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.deps.config.sqsQueueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
      metrics.sqsMessagesDeletedTotal.inc({ outcome: 'success' });
    } catch (err) {
      metrics.sqsMessagesDeletedTotal.inc({ outcome: 'error' });
      this.log.error({ err }, 'failed to delete SQS message');
    }
  }
}
