import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import { getAllUsers } from '../db/email-requests.js';

function createBot(botToken) {
  return new TelegramBot(botToken);
}

export async function setWebhookForUser(userId, botToken) {
  const bot = createBot(botToken);
  const url = `${config.telegram.webhookUrl}/webhook/telegram/${userId}`;
  await bot.setWebHook(url, { secret_token: config.telegram.webhookSecret });
  console.log(`Telegram webhook set for user "${userId}" at ${url}`);
}

export async function registerAllWebhooks() {
  const users = getAllUsers();
  for (const user of users) {
    try {
      await setWebhookForUser(user.id, user.telegram_bot_token);
    } catch (err) {
      console.error(`Failed to set webhook for user "${user.id}":`, err.message);
    }
  }
  console.log(`Registered webhooks for ${users.length} user(s)`);
}

export async function sendApprovalMessage(botToken, chatId, emailRequest) {
  const bot = createBot(botToken);
  const { id, to_addresses, cc_addresses, subject, body, attachments, thread_id } = emailRequest;

  let text = thread_id
    ? `📧 Reply in Thread — Approval Request\n\n`
    : `📧 Email Approval Request\n\n`;
  text += `To: ${to_addresses.join(', ')}\n`;
  if (cc_addresses && cc_addresses.length > 0) {
    text += `CC: ${cc_addresses.join(', ')}\n`;
  }
  text += `Subject: ${subject}\n\n`;
  text += `Body:\n${body}`;

  if (attachments && attachments.length > 0) {
    const filenames = attachments.map((a) => a.filename).join(', ');
    text += `\n\n📎 Attachments: ${filenames}`;
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:${id}` },
        { text: '❌ Decline', callback_data: `decline:${id}` },
      ],
    ],
  };

  const sent = await bot.sendMessage(chatId, text, {
    reply_markup: keyboard,
  });

  return { messageId: sent.message_id, chatId: sent.chat.id };
}

function formatEmailDetails(emailRequest) {
  const { to_addresses, cc_addresses, bcc_addresses, subject, body, attachments, thread_id } = emailRequest;

  let text = '';
  if (thread_id) {
    text += `↩️ Reply in thread\n`;
  }
  text += `To: ${to_addresses.join(', ')}\n`;
  if (cc_addresses && cc_addresses.length > 0) {
    text += `CC: ${cc_addresses.join(', ')}\n`;
  }
  if (bcc_addresses && bcc_addresses.length > 0) {
    text += `BCC: ${bcc_addresses.join(', ')}\n`;
  }
  text += `Subject: ${subject}\n\n`;
  text += `Body:\n${body}`;

  if (attachments && attachments.length > 0) {
    const filenames = attachments.map((a) => a.filename).join(', ');
    text += `\n\n📎 Attachments: ${filenames}`;
  }

  return text;
}

export async function editMessageApproved(botToken, chatId, messageId, emailRequest) {
  const bot = createBot(botToken);
  let text = `✅ APPROVED — Email sent successfully\n`;
  text += `Resolved: ${new Date().toISOString()}\n`;
  text += `─────────────────────\n`;
  text += formatEmailDetails(emailRequest);

  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
}

export async function editMessageDeclined(botToken, chatId, messageId, emailRequest) {
  const bot = createBot(botToken);
  let text = `❌ DECLINED — Email not sent\n`;
  text += `Resolved: ${new Date().toISOString()}\n`;
  text += `─────────────────────\n`;
  text += formatEmailDetails(emailRequest);

  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
}

export async function editMessageFailed(botToken, chatId, messageId, emailRequest, error) {
  const bot = createBot(botToken);
  let text = `⚠️ APPROVED but SEND FAILED\n`;
  text += `Error: ${error}\n`;
  text += `Resolved: ${new Date().toISOString()}\n`;
  text += `─────────────────────\n`;
  text += formatEmailDetails(emailRequest);

  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
}

export async function answerCallbackQuery(botToken, callbackQueryId, text) {
  const bot = createBot(botToken);
  await bot.answerCallbackQuery(callbackQueryId, { text });
}
