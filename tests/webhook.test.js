import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = resolve(__dirname, '../test-webhook-data.db');

const {
  mockGetDb,
  mockAnswerCallbackQuery,
  mockEditMessageApproved,
  mockEditMessageDeclined,
  mockEditMessageFailed,
  mockSendEmail,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockAnswerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  mockEditMessageApproved: vi.fn().mockResolvedValue(undefined),
  mockEditMessageDeclined: vi.fn().mockResolvedValue(undefined),
  mockEditMessageFailed: vi.fn().mockResolvedValue(undefined),
  mockSendEmail: vi.fn().mockResolvedValue({ id: 'gmail-msg-1' }),
}));

vi.mock('../src/config.js', () => ({
  config: {
    apiKey: 'test-api-key',
    dashboardPassword: 'test-dashboard-pw',
    sessionExpiryHours: 24,
    telegram: { webhookUrl: 'https://example.com', webhookSecret: 'test-secret' },
    gmail: { clientId: 'cid', clientSecret: 'cs', redirectUri: 'http://localhost' },
    port: 3000,
  },
}));

vi.mock('../src/db/init.js', () => ({
  initDatabase: vi.fn(),
  getDb: mockGetDb,
}));

vi.mock('../src/services/telegram.js', () => ({
  sendApprovalMessage: vi.fn().mockResolvedValue({ messageId: 1, chatId: 100 }),
  setWebhookForUser: vi.fn().mockResolvedValue(undefined),
  registerAllWebhooks: vi.fn().mockResolvedValue(undefined),
  answerCallbackQuery: mockAnswerCallbackQuery,
  editMessageApproved: mockEditMessageApproved,
  editMessageDeclined: mockEditMessageDeclined,
  editMessageFailed: mockEditMessageFailed,
}));

vi.mock('../src/services/gmail.js', () => ({
  createGmailClient: vi.fn(),
  sendEmail: mockSendEmail,
}));

import express from 'express';
import webhookRoutes from '../src/routes/webhook.js';

let app;
let db;

beforeEach(() => {
  vi.clearAllMocks();

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

  mockGetDb.mockReturnValue(db);

  app = express();
  app.use(express.json());
  app.use('/webhook', webhookRoutes);
});

