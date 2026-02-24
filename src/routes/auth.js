import { Router } from 'express';
import { google } from 'googleapis';
import { config } from '../config.js';
import { getUser, updateUserGmailToken } from '../db/email-requests.js';

const router = Router();

router.get('/gmail', (req, res) => {
  // Accept dashboard password from query param (browser redirect can't set headers)
  const key = req.query.key;
  if (!key || key !== config.dashboardPassword) {
    return res.status(401).json({ error: 'Invalid or missing credentials' });
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

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Gmail Connected</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
          .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
          h1 { color: #16a34a; margin-bottom: 0.5rem; }
          p { margin: 0.5rem 0; }
          a { color: #2563eb; text-decoration: none; }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Gmail Connected!</h1>
          <p>Connected as <strong>${gmailEmail}</strong> for user <strong>${userId}</strong>.</p>
          <p><a href="/">Back to Dashboard</a></p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Gmail OAuth callback error:', err);
    res.status(500).send('Failed to exchange authorization code. Please try again.');
  }
});

export default router;
