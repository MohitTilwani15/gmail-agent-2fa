import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = resolve(__dirname, '../test-api-data.db');

const { mockGetDb, mockSendApprovalMessage, mockSetWebhookForUser } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockSendApprovalMessage: vi.fn().mockResolvedValue({ messageId: 1, chatId: 100 }),
  mockSetWebhookForUser: vi.fn().mockResolvedValue(undefined),
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
  sendApprovalMessage: mockSendApprovalMessage,
  setWebhookForUser: mockSetWebhookForUser,
  registerAllWebhooks: vi.fn().mockResolvedValue(undefined),
  answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  editMessageApproved: vi.fn().mockResolvedValue(undefined),
  editMessageDeclined: vi.fn().mockResolvedValue(undefined),
  editMessageFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/gmail.js', () => ({
  createGmailClient: vi.fn(),
  sendEmail: vi.fn().mockResolvedValue({ id: 'gmail-msg-1' }),
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import apiRoutes from '../src/routes/api.js';

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
  app.use(cookieParser());
  app.use('/api', apiRoutes);
});

afterEach(() => {
  if (db) db.close();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

function req(method, path, body = null, apiKey = 'test-api-key') {
  let r = supertest(app)[method](path);
  if (apiKey) r = r.set('X-API-Key', apiKey);
  if (body) r = r.send(body).set('Content-Type', 'application/json');
  return r;
}

describe('POST /api/login', () => {
  it('should return valid:true for correct password', async () => {
    const res = await supertest(app)
      .post('/api/login')
      .send({ password: 'test-dashboard-pw' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });

  it('should return 401 for wrong password', async () => {
    const res = await supertest(app)
      .post('/api/login')
      .send({ password: 'wrong' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(401);
  });

  it('should return 401 for missing password', async () => {
    const res = await supertest(app)
      .post('/api/login')
      .send({})
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/verify-key', () => {
  it('should accept API key', async () => {
    const res = await req('get', '/api/verify-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });

  it('should accept dashboard password', async () => {
    const res = await supertest(app)
      .get('/api/verify-key')
      .set('X-Dashboard-Key', 'test-dashboard-pw');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });

  it('should return 401 for invalid credentials', async () => {
    const res = await req('get', '/api/verify-key', null, 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('should return 401 for missing credentials', async () => {
    const res = await req('get', '/api/verify-key', null, null);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/users', () => {
  it('should return empty array when no users', async () => {
    const res = await req('get', '/api/users');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('should return users with gmailConnected status', async () => {
    db.prepare('INSERT INTO users (id, telegram_bot_token, telegram_chat_id, gmail_refresh_token) VALUES (?, ?, ?, ?)').run('alice', 'tok-123', 99999, 'refresh-tok');
    db.prepare('INSERT INTO users (id, telegram_bot_token, telegram_chat_id) VALUES (?, ?, ?)').run('bob', 'tok-456', 88888);

    const res = await req('get', '/api/users');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const alice = res.body.find((u) => u.id === 'alice');
    const bob = res.body.find((u) => u.id === 'bob');

    expect(alice.gmailConnected).toBe(true);
    expect(bob.gmailConnected).toBe(false);
    // Should not expose refresh token
    expect(alice.gmail_refresh_token).toBeUndefined();
  });

  it('should reject requests without API key', async () => {
    const res = await req('get', '/api/users', null, null);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/register-user', () => {
  it('should register a new user', async () => {
    const res = await req('post', '/api/register-user', {
      userId: 'alice',
      telegramBotToken: 'tok-123',
      telegramChatId: 99999,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'alice', registered: true });
    expect(mockSetWebhookForUser).toHaveBeenCalledWith('alice', 'tok-123');
  });

  it('should update an existing user on re-register', async () => {
    await req('post', '/api/register-user', {
      userId: 'alice',
      telegramBotToken: 'tok-old',
      telegramChatId: 11111,
    });
    const res = await req('post', '/api/register-user', {
      userId: 'alice',
      telegramBotToken: 'tok-new',
      telegramChatId: 22222,
    });
    expect(res.status).toBe(200);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get('alice');
    expect(user.telegram_bot_token).toBe('tok-new');
    expect(user.telegram_chat_id).toBe(22222);
  });

  it('should reject missing userId', async () => {
    const res = await req('post', '/api/register-user', {
      telegramBotToken: 'tok',
      telegramChatId: 1,
    });
    expect(res.status).toBe(400);
  });

  it('should reject missing telegramBotToken', async () => {
    const res = await req('post', '/api/register-user', {
      userId: 'alice',
      telegramChatId: 1,
    });
    expect(res.status).toBe(400);
  });

  it('should reject non-numeric telegramChatId', async () => {
    const res = await req('post', '/api/register-user', {
      userId: 'alice',
      telegramBotToken: 'tok',
      telegramChatId: 'not-a-number',
    });
    expect(res.status).toBe(400);
  });

  it('should reject requests without API key', async () => {
    const res = await req('post', '/api/register-user', {
      userId: 'alice',
      telegramBotToken: 'tok',
      telegramChatId: 1,
    }, null);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/send-email', () => {
  it('should create email request and send approval', async () => {
    db.prepare('INSERT INTO users (id, telegram_bot_token, telegram_chat_id, gmail_refresh_token) VALUES (?, ?, ?, ?)').run('alice', 'tok-123', 99999, 'refresh-tok');

    const res = await req('post', '/api/send-email', {
      userId: 'alice',
      to: ['test@example.com'],
      subject: 'Test',
      body: 'Hello',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_approval');
    expect(res.body.requestId).toBeTruthy();
    expect(mockSendApprovalMessage).toHaveBeenCalledWith('tok-123', 99999, expect.objectContaining({
      to_addresses: ['test@example.com'],
      subject: 'Test',
    }));
  });

  it('should return 400 when user has no Gmail token', async () => {
    db.prepare('INSERT INTO users (id, telegram_bot_token, telegram_chat_id) VALUES (?, ?, ?)').run('alice', 'tok-123', 99999);

    const res = await req('post', '/api/send-email', {
      userId: 'alice',
      to: ['test@example.com'],
      subject: 'Test',
      body: 'Hello',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not connected Gmail/);
  });

  it('should reject when userId is missing', async () => {
    const res = await req('post', '/api/send-email', {
      to: ['test@example.com'],
      subject: 'Test',
      body: 'Hello',
    });
    expect(res.status).toBe(400);
  });

  it('should return 404 for unregistered user', async () => {
    const res = await req('post', '/api/send-email', {
      userId: 'unknown',
      to: ['test@example.com'],
      subject: 'Test',
      body: 'Hello',
    });
    expect(res.status).toBe(404);
  });

  it('should reject missing "to"', async () => {
    db.prepare('INSERT INTO users (id, telegram_bot_token, telegram_chat_id, gmail_refresh_token) VALUES (?, ?, ?, ?)').run('alice', 'tok', 1, 'rt');
    const res = await req('post', '/api/send-email', {
      userId: 'alice',
      subject: 'Test',
      body: 'Hello',
    });
    expect(res.status).toBe(400);
  });

  it('should store threading fields when provided', async () => {
    db.prepare('INSERT INTO users (id, telegram_bot_token, telegram_chat_id, gmail_refresh_token) VALUES (?, ?, ?, ?)').run('alice', 'tok-123', 99999, 'refresh-tok');

    const res = await req('post', '/api/send-email', {
      userId: 'alice',
      to: ['test@example.com'],
      subject: 'Re: Test',
      body: 'Reply',
      threadId: 'thread-abc',
      inReplyTo: '<msg-001@mail.gmail.com>',
      references: ['<msg-000@mail.gmail.com>', '<msg-001@mail.gmail.com>'],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_approval');

    const row = db.prepare('SELECT thread_id, in_reply_to, gmail_references FROM email_requests WHERE id = ?').get(res.body.requestId);
    expect(row.thread_id).toBe('thread-abc');
    expect(row.in_reply_to).toBe('<msg-001@mail.gmail.com>');
    expect(JSON.parse(row.gmail_references)).toEqual(['<msg-000@mail.gmail.com>', '<msg-001@mail.gmail.com>']);
  });

  it('should reject missing subject', async () => {
    db.prepare('INSERT INTO users (id, telegram_bot_token, telegram_chat_id, gmail_refresh_token) VALUES (?, ?, ?, ?)').run('alice', 'tok', 1, 'rt');
    const res = await req('post', '/api/send-email', {
      userId: 'alice',
      to: ['a@b.com'],
      body: 'Hello',
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/email-status/:id', () => {
  it('should return status of an existing request', async () => {
    db.prepare(`
      INSERT INTO email_requests (id, user_id, to_addresses, subject, body, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('req-1', 'alice', '["a@b.com"]', 'Subj', 'Body', 'pending');

    const res = await req('get', '/api/email-status/req-1');
    expect(res.status).toBe(200);
    expect(res.body.requestId).toBe('req-1');
    expect(res.body.status).toBe('pending');
  });

  it('should return 404 for non-existent request', async () => {
    const res = await req('get', '/api/email-status/nonexistent');
    expect(res.status).toBe(404);
  });
});
