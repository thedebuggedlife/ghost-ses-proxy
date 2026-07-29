import type { Database } from 'better-sqlite3';

/** Ported verbatim from `lib/db.js` — the new build must open the existing `/data` volume unchanged. */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS message_map (
     batch_message_id TEXT PRIMARY KEY,
     ghost_email_id TEXT,
     tags TEXT,
     created_at TEXT DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS recipient_emails (
     ses_message_id TEXT PRIMARY KEY,
     batch_message_id TEXT NOT NULL,
     recipient TEXT NOT NULL,
     ghost_email_id TEXT,
     tags TEXT,
     created_at TEXT DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     event_type TEXT NOT NULL,
     severity TEXT,
     recipient TEXT NOT NULL,
     timestamp INTEGER NOT NULL,
     message_id TEXT,
     email_id TEXT,
     delivery_status_code INTEGER,
     delivery_status_message TEXT,
     delivery_status_enhanced TEXT,
     tags TEXT,
     created_at TEXT DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS suppressions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     email TEXT NOT NULL,
     type TEXT NOT NULL,
     reason TEXT,
     created_at TEXT DEFAULT (datetime('now')),
     UNIQUE(email, type)
   )`,
] as const;

/** Creation order is load-bearing: `PRAGMA index_list` reports newest first. */
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_recipient_emails_batch ON recipient_emails (batch_message_id)',
  'CREATE INDEX IF NOT EXISTS idx_recipient_emails_recipient ON recipient_emails (recipient)',
  'CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type)',
  'CREATE INDEX IF NOT EXISTS idx_events_message ON events (message_id)',
] as const;

export const TABLE_NAMES = [
  'message_map',
  'recipient_emails',
  'events',
  'suppressions',
] as const;

export const INDEX_NAMES = [
  'idx_recipient_emails_batch',
  'idx_recipient_emails_recipient',
  'idx_events_timestamp',
  'idx_events_type',
  'idx_events_message',
] as const;

export function applySchema(raw: Database): void {
  for (const statement of TABLES) raw.exec(statement);
  for (const statement of INDEXES) raw.exec(statement);
}
