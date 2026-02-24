import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = resolve(__dirname, '../test-data.db');

// We manually set up the DB and module functions to avoid loading config.js (which needs env vars)
let db;

function setupDb() {
  db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      telegram_bot_token TEXT NOT NULL,
      telegram_chat_id INTEGER NOT NULL,
      gmail_refresh_token TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

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
}

function teardownDb() {
  if (db) db.close();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
}

// --- User helpers (mirrors email-requests.js logic) ---

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
}

function upsertUser(userId, botToken, chatId) {
  db.prepare(`
    INSERT INTO users (id, telegram_bot_token, telegram_chat_id)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET telegram_bot_token = excluded.telegram_bot_token, telegram_chat_id = excluded.telegram_chat_id
  `).run(userId, botToken, chatId);
  return getUser(userId);
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users').all();
}

function updateUserGmailToken(userId, refreshToken) {
  db.prepare('UPDATE users SET gmail_refresh_token = ? WHERE id = ?').run(refreshToken, userId);
  return getUser(userId);
}

function createRequest({ id, userId, to, cc, bcc, subject, body, isHtml, attachments, threadId, inReplyTo, references }) {
  db.prepare(`
    INSERT INTO email_requests (id, user_id, to_addresses, cc_addresses, bcc_addresses, subject, body, is_html, attachments, thread_id, in_reply_to, gmail_references)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId || null,
    JSON.stringify(to),
    cc ? JSON.stringify(cc) : null,
    bcc ? JSON.stringify(bcc) : null,
    subject,
    body,
    isHtml ? 1 : 0,
    attachments ? JSON.stringify(attachments) : null,
    threadId || null,
    inReplyTo || null,
    references ? JSON.stringify(references) : null,
  );
  return getRequest(id);
}

function getRequest(id) {
  const row = db.prepare('SELECT * FROM email_requests WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    to_addresses: JSON.parse(row.to_addresses),
    cc_addresses: row.cc_addresses ? JSON.parse(row.cc_addresses) : null,
    bcc_addresses: row.bcc_addresses ? JSON.parse(row.bcc_addresses) : null,
    attachments: row.attachments ? JSON.parse(row.attachments) : null,
    is_html: Boolean(row.is_html),
    gmail_references: row.gmail_references ? JSON.parse(row.gmail_references) : null,
  };
}

function updateStatus(id, status, errorMessage = null) {
  db.prepare(`
    UPDATE email_requests
    SET status = ?, error_message = ?, resolved_at = CASE WHEN ? IN ('approved','declined','sent','failed') THEN datetime('now') ELSE resolved_at END
    WHERE id = ?
  `).run(status, errorMessage, status, id);
  return getRequest(id);
}

function updateTelegramIds(id, telegramMessageId, telegramChatId) {
  db.prepare(`
    UPDATE email_requests SET telegram_message_id = ?, telegram_chat_id = ? WHERE id = ?
  `).run(telegramMessageId, telegramChatId, id);
}

// --- Tests ---

describe('Users table', () => {
  beforeEach(() => setupDb());
  afterEach(() => teardownDb());

  it('should insert and retrieve a user', () => {
    const user = upsertUser('alice', 'token-123', 99999);
    expect(user.id).toBe('alice');
    expect(user.telegram_bot_token).toBe('token-123');
    expect(user.telegram_chat_id).toBe(99999);
    expect(user.created_at).toBeTruthy();
  });

  it('should upsert (update) an existing user', () => {
    upsertUser('alice', 'token-old', 11111);
    const updated = upsertUser('alice', 'token-new', 22222);
    expect(updated.telegram_bot_token).toBe('token-new');
    expect(updated.telegram_chat_id).toBe(22222);
  });

  it('should return null for non-existent user', () => {
    expect(getUser('nonexistent')).toBeNull();
  });

  it('should return all users', () => {
    upsertUser('alice', 'tok-a', 1);
    upsertUser('bob', 'tok-b', 2);
    const users = getAllUsers();
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.id).sort()).toEqual(['alice', 'bob']);
  });

  it('should update gmail refresh token', () => {
    upsertUser('alice', 'tok-a', 1);
    const user = getUser('alice');
    expect(user.gmail_refresh_token).toBeNull();

    const updated = updateUserGmailToken('alice', 'gmail-refresh-123');
    expect(updated.gmail_refresh_token).toBe('gmail-refresh-123');
  });
});

describe('Email requests table', () => {
  beforeEach(() => setupDb());
  afterEach(() => teardownDb());

  it('should create a request with userId', () => {
    const req = createRequest({
      id: 'req-1',
      userId: 'alice',
      to: ['a@b.com'],
      subject: 'Hi',
      body: 'Hello',
    });
    expect(req.id).toBe('req-1');
    expect(req.user_id).toBe('alice');
    expect(req.to_addresses).toEqual(['a@b.com']);
    expect(req.status).toBe('pending');
  });

  it('should create a request without userId', () => {
    const req = createRequest({
      id: 'req-2',
      to: ['x@y.com'],
      subject: 'Test',
      body: 'Body',
    });
    expect(req.user_id).toBeNull();
  });

  it('should store and retrieve cc, bcc, attachments', () => {
    const req = createRequest({
      id: 'req-3',
      userId: 'bob',
      to: ['a@b.com'],
      cc: ['cc@b.com'],
      bcc: ['bcc@b.com'],
      subject: 'Subj',
      body: 'Body',
      isHtml: true,
      attachments: [{ filename: 'f.txt', data: 'abc' }],
    });
    expect(req.cc_addresses).toEqual(['cc@b.com']);
    expect(req.bcc_addresses).toEqual(['bcc@b.com']);
    expect(req.is_html).toBe(true);
    expect(req.attachments).toEqual([{ filename: 'f.txt', data: 'abc' }]);
  });

  it('should store and retrieve threading fields', () => {
    const req = createRequest({
      id: 'req-thread',
      userId: 'alice',
      to: ['a@b.com'],
      subject: 'Re: Hello',
      body: 'Reply body',
      threadId: 'thread-abc123',
      inReplyTo: '<msg-001@mail.gmail.com>',
      references: ['<msg-000@mail.gmail.com>', '<msg-001@mail.gmail.com>'],
    });
    expect(req.thread_id).toBe('thread-abc123');
    expect(req.in_reply_to).toBe('<msg-001@mail.gmail.com>');
    expect(req.gmail_references).toEqual(['<msg-000@mail.gmail.com>', '<msg-001@mail.gmail.com>']);
  });

  it('should handle request without threading fields', () => {
    const req = createRequest({
      id: 'req-no-thread',
      userId: 'alice',
      to: ['a@b.com'],
      subject: 'New email',
      body: 'Body',
    });
    expect(req.thread_id).toBeNull();
    expect(req.in_reply_to).toBeNull();
    expect(req.gmail_references).toBeNull();
  });

  it('should return null for non-existent request', () => {
    expect(getRequest('nope')).toBeNull();
  });

  it('should update status to approved with resolved_at', () => {
    createRequest({ id: 'req-4', to: ['a@b.com'], subject: 'S', body: 'B' });
    const updated = updateStatus('req-4', 'approved');
    expect(updated.status).toBe('approved');
    expect(updated.resolved_at).toBeTruthy();
  });

  it('should update status to declined', () => {
    createRequest({ id: 'req-5', to: ['a@b.com'], subject: 'S', body: 'B' });
    const updated = updateStatus('req-5', 'declined');
    expect(updated.status).toBe('declined');
    expect(updated.resolved_at).toBeTruthy();
  });

  it('should update status to failed with error message', () => {
    createRequest({ id: 'req-6', to: ['a@b.com'], subject: 'S', body: 'B' });
    const updated = updateStatus('req-6', 'failed', 'SMTP error');
    expect(updated.status).toBe('failed');
    expect(updated.error_message).toBe('SMTP error');
  });

  it('should update telegram IDs', () => {
    createRequest({ id: 'req-7', to: ['a@b.com'], subject: 'S', body: 'B' });
    updateTelegramIds('req-7', 42, 100);
    const req = getRequest('req-7');
    expect(req.telegram_message_id).toBe(42);
    expect(req.telegram_chat_id).toBe(100);
  });
});
