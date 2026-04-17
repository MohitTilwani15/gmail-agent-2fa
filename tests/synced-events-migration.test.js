import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = resolve(__dirname, '../test-synced-migration.db');

// Exercises the synced_events dedupe + unique-index migration against a
// database that starts in the pre-fix shape (non-unique index, with dupes).
function createLegacySchema(db) {
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

function runMigration(db) {
  const dedupe = db.prepare(`
    DELETE FROM synced_events
    WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM synced_events GROUP BY pair_id, source_event_id
    )
  `).run();
  db.exec(`DROP INDEX IF EXISTS idx_synced_events_source`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_synced_events_source ON synced_events(pair_id, source_event_id)`);
  return dedupe.changes;
}

let db;

beforeEach(() => {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  createLegacySchema(db);
});

afterEach(() => {
  if (db) db.close();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

describe('synced_events migration', () => {
  it('removes duplicate (pair_id, source_event_id) rows keeping the oldest', () => {
    const insert = db.prepare(`
      INSERT INTO synced_events (id, pair_id, source_event_id, source_calendar, mirror_event_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run('r1', 'pair-1', 'evt-A', 1, 'mir-A-old');
    insert.run('r2', 'pair-1', 'evt-A', 1, 'mir-A-new');
    insert.run('r3', 'pair-1', 'evt-B', 1, 'mir-B-only');
    insert.run('r4', 'pair-1', 'evt-C', 1, 'mir-C-old');
    insert.run('r5', 'pair-1', 'evt-C', 1, 'mir-C-new');

    const removed = runMigration(db);
    expect(removed).toBe(2);

    const remaining = db.prepare('SELECT id FROM synced_events ORDER BY id').all().map(r => r.id);
    expect(remaining).toEqual(['r1', 'r3', 'r4']);
  });

  it('rejects duplicate inserts after the unique index is in place', () => {
    runMigration(db);

    const insert = db.prepare(`
      INSERT INTO synced_events (id, pair_id, source_event_id, source_calendar, mirror_event_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run('r1', 'pair-1', 'evt-A', 1, 'mir-A');

    let thrown;
    try {
      insert.run('r2', 'pair-1', 'evt-A', 1, 'mir-A-dup');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('SQLITE_CONSTRAINT_UNIQUE');

    // Same source_event_id on a different pair is still allowed.
    expect(() => insert.run('r3', 'pair-2', 'evt-A', 1, 'mir-A-other')).not.toThrow();
  });

  it('is idempotent — running twice on a clean DB is a no-op', () => {
    runMigration(db);
    const removed = runMigration(db);
    expect(removed).toBe(0);
  });
});
