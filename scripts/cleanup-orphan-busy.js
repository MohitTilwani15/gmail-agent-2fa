import { google } from 'googleapis';
import Database from 'better-sqlite3';
import 'dotenv/config';

const db = new Database(process.env.DB_PATH || './data/data.db');
const pairId = process.argv[2];

if (!pairId) {
  console.error('Usage: node scripts/cleanup-orphan-busy.js <pairId>');
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

async function findAndDeleteBusyEvents(client, calendarId, label) {
  console.log(`\nScanning ${label} (${calendarId})...`);
  let pageToken;
  let found = 0;
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
        console.log('Rate limited on list, waiting 30s...');
        await delay(30000);
        continue;
      }
      throw err;
    }

    const events = res.data.items || [];
    found += events.length;
    console.log(`  Found ${events.length} events in this page (total: ${found})`);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
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
            console.log(`  Rate limited, waiting ${wait / 1000}s (retry ${retries}/5)...`);
            await delay(wait);
          } else {
            console.error(`  Failed: ${ev.id}: ${err.message}`);
            failed++;
            break;
          }
        }
      }
      if (retries >= 5) {
        console.error(`  Gave up on ${ev.id} after 5 retries`);
        failed++;
      }

      // Throttle every 3 deletes
      if ((i + 1) % 3 === 0) {
        await delay(1500);
      }
    }

    process.stdout.write(`  Progress: ${deleted} deleted, ${failed} failed\n`);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`${label}: ${found} found, ${deleted} deleted, ${failed} failed`);
  return { found, deleted, failed };
}

console.log('Waiting 30s for quota to recover before starting...');
await delay(30000);

const cal1Client = createCalClient(pair.account1_token);
const cal2Client = createCalClient(pair.account2_token);

const r1 = await findAndDeleteBusyEvents(cal1Client, pair.account1_cal_id, 'Account 1');
console.log('\nWaiting 30s before scanning Account 2...');
await delay(30000);
const r2 = await findAndDeleteBusyEvents(cal2Client, pair.account2_cal_id, 'Account 2');

console.log(`\nDone. Total: ${r1.found + r2.found} found, ${r1.deleted + r2.deleted} deleted, ${r1.failed + r2.failed} failed`);
