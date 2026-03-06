# Two-Way Calendar Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Two-way sync between two Google Calendar accounts — events on one create "Busy" blocks on the other, with delete propagation and loop prevention.

**Architecture:** Google Push Notifications trigger incremental sync via sync tokens. Mirror events are tagged with extended properties to prevent infinite loops. A DB mapping table tracks source-to-mirror event pairs for delete propagation.

**Tech Stack:** Node.js/Express ESM, googleapis (Google Calendar API v3), better-sqlite3, vitest

---

# Two-Way Calendar Sync Design

## Overview

Add two-way sync between two Google Calendar accounts. When an event exists on calendar 1, a "Busy" block is created on calendar 2, and vice versa. Deletes propagate. No human approval required.

## Requirements

- Two different Google accounts (separate OAuth flows)
- User picks which calendar ID to sync from each account
- Mirror events are minimal: title "Busy", correct start/end, no other details
- Deletes propagate (remove mirror when source is cancelled)
- Fully automatic, no Telegram approval
- Google Push Notifications (webhooks) for real-time sync
- Must not create infinite loops

## Data Model

### `calendar_sync_pairs`

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| user_id | TEXT NOT NULL | FK to users |
| account1_email | TEXT | Google account 1 email |
| account1_token | TEXT | OAuth refresh token for account 1 |
| account1_cal_id | TEXT | Calendar ID to sync |
| account2_email | TEXT | Google account 2 email |
| account2_token | TEXT | OAuth refresh token for account 2 |
| account2_cal_id | TEXT | Calendar ID to sync |
| is_active | INTEGER | 1=syncing, 0=paused |
| channel1_id | TEXT | Push notification channel ID for cal 1 |
| channel1_expiry | TEXT | Channel expiration timestamp |
| channel2_id | TEXT | Push notification channel ID for cal 2 |
| channel2_expiry | TEXT | Channel expiration timestamp |
| sync_token1 | TEXT | Incremental sync token for cal 1 |
| sync_token2 | TEXT | Incremental sync token for cal 2 |
| created_at | TEXT | ISO timestamp |

### `synced_events`

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| pair_id | TEXT NOT NULL | FK to calendar_sync_pairs |
| source_event_id | TEXT NOT NULL | Event ID on originating calendar |
| source_calendar | INTEGER NOT NULL | 1 or 2 |
| mirror_event_id | TEXT NOT NULL | Busy event ID on the other calendar |
| source_start | TEXT | Event start time |
| source_end | TEXT | Event end time |
| created_at | TEXT | ISO timestamp |

Indexes: `(pair_id, source_event_id)`, `(pair_id, mirror_event_id)`

## Loop Prevention

Two-layer defense:

1. **Extended Properties** - Every mirror "Busy" event is created with `extendedProperties.private.calSyncPairId = "<pairId>"`. When processing webhook events, any event with this property is skipped.

2. **DB Lookup** - Before processing, check if the event ID exists as a `mirror_event_id` in `synced_events`. If yes, skip.

## OAuth Flow

New OAuth endpoints for connecting calendar accounts:

- `GET /api/auth/calendar/:pairId/account/:accountNum` - starts OAuth for account 1 or 2
- Callback at `/api/auth/callback/calendar` stores refresh token + email on the sync pair
- Scopes: `calendar.readonly` + `calendar.events` (read source, write mirror)

After both accounts connected, user fetches available calendars and selects which to sync.

## Google Push Notifications

- Webhook endpoint: `POST /webhook/calendar/:pairId`
- Setup via `calendar.events.watch()` for each calendar in the pair
- Channels expire (~7 days max). Scheduled job renews before expiry.
- Headers `X-Goog-Channel-Id` and `X-Goog-Resource-Id` identify which calendar changed.

## Sync Logic

When webhook fires for calendar N:

1. Call `events.list()` with stored `syncToken` for incremental changes
2. For each changed event:
   - If `extendedProperties.private.calSyncPairId` exists -> skip (mirror event)
   - If event ID is a `mirror_event_id` in DB -> skip
   - If event status = `cancelled`: look up `synced_events`, delete mirror, remove DB row
   - If event exists in `synced_events` (update): update mirror start/end
   - If new event: create "Busy" on other calendar with extended property, store mapping
3. Save new `syncToken`

## Initial Sync

On first activation, do full `events.list()` (upcoming events, timeMin=now) for both calendars, creating mirror busy blocks for all existing events.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/calendar-sync | Create new sync pair |
| GET | /api/calendar-sync | List user's sync pairs |
| GET | /api/calendar-sync/:pairId | Get sync pair details |
| DELETE | /api/calendar-sync/:pairId | Delete pair + cleanup |
| POST | /api/calendar-sync/:pairId/pause | Pause sync |
| POST | /api/calendar-sync/:pairId/resume | Resume sync |
| GET | /api/calendar-sync/:pairId/calendars/:accountNum | List available calendars |
| PUT | /api/calendar-sync/:pairId | Update calendar IDs |

## Scheduled Jobs

1. **Channel renewal** - runs hourly, renews channels expiring within 2 hours
2. **Cleanup** - remove orphaned `synced_events` rows

## New Files

```
src/db/calendar-sync.js           - DB operations for sync pairs + synced events
src/routes/calendar-sync.js       - API endpoints
src/routes/calendar-webhook.js    - Google push notification handler
src/services/calendar.js          - Google Calendar API client + sync logic
src/services/calendar-channels.js - Push notification channel management
```

## Config Additions

```
CALENDAR_WEBHOOK_URL  - Base URL for calendar push notification webhooks
```
