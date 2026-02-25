import { Router } from 'express';
import { config } from '../config.js';
import { STATUS } from '../constants.js';
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

  if (emailRequest.status !== STATUS.PENDING) {
    await answerCallbackQuery(botToken, callbackQuery.id, `Already ${emailRequest.status}`);
    return;
  }

  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (action === 'approve') {
    if (!user.gmail_refresh_token) {
      updateStatus(requestId, STATUS.FAILED, 'Gmail not connected for this user');
      await answerCallbackQuery(botToken, callbackQuery.id, 'Gmail not connected');
      await editMessageFailed(botToken, chatId, messageId, emailRequest, 'Gmail not connected for this user');
      return;
    }

    updateStatus(requestId, STATUS.APPROVED);
    await answerCallbackQuery(botToken, callbackQuery.id, 'Approved! Sending email...');

    try {
      await sendEmail(emailRequest, user.gmail_refresh_token);
      updateStatus(requestId, STATUS.SENT);
      await editMessageApproved(botToken, chatId, messageId, emailRequest);
    } catch (err) {
      console.error('Failed to send email:', err);
      // Sanitize error message - don't expose internal details
      const safeErrorMessage = err.message?.includes('invalid_grant') 
        ? 'Gmail authorization expired. Please reconnect Gmail.'
        : 'Failed to send email. Please try again.';
      updateStatus(requestId, STATUS.FAILED, safeErrorMessage);
      await editMessageFailed(botToken, chatId, messageId, emailRequest, safeErrorMessage);
    }
  } else if (action === 'decline') {
    updateStatus(requestId, STATUS.DECLINED);
    await answerCallbackQuery(botToken, callbackQuery.id, 'Declined');
    await editMessageDeclined(botToken, chatId, messageId, emailRequest);
  }
});

export default router;
