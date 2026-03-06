import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = resolve(__dirname, '../test-calendar.db');

let db;

function setupDb() {
  db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_sync_pairs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account1_email TEXT,
      account1_token TEXT,
      account1_cal_id TEXT,
      account2_email TEXT,
      account2_token TEXT,
      account2_cal_id TEXT,
      is_active INTEGER DEFAULT 0,
      channel1_id TEXT,
      channel1_expiry TEXT,
      channel2_id TEXT,
      channel2_expiry TEXT,
      sync_token1 TEXT,
      sync_token2 TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS synced_events (
      id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      source_calendar INTEGER NOT NULL,
      mirror_event_id TEXT NOT NULL,
      source_start TEXT,
      source_end TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_synced_events_source ON synced_events(pair_id, source_event_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_synced_events_mirror ON synced_events(pair_id, mirror_event_id)`);
}

function teardownDb() {
  if (db) db.close();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
}

// --- Helpers (mirrors calendar-sync.js logic) ---

function createSyncPair(userId) {
  const id = `pair-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO calendar_sync_pairs (id, user_id) VALUES (?, ?)').run(id, userId);
  return getSyncPair(id);
}

function getSyncPair(pairId) {
  return db.prepare('SELECT * FROM calendar_sync_pairs WHERE id = ?').get(pairId) || null;
}

function getSyncPairsByUser(userId) {
  return db.prepare('SELECT * FROM calendar_sync_pairs WHERE user_id = ?').all(userId);
}

function getAllActiveSyncPairs() {
  return db.prepare('SELECT * FROM calendar_sync_pairs WHERE is_active = 1').all();
}

function updateSyncPairAccount(pairId, accountNum, refreshToken, email) {
  if (accountNum === 1) {
    db.prepare('UPDATE calendar_sync_pairs SET account1_token = ?, account1_email = ? WHERE id = ?').run(refreshToken, email, pairId);
  } else {
    db.prepare('UPDATE calendar_sync_pairs SET account2_token = ?, account2_email = ? WHERE id = ?').run(refreshToken, email, pairId);
  }
  return getSyncPair(pairId);
}

function updateSyncPairCalendarIds(pairId, calId1, calId2) {
  db.prepare('UPDATE calendar_sync_pairs SET account1_cal_id = ?, account2_cal_id = ? WHERE id = ?').run(calId1, calId2, pairId);
  return getSyncPair(pairId);
}

function updateSyncPairActive(pairId, isActive) {
  db.prepare('UPDATE calendar_sync_pairs SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, pairId);
  return getSyncPair(pairId);
}

function updateSyncPairChannel(pairId, accountNum, channelId, expiry) {
  if (accountNum === 1) {
    db.prepare('UPDATE calendar_sync_pairs SET channel1_id = ?, channel1_expiry = ? WHERE id = ?').run(channelId, expiry, pairId);
  } else {
    db.prepare('UPDATE calendar_sync_pairs SET channel2_id = ?, channel2_expiry = ? WHERE id = ?').run(channelId, expiry, pairId);
  }
}

function updateSyncToken(pairId, accountNum, syncToken) {
  if (accountNum === 1) {
    db.prepare('UPDATE calendar_sync_pairs SET sync_token1 = ? WHERE id = ?').run(syncToken, pairId);
  } else {
    db.prepare('UPDATE calendar_sync_pairs SET sync_token2 = ? WHERE id = ?').run(syncToken, pairId);
  }
}

function deleteSyncPair(pairId) {
  db.prepare('DELETE FROM synced_events WHERE pair_id = ?').run(pairId);
  db.prepare('DELETE FROM calendar_sync_pairs WHERE id = ?').run(pairId);
}

function getSyncPairByChannelId(channelId) {
  return db.prepare('SELECT * FROM calendar_sync_pairs WHERE channel1_id = ? OR channel2_id = ?').get(channelId, channelId) || null;
}

function getExpiringChannels(withinMs) {
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

function createSyncedEvent({ pairId, sourceEventId, sourceCalendar, mirrorEventId, sourceStart, sourceEnd }) {
  const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO synced_events (id, pair_id, source_event_id, source_calendar, mirror_event_id, source_start, source_end)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, pairId, sourceEventId, sourceCalendar, mirrorEventId, sourceStart, sourceEnd);
  return { id, pairId, sourceEventId, sourceCalendar, mirrorEventId, sourceStart, sourceEnd };
}

function getSyncedEventBySource(pairId, sourceEventId) {
  return db.prepare('SELECT * FROM synced_events WHERE pair_id = ? AND source_event_id = ?').get(pairId, sourceEventId) || null;
}

function getSyncedEventByMirror(pairId, mirrorEventId) {
  return db.prepare('SELECT * FROM synced_events WHERE pair_id = ? AND mirror_event_id = ?').get(pairId, mirrorEventId) || null;
}

function deleteSyncedEvent(id) {
  db.prepare('DELETE FROM synced_events WHERE id = ?').run(id);
}

function getSyncedEventsByPair(pairId) {
  return db.prepare('SELECT * FROM synced_events WHERE pair_id = ?').all(pairId);
}

// --- Tests ---

describe('calendar_sync_pairs table', () => {
  beforeEach(() => setupDb());
  afterEach(() => teardownDb());

  it('should create and retrieve a sync pair', () => {
    const pair = createSyncPair('alice');
    expect(pair.user_id).toBe('alice');
    expect(pair.is_active).toBe(0);
    expect(pair.account1_email).toBeNull();
    expect(pair.account2_email).toBeNull();
    expect(pair.created_at).toBeTruthy();
  });

  it('should list sync pairs by user', () => {
    createSyncPair('alice');
    createSyncPair('alice');
    createSyncPair('bob');
    expect(getSyncPairsByUser('alice')).toHaveLength(2);
    expect(getSyncPairsByUser('bob')).toHaveLength(1);
  });

  it('should update account 1 credentials', () => {
    const pair = createSyncPair('alice');
    const updated = updateSyncPairAccount(pair.id, 1, 'refresh-1', 'alice@gmail.com');
    expect(updated.account1_token).toBe('refresh-1');
    expect(updated.account1_email).toBe('alice@gmail.com');
    expect(updated.account2_token).toBeNull();
  });

  it('should update account 2 credentials', () => {
    const pair = createSyncPair('alice');
    const updated = updateSyncPairAccount(pair.id, 2, 'refresh-2', 'alice@work.com');
    expect(updated.account2_token).toBe('refresh-2');
    expect(updated.account2_email).toBe('alice@work.com');
    expect(updated.account1_token).toBeNull();
  });

  it('should update calendar IDs', () => {
    const pair = createSyncPair('alice');
    const updated = updateSyncPairCalendarIds(pair.id, 'cal-personal', 'cal-work');
    expect(updated.account1_cal_id).toBe('cal-personal');
    expect(updated.account2_cal_id).toBe('cal-work');
  });

  it('should toggle active state', () => {
    const pair = createSyncPair('alice');
    expect(pair.is_active).toBe(0);

    const active = updateSyncPairActive(pair.id, true);
    expect(active.is_active).toBe(1);

    const paused = updateSyncPairActive(pair.id, false);
    expect(paused.is_active).toBe(0);
  });

  it('should get all active sync pairs', () => {
    const p1 = createSyncPair('alice');
    const p2 = createSyncPair('bob');
    createSyncPair('charlie');

    updateSyncPairActive(p1.id, true);
    updateSyncPairActive(p2.id, true);

    const active = getAllActiveSyncPairs();
    expect(active).toHaveLength(2);
  });

  it('should update channel info', () => {
    const pair = createSyncPair('alice');
    updateSyncPairChannel(pair.id, 1, 'ch-1', '2026-03-07T00:00:00Z');
    updateSyncPairChannel(pair.id, 2, 'ch-2', '2026-03-07T12:00:00Z');

    const updated = getSyncPair(pair.id);
    expect(updated.channel1_id).toBe('ch-1');
    expect(updated.channel1_expiry).toBe('2026-03-07T00:00:00Z');
    expect(updated.channel2_id).toBe('ch-2');
    expect(updated.channel2_expiry).toBe('2026-03-07T12:00:00Z');
  });

  it('should find sync pair by channel ID', () => {
    const pair = createSyncPair('alice');
    updateSyncPairChannel(pair.id, 1, 'ch-abc', '2026-03-07T00:00:00Z');

    const found = getSyncPairByChannelId('ch-abc');
    expect(found.id).toBe(pair.id);

    expect(getSyncPairByChannelId('nonexistent')).toBeNull();
  });

  it('should update sync tokens', () => {
    const pair = createSyncPair('alice');
    updateSyncToken(pair.id, 1, 'token-a');
    updateSyncToken(pair.id, 2, 'token-b');

    const updated = getSyncPair(pair.id);
    expect(updated.sync_token1).toBe('token-a');
    expect(updated.sync_token2).toBe('token-b');
  });

  it('should find expiring channels', () => {
    const pair = createSyncPair('alice');
    updateSyncPairActive(pair.id, true);
    // Set expiry to 1 hour from now (within 2-hour window)
    const soonExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    updateSyncPairChannel(pair.id, 1, 'ch-1', soonExpiry);

    const expiring = getExpiringChannels(2 * 60 * 60 * 1000);
    expect(expiring).toHaveLength(1);

    // Far future expiry should not be found
    const pair2 = createSyncPair('bob');
    updateSyncPairActive(pair2.id, true);
    const farExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    updateSyncPairChannel(pair2.id, 1, 'ch-2', farExpiry);

    const stillExpiring = getExpiringChannels(2 * 60 * 60 * 1000);
    expect(stillExpiring).toHaveLength(1); // Only alice's pair
  });

  it('should delete sync pair and its events', () => {
    const pair = createSyncPair('alice');
    createSyncedEvent({
      pairId: pair.id,
      sourceEventId: 'src-1',
      sourceCalendar: 1,
      mirrorEventId: 'mir-1',
      sourceStart: '2026-03-06T10:00:00Z',
      sourceEnd: '2026-03-06T11:00:00Z',
    });

    deleteSyncPair(pair.id);
    expect(getSyncPair(pair.id)).toBeNull();
    expect(getSyncedEventsByPair(pair.id)).toHaveLength(0);
  });

  it('should return null for non-existent pair', () => {
    expect(getSyncPair('nonexistent')).toBeNull();
  });
});

describe('synced_events table', () => {
  beforeEach(() => setupDb());
  afterEach(() => teardownDb());

  it('should create and retrieve a synced event by source', () => {
    const pair = createSyncPair('alice');
    const evt = createSyncedEvent({
      pairId: pair.id,
      sourceEventId: 'src-1',
      sourceCalendar: 1,
      mirrorEventId: 'mir-1',
      sourceStart: '2026-03-06T10:00:00Z',
      sourceEnd: '2026-03-06T11:00:00Z',
    });

    expect(evt.sourceEventId).toBe('src-1');
    expect(evt.mirrorEventId).toBe('mir-1');

    const found = getSyncedEventBySource(pair.id, 'src-1');
    expect(found).not.toBeNull();
    expect(found.mirror_event_id).toBe('mir-1');
  });

  it('should retrieve a synced event by mirror ID', () => {
    const pair = createSyncPair('alice');
    createSyncedEvent({
      pairId: pair.id,
      sourceEventId: 'src-1',
      sourceCalendar: 1,
      mirrorEventId: 'mir-1',
      sourceStart: '2026-03-06T10:00:00Z',
      sourceEnd: '2026-03-06T11:00:00Z',
    });

    const found = getSyncedEventByMirror(pair.id, 'mir-1');
    expect(found).not.toBeNull();
    expect(found.source_event_id).toBe('src-1');
  });

  it('should return null for non-existent events', () => {
    const pair = createSyncPair('alice');
    expect(getSyncedEventBySource(pair.id, 'nope')).toBeNull();
    expect(getSyncedEventByMirror(pair.id, 'nope')).toBeNull();
  });

  it('should delete a synced event', () => {
    const pair = createSyncPair('alice');
    const evt = createSyncedEvent({
      pairId: pair.id,
      sourceEventId: 'src-1',
      sourceCalendar: 1,
      mirrorEventId: 'mir-1',
      sourceStart: '2026-03-06T10:00:00Z',
      sourceEnd: '2026-03-06T11:00:00Z',
    });

    deleteSyncedEvent(evt.id);
    expect(getSyncedEventBySource(pair.id, 'src-1')).toBeNull();
  });

  it('should list all synced events for a pair', () => {
    const pair = createSyncPair('alice');
    createSyncedEvent({
      pairId: pair.id,
      sourceEventId: 'src-1',
      sourceCalendar: 1,
      mirrorEventId: 'mir-1',
      sourceStart: '2026-03-06T10:00:00Z',
      sourceEnd: '2026-03-06T11:00:00Z',
    });
    createSyncedEvent({
      pairId: pair.id,
      sourceEventId: 'src-2',
      sourceCalendar: 2,
      mirrorEventId: 'mir-2',
      sourceStart: '2026-03-06T12:00:00Z',
      sourceEnd: '2026-03-06T13:00:00Z',
    });

    const events = getSyncedEventsByPair(pair.id);
    expect(events).toHaveLength(2);
  });

  it('should isolate events between different pairs', () => {
    const pair1 = createSyncPair('alice');
    const pair2 = createSyncPair('bob');

    createSyncedEvent({
      pairId: pair1.id,
      sourceEventId: 'src-1',
      sourceCalendar: 1,
      mirrorEventId: 'mir-1',
      sourceStart: '2026-03-06T10:00:00Z',
      sourceEnd: '2026-03-06T11:00:00Z',
    });

    expect(getSyncedEventsByPair(pair1.id)).toHaveLength(1);
    expect(getSyncedEventsByPair(pair2.id)).toHaveLength(0);
    expect(getSyncedEventBySource(pair2.id, 'src-1')).toBeNull();
  });
});
