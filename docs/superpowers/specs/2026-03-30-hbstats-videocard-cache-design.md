# Cache videoCard Stats in Video.hbStats

## Goal

Eliminate per-video `VideoStatsModel.find` queries in `videoCard` by caching `totalSuperChatAmountJpy`, `totalMembers`, and `totalGifts` directly on the `Video` document in `hbStats`. These values are incrementally updated during stats processing and fully recalculated after cleanup.

## Changes

### 1. Video Model — Extend Stats Class

Add three optional fields to the existing `Stats` class in `src/models/Video.ts`:

```typescript
@prop()
public totalSuperChatAmountJpy?: number;

@prop()
public totalMembers?: number;

@prop()
public totalGifts?: number;
```

### 2. video-stats.ts — Incremental $inc After updateStats

After `updateStats` returns records in each relevant scheduled task, aggregate records by `videoId` (summing `value`), then bulk `$inc` the corresponding `hbStats` field on Video documents.

**Mapping of tasks to hbStats fields:**

| type | messageType | hbStats field |
|---|---|---|
| `PurchaseAmountJpyTotal` | `SuperChat` | `hbStats.totalSuperChatAmountJpy` |
| `PurchaseAmountJpyTotal` | `SuperSticker` | `hbStats.totalSuperChatAmountJpy` |
| `MessageTotal` | `Membership` | `hbStats.totalMembers` |
| `PurchaseAmountTotal` | `MembershipGiftPurchase` | `hbStats.totalGifts` |

**Implementation:** In the four specific scheduled task `job()` functions listed above, after `updateStats` returns records, aggregate them by `_id.videoId` (sum of `value`), then `Video.bulkWrite` with `$inc` operations. No config structure needed — the `$inc` logic is added directly in each relevant `job()` function.

The records from `updateStats` are grouped by `videoId + authorType + currency`. To get a per-video total, sum all records sharing the same `_id.videoId`. Extract this aggregation + bulkWrite into a shared helper (e.g., `incVideoHbStats(records, field)`) to avoid duplication across the four tasks.

### 3. video-stats.ts — Recalculation Function

Add a function `recalcVideoHbStats(videoIds: string[])` that:

1. Aggregates from `VideoStatsModel` for the given videoIds:
   - `totalSuperChatAmountJpy`: sum of `value` where `type === PurchaseAmountJpyTotal` and `messageType in [SuperChat, SuperSticker]`
   - `totalMembers`: sum of `value` where `type === MessageTotal` and `messageType === Membership`
   - `totalGifts`: sum of `value` where `type === PurchaseAmountTotal` and `messageType === MembershipGiftPurchase`
2. Bulk `$set` the three fields on each Video document's `hbStats`
3. For videoIds with no matching stats, set all three fields to 0

This function is exported for use by cleanup.ts and chats-archive.ts.

### 4. cleanup.ts — Recalculate After cleanVideos

In `cleanEndedStreams`, after calling `cleanVideos(toRemoveVideoIds)`, call `recalcVideoHbStats(toRemoveVideoIds)` to recompute the three values from the remaining VideoStats data and `$set` them on the Video documents.

### 5. chats-archive.ts — Use hbStats in videoCard

Replace the `VideoStatsModel.find` query in `videoCard` with reads from `video.hbStats`:

```typescript
const totalSuperChatAmountJpy = video.hbStats?.totalSuperChatAmountJpy ?? 0;
const totalMembers = video.hbStats?.totalMembers ?? 0;
const totalGifts = video.hbStats?.totalGifts ?? 0;
if (totalSuperChatAmountJpy === 0 && totalMembers === 0 && totalGifts === 0) {
  return;
}
```

### 6. chats-archive.ts — Backfill When Run as Main

When `require.main === module`, `videoCard` should instead query VideoStats directly (the original query), recalculate the three values, write them to `hbStats` via `recalcVideoHbStats`, and then render the card. This serves as a one-time backfill for existing videos that don't yet have `hbStats` populated.

**Implementation:** Add a boolean parameter (e.g., `backfill = false`) to `videoCard`. When `true`, call `recalcVideoHbStats([video.id])` and re-read the video to get updated `hbStats` before rendering. The main entry point passes `backfill: true`.

## Files Modified

- `src/models/Video.ts` — extend `Stats` class with three fields
- `src/components/video-stats.ts` — add `$inc` after `updateStats`, add and export `recalcVideoHbStats`
- `src/components/cleanup.ts` — call `recalcVideoHbStats` after `cleanVideos`
- `src/components/chats-archive.ts` — use `hbStats` in `videoCard`, backfill in main mode

## Out of Scope

- Migrating all existing videos (handled by running chats-archive.ts as main)
- Changing the VideoStats model or its indexes
