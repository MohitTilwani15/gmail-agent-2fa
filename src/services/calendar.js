import { google } from 'googleapis';
import { config } from '../config.js';
import {
  getSyncedEventBySource,
  getSyncedEventByMirror,
  createSyncedEvent,
  updateSyncedEvent,
  deleteSyncedEvent,
  updateSyncToken,
  getSyncPair,
  getSyncedEventsByPair,
} from '../db/calendar-sync.js';
import { runSerialized } from './sync-lock.js';

// Create an authenticated Google Calendar client from a refresh token
export function createCalendarClient(refreshToken) {
  const oauth2Client = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// List available calendars for an account
export async function listCalendars(refreshToken) {
  const calendar = createCalendarClient(refreshToken);
  const res = await calendar.calendarList.list();
  return res.data.items.map(cal => ({
    id: cal.id,
    summary: cal.summary,
    primary: cal.primary || false,
    accessRole: cal.accessRole,
  }));
}

// Get the start/end time from a Google Calendar event (handles both dateTime and date-only events)
function getEventTimes(event) {
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;
  return { start, end };
}

// Build the time object for creating/updating a mirror event
function buildTimeObj(timeStr) {
  // If it's a date-only string (YYYY-MM-DD), use date; otherwise use dateTime
  if (timeStr && timeStr.length === 10) {
    return { date: timeStr };
  }
  return { dateTime: timeStr, timeZone: 'UTC' };
}

// Simple delay helper for rate limiting
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Check if an event should be skipped — any event carrying our sync marker
// is one we created. We ignore the pair id on the marker on purpose: a mirror
// left over from a previous pair (e.g., user deleted pair A, then created
// pair B over the same calendars) must still be skipped rather than re-
// mirrored as a source event under the new pair.
function isMirrorEvent(event) {
  return Boolean(event.extendedProperties?.private?.calSyncPairId);
}

// Create a "Busy" mirror event on the target calendar
async function createMirrorEvent(calendarClient, calendarId, pairId, sourceEvent) {
  const { start, end } = getEventTimes(sourceEvent);

  const mirrorEvent = {
    summary: 'Busy',
    start: buildTimeObj(start),
    end: buildTimeObj(end),
    transparency: 'opaque', // Shows as "busy"
    visibility: 'private',
    extendedProperties: {
      private: {
        calSyncPairId: pairId,
        sourceEventId: sourceEvent.id,
      },
    },
  };

  const res = await calendarClient.events.insert({
    calendarId,
    requestBody: mirrorEvent,
  });

  return res.data;
}

// Update an existing mirror event's time
async function updateMirrorEvent(calendarClient, calendarId, mirrorEventId, sourceEvent) {
  const { start, end } = getEventTimes(sourceEvent);

  const res = await calendarClient.events.patch({
    calendarId,
    eventId: mirrorEventId,
    requestBody: {
      start: buildTimeObj(start),
      end: buildTimeObj(end),
    },
  });

  return res.data;
}

// Delete a mirror event
async function deleteMirrorEvent(calendarClient, calendarId, mirrorEventId) {
  try {
    await calendarClient.events.delete({
      calendarId,
      eventId: mirrorEventId,
    });
  } catch (err) {
    // 404/410 means already deleted — that's fine
    if (err.code !== 404 && err.code !== 410) {
      throw err;
    }
  }
}

// Process a single event change from the source calendar
async function processEventChange(event, pair, sourceCalNum, targetClient, targetCalId) {
  const pairId = pair.id;

  // Loop prevention layer 1: skip mirror events (extended properties)
  if (isMirrorEvent(event)) return;

  // Loop prevention layer 2: skip if this event ID is a known mirror
  const asMirror = getSyncedEventByMirror(pairId, event.id);
  if (asMirror) return;

  const existing = getSyncedEventBySource(pairId, event.id);

  if (event.status === 'cancelled') {
    // Event was deleted — remove mirror
    if (existing) {
      await deleteMirrorEvent(targetClient, targetCalId, existing.mirror_event_id);
      deleteSyncedEvent(existing.id);
    }
    return;
  }

  const { start, end } = getEventTimes(event);

  if (existing) {
    // Event was updated — update mirror times
    try {
      await updateMirrorEvent(targetClient, targetCalId, existing.mirror_event_id, event);
      updateSyncedEvent(existing.id, { sourceStart: start, sourceEnd: end });
    } catch (err) {
      if (err.code === 404 || err.code === 410) {
        // Mirror was deleted externally — recreate it
        const mirror = await createMirrorEvent(targetClient, targetCalId, pairId, event);
        updateSyncedEvent(existing.id, { sourceStart: start, sourceEnd: end, mirrorEventId: mirror.id });
      } else {
        throw err;
      }
    }
  } else {
    // New event — create mirror
    const mirror = await createMirrorEvent(targetClient, targetCalId, pairId, event);
    try {
      createSyncedEvent({
        pairId,
        sourceEventId: event.id,
        sourceCalendar: sourceCalNum,
        mirrorEventId: mirror.id,
        sourceStart: start,
        sourceEnd: end,
      });
    } catch (err) {
      // Defense in depth: if a concurrent run (different process, or a bug)
      // already inserted a mapping for this source event, drop the mirror we
      // just created so we don't leave a duplicate "Busy" on the target.
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        console.warn(`Duplicate mirror detected for pair ${pairId} source ${event.id} — removing freshly-created mirror ${mirror.id}`);
        await deleteMirrorEvent(targetClient, targetCalId, mirror.id);
        return;
      }
      throw err;
    }
  }
}

