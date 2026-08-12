import type { RequestHandler } from 'express';
import type { Deps, EventRow } from '../types';

export const DEFAULT_LIMIT = 300;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 1000;

/**
 * D4 (design §5.4). Express parses `?event=a&event=b` into an array, so the
 * legacy `.split(' OR ')` was `undefined` and 500'd. Applied to every query
 * parameter, not just `event` and `tags` — `parseFloat`/`parseInt` on the
 * union `strict` infers are compile errors too, and an `as string` cast would
 * behave differently from this coercion on a repeated parameter.
 */
export function firstString(v: unknown): string {
  return Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '';
}

export function clampLimit(raw: string): number {
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}

function splitFilter(value: string, separator: string): string[] {
  if (!value) return [];
  return value
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface EventsParams {
  domain: string;
  pageToken?: string;
}

interface EventItem {
  id: string;
  event: string;
  timestamp: number;
  recipient: string;
  message: { headers: { 'message-id': string } };
  'user-variables': { 'email-id': string };
  severity?: string;
  'delivery-status'?: {
    code: number;
    message: string;
    description: string;
    'enhanced-code': string;
  };
}

interface Cursor {
  t?: unknown;
  id?: unknown;
}

export function createEventsRoute(
  deps: Pick<Deps, 'db'>,
): RequestHandler<EventsParams> {
  return function getEvents(req, res) {
    const { domain } = req.params;
    const pageToken = req.params.pageToken ?? null;

    const eventTypes = splitFilter(firstString(req.query['event']), ' OR ');
    const tags = splitFilter(firstString(req.query['tags']), ' AND ');
    const begin = parseFloat(firstString(req.query['begin'])) || 0;
    const end = parseFloat(firstString(req.query['end'])) || 9999999999;
    const limit = clampLimit(firstString(req.query['limit']));

    let cursorTimestamp: unknown = null;
    let cursorId: unknown = null;
    if (pageToken) {
      try {
        const decoded = JSON.parse(
          Buffer.from(pageToken, 'base64').toString('utf8'),
        ) as Cursor;
        cursorTimestamp = decoded.t;
        cursorId = decoded.id;
      } catch {
        res.status(400).json({ message: 'Invalid page token' });
        return;
      }
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (eventTypes.length > 0) {
      conditions.push(
        `event_type IN (${eventTypes.map(() => '?').join(',')})`,
      );
      params.push(...eventTypes);
    }

    conditions.push('timestamp >= ?');
    params.push(begin);
    conditions.push('timestamp <= ?');
    params.push(end);

    for (const tag of tags) {
      conditions.push('tags LIKE ?');
      params.push(`%"${tag}"%`);
    }

    if (cursorTimestamp !== null && cursorId !== null) {
      conditions.push('(timestamp > ? OR (timestamp = ? AND id > ?))');
      params.push(cursorTimestamp, cursorTimestamp, cursorId);
    }

    // `conditions` is never empty — the range bounds above are unconditional —
    // so the legacy `if (conditions.length > 0)` guard is dropped as dead.
    const sql =
      `SELECT * FROM events WHERE ${conditions.join(' AND ')}` +
      ' ORDER BY timestamp ASC, id ASC LIMIT ?';
    params.push(limit);

    const rows = deps.db.raw
      .prepare<unknown[], EventRow>(sql)
      .all(...params);

    const items = rows.map((row): EventItem => {
      const item: EventItem = {
        id: row.id,
        event: row.event_type,
        timestamp: row.timestamp,
        recipient: row.recipient,
        message: { headers: { 'message-id': row.message_id || '' } },
        'user-variables': { 'email-id': row.email_id || '' },
      };

      if (row.severity) item.severity = row.severity;

      if (row.delivery_status_code !== null) {
        item['delivery-status'] = {
          code: row.delivery_status_code,
          message: row.delivery_status_message || '',
          description: '',
          'enhanced-code': row.delivery_status_enhanced || '',
        };
      }

      return item;
    });

    const proto =
      firstString(req.headers['x-forwarded-proto']).split(',')[0]?.trim() ||
      'http';
    const base = `${proto}://${req.headers.host}`;
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);

    const listUrl = `${base}/v3/${domain}/events${query}`;

    const lastRow = rows[rows.length - 1];
    const nextToken = lastRow
      ? Buffer.from(
          JSON.stringify({ t: lastRow.timestamp, id: lastRow.id }),
        ).toString('base64url')
      : pageToken ??
        Buffer.from(JSON.stringify({ t: begin, id: '' })).toString('base64url');

    const paging = {
      next: `${base}/v3/${domain}/events/${nextToken}`,
      previous: listUrl,
      first: listUrl,
      last: listUrl,
    };

    res.json({ items, paging });
  };
}
