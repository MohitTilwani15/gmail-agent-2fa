import express from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { initDatabase } from './db/init.js';
import { registerAllWebhooks } from './services/telegram.js';
import apiRoutes from './routes/api.js';
import authRoutes from './routes/auth.js';
import webhookRoutes from './routes/webhook.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(express.static(resolve(__dirname, '../public')));
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api', apiRoutes);
app.use('/api/auth', authRoutes);
app.use('/webhook', webhookRoutes);

async function start() {
  initDatabase();

  try {
    await registerAllWebhooks();
  } catch (err) {
    console.error('Failed to register Telegram webhooks:', err.message);
    console.error('The server will start, but Telegram callbacks may not work for existing users.');
  }

  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

start();
