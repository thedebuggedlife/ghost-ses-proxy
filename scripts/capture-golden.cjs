// Golden fixture capture harness (design §8.3).
//
// Runs INSIDE a container (scripts/Dockerfile.capture) because lib/db.js
// hardcodes /data/ses-proxy.db. Never run in CI; kept in the repo after the
// rewrite as the reproducibility record for test/golden/captured/.
//
// CommonJS is load-bearing: @aws-sdk/* and aws-sdk-client-mock are dual-package,
// and an ESM harness would stub a different class object than the one lib/*.js
// instantiates, so the mock would silently not intercept.

'use strict';

const fs = require('fs');
const path = require('path');

// --- Environment must be set before requiring anything: lib/config.js calls
// --- process.exit(1) at import when a required var is missing.
Object.assign(process.env, {
  AWS_ACCESS_KEY_ID: 'AKIAFAKE',
  AWS_SECRET_ACCESS_KEY: 'fake',
  AWS_REGION: 'us-east-1',
  SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/fake',
  PROXY_API_KEY: 'test-key',
  MAILGUN_DOMAIN: 'example.com',
  SES_CONFIGURATION_SET: 'ghost-ses-proxy',
  PORT: '3003',
  SEND_CONCURRENCY: '10',
});

const { mockClient } = require('aws-sdk-client-mock');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const { SQSClient, ReceiveMessageCommand } = require('@aws-sdk/client-sqs');

const SES_MESSAGE_ID = '0100000000000000-11111111-2222-3333-4444-555555555555-000000';

const capturedMime = [];
let sesBehaviour = 'ok';

mockClient(SESClient).on(SendRawEmailCommand).callsFake((input) => {
  capturedMime.push(input.RawMessage.Data.toString('utf8'));
  if (sesBehaviour === 'fail') return Promise.reject(new Error('SES unavailable'));
  return Promise.resolve({ MessageId: SES_MESSAGE_ID });
});

// MUST resolve on a macrotask: lib/sqs-poller.js's loop() recurses from a
// .then(), so a synchronously-resolving mock starves the event loop and the
// HTTP server never answers this harness's own requests.
mockClient(SQSClient).on(ReceiveMessageCommand)
  .callsFake(() => new Promise((resolve) => setTimeout(() => resolve({}), 20000)));

// Mocks are installed; only now may the real entrypoint be required.
require('../server.js');

const { normalize, normalizeJson } = require('./normalize.cjs');
const dbModule = require('../lib/db.js');
const mapSesEvent = require('../lib/event-mapper.js');
const substituteVars = require('../lib/template-vars.js');

const OUT_DIR = path.join(__dirname, '..', 'test', 'golden', 'captured');

function writeRaw(name, value) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(value, null, 2) + '\n');
  console.log('captured: ' + name);
}

function writeJson(name, value) {
  writeRaw(name, normalizeJson(value));
}

function writeText(name, value) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), normalize(value));
  console.log('captured: ' + name);
}

// --- Seed data -------------------------------------------------------------
// Owned by the harness and written out as committed artifacts. Nothing under
// test/golden/captured/ is hand-authored on the host; test/ is never copied
// into the capture image.
//
// events.id values are fixed (evt-NNNN) rather than implementation-generated:
// the events API's paging.next cursor embeds an id and is NOT normalized
// (design §8.4), so it can only reproduce if the ids are seeded constants.

