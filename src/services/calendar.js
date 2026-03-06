import { google } from 'googleapis';
import { config } from '../config.js';
import {
  getSyncedEventBySource,
  getSyncedEventByMirror,
  createSyncedEvent,
  updateSyncedEvent,
  deleteSyncedEvent,
  updateSyncToken,
} from '../db/calendar-sync.js';

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

// Check if an event should be skipped (is a mirror event we created)
function isMirrorEvent(event, pairId) {
  // Layer 1: Check extended properties
  const syncPairId = event.extendedProperties?.private?.calSyncPairId;
  if (syncPairId === pairId) return true;
  return false;
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
  if (isMirrorEvent(event, pairId)) return;

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
    createSyncedEvent({
      pairId,
      sourceEventId: event.id,
      sourceCalendar: sourceCalNum,
      mirrorEventId: mirror.id,
      sourceStart: start,
      sourceEnd: end,
    });
  }
}

// Run incremental sync for one calendar in a pair
// sourceCalNum is 1 or 2 (which calendar triggered the webhook)
export async function incrementalSync(pair, sourceCalNum) {
  const sourceToken = sourceCalNum === 1 ? pair.account1_token : pair.account2_token;
  const sourceCalId = sourceCalNum === 1 ? pair.account1_cal_id : pair.account2_cal_id;
  const targetToken = sourceCalNum === 1 ? pair.account2_token : pair.account1_token;
  const targetCalId = sourceCalNum === 1 ? pair.account2_cal_id : pair.account1_cal_id;
  const currentSyncToken = sourceCalNum === 1 ? pair.sync_token1 : pair.sync_token2;

  const sourceClient = createCalendarClient(sourceToken);
  const targetClient = createCalendarClient(targetToken);

  let pageToken;
  let newSyncToken;

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
        // Sync token expired — do full sync instead
        console.log(`Sync token expired for pair ${pair.id} cal ${sourceCalNum}, doing full sync`);
        await fullSync(pair, sourceCalNum);
        return;
      }
      throw err;
    }

    const events = res.data.items || [];
    for (const event of events) {
      try {
        await processEventChange(event, pair, sourceCalNum, targetClient, targetCalId);
      } catch (err) {
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

    for (const event of events) {
      try {
        // Skip mirror events
        if (isMirrorEvent(event, pair.id)) continue;
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
      } catch (err) {
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