// Run incremental sync for one calendar in a pair
// sourceCalNum is 1 or 2 (which calendar triggered the webhook)
// Exported entry point: serializes per (pairId, sourceCalNum) so concurrent
// webhook deliveries can't race in processEventChange and create duplicate
// mirror events for the same source event.
export async function incrementalSync(pairOrId, sourceCalNum) {
  const pairId = typeof pairOrId === 'string' ? pairOrId : pairOrId.id;
  return runSerialized(`${pairId}:${sourceCalNum}`, async () => {
    // Refetch inside the lock so a coalesced follow-up picks up the sync
    // token the previous run just persisted.
    const pair = getSyncPair(pairId);
    if (!pair) return;
    await runIncrementalSync(pair, sourceCalNum);
  });
}

async function runIncrementalSync(pair, sourceCalNum) {
  const sourceToken = sourceCalNum === 1 ? pair.account1_token : pair.account2_token;
  const sourceCalId = sourceCalNum === 1 ? pair.account1_cal_id : pair.account2_cal_id;
  const targetToken = sourceCalNum === 1 ? pair.account2_token : pair.account1_token;
  const targetCalId = sourceCalNum === 1 ? pair.account2_cal_id : pair.account1_cal_id;
  const currentSyncToken = sourceCalNum === 1 ? pair.sync_token1 : pair.sync_token2;

  const sourceClient = createCalendarClient(sourceToken);
  const targetClient = createCalendarClient(targetToken);

  let pageToken;
  let newSyncToken;

  // If no sync token, establish one without processing existing events
  if (!currentSyncToken) {
    console.log(`No sync token for pair ${pair.id} cal ${sourceCalNum}, establishing token...`);
    let ptk;
    let token;
    do {
      const p = { calendarId: sourceCalId, singleEvents: true, showDeleted: false, timeMin: new Date().toISOString(), maxResults: 250 };
      if (ptk) p.pageToken = ptk;
      const r = await sourceClient.events.list(p);
      ptk = r.data.nextPageToken;
      token = r.data.nextSyncToken;
    } while (ptk);
    if (token) {
      updateSyncToken(pair.id, sourceCalNum, token);
      console.log(`Sync token established for pair ${pair.id} cal ${sourceCalNum}`);
    }
    return;
  }

  do {
    const params = {
      calendarId: sourceCalId,
      singleEvents: true,
      showDeleted: true,
    };

    if (currentSyncToken && !pageToken) {
      params.syncToken = currentSyncToken;
    }
    if (pageToken) {
      params.pageToken = pageToken;
    }

    let res;
    try {
      res = await sourceClient.events.list(params);
    } catch (err) {
      if (err.code === 410) {
        // Sync token expired — re-establish without full sync
        console.log(`Sync token expired for pair ${pair.id} cal ${sourceCalNum}, re-establishing...`);
        updateSyncToken(pair.id, sourceCalNum, null);
        return;
      }
      throw err;
    }

    const events = res.data.items || [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      try {
        await processEventChange(event, pair, sourceCalNum, targetClient, targetCalId);
        if ((i + 1) % 5 === 0) await delay(1000);
      } catch (err) {
        if (err.code === 429 || (err.message && err.message.includes('Rate Limit')) || (err.message && err.message.includes('Quota exceeded'))) {
          console.log(`Rate limited during incremental sync for pair ${pair.id}, pausing 15s...`);
          await delay(15000);
          i--; // Retry
          continue;
        }
        console.error(`Error processing event ${event.id} for pair ${pair.id}:`, err.message);
      }
    }

    pageToken = res.data.nextPageToken;
    newSyncToken = res.data.nextSyncToken;
  } while (pageToken);

  if (newSyncToken) {
    updateSyncToken(pair.id, sourceCalNum, newSyncToken);
  }
}

