import type {
  NormalizedEvent,
  SesEvent,
  SesHeader,
  SuppressionType,
} from './types';

interface EventMapping {
  event: string;
  severity: string | null;
  code: number | null;
  message: string | null;
}

const EVENT_MAP: Record<string, EventMapping> = {
  Delivery: { event: 'delivered', severity: null, code: 250, message: 'OK' },
  Open: { event: 'opened', severity: null, code: null, message: null },
  Click: { event: 'clicked', severity: null, code: null, message: null },
  Complaint: { event: 'complained', severity: null, code: null, message: null },
  Reject: {
    event: 'failed',
    severity: 'permanent',
    code: 607,
    message: 'Not delivering to previously bounced address',
  },
};

const PERMANENT_BOUNCE: EventMapping = {
  event: 'failed',
  severity: 'permanent',
  code: 607,
  message: 'Not delivering to previously bounced address',
};

const TRANSIENT_BOUNCE: EventMapping = {
  event: 'failed',
  severity: 'temporary',
  code: 450,
  message: 'Temporary bounce',
};

/** Types with no Mailgun equivalent — intentionally skipped. */
const SKIP_TYPES: ReadonlySet<string> = new Set(['Send', 'DeliveryDelay']);

function emailAddresses(
  recipients: readonly { emailAddress?: string }[] | undefined,
): string[] {
  return (recipients ?? [])
    .map((recipient) => recipient.emailAddress)
    .filter((address): address is string => address !== undefined);
}

/** D7 (design §5.5): every optional event block is guarded, so a missing one yields no recipients. */
function getRecipients(sesEvent: SesEvent): string[] {
  const eventType = sesEvent.eventType;

  if (eventType === 'Delivery') {
    return sesEvent.delivery?.recipients ?? [];
  }
  if (eventType === 'Bounce') {
    return emailAddresses(sesEvent.bounce?.bouncedRecipients);
  }
  if (eventType === 'Complaint') {
    return emailAddresses(sesEvent.complaint?.complainedRecipients);
  }
  // Open, Click, Reject — use mail.destination
  return sesEvent.mail?.destination ?? [];
}

function getTimestamp(sesEvent: SesEvent): number {
  const eventType = sesEvent.eventType;
  let iso: string | undefined;

  if (eventType === 'Delivery' && sesEvent.delivery) {
    iso = sesEvent.delivery.timestamp;
  } else if (eventType === 'Bounce' && sesEvent.bounce) {
    iso = sesEvent.bounce.timestamp;
  } else if (eventType === 'Complaint' && sesEvent.complaint) {
    iso = sesEvent.complaint.timestamp || sesEvent.complaint.arrivalDate;
  } else if (eventType === 'Open' && sesEvent.open) {
    iso = sesEvent.open.timestamp;
  } else if (eventType === 'Click' && sesEvent.click) {
    iso = sesEvent.click.timestamp;
  }

  if (!iso && sesEvent.mail) {
    iso = sesEvent.mail.timestamp;
  }

  return iso ? new Date(iso).getTime() / 1000 : Date.now() / 1000;
}

function extractHeader(
  headers: readonly SesHeader[] | undefined,
  name: string,
): string | null {
  if (!headers || !Array.isArray(headers)) return null;
  for (const header of headers) {
    if (header.name === name) return header.value ?? null;
  }
  return null;
}

function stripAngleBrackets(str: string | null): string | null {
  if (!str) return str;
  return str.replace(/^</, '').replace(/>$/, '');
}

interface Suppression {
  is_suppression: boolean;
  suppression_type: SuppressionType | null;
  suppression_reason: string | null;
}

const NOT_SUPPRESSED: Suppression = {
  is_suppression: false,
  suppression_type: null,
  suppression_reason: null,
};

function getSuppression(sesEvent: SesEvent): Suppression {
  const eventType = sesEvent.eventType;

  if (eventType === 'Bounce' && sesEvent.bounce?.bounceType === 'Permanent') {
    return {
      is_suppression: true,
      suppression_type: 'bounces',
      suppression_reason: 'Permanent bounce',
    };
  }
  if (eventType === 'Complaint') {
    return {
      is_suppression: true,
      suppression_type: 'complaints',
      suppression_reason: 'Spam complaint',
    };
  }
  if (eventType === 'Reject') {
    return {
      is_suppression: true,
      suppression_type: 'bounces',
      suppression_reason: 'Rejected by SES',
    };
  }
  return NOT_SUPPRESSED;
}

export function mapSesEvent(
  sesEvent: SesEvent | null | undefined,
): NormalizedEvent[] {
  if (!sesEvent || !sesEvent.eventType) return [];

  const eventType = sesEvent.eventType;

  if (SKIP_TYPES.has(eventType)) return [];

  // Bounce severity depends on the bounce type, so it is not a static table entry.
  const mapping: EventMapping | undefined =
    eventType === 'Bounce'
      ? sesEvent.bounce?.bounceType === 'Permanent'
        ? PERMANENT_BOUNCE
        : TRANSIENT_BOUNCE
      : EVENT_MAP[eventType];

  if (!mapping) return [];

  const recipients = getRecipients(sesEvent);
  const timestamp = getTimestamp(sesEvent);
  const sesMessageId = sesEvent.mail?.messageId ?? null;

  // Headers are the correlation fallback when the DB has no matching row.
  const headers = sesEvent.mail?.headers ?? [];
  const batchMessageId = stripAngleBrackets(
    extractHeader(headers, 'Message-ID'),
  );
  const ghostEmailId = extractHeader(headers, 'X-Ghost-Email-Id');

  const suppression = getSuppression(sesEvent);

  let enhancedCode = '';
  if (eventType === 'Bounce') {
    const first = sesEvent.bounce?.bouncedRecipients?.[0];
    if (first) enhancedCode = first.diagnosticCode || '';
  }

  return recipients.map((recipient) => ({
    event_type: mapping.event,
    severity: mapping.severity,
    recipient,
    timestamp,
    ses_message_id: sesMessageId,
    ghost_email_id: ghostEmailId,
    batch_message_id: batchMessageId,
    delivery_status_code: mapping.code,
    delivery_status_message: mapping.message,
    delivery_status_enhanced: enhancedCode,
    ...suppression,
  }));
}