const EVENTS_SEED = [
  {
    id: 'evt-0001',
    event_type: 'delivered',
    severity: null,
    recipient: 'alice@example.com',
    timestamp: 1750000001,
    message_id: '11111111-1111-4111-8111-111111111111@example.com',
    email_id: '650000000000000000000001',
    delivery_status_code: 250,
    delivery_status_message: 'OK',
    delivery_status_enhanced: '',
    tags: '["bulk-email","ghost-email"]',
  },
  {
    id: 'evt-0002',
    event_type: 'opened',
    severity: null,
    recipient: 'bob@example.com',
    timestamp: 1750000002,
    message_id: '11111111-1111-4111-8111-111111111111@example.com',
    email_id: '650000000000000000000001',
    delivery_status_code: null,
    delivery_status_message: null,
    delivery_status_enhanced: null,
    tags: '["bulk-email"]',
  },
  {
    id: 'evt-0003',
    event_type: 'failed',
    severity: 'permanent',
    recipient: 'carol@example.com',
    timestamp: 1750000003,
    message_id: '22222222-2222-4222-8222-222222222222@example.com',
    email_id: '650000000000000000000002',
    delivery_status_code: 607,
    delivery_status_message: 'Not delivering to previously bounced address',
    delivery_status_enhanced: '5.1.1 user unknown',
    tags: '["bulk-email","ghost-email"]',
  },
  {
    id: 'evt-0004',
    event_type: 'failed',
    severity: 'temporary',
    recipient: 'dave@example.com',
    timestamp: 1750000004,
    message_id: '22222222-2222-4222-8222-222222222222@example.com',
    email_id: '650000000000000000000002',
    delivery_status_code: 450,
    delivery_status_message: 'Temporary bounce',
    delivery_status_enhanced: '4.4.7 timeout',
    tags: '["ghost-email"]',
  },
  {
    id: 'evt-0005',
    event_type: 'delivered',
    severity: null,
    recipient: 'erin+news@example.com',
    timestamp: 1750000005,
    message_id: '33333333-3333-4333-8333-333333333333@example.com',
    email_id: '',
    delivery_status_code: 250,
    delivery_status_message: 'OK',
    delivery_status_enhanced: '',
    tags: '["bulk-email"]',
  },
  {
    id: 'evt-0006',
    event_type: 'clicked',
    severity: null,
    recipient: 'frank@example.com',
    timestamp: 1750000006,
    message_id: '33333333-3333-4333-8333-333333333333@example.com',
    email_id: '650000000000000000000003',
    delivery_status_code: null,
    delivery_status_message: null,
    delivery_status_enhanced: null,
    tags: '[]',
  },
  {
    id: 'evt-0007',
    event_type: 'complained',
    severity: null,
    recipient: 'grace@example.com',
    timestamp: 1750000007,
    message_id: '33333333-3333-4333-8333-333333333333@example.com',
    email_id: '650000000000000000000003',
    delivery_status_code: null,
    delivery_status_message: null,
    delivery_status_enhanced: null,
    tags: '["bulk-email","ghost-email"]',
  },
];

const SUPPRESSIONS_SEED = [
  { email: 'bounced+tag@example.com', type: 'bounces', reason: 'Permanent bounce' },
  { email: 'complainer@example.com', type: 'complaints', reason: 'Spam complaint' },
];

function seed() {
  for (const row of EVENTS_SEED) {
    dbModule.insertEvent.run(
      row.id,
      row.event_type,
      row.severity,
      row.recipient,
      row.timestamp,
      row.message_id,
      row.email_id,
      row.delivery_status_code,
      row.delivery_status_message,
      row.delivery_status_enhanced,
      row.tags
    );
  }
  for (const row of SUPPRESSIONS_SEED) {
    dbModule.insertSuppression.run(row.email, row.type, row.reason);
  }
  // Seeds are INPUTS, not observed behavior: written raw so the values that
  // reproduce the paging cursor and the mapper timestamps survive verbatim.
  writeRaw('events-seed.json', EVENTS_SEED);
  writeRaw('suppressions-seed.json', SUPPRESSIONS_SEED);
}

// --- SES event inputs ------------------------------------------------------
// Committed as an artifact so test/helpers/fixtures.ts imports these payloads
// rather than restating them. Written raw for the same reason as the seeds:
// the ISO timestamps here are what mapSesEvent turns into the numeric
// timestamps recorded in event-map-*.json.

function mail(messageId, destination, extraHeaders) {
  return {
    timestamp: '2026-07-20T12:00:00.000Z',
    source: 'newsletter@example.com',
    messageId: messageId,
    destination: destination,
    headers: [
      { name: 'From', value: 'newsletter@example.com' },
      { name: 'To', value: destination.join(', ') },
      { name: 'Subject', value: 'Weekly digest' },
      { name: 'Message-ID', value: '<44444444-4444-4444-8444-444444444444@example.com>' },
      { name: 'X-Ghost-Email-Id', value: '650000000000000000000009' },
    ].concat(extraHeaders || []),
  };
}

