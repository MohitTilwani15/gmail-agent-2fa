import { Router } from 'express';
import { config } from '../config.js';
import { getRequest, updateStatus, getUser } from '../db/email-requests.js';
import { sendEmail } from '../services/gmail.js';
import {
  answerCallbackQuery,
  editMessageApproved,
  editMessageDeclined,
  editMessageFailed,
} from '../services/telegram.js';

const router = Router();

router.post('/telegram/:userId', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== config.telegram.webhookSecret) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  const { userId } = req.params;
  const user = getUser(userId);
  if (!user) {
    console.error(`Webhook received for unknown user "${userId}"`);
    return;
  }

  const botToken = user.telegram_bot_token;

  const update = req.body;
  if (!update.callback_query) return;

  const callbackQuery = update.callback_query;
  const data = callbackQuery.data;
  const [action, requestId] = data.split(':');

  if (!action || !requestId) return;

  const emailRequest = getRequest(requestId);
  if (!emailRequest) {
    await answerCallbackQuery(botToken, callbackQuery.id, 'Request not found');
    return;
  }

  if (emailRequest.status !== 'pending') {
    await answerCallbackQuery(botToken, callbackQuery.id, `Already ${emailRequest.status}`);
    return;
  }

  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (action === 'approve') {
    if (!user.gmail_refresh_token) {
      updateStatus(requestId, 'failed', 'Gmail not connected for this user');
      await answerCallbackQuery(botToken, callbackQuery.id, 'Gmail not connected');
      await editMessageFailed(botToken, chatId, messageId, emailRequest, 'Gmail not connected for this user');
      return;
    }

    updateStatus(requestId, 'approved');
    await answerCallbackQuery(botToken, callbackQuery.id, 'Approved! Sending email...');

    try {
      await sendEmail(emailRequest, user.gmail_refresh_token);
      updateStatus(requestId, 'sent');
      await editMessageApproved(botToken, chatId, messageId, emailRequest);
    } catch (err) {
      console.error('Failed to send email:', err);
      updateStatus(requestId, 'failed', err.message);
      await editMessageFailed(botToken, chatId, messageId, emailRequest, err.message);
    }
  } else if (action === 'decline') {
    updateStatus(requestId, 'declined');
    await answerCallbackQuery(botToken, callbackQuery.id, 'Declined');
    await editMessageDeclined(botToken, chatId, messageId, emailRequest);
  }
});

export default router;
