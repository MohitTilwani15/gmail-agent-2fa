import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireApiKey, requireDashboard, createSession, destroySession, getSessionMaxAgeMs } from '../middleware/auth.js';
import { config } from '../config.js';
import { STATUS } from '../constants.js';
import { createRequest, getRequest, getUser, getAllUsers, upsertUser, updateUserGmailToken, cleanupOldRequests } from '../db/email-requests.js';
import { sendApprovalMessage, setWebhookForUser } from '../services/telegram.js';
import { updateTelegramIds } from '../db/email-requests.js';

const router = Router();

// Cookie options for session (maxAge set dynamically from config)
function getCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: getSessionMaxAgeMs(),
  };
}

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== config.dashboardPassword) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  // Create session and set httpOnly cookie
  const sessionToken = createSession();
  res.cookie('session', sessionToken, getCookieOptions());
  res.json({ valid: true });
});

router.post('/logout', (req, res) => {
  const sessionToken = req.cookies?.session;
  if (sessionToken) {
    destroySession(sessionToken);
  }
  res.clearCookie('session');
  res.json({ success: true });
});

router.get('/verify-key', requireDashboard, (_req, res) => {
  res.json({ valid: true });
});

router.get('/users', requireDashboard, (_req, res) => {
  const users = getAllUsers();
  res.json(users.map((u) => ({
    id: u.id,
    telegramChatId: u.telegram_chat_id,
    gmailConnected: Boolean(u.gmail_refresh_token),
    gmailEmail: u.gmail_email || null,
    createdAt: u.created_at,
  })));
});

router.post('/disconnect-gmail', requireDashboard, (req, res) => {
  const { userId } = req.body;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: '"userId" is required' });
  }
  const user = getUser(userId);
  if (!user) {
    return res.status(404).json({ error: `User "${userId}" not found` });
  }
  updateUserGmailToken(userId, null, null);
  res.json({ userId, gmailConnected: false });
});

router.post('/register-user', requireDashboard, async (req, res) => {
  try {
    const { userId, telegramBotToken, telegramChatId } = req.body;

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: '"userId" is required' });
    }
    if (!telegramBotToken || typeof telegramBotToken !== 'string') {
      return res.status(400).json({ error: '"telegramBotToken" is required' });
    }
    if (!telegramChatId || typeof telegramChatId !== 'number') {
      return res.status(400).json({ error: '"telegramChatId" must be a number' });
    }

    upsertUser(userId, telegramBotToken, telegramChatId);
    await setWebhookForUser(userId, telegramBotToken);

    res.json({ userId, registered: true });
  } catch (err) {
    console.error('Error registering user:', err);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

router.post('/send-email', requireApiKey, async (req, res) => {
  try {
    const { userId, to, cc, bcc, subject, body, isHtml, attachments, threadId, inReplyTo, references } = req.body;

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: '"userId" is required' });
    }
    if (!to || !Array.isArray(to) || to.length === 0) {
      return res.status(400).json({ error: '"to" must be a non-empty array of email addresses' });
    }
    if (!subject || typeof subject !== 'string') {
      return res.status(400).json({ error: '"subject" is required' });
    }
    if (!body || typeof body !== 'string') {
      return res.status(400).json({ error: '"body" is required' });
    }

    const user = getUser(userId);
    if (!user) {
      return res.status(404).json({ error: `User "${userId}" not found. Register first via POST /api/register-user.` });
    }
    if (!user.gmail_refresh_token) {
      return res.status(400).json({ error: `User "${userId}" has not connected Gmail. Connect via the dashboard first.` });
    }

    const id = uuidv4();
    const emailRequest = createRequest({ id, userId, to, cc, bcc, subject, body, isHtml, attachments, threadId, inReplyTo, references });

    const { messageId, chatId } = await sendApprovalMessage(user.telegram_bot_token, user.telegram_chat_id, emailRequest);
    updateTelegramIds(id, messageId, chatId);

    res.json({ requestId: id, status: 'pending_approval' });
  } catch (err) {
    console.error('Error creating email request:', err);
    res.status(500).json({ error: 'Failed to create email request' });
  }
});

router.get('/prompt/:userId', requireDashboard, (req, res) => {
  const { userId } = req.params;
  const user = getUser(userId);
  if (!user) {
    return res.status(404).json({ error: `User "${userId}" not found` });
  }
  if (!user.gmail_refresh_token) {
    return res.status(400).json({ error: `User "${userId}" has not connected Gmail` });
  }

  const baseUrl = req.protocol + '://' + req.get('host');
  const apiKey = config.apiKey;

  const prompt = `You have access to a Gmail API that sends emails on my behalf.

## Gmail API

Base URL: ${baseUrl}
API Key: ${apiKey}

### Send Email

POST ${baseUrl}/api/send-email
Headers:
  X-API-Key: ${apiKey}
  Content-Type: application/json

Body:
{
  "userId": "${userId}",
  "to": ["recipient@example.com"],
  "subject": "string",
  "body": "string",
  "cc": ["email@example.com"],          // optional
  "bcc": ["email@example.com"],         // optional
  "isHtml": false,                       // optional, set true for HTML body
  "attachments": [                       // optional
    {
      "filename": "file.txt",
      "base64": "...",
      "contentType": "text/plain"
    }
  ],
  "threadId": "gmail-thread-id",        // optional, for replying in a thread
  "inReplyTo": "<message-id>",          // optional, Message-ID being replied to
  "references": ["<msg-id-1>"]          // optional, Message-ID chain for threading
}

Response: { "requestId": "uuid", "status": "pending_approval" }

When replying to a thread, include threadId, inReplyTo, and references together. Prefix the subject with "Re: ".

### Check Email Status

GET ${baseUrl}/api/email-status/\${requestId}
Headers:
  X-API-Key: ${apiKey}

Response: { "requestId": "uuid", "status": "pending|approved|declined|sent|failed", "createdAt": "...", "resolvedAt": "..." }

### Usage Rules

- Always use userId "${userId}" and pass "to" as an array
- When I ask you to send an email, call the send-email endpoint and tell me the email has been submitted
- If I ask whether an email was sent, check the status using the requestId`;

  res.json({ prompt });
});

router.get('/email-status/:id', requireApiKey, (req, res) => {
  const emailRequest = getRequest(req.params.id);
  if (!emailRequest) {
    return res.status(404).json({ error: 'Email request not found' });
  }
  res.json({
    requestId: emailRequest.id,
    status: emailRequest.status,
    createdAt: emailRequest.created_at,
    resolvedAt: emailRequest.resolved_at,
  });
});

export default router;
