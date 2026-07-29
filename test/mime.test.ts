import { describe, expect, it } from 'vitest';
import { buildRawMime, defaultBoundary, type MimeOptions } from '../src/mime';

const BOUNDARY = '----=_Part_0123456789abcdef0123456789abcdef';
const pinned = (): string => BOUNDARY;

const base: MimeOptions = {
  from: 'Example Newsletter <newsletter@example.com>',
  to: 'alice@example.com',
  subject: 'Weekly digest',
  text: 'Hello Alice!',
  html: '<html><body><p>Hello Alice!</p></body></html>',
};

function headerLines(raw: string): string[] {
  const lines = raw.split('\r\n');
  return lines.slice(0, lines.indexOf(''));
}

describe('buildRawMime', () => {
  it('emits the required headers in order', () => {
    expect(headerLines(buildRawMime(base, pinned))).toEqual([
      'From: Example Newsletter <newsletter@example.com>',
      'To: alice@example.com',
      'Subject: Weekly digest',
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${BOUNDARY}"`,
    ]);
  });

  it('emits every optional header in the pinned order', () => {
    const raw = buildRawMime(
      {
        ...base,
        replyTo: 'reply@example.com',
        sender: 'sender@example.com',
        messageId: '<batch@example.com>',
        listUnsubscribe: '<https://example.com/unsub>',
        listUnsubscribePost: 'List-Unsubscribe=One-Click',
        customHeaders: { 'X-Foo': 'foo', 'X-Ghost-Email-Id': 'abc123' },
      },
      pinned,
    );

    expect(headerLines(raw)).toEqual([
      'From: Example Newsletter <newsletter@example.com>',
      'To: alice@example.com',
      'Subject: Weekly digest',
      'Reply-To: reply@example.com',
      'Sender: sender@example.com',
      'Message-ID: <batch@example.com>',
      'List-Unsubscribe: <https://example.com/unsub>',
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
      'X-Foo: foo',
      'X-Ghost-Email-Id: abc123',
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${BOUNDARY}"`,
    ]);
  });

  it('omits optional headers that are empty strings', () => {
    const raw = buildRawMime(
      {
        ...base,
        replyTo: '',
        sender: '',
        messageId: '',
        listUnsubscribe: '',
        listUnsubscribePost: '',
      },
      pinned,
    );

    expect(raw).not.toContain('Reply-To:');
    expect(raw).not.toContain('Sender:');
    expect(raw).not.toContain('Message-ID:');
    expect(raw).not.toContain('List-Unsubscribe:');
    expect(raw).not.toContain('List-Unsubscribe-Post:');
  });

  it('preserves custom header insertion order', () => {
    const raw = buildRawMime(
      { ...base, customHeaders: { 'X-B': '2', 'X-A': '1', 'X-C': '3' } },
      pinned,
    );
    const headers = headerLines(raw);
    expect(headers.slice(3, 6)).toEqual(['X-B: 2', 'X-A: 1', 'X-C: 3']);
  });

  it('emits no custom headers when the map is empty', () => {
    const raw = buildRawMime({ ...base, customHeaders: {} }, pinned);
    expect(headerLines(raw)).toHaveLength(5);
  });

  it('base64-encodes the text part then the html part', () => {
    const raw = buildRawMime(base, pinned);
    const textIndex = raw.indexOf('Content-Type: text/plain; charset=UTF-8');
    const htmlIndex = raw.indexOf('Content-Type: text/html; charset=UTF-8');

    expect(textIndex).toBeGreaterThan(-1);
    expect(htmlIndex).toBeGreaterThan(textIndex);
    expect(raw).toContain(Buffer.from(base.text ?? '').toString('base64'));
    expect(raw).toContain(Buffer.from(base.html ?? '').toString('base64'));
    expect(raw.match(/Content-Transfer-Encoding: base64/g)).toHaveLength(2);
  });

  it('omits the text part when text is absent', () => {
    const raw = buildRawMime({ ...base, text: undefined }, pinned);
    expect(raw).not.toContain('text/plain');
    expect(raw).toContain('text/html');
    expect(raw.match(new RegExp(`--${BOUNDARY}`, 'g'))).toHaveLength(2);
  });

  it('omits the html part when html is absent', () => {
    const raw = buildRawMime({ ...base, html: undefined }, pinned);
    expect(raw).toContain('text/plain');
    expect(raw).not.toContain('text/html');
  });

  it('omits both parts when neither text nor html is present', () => {
    const raw = buildRawMime({ ...base, text: '', html: '' }, pinned);
    expect(raw).not.toContain('Content-Transfer-Encoding');
    expect(raw.endsWith(`--${BOUNDARY}--\r\n`)).toBe(true);
  });

  it('uses the boundary in the Content-Type, both part delimiters, and the terminator', () => {
    const raw = buildRawMime(base, pinned);
    expect(raw).toContain(`boundary="${BOUNDARY}"`);
    expect(raw).toContain(`--${BOUNDARY}\r\nContent-Type: text/plain`);
    expect(raw).toContain(`--${BOUNDARY}\r\nContent-Type: text/html`);
    expect(raw).toContain(`--${BOUNDARY}--\r\n`);
  });

  it('joins with CRLF and ends with a trailing empty line', () => {
    const raw = buildRawMime(base, pinned);
    expect(raw).not.toMatch(/[^\r]\n/);
    expect(raw.endsWith('\r\n')).toBe(true);
  });

  it('round-trips a UTF-8 subject verbatim and UTF-8 bodies through base64', () => {
    const subject = 'Résumé — 日本語 ✉️';
    const text = 'Grüße — こんにちは';
    const html = '<p>Grüße — こんにちは</p>';
    const raw = buildRawMime({ ...base, subject, text, html }, pinned);

    expect(raw).toContain(`Subject: ${subject}`);

    const parts = raw.split(`--${BOUNDARY}`);
    const decode = (part: string): string =>
      Buffer.from(part.split('\r\n\r\n')[1]?.trim() ?? '', 'base64').toString(
        'utf8',
      );
    expect(decode(parts[1] ?? '')).toBe(text);
    expect(decode(parts[2] ?? '')).toBe(html);
  });

  it('defaults to a random hex boundary', () => {
    const first = defaultBoundary();
    expect(first).toMatch(/^----=_Part_[0-9a-f]{32}$/);
    expect(defaultBoundary()).not.toBe(first);
  });

  it('uses defaultBoundary when no generator is supplied', () => {
    const raw = buildRawMime(base);
    expect(raw).toMatch(
      /Content-Type: multipart\/alternative; boundary="----=_Part_[0-9a-f]{32}"/,
    );
  });
});
