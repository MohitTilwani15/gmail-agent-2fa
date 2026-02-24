import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../../data.db');

let db;

export function initDatabase() {
  db = new Database(DB_PATH);
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

  console.log('Database initialized');
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized — call initDatabase() first');
  return db;
}