const SES_EVENT_INPUTS = {
  delivery: {
    eventType: 'Delivery',
    mail: mail('010001912a3b4c5d-0000000000000001-000000', ['alice@example.com']),
    delivery: {
      timestamp: '2026-07-20T12:00:05.000Z',
      recipients: ['alice@example.com'],
      processingTimeMillis: 1234,
      smtpResponse: '250 2.0.0 OK',
      reportingMTA: 'a8-52.smtp-out.amazonses.com',
    },
  },
  'delivery-multi-recipient': {
    eventType: 'Delivery',
    mail: mail('010001912a3b4c5d-0000000000000002-000000', ['alice@example.com', 'bob@example.com']),
    delivery: {
      timestamp: '2026-07-20T12:00:06.000Z',
      recipients: ['alice@example.com', 'bob@example.com'],
      processingTimeMillis: 2345,
      smtpResponse: '250 2.0.0 OK',
      reportingMTA: 'a8-52.smtp-out.amazonses.com',
    },
  },
  'bounce-permanent': {
    eventType: 'Bounce',
    mail: mail('010001912a3b4c5d-0000000000000003-000000', ['carol@example.com']),
    bounce: {
      timestamp: '2026-07-20T12:00:07.000Z',
      bounceType: 'Permanent',
      bounceSubType: 'General',
      feedbackId: '010001912a3b4c5d-feedback-000001-000000',
      reportingMTA: 'dsn; a8-52.smtp-out.amazonses.com',
      bouncedRecipients: [
        {
          emailAddress: 'carol@example.com',
          action: 'failed',
          status: '5.1.1',
          diagnosticCode: 'smtp; 550 5.1.1 user unknown',
        },
      ],
    },
  },
  'bounce-transient': {
    eventType: 'Bounce',
    mail: mail('010001912a3b4c5d-0000000000000004-000000', ['dave@example.com']),
    bounce: {
      timestamp: '2026-07-20T12:00:08.000Z',
      bounceType: 'Transient',
      bounceSubType: 'MailboxFull',
      feedbackId: '010001912a3b4c5d-feedback-000002-000000',
      reportingMTA: 'dsn; a8-52.smtp-out.amazonses.com',
      bouncedRecipients: [
        {
          emailAddress: 'dave@example.com',
          action: 'delayed',
          status: '4.4.7',
          diagnosticCode: 'smtp; 452 4.2.2 mailbox full',
        },
      ],
    },
  },
  complaint: {
    eventType: 'Complaint',
    mail: mail('010001912a3b4c5d-0000000000000005-000000', ['grace@example.com']),
    complaint: {
      timestamp: '2026-07-20T12:00:09.000Z',
      arrivalDate: '2026-07-20T12:00:10.000Z',
      feedbackId: '010001912a3b4c5d-feedback-000003-000000',
      complaintFeedbackType: 'abuse',
      userAgent: 'AnyCompany Feedback Loop (V0.01)',
      complainedRecipients: [{ emailAddress: 'grace@example.com' }],
    },
  },
  open: {
    eventType: 'Open',
    mail: mail('010001912a3b4c5d-0000000000000006-000000', ['bob@example.com']),
    open: {
      timestamp: '2026-07-20T12:00:11.000Z',
      ipAddress: '203.0.113.10',
      userAgent: 'Mozilla/5.0',
    },
  },
  click: {
    eventType: 'Click',
    mail: mail('010001912a3b4c5d-0000000000000007-000000', ['frank@example.com']),
    click: {
      timestamp: '2026-07-20T12:00:12.000Z',
      ipAddress: '203.0.113.11',
      userAgent: 'Mozilla/5.0',
      link: 'https://example.com/post',
      linkTags: null,
    },
  },
  reject: {
    eventType: 'Reject',
    mail: mail('010001912a3b4c5d-0000000000000008-000000', ['heidi@example.com']),
    reject: { reason: 'Bad content' },
  },
  send: {
    eventType: 'Send',
    mail: mail('010001912a3b4c5d-0000000000000009-000000', ['alice@example.com']),
    send: {},
  },
  'delivery-delay': {
    eventType: 'DeliveryDelay',
    mail: mail('010001912a3b4c5d-000000000000000a-000000', ['ivan@example.com']),
    deliveryDelay: {
      timestamp: '2026-07-20T12:00:13.000Z',
      delayType: 'TransientCommunicationFailure',
      expirationTime: '2026-07-21T12:00:13.000Z',
      delayedRecipients: [{ emailAddress: 'ivan@example.com', status: '4.4.1' }],
    },
  },
  'unknown-type': {
    eventType: 'Subscription',
    mail: mail('010001912a3b4c5d-000000000000000b-000000', ['judy@example.com']),
    subscription: { contactList: 'example' },
  },
};

