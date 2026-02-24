import 'dotenv/config';
import { google } from 'googleapis';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../data.db');

// --- Parse CLI args ---
const args = process.argv.slice(2);
const userFlagIndex = args.indexOf('--user');
if (userFlagIndex === -1 || !args[userFlagIndex + 1]) {
  console.error('Usage: node scripts/get-thread-info.js --user <userId>');
  process.exit(1);
}
const userId = args[userFlagIndex + 1];

// --- Validate env ---
const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first');
  process.exit(1);
}

// --- Read refresh token from DB ---
const db = new Database(DB_PATH, { readonly: true });
const user = db.prepare('SELECT gmail_refresh_token FROM users WHERE id = ?').get(userId);
db.close();

if (!user || !user.gmail_refresh_token) {
  console.error(`No Gmail refresh token found for user "${userId}". Connect Gmail from the dashboard first.`);
  process.exit(1);
}

// --- Set up Gmail client ---
const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
oauth2Client.setCredentials({ refresh_token: user.gmail_refresh_token });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// --- List recent messages ---
console.log(`\nFetching recent messages for user "${userId}"...\n`);

const listRes = await gmail.users.messages.list({
  userId: 'me',
  maxResults: 10,
  labelIds: ['INBOX'],
});

const messages = listRes.data.messages;
if (!messages || messages.length === 0) {
  console.log('No messages found in inbox.');
  process.exit(0);
}

// Fetch summary headers for each message
const summaries = await Promise.all(
  messages.map(async (msg) => {
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });
    const headers = res.data.payload.headers;
    const get = (name) => headers.find((h) => h.name === name)?.value || '(none)';
    return { id: msg.id, threadId: res.data.threadId, subject: get('Subject'), from: get('From'), date: get('Date') };
  }),
);

// Display numbered list
console.log('Recent inbox messages:\n');
summaries.forEach((msg, i) => {
  console.log(`  [${i + 1}]  ${msg.subject}`);
  console.log(`       From: ${msg.from}`);
  console.log(`       Date: ${msg.date}\n`);
});

// --- Prompt user to select ---
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await new Promise((resolve) => {
  rl.question('Select a message number: ', resolve);
});
rl.close();

const selection = parseInt(answer, 10);
if (isNaN(selection) || selection < 1 || selection > summaries.length) {
  console.error('Invalid selection.');
  process.exit(1);
}

const selected = summaries[selection - 1];

// --- Fetch full metadata for selected message ---
const fullRes = await gmail.users.messages.get({
  userId: 'me',
  id: selected.id,
  format: 'metadata',
  metadataHeaders: ['Subject', 'From', 'Message-ID', 'Message-Id', 'References'],
});

const fullHeaders = fullRes.data.payload.headers;
const getHeader = (name) => fullHeaders.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || null;

const threadId = fullRes.data.threadId;
const messageId = getHeader('Message-ID') || getHeader('Message-Id');
const references = getHeader('References');
const subject = getHeader('Subject') || '(no subject)';
const from = getHeader('From') || '(unknown)';

console.log('\n--- Thread Info ---\n');
console.log(`  Thread ID:   ${threadId}`);
console.log(`  Message-Id:  ${messageId}`);
console.log(`  References:  ${references || '(none)'}`);
console.log(`  Subject:     ${subject}`);
console.log(`  From:        ${from}`);

// Build references array for reply: existing references + this message's ID
const replyReferences = [references, messageId].filter(Boolean).join(' ');
const replySubject = subject.startsWith('Re: ') ? subject : `Re: ${subject}`;

// Extract just the email address from "Name <email>" format
const fromEmail = from.includes('<') ? from.match(/<([^>]+)>/)?.[1] || from : from;

console.log('\n--- Ready-to-use curl command ---\n');
console.log(`curl -X POST http://localhost:3000/api/send-email \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '${JSON.stringify(
    {
      userId,
      to: [fromEmail],
      subject: replySubject,
      body: 'Test reply via threading.',
      threadId,
      inReplyTo: messageId,
      references: replyReferences.split(/\s+/).filter(Boolean),
    },
    null,
    2,
  )}'`);

console.log('');
