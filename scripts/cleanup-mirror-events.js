import Database from 'better-sqlite3';
import { google } from 'googleapis';
import 'dotenv/config';

const db = new Database(process.env.DB_PATH || './data/data.db');
const pairId = process.argv[2];

if (!pairId) {
  console.error('Usage: node scripts/cleanup-mirror-events.js <pairId>');
  process.exit(1);
}

const pair = db.prepare('SELECT * FROM calendar_sync_pairs WHERE id = ?').get(pairId);
if (!pair) {
  console.error('Sync pair not found:', pairId);
  process.exit(1);
}

function createCalClient(refreshToken) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const events = db.prepare('SELECT * FROM synced_events WHERE pair_id = ?').all(pairId);
console.log(`Found ${events.length} mirror events to delete`);

const cal1Client = createCalClient(pair.account1_token);
const cal2Client = createCalClient(pair.account2_token);

let deleted = 0;
let failed = 0;

for (let i = 0; i < events.length; i++) {
  const ev = events[i];
  // source_calendar=1 means source was account1, mirror is on account2
  const client = ev.source_calendar === 1 ? cal2Client : cal1Client;
  const calId = ev.source_calendar === 1 ? pair.account2_cal_id : pair.account1_cal_id;

  try {
    await client.events.delete({ calendarId: calId, eventId: ev.mirror_event_id });
    deleted++;
  } catch (err) {
    if (err.code === 404 || err.code === 410) {
      deleted++; // Already gone
    } else if (err.code === 429 || (err.message && err.message.includes('Rate Limit'))) {
      console.log(`Rate limited at ${i}/${events.length}, waiting 15s...`);
      await delay(15000);
      i--; // Retry
      continue;
    } else {
      failed++;
      console.error(`Failed to delete mirror ${ev.mirror_event_id}:`, err.message);
    }
  }

  // Throttle: pause every 4 deletes
  if ((i + 1) % 4 === 0) {
    process.stdout.write(`\r  Deleted ${deleted}/${events.length}...`);
    await delay(1000);
  }
}

console.log(`\nDeleted ${deleted} mirror events (${failed} failures)`);

// Clear DB records
db.prepare('DELETE FROM synced_events WHERE pair_id = ?').run(pairId);
// Reset sync tokens so next activation starts fresh
db.prepare('UPDATE calendar_sync_pairs SET sync_token1 = NULL, sync_token2 = NULL WHERE id = ?').run(pairId);
console.log('Cleared synced_events and reset sync tokens in DB');