// --- substituteVars inputs -------------------------------------------------

const TEMPLATE_VAR_INPUTS = {
  basic: { str: 'Hello %recipient.name%!', vars: { name: 'Alice' } },
  'unknown-var-left-verbatim': { str: 'Hi %recipient.missing%', vars: { name: 'Alice' } },
  'empty-string': { str: '', vars: { name: 'Alice' } },
  'null-vars': { str: 'Hello %recipient.name%', vars: null },
  'empty-vars': { str: 'Hello %recipient.name%', vars: {} },
  'repeated-occurrences': { str: '%recipient.name% and %recipient.name%', vars: { name: 'Bob' } },
  'multiple-vars': { str: 'To %recipient.first% %recipient.last%', vars: { first: 'Ada', last: 'Lovelace' } },
  'no-placeholders': { str: 'plain text', vars: { name: 'Alice' } },
  'regex-special-value': { str: 'Hi %recipient.name%', vars: { name: "$& $1 $` $' $$" } },
  'empty-value': { str: 'Hi %recipient.name%!', vars: { name: '' } },
  'unsubscribe-url': {
    str: '<https://example.com/unsubscribe?uuid=%recipient.uuid%>',
    vars: { uuid: 'abc-123' },
  },
};

// --- HTTP scenarios --------------------------------------------------------
// Ghost's mailgun.js is the anchoring consumer for every artifact below.
//
// Send request field maps are committed as send-scenarios.json so the contract
// test replays the exact same requests; the MIME artifacts are the output of
// the whole pipeline (busboy -> substituteVars -> placeholder stripping ->
// h:* collection -> X-Ghost-Email-Id injection -> buildRawMime), because
// buildRawMime is not exported by lib/send-email.js.

const BASE_URL = 'http://localhost:3003';
const AUTH_HEADER = 'Basic ' + Buffer.from('api:test-key').toString('base64');

const EVENT_SCENARIOS = [
  ['events-unfiltered', '/v3/example.com/events'],
  ['events-filter-event', '/v3/example.com/events?event=' + encodeURIComponent('delivered OR failed')],
  ['events-filter-tags', '/v3/example.com/events?tags=' + encodeURIComponent('bulk-email AND ghost-email')],
  ['events-range', '/v3/example.com/events?begin=1750000002&end=1750000005'],
  ['events-limit-3', '/v3/example.com/events?limit=3'],
];

const SUPPRESSION_SCENARIOS = [
  // Fully percent-encoded local part: %2B for the plus, %40 for the at sign.
  ['suppression-bounces-encoded', '/v3/example.com/bounces/bounced%2Btag%40example.com'],
  // Literal '+' in the path — not a space, unlike a query string.
  ['suppression-plus-literal', '/v3/example.com/bounces/bounced+tag%40example.com'],
  ['suppression-complaints', '/v3/example.com/complaints/complainer%40example.com'],
  ['suppression-unknown-type', '/v3/example.com/unsubscribed/complainer%40example.com'],
];

const RECIPIENT_VARIABLES = JSON.stringify({
  'alice@example.com': { name: 'Alice', unsubscribe_url: 'https://example.com/unsubscribe/alice' },
  'bob@example.com': { name: 'Bob', unsubscribe_url: 'https://example.com/unsubscribe/bob' },
});

