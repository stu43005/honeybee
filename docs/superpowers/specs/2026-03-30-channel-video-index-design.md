# Channel Video Index Pages

## Goal

Add per-channel video list pages at `{CHAT_ARCHIVE_DIR}/{channelId}/index.html`, triggered when a channel has live or recently ended videos, and link to them from the main index page.

## Changes

### 1. Video Model — Compound Index

Add a compound index on `{ channelId: 1, availableAt: -1 }` to the `Video` class in `src/models/Video.ts`. This supports the per-channel query sorted by `availableAt` descending without an in-memory sort stage.

```typescript
@index({ channelId: 1, availableAt: -1 })
```

### 2. `genIndexFile` — Collect Channel IDs

During the existing iteration over live and recently ended videos in `genIndexFile`, collect all unique `channelId` values into a `Set<string>`. After completing the main index generation, iterate over the set and call `genChannelIndexFile(channelId)` for each.

No new Agenda job or schedule is needed — channel index generation piggybacks on the existing `"chats archive index"` job.

### 3. `genChannelIndexFile` — New Function

Generates `{CHAT_ARCHIVE_DIR}/{channelId}/index.html`.

**Query:** `VideoModel.find({ channelId }).sort({ availableAt: -1 }).limit(1000).populate("channel")` with `readPreference: "secondaryPreferred"`.

**Page structure:**
- Channel header: avatar (48px, rounded) + channel name as `<h1>`
- `<hr />`
- Video card grid: Bootstrap `row-cols-1 row-cols-md-4 g-4`, same card layout as the main index
- Each card rendered by the existing `videoCard` function
- Only write the file if at least one video card was rendered (same pattern as `archiveVideo` — write to `.tmp` then rename)

**Filtering:** Videos are filtered the same way as `videoCard` currently does — if `videoCard` finds no stats for a video, it returns without writing anything. Videos with no stats produce no card.

### 4. `videoCard` — Channel Name Link

In the `videoCard` function, wrap the channel name (`channel.name`) in a link to the channel's index page:

```html
<a href="{channelId}/index.html">{channel.name}</a>
```

`videoCard` is called from both `genIndexFile` (root level) and `genChannelIndexFile` (channel level). To make relative paths work in both contexts, add an optional `basePath` parameter to `videoCard` (default `""`). `genIndexFile` passes `""` (links become `{channelId}/index.html`), `genChannelIndexFile` passes `"../"` (links become `../{channelId}/index.html`).

## Files Modified

- `src/models/Video.ts` — add compound index
- `src/components/chats-archive.ts` — add `genChannelIndexFile`, modify `genIndexFile` and `videoCard`

## Out of Scope

- Pagination (capped at 1000 videos per channel instead)
- Channel index page styling beyond what the main index already uses
- Cleanup of stale channel index files