// Run full sync for one calendar direction (used on initial setup or when sync token expires)
export async function fullSync(pair, sourceCalNum) {
  const sourceToken = sourceCalNum === 1 ? pair.account1_token : pair.account2_token;
  const sourceCalId = sourceCalNum === 1 ? pair.account1_cal_id : pair.account2_cal_id;
  const targetToken = sourceCalNum === 1 ? pair.account2_token : pair.account1_token;
  const targetCalId = sourceCalNum === 1 ? pair.account2_cal_id : pair.account1_cal_id;

  const sourceClient = createCalendarClient(sourceToken);
  const targetClient = createCalendarClient(targetToken);

  let pageToken;
  let newSyncToken;

  do {
    const params = {
      calendarId: sourceCalId,
      singleEvents: true,
      showDeleted: false,
      timeMin: new Date().toISOString(),
      maxResults: 250,
    };
    if (pageToken) params.pageToken = pageToken;

    const res = await sourceClient.events.list(params);
    const events = res.data.items || [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      try {
        // Skip mirror events
        if (isMirrorEvent(event)) continue;
        if (getSyncedEventByMirror(pair.id, event.id)) continue;

        // Skip if already synced
        const existing = getSyncedEventBySource(pair.id, event.id);
        if (existing) continue;

        const { start, end } = getEventTimes(event);
        const mirror = await createMirrorEvent(targetClient, targetCalId, pair.id, event);
        createSyncedEvent({
          pairId: pair.id,
          sourceEventId: event.id,
          sourceCalendar: sourceCalNum,
          mirrorEventId: mirror.id,
          sourceStart: start,
          sourceEnd: end,
        });

        // Throttle: pause every 5 events to stay under rate limits
        if ((i + 1) % 5 === 0) {
          await delay(1000);
        }
      } catch (err) {
        if (err.code === 429 || (err.message && (err.message.includes('Rate Limit') || err.message.includes('Quota exceeded')))) {
          console.log(`Rate limited on pair ${pair.id}, pausing 15s...`);
          await delay(15000);
          i--; // Retry this event
          continue;
        }
        console.error(`Error syncing event ${event.id} for pair ${pair.id}:`, err.message);
      }
    }

    pageToken = res.data.nextPageToken;
    newSyncToken = res.data.nextSyncToken;
  } while (pageToken);

  if (newSyncToken) {
    updateSyncToken(pair.id, sourceCalNum, newSyncToken);
  }
}

// Run initial sync for both directions of a pair
export async function initialSync(pair) {
  console.log(`Running initial sync for pair ${pair.id}`);
  await fullSync(pair, 1);
  await fullSync(pair, 2);
  console.log(`Initial sync complete for pair ${pair.id}`);
}

// Iterate every mirror event this pair created on one calendar.
// If `keepSet` is provided, events whose id is in the set are preserved.
async function deleteMirrorsOnCalendar(client, calendarId, pairId, keepSet) {
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
        await delay(15000);
        continue;
      }
      throw err;
    }

    const events = res.data.items || [];
    found += events.length;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (keepSet && keepSet.has(ev.id)) continue;

      try {
        await client.events.delete({ calendarId, eventId: ev.id });
        deleted++;
      } catch (err) {
        if (err.code === 404 || err.code === 410) {
          deleted++;
        } else if (err.code === 429 || (err.message && (err.message.includes('Rate Limit') || err.message.includes('Quota exceeded')))) {
          await delay(15000);
          i--;
          continue;
        } else {
          failed++;
          console.error(`Failed to delete mirror ${ev.id} on ${calendarId}: ${err.message}`);
        }
      }

      if ((i + 1) % 3 === 0) await delay(1500);
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return { found, deleted, failed };
}

// Delete every mirror event we created for this pair from both calendars.
// Called when a pair is being deleted so reconnects don't see stacked "Busy" placeholders.
export async function removeAllMirrorsForPair(pair) {
  const results = { account1: null, account2: null };
  if (pair.account1_token && pair.account1_cal_id) {
    const c1 = createCalendarClient(pair.account1_token);
    results.account1 = await deleteMirrorsOnCalendar(c1, pair.account1_cal_id, pair.id, null);
  }
  if (pair.account2_token && pair.account2_cal_id) {
    const c2 = createCalendarClient(pair.account2_token);
    results.account2 = await deleteMirrorsOnCalendar(c2, pair.account2_cal_id, pair.id, null);
  }
  return results;
}

// Delete mirror events for this pair that are NOT tracked in the local DB.
// Cleans up orphans left behind by the historical duplicate-insert race (the
// newer mirror events whose DB rows were removed by the dedupe migration).
export async function removeOrphanMirrorsForPair(pair) {
  const tracked = new Set(getSyncedEventsByPair(pair.id).map(row => row.mirror_event_id));
  const results = { account1: null, account2: null };
  if (pair.account1_token && pair.account1_cal_id) {
    const c1 = createCalendarClient(pair.account1_token);
    results.account1 = await deleteMirrorsOnCalendar(c1, pair.account1_cal_id, pair.id, tracked);
  }
  if (pair.account2_token && pair.account2_cal_id) {
    const c2 = createCalendarClient(pair.account2_token);
    results.account2 = await deleteMirrorsOnCalendar(c2, pair.account2_cal_id, pair.id, tracked);
  }
  return results;
}
