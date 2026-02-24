import { google } from 'googleapis';
import { config } from '../config.js';
import { processAttachments } from './attachments.js';

export function createGmailClient(refreshToken) {
  const oauth2Client = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.gmail.redirectUri,
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export async function sendEmail(emailRequest, refreshToken) {
  const gmail = createGmailClient(refreshToken);

  const { to_addresses, cc_addresses, bcc_addresses, subject, body, is_html, attachments, thread_id, in_reply_to, gmail_references } = emailRequest;

  const processedAttachments = await processAttachments(attachments);
  const boundary = `boundary_${Date.now()}`;
  const hasAttachments = processedAttachments.length > 0;

  let message = '';
  message += `To: ${to_addresses.join(', ')}\r\n`;
  if (cc_addresses && cc_addresses.length > 0) {
    message += `Cc: ${cc_addresses.join(', ')}\r\n`;
  }
  if (bcc_addresses && bcc_addresses.length > 0) {
    message += `Bcc: ${bcc_addresses.join(', ')}\r\n`;
  }
  if (in_reply_to) {
    message += `In-Reply-To: ${in_reply_to}\r\n`;
  }
  if (gmail_references && gmail_references.length > 0) {
    message += `References: ${gmail_references.join(' ')}\r\n`;
  }
  message += `Subject: ${subject}\r\n`;
  message += `MIME-Version: 1.0\r\n`;

  if (hasAttachments) {
    message += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
    message += `--${boundary}\r\n`;
    message += `Content-Type: ${is_html ? 'text/html' : 'text/plain'}; charset="UTF-8"\r\n\r\n`;
    message += `${body}\r\n`;

    for (const att of processedAttachments) {
      message += `--${boundary}\r\n`;
      message += `Content-Type: ${att.contentType}; name="${att.filename}"\r\n`;
      message += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
      message += `Content-Transfer-Encoding: base64\r\n\r\n`;
      message += `${att.data}\r\n`;
    }
    message += `--${boundary}--`;
  } else {
    message += `Content-Type: ${is_html ? 'text/html' : 'text/plain'}; charset="UTF-8"\r\n\r\n`;
    message += body;
  }

  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const requestBody = { raw: encodedMessage };
  if (thread_id) {
    requestBody.threadId = thread_id;
  }

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody,
  });

  return result.data;
}
