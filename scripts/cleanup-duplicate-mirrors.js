// Removes orphan mirror events left behind by the historical duplicate-insert
// race. For each sync pair, compares events carrying this pair's calSyncPairId
// marker in each calendar against the set of mirror_event_ids tracked in the
// local DB, and deletes any that aren't tracked.
//
// Safe to run multiple times. Safe to run against a DB that has not yet gone
// through the dedupe migration — in that case, both duplicates are "tracked"
// and nothing is deleted.
//
// Usage:
//   node scripts/cleanup-duplicate-mirrors.js           # all pairs
//   node scripts/cleanup-duplicate-mirrors.js <pairId>  # one pair

import { google } from 'googleapis';
import Database from 'better-sqlite3';
import 'dotenv/config';

const db = new Database(process.env.DB_PATH || './data/data.db');
const targetPairId = process.argv[2];

const pairs = targetPairId
  ? [db.prepare('SELECT * FROM calendar_sync_pairs WHERE id = ?').get(targetPairId)].filter(Boolean)
  : db.prepare('SELECT * FROM calendar_sync_pairs').all();

if (pairs.length === 0) {
  console.error(targetPairId ? `No sync pair with id ${targetPairId}` : 'No sync pairs found');
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

async function cleanupCalendar(client, calendarId, pairId, keepSet, label) {
  console.log(`\n${label} (${calendarId}) — tracked mirrors: ${keepSet.size}`);
  let pageToken;
  let scanned = 0;
  let orphans = 0;
  let deleted = 0;
  let failed = 0;

  do {
    const params = {
      calendarId,
      privateExtendedProperty: `calSyncPairId=${pairId}`,
      maxResults: 100,
      showDeleted: false,
    };
    if (pageToken) params.pageToken = pageToken;

    let res;
    try {
      res = await client.events.list(params);
    } catch (err) {
      if (err.code === 429 || (err.message && (err.message.includes('Rate Limit') || err.message.includes('Quota exceeded')))) {
        console.log('  Rate limited on list — waiting 30s');
        await delay(30000);
        continue;
      }
      throw err;
    }

    const events = res.data.items || [];
    scanned += events.length;
    const toDelete = events.filter(ev => !keepSet.has(ev.id));
    orphans += toDelete.length;
    console.log(`  Page: scanned ${events.length}, orphans ${toDelete.length} (running totals: ${scanned}/${orphans})`);

    for (let i = 0; i < toDelete.length; i++) {
      const ev = toDelete[i];
      let retries = 0;
      while (retries < 5) {
        try {
          await client.events.delete({ calendarId, eventId: ev.id });
          deleted++;
          break;
        } catch (err) {
          if (err.code === 404 || err.code === 410) {
            deleted++;
            break;
          }
          if (err.code === 429 || (err.message && (err.message.includes('Rate Limit') || err.message.includes('Quota exceeded')))) {
            retries++;
            const wait = 15000 * retries;
            console.log(`  Rate limited — waiting ${wait / 1000}s (retry ${retries}/5)`);
            await delay(wait);
          } else {
            console.error(`  Failed ${ev.id}: ${err.message}`);
            failed++;
            break;
          }
        }
      }
      if (retries >= 5) {
        console.error(`  Gave up on ${ev.id} after 5 retries`);
        failed++;
      }
      if ((i + 1) % 3 === 0) await delay(1500);
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`  ${label}: scanned ${scanned}, orphans ${orphans}, deleted ${deleted}, failed ${failed}`);
  return { scanned, orphans, deleted, failed };
}

const grand = { scanned: 0, orphans: 0, deleted: 0, failed: 0 };

for (const pair of pairs) {
  console.log(`\n=== Pair ${pair.id} (${pair.account1_email || '?'} <-> ${pair.account2_email || '?'}) ===`);

  if (!pair.account1_token || !pair.account2_token || !pair.account1_cal_id || !pair.account2_cal_id) {
    console.log('  Skipping — pair not fully configured');
    continue;
  }

  const rows = db.prepare('SELECT mirror_event_id FROM synced_events WHERE pair_id = ?').all(pair.id);
  const keepSet = new Set(rows.map(r => r.mirror_event_id));

  const c1 = createCalClient(pair.account1_token);
  const c2 = createCalClient(pair.account2_token);

  const r1 = await cleanupCalendar(c1, pair.account1_cal_id, pair.id, keepSet, 'Account 1');
  console.log('\n  Waiting 15s before scanning Account 2...');
  await delay(15000);
  const r2 = await cleanupCalendar(c2, pair.account2_cal_id, pair.id, keepSet, 'Account 2');

  grand.scanned += r1.scanned + r2.scanned;
  grand.orphans += r1.orphans + r2.orphans;
  grand.deleted += r1.deleted + r2.deleted;
  grand.failed += r1.failed + r2.failed;
}

console.log(`\n=== Total: scanned ${grand.scanned}, orphans ${grand.orphans}, deleted ${grand.deleted}, failed ${grand.failed} ===`);
