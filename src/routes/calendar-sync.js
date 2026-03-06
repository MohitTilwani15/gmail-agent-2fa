import { Router } from 'express';
import { requireDashboard } from '../middleware/auth.js';
import {
  createSyncPair,
  getSyncPair,
  getSyncPairsByUser,
  updateSyncPairCalendarIds,
  updateSyncPairActive,
  deleteSyncPair,
} from '../db/calendar-sync.js';
import { listCalendars, initialSync } from '../services/calendar.js';
import { setupChannelsForPair, stopChannelsForPair } from '../services/calendar-channels.js';
import { deleteSyncedEventsByPair, getSyncedEventsByPair } from '../db/calendar-sync.js';

const router = Router();

// Create a new sync pair
router.post('/', requireDashboard, (req, res) => {
  const { userId } = req.body;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: '"userId" is required' });
  }
  const pair = createSyncPair(userId);
  res.json(pair);
});

// List sync pairs for a user
router.get('/', requireDashboard, (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: '"userId" query parameter is required' });
  }
  const pairs = getSyncPairsByUser(userId);
  res.json(pairs);
});

// Get a specific sync pair
router.get('/:pairId', requireDashboard, (req, res) => {
  const pair = getSyncPair(req.params.pairId);
  if (!pair) {
    return res.status(404).json({ error: 'Sync pair not found' });
  }
  // Don't expose refresh tokens in response
  const { account1_token, account2_token, ...safe } = pair;
  res.json({
    ...safe,
    account1_connected: Boolean(account1_token),
    account2_connected: Boolean(account2_token),
  });
});

// Update calendar IDs for a sync pair
router.put('/:pairId', requireDashboard, (req, res) => {
  const { calendarId1, calendarId2 } = req.body;
  if (!calendarId1 || !calendarId2) {
    return res.status(400).json({ error: '"calendarId1" and "calendarId2" are required' });
  }
  const pair = getSyncPair(req.params.pairId);
  if (!pair) {
    return res.status(404).json({ error: 'Sync pair not found' });
  }
  const updated = updateSyncPairCalendarIds(pair.id, calendarId1, calendarId2);
  res.json(updated);
});

// List available calendars for an account in a sync pair
router.get('/:pairId/calendars/:accountNum', requireDashboard, async (req, res) => {
  const pair = getSyncPair(req.params.pairId);
  if (!pair) {
    return res.status(404).json({ error: 'Sync pair not found' });
  }
  const num = parseInt(req.params.accountNum, 10);
  if (num !== 1 && num !== 2) {
    return res.status(400).json({ error: 'accountNum must be 1 or 2' });
  }
  const token = num === 1 ? pair.account1_token : pair.account2_token;
  if (!token) {
    return res.status(400).json({ error: `Account ${num} is not connected yet` });
  }
  try {
    const calendars = await listCalendars(token);
    res.json(calendars);
  } catch (err) {
    console.error('Error listing calendars:', err.message);
    res.status(500).json({ error: 'Failed to list calendars' });
  }
});

// Activate sync (requires both accounts connected and calendar IDs set)
router.post('/:pairId/activate', requireDashboard, async (req, res) => {
  const pair = getSyncPair(req.params.pairId);
  if (!pair) {
    return res.status(404).json({ error: 'Sync pair not found' });
  }
  if (!pair.account1_token || !pair.account2_token) {
    return res.status(400).json({ error: 'Both accounts must be connected before activating' });
  }
  if (!pair.account1_cal_id || !pair.account2_cal_id) {
    return res.status(400).json({ error: 'Calendar IDs must be set before activating' });
  }

  try {
    updateSyncPairActive(pair.id, true);
    const updatedPair = getSyncPair(pair.id);

    // Set up push notification channels
    await setupChannelsForPair(updatedPair);

    // Run initial sync
    const freshPair = getSyncPair(pair.id);
    await initialSync(freshPair);

    res.json({ ...freshPair, is_active: 1, message: 'Sync activated and initial sync complete' });
  } catch (err) {
    console.error('Error activating sync:', err.message);
    updateSyncPairActive(pair.id, false);
    res.status(500).json({ error: 'Failed to activate sync' });
  }
});

// Pause sync
router.post('/:pairId/pause', requireDashboard, async (req, res) => {
  const pair = getSyncPair(req.params.pairId);
  if (!pair) {
    return res.status(404).json({ error: 'Sync pair not found' });
  }

  await stopChannelsForPair(pair);
  updateSyncPairActive(pair.id, false);

  res.json({ id: pair.id, is_active: 0, message: 'Sync paused' });
});

// Resume sync
router.post('/:pairId/resume', requireDashboard, async (req, res) => {
  const pair = getSyncPair(req.params.pairId);
  if (!pair) {
    return res.status(404).json({ error: 'Sync pair not found' });
  }
  if (!pair.account1_token || !pair.account2_token || !pair.account1_cal_id || !pair.account2_cal_id) {
    return res.status(400).json({ error: 'Both accounts and calendar IDs must be configured' });
  }

  try {
    updateSyncPairActive(pair.id, true);
    const updatedPair = getSyncPair(pair.id);
    await setupChannelsForPair(updatedPair);

    res.json({ id: pair.id, is_active: 1, message: 'Sync resumed' });
  } catch (err) {
    console.error('Error resuming sync:', err.message);
    updateSyncPairActive(pair.id, false);
    res.status(500).json({ error: 'Failed to resume sync' });
  }
});

// Delete sync pair
router.delete('/:pairId', requireDashboard, async (req, res) => {
  const pair = getSyncPair(req.params.pairId);
  if (!pair) {
    return res.status(404).json({ error: 'Sync pair not found' });
  }

  // Stop channels
  await stopChannelsForPair(pair);

  // Delete pair and all synced events
  deleteSyncPair(pair.id);

  res.json({ id: pair.id, deleted: true });
});

export default router;
