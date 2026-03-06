import { getDb } from './init.js';
import { v4 as uuidv4 } from 'uuid';

// --- Sync Pair CRUD ---

export function createSyncPair(userId) {
  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO calendar_sync_pairs (id, user_id) VALUES (?, ?)').run(id, userId);
  return getSyncPair(id);
}

export function getSyncPair(pairId) {
  const db = getDb();
  return db.prepare('SELECT * FROM calendar_sync_pairs WHERE id = ?').get(pairId) || null;
}

export function getSyncPairsByUser(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM calendar_sync_pairs WHERE user_id = ?').all(userId);
}

export function getAllActiveSyncPairs() {
  const db = getDb();
  return db.prepare('SELECT * FROM calendar_sync_pairs WHERE is_active = 1').all();
}

export function updateSyncPairAccount(pairId, accountNum, refreshToken, email) {
  const db = getDb();
  if (accountNum === 1) {
    db.prepare('UPDATE calendar_sync_pairs SET account1_token = ?, account1_email = ? WHERE id = ?').run(refreshToken, email, pairId);
  } else {
    db.prepare('UPDATE calendar_sync_pairs SET account2_token = ?, account2_email = ? WHERE id = ?').run(refreshToken, email, pairId);
  }
  return getSyncPair(pairId);
}

export function updateSyncPairCalendarIds(pairId, calId1, calId2) {
  const db = getDb();
  db.prepare('UPDATE calendar_sync_pairs SET account1_cal_id = ?, account2_cal_id = ? WHERE id = ?').run(calId1, calId2, pairId);
  return getSyncPair(pairId);
}

export function updateSyncPairActive(pairId, isActive) {
  const db = getDb();
  db.prepare('UPDATE calendar_sync_pairs SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, pairId);
  return getSyncPair(pairId);
}

export function updateSyncPairChannel(pairId, accountNum, channelId, expiry) {
  const db = getDb();
  if (accountNum === 1) {
    db.prepare('UPDATE calendar_sync_pairs SET channel1_id = ?, channel1_expiry = ? WHERE id = ?').run(channelId, expiry, pairId);
  } else {
    db.prepare('UPDATE calendar_sync_pairs SET channel2_id = ?, channel2_expiry = ? WHERE id = ?').run(channelId, expiry, pairId);
  }
  return getSyncPair(pairId);
}

export function updateSyncToken(pairId, accountNum, syncToken) {
  const db = getDb();
  if (accountNum === 1) {
    db.prepare('UPDATE calendar_sync_pairs SET sync_token1 = ? WHERE id = ?').run(syncToken, pairId);
  } else {
    db.prepare('UPDATE calendar_sync_pairs SET sync_token2 = ? WHERE id = ?').run(syncToken, pairId);
  }
}

export function deleteSyncPair(pairId) {
  const db = getDb();
  db.prepare('DELETE FROM synced_events WHERE pair_id = ?').run(pairId);
  db.prepare('DELETE FROM calendar_sync_pairs WHERE id = ?').run(pairId);
}

export function getExpiringChannels(withinMs) {
  const db = getDb();
  const cutoff = new Date(Date.now() + withinMs).toISOString();
  return db.prepare(`
    SELECT * FROM calendar_sync_pairs
    WHERE is_active = 1
    AND (
      (channel1_expiry IS NOT NULL AND channel1_expiry < ?)
      OR (channel2_expiry IS NOT NULL AND channel2_expiry < ?)
    )
  `).all(cutoff, cutoff);
}

// Find sync pair by channel ID (for webhook routing)
export function getSyncPairByChannelId(channelId) {
  const db = getDb();
  return db.prepare('SELECT * FROM calendar_sync_pairs WHERE channel1_id = ? OR channel2_id = ?').get(channelId, channelId) || null;
}

// --- Synced Events CRUD ---

export function createSyncedEvent({ pairId, sourceEventId, sourceCalendar, mirrorEventId, sourceStart, sourceEnd }) {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO synced_events (id, pair_id, source_event_id, source_calendar, mirror_event_id, source_start, source_end)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, pairId, sourceEventId, sourceCalendar, mirrorEventId, sourceStart, sourceEnd);
  return { id, pairId, sourceEventId, sourceCalendar, mirrorEventId, sourceStart, sourceEnd };
}

export function getSyncedEventBySource(pairId, sourceEventId) {
  const db = getDb();
  return db.prepare('SELECT * FROM synced_events WHERE pair_id = ? AND source_event_id = ?').get(pairId, sourceEventId) || null;
}

export function getSyncedEventByMirror(pairId, mirrorEventId) {
  const db = getDb();
  return db.prepare('SELECT * FROM synced_events WHERE pair_id = ? AND mirror_event_id = ?').get(pairId, mirrorEventId) || null;
}

export function updateSyncedEvent(id, { sourceStart, sourceEnd, mirrorEventId }) {
  const db = getDb();
  if (mirrorEventId !== undefined) {
    db.prepare('UPDATE synced_events SET source_start = ?, source_end = ?, mirror_event_id = ? WHERE id = ?').run(sourceStart, sourceEnd, mirrorEventId, id);
  } else {
    db.prepare('UPDATE synced_events SET source_start = ?, source_end = ? WHERE id = ?').run(sourceStart, sourceEnd, id);
  }
}

export function deleteSyncedEvent(id) {
  const db = getDb();
  db.prepare('DELETE FROM synced_events WHERE id = ?').run(id);
}

export function deleteSyncedEventsByPair(pairId) {
  const db = getDb();
  db.prepare('DELETE FROM synced_events WHERE pair_id = ?').run(pairId);
}

export function getSyncedEventsByPair(pairId) {
  const db = getDb();
  return db.prepare('SELECT * FROM synced_events WHERE pair_id = ?').all(pairId);
}
