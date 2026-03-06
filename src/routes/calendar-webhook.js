import { Router } from 'express';
import { getSyncPairByChannelId, getSyncPair } from '../db/calendar-sync.js';
import { incrementalSync } from '../services/calendar.js';

const router = Router();

router.post('/calendar', async (req, res) => {
  // Always respond 200 immediately (Google requires fast response)
  res.sendStatus(200);

  const channelId = req.headers['x-goog-channel-id'];
  const resourceState = req.headers['x-goog-resource-state'];

  if (!channelId) return;

  // "sync" is the initial verification ping — no action needed
  if (resourceState === 'sync') {
    console.log(`Calendar webhook: sync ping for channel ${channelId}`);
    return;
  }

  // Only process "exists" (something changed)
  if (resourceState !== 'exists') return;

  try {
    const pair = getSyncPairByChannelId(channelId);
    if (!pair) {
      console.warn(`Calendar webhook: no sync pair found for channel ${channelId}`);
      return;
    }

    if (!pair.is_active) {
      console.log(`Calendar webhook: pair ${pair.id} is paused, ignoring`);
      return;
    }

    // Determine which calendar triggered the webhook
    const sourceCalNum = pair.channel1_id === channelId ? 1 : 2;

    // Re-fetch pair to get latest sync tokens
    const freshPair = getSyncPair(pair.id);
    if (!freshPair) return;

    console.log(`Calendar webhook: processing changes for pair ${freshPair.id} calendar ${sourceCalNum}`);
    await incrementalSync(freshPair, sourceCalNum);
  } catch (err) {
    console.error(`Calendar webhook error for channel ${channelId}:`, err.message);
  }
});

export default router;
