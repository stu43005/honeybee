# Raid Handle Resolution Design

**Date:** 2026-04-07
**Status:** Approved

## Problem

masterchat's `addIncomingRaidBannerAction` and `addOutgoingRaidBannerAction` provide `sourceName`/`targetName` that may be either a `@handle` or a display name (YouTube's behavior is inconsistent). Raid records should always store the display name, not handles.

Previous commits stored `@handle` directly and applied `.toLowerCase()`. This design replaces that approach.

## Solution

### 1. `youtube.ts` — New `updateChannelByHandle(handle: string)`

- Calls `channels.list({ forHandle: handle, part: ["snippet", "contentDetails", "statistics", "brandingSettings"] })`
- Updates/creates Channel document using the same field mapping as existing `updateChannelFromYoutube`
- Returns `DocumentType<Channel> | null` (null if YouTube API finds no channel for the handle)

### 2. `Channel.ts` — New `findByHandle(handle: string)`

- Static method on Channel model
- Queries `{ customUrl: handle.toLowerCase() }` (customUrl is stored lowercase from YouTube API)
- Returns channel document or null

### 3. `worker.ts` — Raid handler handle resolution

For both IncomingRaid and OutgoingRaid, when receiving `sourceName`/`targetName` from masterchat:

- If value starts with `@`: try `findByHandle()` first, if not found call `updateChannelByHandle()`, use `channel.name` as the display name. If both fail, fallback to the raw string.
- If value does not start with `@`: use as-is.

Raid `sourceName`/`originName` fields store the resolved display name.

### 4. Revert previous changes

- Remove `.toLowerCase()` from `action.sourceName` and `action.targetName` in worker.ts
- Change `originName` back from `channelHandle ?? channelName` to resolved display name (for own channel, use `channelName` as before)
- Change `sourceName` back from `channelHandle ?? channelName` to `channelName` (for own channel)
- Remove `.toLowerCase()` from `customUrl` assignment in youtube.ts (API already returns lowercase)

### 5. Unchanged

- `customUrl` field on Channel model (kept)
- YouTube API populating `customUrl` in `updateChannelFromYoutube` (kept, without toLowerCase)
- `findByName` including `customUrl` in search (kept)
- `channelHandle` destructuring in worker.ts (removed, no longer needed)

## Files to modify

| File | Change |
|------|--------|
| `src/modules/youtube.ts` | Add `updateChannelByHandle`; revert `.toLowerCase()` on customUrl |
| `src/models/Channel.ts` | Add `findByHandle` static method |
| `src/commands/worker.ts` | Revert raid handler changes; add handle resolution logic |
