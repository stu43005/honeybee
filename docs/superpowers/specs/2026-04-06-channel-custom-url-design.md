# Channel Custom URL (@handle) Support

**Date:** 2026-04-06
**Status:** Approved

## Problem

YouTube raids in masterchat use `@handle` format for channel names (`sourceName` in IncomingRaid, `targetName` in OutgoingRaid). However, when storing raid data for our own monitored channel, we use the display name (`channelName`), creating an inconsistency:

- IncomingRaid `originName` = display name (e.g. `兎田ぺこら`)
- OutgoingRaid `sourceName` = display name (e.g. `兎田ぺこら`)
- IncomingRaid `sourceName` = `@handle` (from masterchat) 
- OutgoingRaid `originName` = `@handle` (from masterchat) 

Additionally, `findByName` cannot search channels by their YouTube handle.

## Solution

### 1. Channel Model — Add `customUrl` field

Add `customUrl?: string` property to the `Channel` class in `src/models/Channel.ts`. Stores the YouTube `@handle` (e.g. `@pekoBoruchannel`).

### 2. YouTube API — Populate `customUrl`

In `updateChannelFromYoutube()` in `src/modules/youtube.ts`, extract `snippet.customUrl` from the YouTube API response and write it to the channel document.

### 3. `findByName` — Include handle in search

Add `{ customUrl: { $regex: name, $options: "i" } }` to the `$or` array in `Channel.findByName()`.

### 4. Worker Raid — Use handle for own channel

In `src/commands/worker.ts`, destructure `customUrl` from the channel alongside `name` and `avatarUrl`. Use `customUrl ?? channelName` as fallback for:

- IncomingRaid `originName` (line ~710)
- OutgoingRaid `sourceName` (line ~737)

### 5. Out of scope

- Raid model schema unchanged (`sourceName`/`originName` remain `string`)
- Raid unique index `{ originVideoId, sourceName }` unchanged
- Discord webhook templates unchanged (already have `sourceChannel?.name` fallback)
- `updateFromHolodex` unchanged (Holodex does not provide handle data)

## Files to modify

| File | Change |
|------|--------|
| `src/models/Channel.ts` | Add `customUrl` prop; update `findByName` `$or` |
| `src/modules/youtube.ts` | Extract `snippet.customUrl` in `updateChannelFromYoutube` |
| `src/commands/worker.ts` | Use `customUrl ?? channelName` in raid handlers |
