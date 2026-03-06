import express from 'express';
import cookieParser from 'cookie-parser';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { initDatabase } from './db/init.js';
import { cleanupOldRequests } from './db/email-requests.js';
import { registerAllWebhooks } from './services/telegram.js';
import { rateLimit } from './middleware/rate-limit.js';
import apiRoutes from './routes/api.js';
import authRoutes from './routes/auth.js';
import webhookRoutes from './routes/webhook.js';
import calendarSyncRoutes from './routes/calendar-sync.js';
import calendarWebhookRoutes from './routes/calendar-webhook.js';
import { registerAllCalendarChannels, renewExpiringChannels } from './services/calendar-channels.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// Middleware
app.use(express.static(resolve(__dirname, '../public')));
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

// Apply rate limiting to API routes (not webhooks)
app.use('/api', rateLimit);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api', apiRoutes);
app.use('/api/auth', authRoutes);
app.use('/webhook', webhookRoutes);
app.use('/api/calendar-sync', calendarSyncRoutes);
app.use('/webhook', calendarWebhookRoutes);

// Schedule cleanup of old email requests (run daily at midnight)
function scheduleCleanup() {
  const runCleanup = () => {
    try {
      const deleted = cleanupOldRequests();
      if (deleted > 0) {
        console.log(`Cleanup: Deleted ${deleted} old email request(s)`);
      }
    } catch (err) {
      console.error('Cleanup error:', err.message);
    }
  };

  // Run cleanup every 24 hours
  setInterval(runCleanup, 24 * 60 * 60 * 1000);
  
  // Also run once at startup (after a short delay to ensure DB is ready)
  setTimeout(runCleanup, 5000);
}

function scheduleChannelRenewal() {
  // Renew expiring calendar channels every hour
  setInterval(async () => {
    try {
      await renewExpiringChannels();
    } catch (err) {
      console.error('Channel renewal error:', err.message);
    }
  }, 60 * 60 * 1000);
}

async function start() {
  initDatabase();

  try {
    await registerAllWebhooks();
  } catch (err) {
    console.error('Failed to register Telegram webhooks:', err.message);
    console.error('The server will start, but Telegram callbacks may not work for existing users.');
  }

  try {
    await registerAllCalendarChannels();
  } catch (err) {
    console.error('Failed to register calendar channels:', err.message);
    console.error('Calendar sync may not work for existing pairs until channels are renewed.');
  }

  scheduleCleanup();
  scheduleChannelRenewal();

  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

start();