afterEach(() => {
  if (db) db.close();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

function sendWebhook(path, body, secret = 'test-secret') {
  let r = supertest(app).post(path).send(body).set('Content-Type', 'application/json');
  if (secret) r = r.set('X-Telegram-Bot-Api-Secret-Token', secret);
  return r;
}

function seedUser(id = 'alice', token = 'tok-123', chatId = 100, gmailToken = 'gmail-refresh-tok') {
  db.prepare('INSERT INTO users (id, telegram_bot_token, telegram_chat_id, gmail_refresh_token) VALUES (?, ?, ?, ?)').run(id, token, chatId, gmailToken);
}

function seedRequest(id = 'req-1', userId = 'alice', status = 'pending') {
  db.prepare(`
    INSERT INTO email_requests (id, user_id, to_addresses, subject, body, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, '["a@b.com"]', 'Subj', 'Body', status);
}

describe('POST /webhook/telegram/:userId', () => {
  it('should reject invalid webhook secret', async () => {
    const res = await sendWebhook('/webhook/telegram/alice', {}, 'wrong-secret');
    expect(res.status).toBe(403);
  });

  it('should return 200 for valid request with no callback_query', async () => {
    seedUser();
    const res = await sendWebhook('/webhook/telegram/alice', { message: { text: 'hi' } });
    expect(res.status).toBe(200);
  });

  it('should approve an email request', async () => {
    seedUser();
    seedRequest();

    const res = await sendWebhook('/webhook/telegram/alice', {
      callback_query: {
        id: 'cb-1',
        data: 'approve:req-1',
        message: { chat: { id: 100 }, message_id: 42 },
      },
    });
    expect(res.status).toBe(200);

    // Wait for async processing after res.sendStatus(200)
    await vi.waitFor(() => {
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith('tok-123', 'cb-1', 'Approved! Sending email...');
    });
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ id: 'req-1' }), 'gmail-refresh-tok');
    expect(mockEditMessageApproved).toHaveBeenCalledWith('tok-123', 100, 42, expect.objectContaining({ id: 'req-1' }));

    const row = db.prepare('SELECT status FROM email_requests WHERE id = ?').get('req-1');
    expect(row.status).toBe('sent');
  });

  it('should pass threading fields to sendEmail on approval', async () => {
    seedUser();
    db.prepare(`
      INSERT INTO email_requests (id, user_id, to_addresses, subject, body, status, thread_id, in_reply_to, gmail_references)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('req-thread', 'alice', '["a@b.com"]', 'Re: Subj', 'Reply', 'pending', 'thread-abc', '<msg-001@mail.gmail.com>', '["<msg-000@mail.gmail.com>","<msg-001@mail.gmail.com>"]');

    await sendWebhook('/webhook/telegram/alice', {
      callback_query: {
        id: 'cb-thread',
        data: 'approve:req-thread',
        message: { chat: { id: 100 }, message_id: 42 },
      },
    });

    await vi.waitFor(() => {
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'req-thread',
          thread_id: 'thread-abc',
          in_reply_to: '<msg-001@mail.gmail.com>',
          gmail_references: ['<msg-000@mail.gmail.com>', '<msg-001@mail.gmail.com>'],
        }),
        'gmail-refresh-tok',
      );
    });
  });

  it('should decline an email request', async () => {
    seedUser();
    seedRequest();

    await sendWebhook('/webhook/telegram/alice', {
      callback_query: {
        id: 'cb-2',
        data: 'decline:req-1',
        message: { chat: { id: 100 }, message_id: 42 },
      },
    });

    await vi.waitFor(() => {
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith('tok-123', 'cb-2', 'Declined');
    });
    expect(mockEditMessageDeclined).toHaveBeenCalledWith('tok-123', 100, 42, expect.objectContaining({ id: 'req-1' }));

    const row = db.prepare('SELECT status FROM email_requests WHERE id = ?').get('req-1');
    expect(row.status).toBe('declined');
  });

  it('should handle already processed request', async () => {
    seedUser();
    seedRequest('req-1', 'alice', 'sent');

    await sendWebhook('/webhook/telegram/alice', {
      callback_query: {
        id: 'cb-3',
        data: 'approve:req-1',
        message: { chat: { id: 100 }, message_id: 42 },
      },
    });

    await vi.waitFor(() => {
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith('tok-123', 'cb-3', 'Already sent');
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('should handle email send failure', async () => {
    seedUser();
    seedRequest();
    mockSendEmail.mockRejectedValueOnce(new Error('SMTP error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendWebhook('/webhook/telegram/alice', {
      callback_query: {
        id: 'cb-4',
        data: 'approve:req-1',
        message: { chat: { id: 100 }, message_id: 42 },
      },
    });

    await vi.waitFor(() => {
      expect(mockEditMessageFailed).toHaveBeenCalledWith('tok-123', 100, 42, expect.anything(), 'Failed to send email. Please try again.');
    });

    const row = db.prepare('SELECT status FROM email_requests WHERE id = ?').get('req-1');
    expect(row.status).toBe('failed');
    consoleSpy.mockRestore();
  });

  it('should handle unknown request id', async () => {
    seedUser();

    await sendWebhook('/webhook/telegram/alice', {
      callback_query: {
        id: 'cb-5',
        data: 'approve:nonexistent',
        message: { chat: { id: 100 }, message_id: 42 },
      },
    });

    await vi.waitFor(() => {
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith('tok-123', 'cb-5', 'Request not found');
    });
  });

  it('should fail gracefully when user has no Gmail token', async () => {
    // Seed user without Gmail token
    db.prepare('INSERT INTO users (id, telegram_bot_token, telegram_chat_id) VALUES (?, ?, ?)').run('bob', 'tok-456', 200);
    db.prepare(`
      INSERT INTO email_requests (id, user_id, to_addresses, subject, body, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('req-2', 'bob', '["a@b.com"]', 'Subj', 'Body', 'pending');

    await sendWebhook('/webhook/telegram/bob', {
      callback_query: {
        id: 'cb-6',
        data: 'approve:req-2',
        message: { chat: { id: 200 }, message_id: 50 },
      },
    });

    await vi.waitFor(() => {
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith('tok-456', 'cb-6', 'Gmail not connected');
    });
    expect(mockEditMessageFailed).toHaveBeenCalledWith('tok-456', 200, 50, expect.anything(), 'Gmail not connected for this user');
    expect(mockSendEmail).not.toHaveBeenCalled();

    const row = db.prepare('SELECT status FROM email_requests WHERE id = ?').get('req-2');
    expect(row.status).toBe('failed');
  });
});
