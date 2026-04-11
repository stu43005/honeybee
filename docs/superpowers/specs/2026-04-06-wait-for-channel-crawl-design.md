# Wait for Channel Crawl on Track Commands

## Problem

When a user invokes `/track add`, `/track chat block-moderator`, or `/track chat follow-sender` with a YouTube channel ID that doesn't yet exist in the `channels` collection, the command creates a placeholder document with `name: "Unknown channel"` and immediately replies to the user referencing that placeholder name. The YouTube crawler (scheduled every 5 minutes, prioritizing `crawledAt: null`) will populate the real channel info shortly after, but the user's Discord reply remains frozen with "Unknown channel", forcing them to manually re-check or re-run commands.

## Goal

After the initial reply, wait for the crawler to populate the channel document, then edit the reply to show the real channel name. Keep waiting up to 10 minutes (2× the crawler interval).

## Scope

Applies to the 3 track commands that create new channel documents via `ChannelModel.create`:

- `addTrackChannel` — [src/discord/commands/track/track.ts:190-243](src/discord/commands/track/track.ts#L190-L243)
- `blockModerator` — [src/discord/commands/track/track.ts:513-565](src/discord/commands/track/track.ts#L513-L565)
- `followSender` — [src/discord/commands/track/track.ts:625-677](src/discord/commands/track/track.ts#L625-L677)

Out of scope: `remove`, `list`, `unblock-moderator`, `unfollow-sender` — these build in-memory `ChannelModel` instances purely for display and never persist "Unknown channel" to the DB, so no waiting is required.

## Design

### 1. New static method `Channel.waitForCrawl`

Added to [src/models/Channel.ts](src/models/Channel.ts), alongside the other static finder methods.

```ts
public static async waitForCrawl(
  this: ReturnModelType<typeof Channel>,
  channelId: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<DocumentType<Channel> | null>
```

**Behavior:**

- Polls `this.findByChannelId(channelId)` with increasing interval: 5s → 10s → 15s → 20s → 25s → 30s, capped at 30s thereafter.
- Returns the document as soon as `crawledAt` is non-null.
- Default `timeoutMs` is `600_000` (10 minutes). On timeout, returns the latest document snapshot (which will still have `crawledAt == null`). Caller uses the presence/absence of `crawledAt` to decide what to do.
- Returns `null` if the document never exists for the full timeout window (defensive — not expected in the track flow since the caller always creates the doc first).
- Honors `AbortSignal` if provided; throws on abort.
- Does not throw on timeout — returns the current state so the caller can gracefully fall through.

### 2. Discord command changes

Each of the 3 commands changes its final reply from a single `reply` call to `reply` + conditional `editReply`:

**Before (representative: `addTrackChannel`):**

```ts
await intr.reply({
  embeds: [{ description: `Now tracking ${channel.getHyperlink()} (${channelId}).` }],
});
```

**After:**

```ts
await intr.reply({
  embeds: [{ description: `Now tracking ${channel.getHyperlink()} (${channelId}).` }],
});

if (!channel.crawledAt) {
  try {
    const updated = await ChannelModel.waitForCrawl(channelId);
    if (updated?.crawledAt) {
      const warning = updated.deleted
        ? " ⚠️ This channel may not exist on YouTube."
        : "";
      await intr.editReply({
        embeds: [{
          description: `Now tracking ${updated.getHyperlink()} (${channelId}).${warning}`,
        }],
      });
    }
    // Timeout: leave original reply as-is (shows "Unknown channel")
  } catch (err) {
    // Log and swallow — tracking already succeeded; edit failure shouldn't throw
  }
}
```

The same pattern applies to `blockModerator` (message "Blocked …") and `followSender` (message "Following …"), preserving each command's existing copy.

### 3. Interaction lifetime

Discord webhook interaction tokens allow `editReply` for up to **15 minutes** after the initial response, which comfortably covers the 10-minute timeout. No `deferReply` is needed — we reply immediately, then the handler continues to await the poll, then edits.

### 4. Edge cases

| Case | Behavior |
|------|----------|
| Channel already had `crawledAt` set before command ran | Skip `waitForCrawl` entirely (the `if (!channel.crawledAt)` guard) |
| Crawler updates doc within 5s | First poll returns it; edit happens almost immediately |
| Timeout (10 min elapsed, still `crawledAt: null`) | Leave original reply unchanged (per user preference 1A) |
| Channel marked `deleted: true` after crawl | Edit reply with name + ⚠️ warning suffix (per user preference 2B) |
| `editReply` fails (e.g., message deleted, token expired) | Catch, log, don't throw |
| Two simultaneous track commands for the same new channel | Both poll independently; both observe the same crawled doc and edit their own replies |

### 5. Testing

Add unit tests for `Channel.waitForCrawl` covering:

- Returns document when `crawledAt` is already set on first poll
- Polls multiple times with backoff until `crawledAt` appears
- Returns latest snapshot (with `crawledAt: null`) on timeout
- Honors `AbortSignal`
- Returns `null` when document never exists

Use fake timers (e.g., `vi.useFakeTimers()`) to drive the backoff without real waits.

No integration tests for the Discord commands themselves — existing test conventions in the repo don't cover the Discord command layer.

## Non-Goals

- Converting to MongoDB change streams (polling is sufficient for this low-frequency onboarding flow).
- Adding a loading indicator / spinner to the initial reply.
- Retroactively fixing old "Unknown channel" entries in previously-sent messages.
- Changing the crawler's scheduling or priority.
