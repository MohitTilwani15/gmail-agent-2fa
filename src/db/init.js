import Database from 'better-sqlite3';
import { config } from '../config.js';

let db;

export function initDatabase() {
  db = new Database(config.db.path);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      telegram_bot_token TEXT NOT NULL,
      telegram_chat_id INTEGER NOT NULL,
      gmail_refresh_token TEXT,
      gmail_email TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migrations for existing databases
  try {
    db.exec(`ALTER TABLE users ADD COLUMN gmail_refresh_token TEXT`);
  } catch (_err) {
    // Column already exists — ignore
  }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN gmail_email TEXT`);
  } catch (_err) {
    // Column already exists — ignore
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      to_addresses TEXT NOT NULL,
      cc_addresses TEXT,
      bcc_addresses TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      is_html INTEGER DEFAULT 0,
      attachments TEXT,
      thread_id TEXT,
      in_reply_to TEXT,
      gmail_references TEXT,
      status TEXT DEFAULT 'pending',
      telegram_message_id INTEGER,
      telegram_chat_id INTEGER,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    )
  `);

  // Migrations for threading columns on existing databases
  try {
    db.exec(`ALTER TABLE email_requests ADD COLUMN thread_id TEXT`);
  } catch (_err) {
    // Column already exists — ignore
  }
  try {
    db.exec(`ALTER TABLE email_requests ADD COLUMN in_reply_to TEXT`);
  } catch (_err) {
    // Column already exists — ignore
  }
  try {
    db.exec(`ALTER TABLE email_requests ADD COLUMN gmail_references TEXT`);
  } catch (_err) {
    // Column already exists — ignore
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_sync_pairs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account1_email TEXT,
      account1_token TEXT,
      account1_cal_id TEXT,
      account2_email TEXT,
      account2_token TEXT,
      account2_cal_id TEXT,
      is_active INTEGER DEFAULT 0,
      channel1_id TEXT,
      channel1_expiry TEXT,
      channel2_id TEXT,
      channel2_expiry TEXT,
      sync_token1 TEXT,
      sync_token2 TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS synced_events (
      id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      source_calendar INTEGER NOT NULL,
      mirror_event_id TEXT NOT NULL,
      source_start TEXT,
      source_end TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_synced_events_source ON synced_events(pair_id, source_event_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_synced_events_mirror ON synced_events(pair_id, mirror_event_id)`);

  console.log('Database initialized');
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized — call initDatabase() first');
  return db;
}
