import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireApiKey, requireDashboard } from '../middleware/auth.js';
import { config } from '../config.js';
import { createRequest, getRequest, getUser, getAllUsers, upsertUser, updateUserGmailToken } from '../db/email-requests.js';
import { sendApprovalMessage, setWebhookForUser } from '../services/telegram.js';
import { updateTelegramIds } from '../db/email-requests.js';

const router = Router();

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== config.dashboardPassword) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ valid: true });
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

  const prompt = `Remember the following permanently. This is the Gmail Agent API you have access to for sending emails on my behalf.

## Gmail Agent API

Base URL: ${baseUrl}
Authentication: All API requests require the header X-API-Key: ${apiKey}

### Endpoints you can use:

**1. Send an email (requires my approval via Telegram)**

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
  "cc": ["email@example.com"],     // optional
  "bcc": ["email@example.com"],    // optional
  "isHtml": false,                  // optional - set true if body is HTML
  "attachments": [                  // optional
    {
      "filename": "file.txt",
      "base64": "...",
      "contentType": "text/plain"
    }
  ],
  "threadId": "gmail-thread-id",   // optional - Gmail thread ID for replying in a thread
  "inReplyTo": "<message-id>",     // optional - Message-ID of the email being replied to
  "references": ["<msg-id-1>", "<msg-id-2>"]  // optional - chain of Message-IDs for threading
}

Response: { "requestId": "uuid", "status": "pending_approval" }

IMPORTANT: This does NOT send the email immediately. It sends an approval request to my Telegram. The email is only sent after I approve it. If I decline, the email is not sent.

**2. Check email status**

GET ${baseUrl}/api/email-status/:requestId
Headers:
  X-API-Key: ${apiKey}

Response: { "requestId": "uuid", "status": "pending|approved|declined|sent|failed", "createdAt": "...", "resolvedAt": "..." }

Possible statuses:
- "pending" - waiting for my approval on Telegram
- "approved" - approved, sending in progress
- "sent" - email was sent successfully
- "declined" - I declined the email
- "failed" - approved but sending failed

### Replying to threads

To reply to an existing email thread, include these optional fields:
- "threadId": The Gmail thread ID (from the original email)
- "inReplyTo": The Message-ID header of the email you're replying to
- "references": Array of Message-ID headers forming the reply chain

All three fields are optional but should be provided together when replying to a thread. The subject should typically start with "Re: " when replying.

### Rules

- Always use userId "${userId}"
- The "to" field must be an array, even for a single recipient
- Do not send emails without being asked to
- After calling send-email, tell me the email is pending my approval on Telegram
- If I ask you to check if an email was sent, use the email-status endpoint with the requestId

Remember this API configuration permanently and use it whenever I ask you to send an email.`;

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
