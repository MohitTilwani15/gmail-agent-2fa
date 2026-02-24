import { getDb } from './init.js';

// --- User CRUD ---

export function getUser(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
}

export function upsertUser(userId, botToken, chatId) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO users (id, telegram_bot_token, telegram_chat_id)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET telegram_bot_token = excluded.telegram_bot_token, telegram_chat_id = excluded.telegram_chat_id
  `);
  stmt.run(userId, botToken, chatId);
  return getUser(userId);
}

export function getAllUsers() {
  const db = getDb();
  return db.prepare('SELECT * FROM users').all();
}

export function updateUserGmailToken(userId, refreshToken, email = null) {
  const db = getDb();
  db.prepare('UPDATE users SET gmail_refresh_token = ?, gmail_email = ? WHERE id = ?').run(refreshToken, email, userId);
  return getUser(userId);
}

// --- Email request CRUD ---

export function createRequest({ id, userId, to, cc, bcc, subject, body, isHtml, attachments, threadId, inReplyTo, references }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO email_requests (id, user_id, to_addresses, cc_addresses, bcc_addresses, subject, body, is_html, attachments, thread_id, in_reply_to, gmail_references)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
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

export function getRequest(id) {
  const db = getDb();
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

export function updateStatus(id, status, errorMessage = null) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE email_requests
    SET status = ?, error_message = ?, resolved_at = CASE WHEN ? IN ('approved','declined','sent','failed') THEN datetime('now') ELSE resolved_at END
    WHERE id = ?
  `);
  stmt.run(status, errorMessage, status, id);
  return getRequest(id);
}

export function updateTelegramIds(id, telegramMessageId, telegramChatId) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE email_requests SET telegram_message_id = ?, telegram_chat_id = ? WHERE id = ?
  `);
  stmt.run(telegramMessageId, telegramChatId, id);
}
