import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapSesEvent } from '../src/event-mapper';
import type { SesEvent } from '../src/types';
import {
  sesEvent,
  sesFixtureNames,
  withoutEventBlock,
} from './helpers/fixtures';

const BATCH_MESSAGE_ID = '44444444-4444-4444-8444-444444444444@example.com';
const GHOST_EMAIL_ID = '650000000000000000000009';

const only = (event: SesEvent | null | undefined) => {
  const mapped = mapSesEvent(event);
  expect(mapped).toHaveLength(1);
  return mapped[0]!;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('mapSesEvent — fixture coverage', () => {
  it('has a fixture for every SES type the mapper handles', () => {
    expect(sesFixtureNames).toEqual(
      expect.arrayContaining([
        'delivery',
        'delivery-multi-recipient',
        'bounce-permanent',
        'bounce-transient',
        'complaint',
        'open',
        'click',
        'reject',
        'send',
        'delivery-delay',
        'unknown-type',
      ]),
    );
  });
});

describe('mapSesEvent — event type mapping', () => {
  it('maps Delivery to delivered/250 OK with no severity', () => {
    expect(only(sesEvent('delivery'))).toMatchObject({
      event_type: 'delivered',
      severity: null,
      delivery_status_code: 250,
      delivery_status_message: 'OK',
      delivery_status_enhanced: '',
    });
  });

  it('maps Open to opened', () => {
    expect(only(sesEvent('open'))).toMatchObject({
      event_type: 'opened',
      severity: null,
      delivery_status_code: null,
      delivery_status_message: null,
    });
  });

  it('maps Click to clicked', () => {
    expect(only(sesEvent('click'))).toMatchObject({
      event_type: 'clicked',
      severity: null,
      delivery_status_code: null,
      delivery_status_message: null,
    });
  });

  it('maps Complaint to complained', () => {
    expect(only(sesEvent('complaint'))).toMatchObject({
      event_type: 'complained',
      severity: null,
      delivery_status_code: null,
      delivery_status_message: null,
    });
  });

  it('maps Reject to failed/permanent/607', () => {
    expect(only(sesEvent('reject'))).toMatchObject({
      event_type: 'failed',
      severity: 'permanent',
      delivery_status_code: 607,
      delivery_status_message: 'Not delivering to previously bounced address',
    });
  });

  it('maps a Permanent Bounce to failed/permanent/607', () => {
    expect(only(sesEvent('bounce-permanent'))).toMatchObject({
      event_type: 'failed',
      severity: 'permanent',
      delivery_status_code: 607,
      delivery_status_message: 'Not delivering to previously bounced address',
    });
  });

  it('maps a Transient Bounce to failed/temporary/450', () => {
    expect(only(sesEvent('bounce-transient'))).toMatchObject({
      event_type: 'failed',
      severity: 'temporary',
      delivery_status_code: 450,
      delivery_status_message: 'Temporary bounce',
    });
  });

  it('treats a bounce with no bounceType as transient', () => {
    const event = sesEvent('bounce-permanent');
    delete event.bounce?.bounceType;
    expect(only(event)).toMatchObject({
      severity: 'temporary',
      delivery_status_code: 450,
      is_suppression: false,
    });
  });
});

describe('mapSesEvent — skipped and unmappable events', () => {
  it.each(['send', 'delivery-delay'] as const)(
    'returns [] for the skipped type %s',
    (name) => {
      expect(mapSesEvent(sesEvent(name))).toEqual([]);
    },
  );

  it('returns [] for an unknown event type', () => {
    expect(mapSesEvent(sesEvent('unknown-type'))).toEqual([]);
  });

  it('returns [] when eventType is missing', () => {
    const event = sesEvent('delivery');
    delete event.eventType;
    expect(mapSesEvent(event)).toEqual([]);
  });

  it('returns [] for null and undefined input', () => {
    expect(mapSesEvent(null)).toEqual([]);
    expect(mapSesEvent(undefined)).toEqual([]);
  });

  it('returns [] for a recognized type with no recipients', () => {
    expect(
      mapSesEvent({
        eventType: 'Delivery',
        mail: { messageId: 'm-1', timestamp: '2026-07-20T12:00:00.000Z' },
        delivery: { timestamp: '2026-07-20T12:00:05.000Z', recipients: [] },
      }),
    ).toEqual([]);
  });
});

describe('mapSesEvent — recipient extraction', () => {
  it('takes Delivery recipients from the delivery block, not mail.destination', () => {
    const event = sesEvent('delivery');
    event.mail!.destination = ['wrong@example.com'];
    expect(only(event).recipient).toBe('alice@example.com');
  });

  it('takes Bounce recipients from bouncedRecipients', () => {
    expect(only(sesEvent('bounce-permanent')).recipient).toBe(
      'carol@example.com',
    );
  });

  it('takes Complaint recipients from complainedRecipients', () => {
    expect(only(sesEvent('complaint')).recipient).toBe('grace@example.com');
  });

  it.each([
    ['open', 'bob@example.com'],
    ['click', 'frank@example.com'],
    ['reject', 'heidi@example.com'],
  ] as const)('takes %s recipients from mail.destination', (name, expected) => {
    expect(only(sesEvent(name)).recipient).toBe(expected);
  });

  it('fans out one entry per recipient', () => {
    const mapped = mapSesEvent(sesEvent('delivery-multi-recipient'));
    expect(mapped.map((e) => e.recipient)).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
    expect(mapped.map((e) => e.timestamp)).toEqual([1784548806, 1784548806]);
    expect(new Set(mapped.map((e) => e.ses_message_id)).size).toBe(1);
  });

  it('drops a bounced recipient carrying no emailAddress', () => {
    const event = sesEvent('bounce-permanent');
    event.bounce!.bouncedRecipients = [
      { diagnosticCode: 'smtp; 550 5.1.1 user unknown' },
      { emailAddress: 'carol@example.com' },
    ];
    expect(mapSesEvent(event).map((e) => e.recipient)).toEqual([
      'carol@example.com',
    ]);
  });

  it('returns [] when mail.destination is absent for a destination-based type', () => {
    const event = sesEvent('open');
    delete event.mail?.destination;
    expect(mapSesEvent(event)).toEqual([]);
  });
});

describe('mapSesEvent — timestamps', () => {
  it.each([
    ['delivery', 1784548805],
    ['bounce-permanent', 1784548807],
    ['bounce-transient', 1784548808],
    ['complaint', 1784548809],
    ['open', 1784548811],
    ['click', 1784548812],
  ] as const)('takes the %s timestamp from its event block', (name, expected) => {
    expect(only(sesEvent(name)).timestamp).toBe(expected);
  });

  it('falls back to mail.timestamp when the event block has none', () => {
    // Reject carries no timestamp of its own.
    expect(only(sesEvent('reject')).timestamp).toBe(1784548800);
  });

  it('falls back to mail.timestamp when the event block is present but timestamp-less', () => {
    const event = sesEvent('delivery');
    delete event.delivery?.timestamp;
    expect(only(event).timestamp).toBe(1784548800);
  });

  it('falls back to complaint.arrivalDate when complaint.timestamp is absent', () => {
    const event = sesEvent('complaint');
    delete event.complaint?.timestamp;
    expect(only(event).timestamp).toBe(1784548810);
  });

  it('falls back to Date.now() when no timestamp is available anywhere', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    const event = sesEvent('open');
    delete event.open;
    delete event.mail?.timestamp;
    expect(only(event).timestamp).toBe(Date.now() / 1000);
  });

  it('preserves sub-second resolution', () => {
    const event = sesEvent('delivery');
    event.delivery!.timestamp = '2026-07-20T12:00:05.250Z';
    expect(only(event).timestamp).toBe(1784548805.25);
  });
});

