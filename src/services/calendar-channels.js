import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { createCalendarClient } from './calendar.js';
import {
  updateSyncPairChannel,
  getAllActiveSyncPairs,
  getExpiringChannels,
  getSyncPair,
} from '../db/calendar-sync.js';

// Set up a push notification channel for one calendar in a sync pair
export async function setupChannel(pair, accountNum) {
  const token = accountNum === 1 ? pair.account1_token : pair.account2_token;
  const calId = accountNum === 1 ? pair.account1_cal_id : pair.account2_cal_id;

  const calendar = createCalendarClient(token);
  const channelId = uuidv4();

  const res = await calendar.events.watch({
    calendarId: calId,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: `${config.calendar.webhookUrl}/webhook/calendar`,
      // Channel expires in ~7 days (Google's max)
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  const expiry = new Date(parseInt(res.data.expiration)).toISOString();
  updateSyncPairChannel(pair.id, accountNum, channelId, expiry);

  console.log(`Channel set up for pair ${pair.id} account ${accountNum}: ${channelId} (expires ${expiry})`);
  return { channelId, expiry };
}

// Set up channels for both calendars in a sync pair
export async function setupChannelsForPair(pair) {
  await setupChannel(pair, 1);
  await setupChannel(pair, 2);
}

// Stop a push notification channel
export async function stopChannel(refreshToken, channelId, resourceId) {
  if (!channelId) return;
  const calendar = createCalendarClient(refreshToken);
  try {
    await calendar.channels.stop({
      requestBody: {
        id: channelId,
        resourceId,
      },
    });
  } catch (err) {
    // 404 means channel already expired or doesn't exist
    if (err.code !== 404) {
      console.error(`Failed to stop channel ${channelId}:`, err.message);
    }
  }
}

// Stop all channels for a sync pair
export async function stopChannelsForPair(pair) {
  // We don't have resourceId stored, so we just let them expire.
  // Alternatively, we clear the channel references so webhooks are ignored.
  updateSyncPairChannel(pair.id, 1, null, null);
  updateSyncPairChannel(pair.id, 2, null, null);
}

// Renew channels that are expiring soon
export async function renewExpiringChannels() {
  // Renew channels expiring within 2 hours
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const expiring = getExpiringChannels(twoHoursMs);

  for (const pair of expiring) {
    try {
      const now = new Date();

      if (pair.channel1_expiry && new Date(pair.channel1_expiry) < new Date(now.getTime() + twoHoursMs)) {
        console.log(`Renewing channel for pair ${pair.id} account 1`);
        const freshPair = getSyncPair(pair.id);
        if (freshPair && freshPair.is_active) {
          await setupChannel(freshPair, 1);
        }
      }

      if (pair.channel2_expiry && new Date(pair.channel2_expiry) < new Date(now.getTime() + twoHoursMs)) {
        console.log(`Renewing channel for pair ${pair.id} account 2`);
        const freshPair = getSyncPair(pair.id);
        if (freshPair && freshPair.is_active) {
          await setupChannel(freshPair, 2);
        }
      }
    } catch (err) {
      console.error(`Error renewing channels for pair ${pair.id}:`, err.message);
    }
  }
}

// Set up channels for all active sync pairs (called at startup)
export async function registerAllCalendarChannels() {
  const pairs = getAllActiveSyncPairs();
  for (const pair of pairs) {
    try {
      await setupChannelsForPair(pair);
    } catch (err) {
      console.error(`Failed to set up channels for pair ${pair.id}:`, err.message);
    }
  }
  if (pairs.length > 0) {
    console.log(`Registered calendar channels for ${pairs.length} active sync pair(s)`);
  }
}
