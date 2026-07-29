import { randomBytes } from 'crypto';

export interface MimeOptions {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  sender?: string;
  messageId?: string;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  customHeaders?: Record<string, string>;
}

export function defaultBoundary(): string {
  return '----=_Part_' + randomBytes(16).toString('hex');
}

/**
 * Builds the raw `multipart/alternative` message handed to SES `SendRawEmail`.
 *
 * Header order, CRLF joins, and base64 part encoding are contract with SES and
 * are pinned byte-for-byte by the golden `mime-*.txt` fixtures.
 */
export function buildRawMime(
  opts: MimeOptions,
  genBoundary: () => string = defaultBoundary,
): string {
  const boundary = genBoundary();
  const lines: string[] = [];

  lines.push('From: ' + opts.from);
  lines.push('To: ' + opts.to);
  lines.push('Subject: ' + opts.subject);

  if (opts.replyTo) {
    lines.push('Reply-To: ' + opts.replyTo);
  }
  if (opts.sender) {
    lines.push('Sender: ' + opts.sender);
  }
  if (opts.messageId) {
    lines.push('Message-ID: ' + opts.messageId);
  }
  if (opts.listUnsubscribe) {
    lines.push('List-Unsubscribe: ' + opts.listUnsubscribe);
  }
  if (opts.listUnsubscribePost) {
    lines.push('List-Unsubscribe-Post: ' + opts.listUnsubscribePost);
  }

  if (opts.customHeaders) {
    for (const [name, value] of Object.entries(opts.customHeaders)) {
      lines.push(name + ': ' + value);
    }
  }

  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
  lines.push('');

  if (opts.text) {
    lines.push('--' + boundary);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(opts.text).toString('base64'));
    lines.push('');
  }

  if (opts.html) {
    lines.push('--' + boundary);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(opts.html).toString('base64'));
    lines.push('');
  }

  lines.push('--' + boundary + '--');
  lines.push('');

  return lines.join('\r\n');
}