describe('mapSesEvent — correlation fields', () => {
  it('carries the SES message id', () => {
    expect(only(sesEvent('delivery')).ses_message_id).toBe(
      '010001912a3b4c5d-0000000000000001-000000',
    );
  });

  it('is null when mail.messageId is absent', () => {
    const event = sesEvent('delivery');
    delete event.mail?.messageId;
    expect(only(event).ses_message_id).toBeNull();
  });

  it('extracts the batch message id from Message-ID with angle brackets stripped', () => {
    expect(only(sesEvent('delivery')).batch_message_id).toBe(BATCH_MESSAGE_ID);
  });

  it('extracts X-Ghost-Email-Id verbatim', () => {
    expect(only(sesEvent('delivery')).ghost_email_id).toBe(GHOST_EMAIL_ID);
  });

  it('leaves a Message-ID without angle brackets unchanged', () => {
    const event = sesEvent('delivery');
    event.mail!.headers = [{ name: 'Message-ID', value: BATCH_MESSAGE_ID }];
    expect(only(event).batch_message_id).toBe(BATCH_MESSAGE_ID);
  });

  it('yields null correlation headers when mail carries none', () => {
    const event = sesEvent('delivery');
    delete event.mail?.headers;
    expect(only(event)).toMatchObject({
      batch_message_id: null,
      ghost_email_id: null,
    });
  });

  it('yields null correlation headers when headers is not an array', () => {
    const event = sesEvent('delivery');
    event.mail!.headers = 'not-an-array' as unknown as [];
    expect(only(event)).toMatchObject({
      batch_message_id: null,
      ghost_email_id: null,
    });
  });

  it('yields null for a matching header with no value', () => {
    const event = sesEvent('delivery');
    event.mail!.headers = [{ name: 'X-Ghost-Email-Id' }];
    expect(only(event).ghost_email_id).toBeNull();
  });
});

