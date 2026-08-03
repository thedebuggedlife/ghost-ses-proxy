import type { RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { RecipientOutcome, SendOutcome } from '../metrics';
import { buildRawMime } from '../mime';
import { parseFormData, type FormFields } from '../multipart';
import { Semaphore } from '../semaphore';
import { substituteVars, type RecipientVars } from '../template-vars';
import type { Deps } from '../types';

/** `h:*` fields that become real headers rather than passthrough custom headers. */
export const RESERVED_HEADER_FIELDS: ReadonlySet<string> = new Set([
  'h:Reply-To',
  'h:Sender',
  'h:List-Unsubscribe',
  'h:List-Unsubscribe-Post',
]);

/** prom-client sets `collect` on every metric instance but does not declare it on the class. */
interface Collectable {
  collect: () => void;
}

/** Reads a field busboy may have accumulated into an array as a single value. */
export function scalarField(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export function listField(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Drops Mailgun's `<%tag_unsubscribe_email%>` placeholder and the comma it leaves behind. */
export function stripUnsubscribePlaceholder(value: string): string {
  return value
    .replace(/,?\s*<%tag_unsubscribe_email%>/g, '')
    .replace(/^,\s*/, '')
    .replace(/,\s*$/, '')
    .trim();
}

export interface SendParams {
  domain: string;
}

interface RecipientError {
  recipient: string;
  error: string;
}

export function createSendEmailRoute(deps: Deps): RequestHandler<SendParams> {
  const log = deps.logger.child({ component: 'send' });
  const {
    sendBatchesTotal,
    sendRecipientsTotal,
    sendBatchRecipients,
    sendInFlight,
    sendQueueDepth,
  } = deps.metrics;

  // One semaphore per app, not per request — a per-request limiter would not limit.
  const semaphore = new Semaphore(deps.config.sendConcurrency);

  (sendInFlight as unknown as Collectable).collect = () => {
    sendInFlight.set(semaphore.inFlight);
  };
  (sendQueueDepth as unknown as Collectable).collect = () => {
    sendQueueDepth.set(semaphore.queueDepth);
  };

  return async function sendEmail(req, res) {
    const reqId = String(req.id);

    try {
      const fields: FormFields = await parseFormData(req);

      const from = scalarField(fields['from']);
      const subject = scalarField(fields['subject']);
      const html = scalarField(fields['html']);
      const text = scalarField(fields['text']);
      const recipientVarsRaw = scalarField(fields['recipient-variables']);
      const toList = listField(fields['to']);
      const tags = listField(fields['o:tag']);
      const ghostEmailId = scalarField(fields['v:email-id']);

      if (!from || !subject || toList.length === 0) {
        sendBatchesTotal.inc({ outcome: 'rejected' satisfies SendOutcome });
        log.warn(
          { reqId, ghostEmailId, recipientCount: toList.length },
          'rejected send: missing required fields',
        );
        res
          .status(400)
          .json({ message: 'Missing required fields: from, subject, to' });
        return;
      }

      let recipientVars: Record<string, RecipientVars> = {};
      if (recipientVarsRaw) {
        try {
          recipientVars = JSON.parse(recipientVarsRaw) as Record<
            string,
            RecipientVars
          >;
        } catch (err) {
          sendBatchesTotal.inc({ outcome: 'rejected' satisfies SendOutcome });
          log.warn(
            { reqId, ghostEmailId, err },
            'rejected send: invalid recipient-variables JSON',
          );
          res.status(400).json({ message: 'Invalid recipient-variables JSON' });
          return;
        }
      }

      const batchId = `${uuidv4()}@${req.params.domain}`;
      const batchMessageId = `<${batchId}>`;
      const tagsJson = JSON.stringify(tags);

      deps.db.insertMessageMap(batchMessageId, ghostEmailId, tagsJson);

      const customHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(fields)) {
        if (name.startsWith('h:') && !RESERVED_HEADER_FIELDS.has(name)) {
          customHeaders[name.slice(2)] = scalarField(value);
        }
      }
      if (ghostEmailId) {
        customHeaders['X-Ghost-Email-Id'] = ghostEmailId;
      }

      const replyTo = scalarField(fields['h:Reply-To']);
      const sender = scalarField(fields['h:Sender']);
      const listUnsubscribeRaw = scalarField(fields['h:List-Unsubscribe']);
      const listUnsubscribePost = scalarField(
        fields['h:List-Unsubscribe-Post'],
      );

      let succeeded = 0;
      let failed = 0;
      const errors: RecipientError[] = [];

      sendBatchRecipients.observe(toList.length);

      await Promise.all(
        toList.map((recipient) =>
          // D1 (design §5.1): `runExclusive` owns the acquire/release pair, and the
          // inner try/catch turns *any* throw — not just an SES rejection — into a
          // failed recipient, so one bad recipient can neither wedge the semaphore
          // nor 500 a batch that partly succeeded.
          semaphore.runExclusive(async () => {
            try {
              const vars = recipientVars[recipient] ?? {};

              const recipientHtml = substituteVars(html, vars);
              const recipientText = substituteVars(text, vars);

              const listUnsubscribe = listUnsubscribeRaw
                ? stripUnsubscribePlaceholder(
                    substituteVars(listUnsubscribeRaw, vars),
                  )
                : '';

              const rawMessage = buildRawMime({
                from,
                to: recipient,
                subject,
                html: recipientHtml,
                text: recipientText,
                replyTo,
                sender,
                messageId: batchMessageId,
                listUnsubscribe: listUnsubscribe || undefined,
                listUnsubscribePost: listUnsubscribePost || undefined,
                customHeaders,
              });

              const result = await deps.ses.sendRawEmail(
                rawMessage,
                deps.config.sesConfigurationSet,
                { reqId, batchId, recipient },
              );
              if (!result.messageId) {
                throw new Error('SES returned no MessageId');
              }

              deps.db.insertRecipientEmail(
                result.messageId,
                batchMessageId,
                recipient,
                ghostEmailId,
                tagsJson,
              );

              succeeded += 1;
              sendRecipientsTotal.inc({
                outcome: 'sent' satisfies RecipientOutcome,
              });
              log.debug(
                {
                  reqId,
                  batchId,
                  ghostEmailId,
                  recipient,
                  sesMessageId: result.messageId,
                },
                'sent to recipient',
              );
            } catch (err) {
              failed += 1;
              errors.push({ recipient, error: (err as Error).message });
              sendRecipientsTotal.inc({
                outcome: 'failed' satisfies RecipientOutcome,
              });
              log.error(
                { reqId, batchId, ghostEmailId, recipient, err },
                'failed to send to recipient',
              );
            }
          }),
        ),
      );

      const outcomeFields = {
        reqId,
        batchId,
        ghostEmailId,
        recipientCount: toList.length,
        succeeded,
        failed,
      };

      if (succeeded === 0 && failed > 0) {
        sendBatchesTotal.inc({ outcome: 'failure' satisfies SendOutcome });
        log.error(outcomeFields, 'all recipients failed');
        res
          .status(500)
          .json({ message: 'Failed to send to all recipients', errors });
        return;
      }

      if (failed > 0) {
        sendBatchesTotal.inc({ outcome: 'partial' satisfies SendOutcome });
        log.warn(outcomeFields, 'partial send failure');
      } else {
        sendBatchesTotal.inc({ outcome: 'success' satisfies SendOutcome });
        log.info(outcomeFields, 'sent batch');
      }

      res.json({ id: batchMessageId, message: 'Queued. Thank you.' });
    } catch (err) {
      // Reached only by a malformed multipart body or a failing database
      // statement. Deliberately not a `send_batches_total` outcome (P11) — it is
      // a malformed client request, covered by http_requests_total{status_code="500"}.
      log.error({ reqId, err }, 'send failed');
      res
        .status(500)
        .json({ message: 'Internal server error: ' + (err as Error).message });
    }
  };
}
