import Database from 'better-sqlite3';
import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';
import type { Logger } from 'pino';
import { applySchema } from './schema';
import type {
  Db,
  DbOperation,
  EventRow,
  Metrics,
  RecipientEmailRow,
} from './types';

export function createDb(path: string, logger: Logger, metrics: Metrics): Db {
  const log = logger.child({ component: 'db' });
  const raw: SqliteDatabase = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');
  applySchema(raw);

  const statements: Record<DbOperation, Statement<unknown[]>> = {
    insertMessageMap: raw.prepare(
      'INSERT OR IGNORE INTO message_map (batch_message_id, ghost_email_id, tags) VALUES (?, ?, ?)',
    ),
    insertRecipientEmail: raw.prepare(
      'INSERT OR IGNORE INTO recipient_emails (ses_message_id, batch_message_id, recipient, ghost_email_id, tags) VALUES (?, ?, ?, ?, ?)',
    ),
    insertEvent: raw.prepare(
      'INSERT OR IGNORE INTO events (id, event_type, severity, recipient, timestamp,' +
        ' message_id, email_id, delivery_status_code, delivery_status_message,' +
        ' delivery_status_enhanced, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    insertSuppression: raw.prepare(
      'INSERT OR IGNORE INTO suppressions (email, type, reason) VALUES (?, ?, ?)',
    ),
    deleteSuppression: raw.prepare(
      'DELETE FROM suppressions WHERE email = ? AND type = ?',
    ),
    lookupRecipientEmail: raw.prepare(
      'SELECT * FROM recipient_emails WHERE ses_message_id = ?',
    ),
  };

  function guard<T>(operation: DbOperation, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      metrics.dbErrorsTotal.inc({ operation });
      log.error({ err, operation }, 'database statement failed');
      throw err;
    }
  }

  const run = (operation: DbOperation, ...params: unknown[]): number =>
    guard(operation, () => statements[operation].run(...params).changes);

  return {
    raw,

    insertMessageMap(batchMessageId, ghostEmailId, tags) {
      run('insertMessageMap', batchMessageId, ghostEmailId, tags);
    },

    insertRecipientEmail(sesMessageId, batchMessageId, recipient, ghostEmailId, tags) {
      run(
        'insertRecipientEmail',
        sesMessageId,
        batchMessageId,
        recipient,
        ghostEmailId,
        tags,
      );
    },

    insertEvent(row: EventRow) {
      run(
        'insertEvent',
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
        row.tags,
      );
    },

    insertSuppression(email, type, reason) {
      run('insertSuppression', email, type, reason);
    },

    deleteSuppression(email, type) {
      return run('deleteSuppression', email, type);
    },

    lookupRecipientEmail(sesMessageId) {
      return guard('lookupRecipientEmail', () =>
        statements.lookupRecipientEmail.get(sesMessageId),
      ) as RecipientEmailRow | undefined;
    },

    close() {
      raw.close();
    },
  };
}