const SEND_SCENARIOS = {
  canonical: {
    sesBehaviour: 'ok',
    fields: {
      from: 'Example Newsletter <newsletter@example.com>',
      subject: 'Weekly digest',
      to: ['alice@example.com', 'bob@example.com'],
      html: '<html><body><p>Hello %recipient.name%!</p><p><a href="%recipient.unsubscribe_url%">Unsubscribe</a></p></body></html>',
      text: 'Hello %recipient.name%!\r\nUnsubscribe: %recipient.unsubscribe_url%',
      'recipient-variables': RECIPIENT_VARIABLES,
      'o:tag': ['bulk-email', 'ghost-email'],
      'v:email-id': '650000000000000000000001',
      'h:List-Unsubscribe': '<%recipient.unsubscribe_url%>, <%tag_unsubscribe_email%>',
      'h:List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  },
  'no-text': {
    sesBehaviour: 'ok',
    fields: {
      from: 'newsletter@example.com',
      subject: 'HTML only',
      to: ['alice@example.com'],
      html: '<html><body><p>HTML only</p></body></html>',
      'v:email-id': '650000000000000000000002',
    },
  },
  'no-html': {
    sesBehaviour: 'ok',
    fields: {
      from: 'newsletter@example.com',
      subject: 'Text only',
      to: ['alice@example.com'],
      text: 'Text only',
      'v:email-id': '650000000000000000000003',
    },
  },
  'custom-headers': {
    sesBehaviour: 'ok',
    fields: {
      from: 'newsletter@example.com',
      subject: 'Custom headers',
      to: ['alice@example.com'],
      html: '<html><body><p>Custom headers</p></body></html>',
      text: 'Custom headers',
      'h:Reply-To': 'reply@example.com',
      'h:Sender': 'sender@example.com',
      'h:X-Foo': 'foo-value',
      'h:X-Bar': 'bar-value',
      'v:email-id': '650000000000000000000004',
    },
  },
  utf8: {
    sesBehaviour: 'ok',
    fields: {
      from: 'Résumé <newsletter@example.com>',
      subject: 'Résumé — 日本語 ✉️',
      to: ['alice@example.com'],
      html: '<html><body><p>Grüße — 日本語 ✉️</p></body></html>',
      text: 'Grüße — 日本語 ✉️',
      'v:email-id': '650000000000000000000005',
    },
  },
  'missing-from': {
    sesBehaviour: 'ok',
    fields: {
      subject: 'No from field',
      to: ['alice@example.com'],
      text: 'No from field',
    },
  },
  'malformed-recipient-variables': {
    sesBehaviour: 'ok',
    fields: {
      from: 'newsletter@example.com',
      subject: 'Bad vars',
      to: ['alice@example.com'],
      text: 'Bad vars',
      'recipient-variables': '{not valid json',
    },
  },
  'all-recipients-fail': {
    sesBehaviour: 'fail',
    fields: {
      from: 'newsletter@example.com',
      subject: 'Everything fails',
      to: ['alice@example.com', 'bob@example.com'],
      text: 'Everything fails',
      'v:email-id': '650000000000000000000006',
    },
  },
};

async function waitForServer() {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const res = await fetch(BASE_URL + '/health');
      if (res.ok) {
        await res.arrayBuffer();
        return;
      }
    } catch (e) {
      // listener not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server never became ready on ' + BASE_URL);
}

async function request(method, path, init) {
  const res = await fetch(BASE_URL + path, Object.assign({ method: method }, init || {}));
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = text;
  }
  return { status: res.status, body: body };
}

async function captureHealth() {
  const res = await request('GET', '/health');
  writeJson('http-health.json', {
    _precondition: {
      note: 'Captured immediately after seeding and before any send scenario, so the counts are exactly the seed. Assert this fixture only against a database in the same state.',
      seeds: ['events-seed.json', 'suppressions-seed.json'],
      expectedCounts: {
        message_map: 0,
        recipient_emails: 0,
        events: EVENTS_SEED.length,
        suppressions: SUPPRESSIONS_SEED.length,
      },
    },
    _request: { method: 'GET', path: '/health', auth: false },
    status: res.status,
    body: res.body,
  });
}

async function captureEvents() {
  let limitedPage = null;

  for (const entry of EVENT_SCENARIOS) {
    const name = entry[0];
    const path = entry[1];
    const res = await request('GET', path, { headers: { Authorization: AUTH_HEADER } });
    if (name === 'events-limit-3') limitedPage = res;
    writeJson('http-' + name + '.json', {
      _request: { method: 'GET', path: path, auth: true },
      status: res.status,
      body: res.body,
    });
  }

  // paging.next is NOT normalized (design §8.4): it reproduces because the
  // harness always talks to localhost:3003 and the seed ids are fixed.
  const nextUrl = limitedPage && limitedPage.body && limitedPage.body.paging && limitedPage.body.paging.next;
  if (!nextUrl) throw new Error('events-limit-3 produced no paging.next cursor');
  const nextPath = nextUrl.slice(BASE_URL.length);
  const secondPage = await request('GET', nextPath, { headers: { Authorization: AUTH_HEADER } });
  writeJson('http-events-page-2.json', {
    _request: { method: 'GET', path: nextPath, auth: true, derivedFrom: 'http-events-limit-3.json paging.next' },
    status: secondPage.status,
    body: secondPage.body,
  });

  const badTokenPath = '/v3/example.com/events/invalid-page-token';
  const badToken = await request('GET', badTokenPath, { headers: { Authorization: AUTH_HEADER } });
  writeJson('http-events-invalid-token.json', {
    _request: { method: 'GET', path: badTokenPath, auth: true },
    status: badToken.status,
    body: badToken.body,
  });
}

async function captureSuppressions() {
  for (const entry of SUPPRESSION_SCENARIOS) {
    const name = entry[0];
    const path = entry[1];
    const res = await request('DELETE', path, { headers: { Authorization: AUTH_HEADER } });
    writeJson('http-' + name + '.json', {
      _request: { method: 'DELETE', path: path, auth: true },
      status: res.status,
      body: res.body,
    });
  }
}

async function captureSends() {
  writeRaw('send-scenarios.json', SEND_SCENARIOS);

  for (const name of Object.keys(SEND_SCENARIOS)) {
    const scenario = SEND_SCENARIOS[name];
    sesBehaviour = scenario.sesBehaviour;

    const form = new FormData();
    for (const key of Object.keys(scenario.fields)) {
      const value = scenario.fields[key];
      if (Array.isArray(value)) {
        for (const item of value) form.append(key, item);
      } else {
        form.append(key, value);
      }
    }

    const before = capturedMime.length;
    const res = await request('POST', '/v3/example.com/messages', {
      body: form,
      headers: { Authorization: AUTH_HEADER },
    });

    writeJson('http-send-' + name + '.json', {
      _request: {
        method: 'POST',
        path: '/v3/example.com/messages',
        auth: true,
        scenario: name,
        fieldsFrom: 'send-scenarios.json',
      },
      status: res.status,
      body: res.body,
    });

    const produced = capturedMime.slice(before);
    for (let i = 0; i < produced.length; i++) {
      writeText('mime-' + name + '-' + i + '.txt', produced[i]);
    }
  }

  sesBehaviour = 'ok';
}

// --- Capture ---------------------------------------------------------------

const TABLES = ['message_map', 'recipient_emails', 'events', 'suppressions'];

function captureSchema() {
  const schema = {};
  for (const table of TABLES) {
    schema[table] = {
      table_info: dbModule.db.prepare('PRAGMA table_info(' + table + ')').all(),
      index_list: dbModule.db.prepare('PRAGMA index_list(' + table + ')').all(),
    };
  }
  writeJson('schema.json', schema);
}

function captureEventMaps() {
  writeRaw('ses-event-inputs.json', SES_EVENT_INPUTS);
  for (const name of Object.keys(SES_EVENT_INPUTS)) {
    writeJson('event-map-' + name + '.json', mapSesEvent(SES_EVENT_INPUTS[name]));
  }
}

function captureTemplateVars() {
  const out = {};
  for (const name of Object.keys(TEMPLATE_VAR_INPUTS)) {
    const input = TEMPLATE_VAR_INPUTS[name];
    const result = substituteVars(input.str, input.vars);
    out[name] = { input: input, output: result === undefined ? null : result };
  }
  writeJson('template-vars.json', out);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  seed();
  captureSchema();
  captureEventMaps();
  captureTemplateVars();

  // Capture order is load-bearing: /health records the seed counts, so it must
  // run before any send scenario inserts message_map / recipient_emails rows.
  await waitForServer();
  await captureHealth();
  await captureEvents();
  await captureSuppressions();
  await captureSends();

  console.log('capture complete');
  // The express listener, the poller promise, and lib/db.js's cleanup interval
  // all keep the loop alive.
  process.exit(0);
}

main().catch((err) => {
  console.error('capture failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