describe('mapSesEvent — suppression flags', () => {
  it('flags a permanent bounce as a bounces suppression', () => {
    expect(only(sesEvent('bounce-permanent'))).toMatchObject({
      is_suppression: true,
      suppression_type: 'bounces',
      suppression_reason: 'Permanent bounce',
    });
  });

  it('does not flag a transient bounce', () => {
    expect(only(sesEvent('bounce-transient'))).toMatchObject({
      is_suppression: false,
      suppression_type: null,
      suppression_reason: null,
    });
  });

  it('flags a complaint as a complaints suppression', () => {
    expect(only(sesEvent('complaint'))).toMatchObject({
      is_suppression: true,
      suppression_type: 'complaints',
      suppression_reason: 'Spam complaint',
    });
  });

  it('flags a reject as a bounces suppression', () => {
    expect(only(sesEvent('reject'))).toMatchObject({
      is_suppression: true,
      suppression_type: 'bounces',
      suppression_reason: 'Rejected by SES',
    });
  });

  it.each(['delivery', 'open', 'click'] as const)(
    'does not flag %s',
    (name) => {
      expect(only(sesEvent(name)).is_suppression).toBe(false);
    },
  );
});

describe('mapSesEvent — enhanced status code', () => {
  it('takes the diagnostic code from the first bounced recipient', () => {
    expect(only(sesEvent('bounce-permanent')).delivery_status_enhanced).toBe(
      'smtp; 550 5.1.1 user unknown',
    );
  });

  it('is empty when the bounced recipient has no diagnostic code', () => {
    const event = sesEvent('bounce-permanent');
    delete event.bounce?.bouncedRecipients?.[0]?.diagnosticCode;
    expect(only(event).delivery_status_enhanced).toBe('');
  });

  it('produces no rows at all when bouncedRecipients is empty, rather than reading index 0', () => {
    const event = sesEvent('bounce-permanent');
    event.bounce!.bouncedRecipients = [];
    event.mail!.destination = ['carol@example.com'];
    expect(mapSesEvent(event)).toEqual([]);
  });

  it('is empty for every non-bounce type', () => {
    expect(only(sesEvent('delivery')).delivery_status_enhanced).toBe('');
    expect(only(sesEvent('complaint')).delivery_status_enhanced).toBe('');
  });
});

describe('mapSesEvent — D7 malformed payloads (design §5.5)', () => {
  it('returns [] for a Delivery with no delivery block', () => {
    const event = withoutEventBlock('delivery', 'delivery');
    expect(() => mapSesEvent(event)).not.toThrow();
    expect(mapSesEvent(event)).toEqual([]);
  });

  it('returns [] for a Bounce with no bounce block', () => {
    const event = withoutEventBlock('bounce-permanent', 'bounce');
    expect(() => mapSesEvent(event)).not.toThrow();
    expect(mapSesEvent(event)).toEqual([]);
  });

  it('returns [] for a Complaint with no complaint block', () => {
    const event = withoutEventBlock('complaint', 'complaint');
    expect(() => mapSesEvent(event)).not.toThrow();
    expect(mapSesEvent(event)).toEqual([]);
  });

  it('returns [] for a Delivery whose delivery block has no recipients', () => {
    const event = sesEvent('delivery');
    delete event.delivery?.recipients;
    expect(mapSesEvent(event)).toEqual([]);
  });

  it('returns [] for a Bounce whose bounce block has no bouncedRecipients', () => {
    const event = sesEvent('bounce-permanent');
    delete event.bounce?.bouncedRecipients;
    expect(mapSesEvent(event)).toEqual([]);
  });

  it('returns [] for a Complaint whose complaint block has no complainedRecipients', () => {
    const event = sesEvent('complaint');
    delete event.complaint?.complainedRecipients;
    expect(mapSesEvent(event)).toEqual([]);
  });

  it('returns [] for an empty object', () => {
    expect(mapSesEvent({})).toEqual([]);
  });
});
