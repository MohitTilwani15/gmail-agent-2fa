import { Router } from 'express';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { getUser, updateUserGmailToken } from '../db/email-requests.js';
import { validateSession } from '../middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

// Load HTML template
const gmailConnectedTemplate = readFileSync(
  resolve(__dirname, '../templates/gmail-connected.html'),
  'utf-8'
);

function renderTemplate(template, variables) {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), escapeHtml(value));
  }
  return result;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

router.get('/gmail', (req, res) => {
  // Use session cookie for authentication (no password in URL)
  const sessionToken = req.cookies?.session;
  if (!sessionToken || !validateSession(sessionToken)) {
    return res.status(401).json({ 
      error: 'Invalid or missing session. Please log in to the dashboard first.' 
    });
  }

  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: '"userId" query parameter is required' });
  }

  const user = getUser(userId);
  if (!user) {
    return res.status(404).json({ error: `User "${userId}" not found` });
  }

  const oauth2Client = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.gmail.redirectUri,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'],
    state: userId,
  });

  res.redirect(authUrl);
});

router.get('/callback/google', async (req, res) => {
  const { code, state: userId } = req.query;

  if (!code || !userId) {
    return res.status(400).send('Missing code or state parameter');
  }

  const user = getUser(userId);
  if (!user) {
    return res.status(404).send(`User "${userId}" not found`);
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      config.gmail.clientId,
      config.gmail.clientSecret,
      config.gmail.redirectUri,
    );

    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      return res.status(400).send('No refresh token received. Try revoking app access in your Google account and retrying.');
    }

    // Fetch the user's Gmail address
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const gmailEmail = profile.data.emailAddress;

    updateUserGmailToken(userId, tokens.refresh_token, gmailEmail);

    const html = renderTemplate(gmailConnectedTemplate, {
      email: gmailEmail,
      userId: userId,
    });
    res.send(html);
  } catch (err) {
    console.error('Gmail OAuth callback error:', err);
    res.status(500).send('Failed to exchange authorization code. Please try again.');
  }
});

// --- Calendar OAuth ---

router.get('/calendar/:pairId/account/:accountNum', (req, res) => {
  const sessionToken = req.cookies?.session;
  if (!sessionToken || !validateSession(sessionToken)) {
    return res.status(401).json({
      error: 'Invalid or missing session. Please log in to the dashboard first.'
    });
  }

  const { pairId, accountNum } = req.params;
  const num = parseInt(accountNum, 10);
  if (num !== 1 && num !== 2) {
    return res.status(400).json({ error: 'accountNum must be 1 or 2' });
  }

  const oauth2Client = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.gmail.calendarRedirectUri,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    state: JSON.stringify({ pairId, accountNum: num }),
  });

  res.redirect(authUrl);
});

router.get('/callback/calendar', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send('Missing code or state parameter');
  }

  let parsed;
  try {
    parsed = JSON.parse(state);
  } catch {
    return res.status(400).send('Invalid state parameter');
  }

  const { pairId, accountNum } = parsed;

  try {
    const oauth2Client = new google.auth.OAuth2(
      config.gmail.clientId,
      config.gmail.clientSecret,
      config.gmail.calendarRedirectUri,
    );

    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      return res.status(400).send('No refresh token received. Try revoking app access in your Google account and retrying.');
    }

    // Fetch the account email
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    // Import dynamically to avoid circular deps
    const { updateSyncPairAccount } = await import('../db/calendar-sync.js');
    updateSyncPairAccount(pairId, accountNum, tokens.refresh_token, email);

    res.send(`<html><body><h2>Calendar account connected!</h2><p>${escapeHtml(email)} connected as Account ${accountNum}.</p><p>You can close this window.</p></body></html>`);
  } catch (err) {
    console.error('Calendar OAuth callback error:', err);
    res.status(500).send('Failed to exchange authorization code. Please try again.');
  }
});

export default router;
