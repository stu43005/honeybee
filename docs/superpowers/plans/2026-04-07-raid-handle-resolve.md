# Raid Handle Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve `@handle` strings from masterchat raid events into display names before storing in Raid records, using YouTube API `forHandle` when DB lookup fails.

**Architecture:** Extract shared YouTube-to-Channel field mapping into `applyYoutubeChannelInfo` helper. Add `findByHandle` to Channel model and `updateChannelByHandle` to youtube.ts (both using the shared helper). In worker raid handlers, detect `@`-prefixed names and resolve them to display names. Revert previous changes that stored handles directly.

**Tech Stack:** TypeScript, Typegoose/Mongoose, googleapis v134 (channels.list forHandle)

---

### Task 1: Add `findByHandle` to Channel model

**Files:**
- Modify: `src/models/Channel.ts:128-133` (add method after `findByChannelId`)

- [ ] **Step 1: Add `findByHandle` static method**

In `src/models/Channel.ts`, add after `findByChannelId` method (after line 133):

```typescript
  public static findByHandle(
    this: ReturnModelType<typeof Channel>,
    handle: string
  ) {
    return this.findOne({ customUrl: handle.toLowerCase() });
  }
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/models/Channel.ts
git commit -m "feat(channel): add findByHandle static method"
```

---

### Task 2: Extract shared helper and add `updateChannelByHandle`

**Files:**
- Modify: `src/modules/youtube.ts` (extract helper, refactor `updateChannelFromYoutube`, add `updateChannelByHandle`, revert `.toLowerCase()`)

- [ ] **Step 1: Extract `applyYoutubeChannelInfo` helper and revert `.toLowerCase()`**

In `src/modules/youtube.ts`, add a new helper function before `updateChannelFromYoutube` (before line 184):

```typescript
function applyYoutubeChannelInfo(
  channel: DocumentType<Channel>,
  ytInfo: youtube_v3.Schema$Channel
): void {
  if (ytInfo.snippet?.title) channel.name = ytInfo.snippet.title;
  if (ytInfo.snippet?.customUrl)
    channel.customUrl = ytInfo.snippet.customUrl;
  if (ytInfo.snippet?.description)
    channel.description = ytInfo.snippet.description;
  if (ytInfo.snippet?.thumbnails?.high?.url)
    channel.avatarUrl = ytInfo.snippet.thumbnails.high.url;
  if (ytInfo.brandingSettings?.image?.bannerExternalUrl)
    channel.bannerUrl = ytInfo.brandingSettings.image.bannerExternalUrl;
  if (ytInfo.snippet?.publishedAt)
    channel.publishedAt = new Date(ytInfo.snippet.publishedAt);
  if (ytInfo.statistics?.viewCount)
    channel.viewCount = Number(ytInfo.statistics.viewCount);
  if (ytInfo.statistics?.videoCount)
    channel.videoCount = Number(ytInfo.statistics.videoCount);
  if (ytInfo.statistics?.subscriberCount)
    channel.subscriberCount = Number(ytInfo.statistics.subscriberCount);
  if (channel.deleted) channel.deleted = false;
}
```

- [ ] **Step 2: Refactor `updateChannelFromYoutube` to use `applyYoutubeChannelInfo`**

Replace the body of the `if (ytInfo)` block inside the for loop (lines 207-225) with a call to the helper:

Change from:

```typescript
    if (ytInfo) {
      if (ytInfo.snippet?.title) channel.name = ytInfo.snippet.title;
      if (ytInfo.snippet?.customUrl)
        channel.customUrl = ytInfo.snippet.customUrl.toLowerCase();
      if (ytInfo.snippet?.description)
        channel.description = ytInfo.snippet.description;
      if (ytInfo.snippet?.thumbnails?.high?.url)
        channel.avatarUrl = ytInfo.snippet.thumbnails.high.url;
      if (ytInfo.brandingSettings?.image?.bannerExternalUrl)
        channel.bannerUrl = ytInfo.brandingSettings.image.bannerExternalUrl;
      if (ytInfo.snippet?.publishedAt)
        channel.publishedAt = new Date(ytInfo.snippet.publishedAt);
      if (ytInfo.statistics?.viewCount)
        channel.viewCount = Number(ytInfo.statistics.viewCount);
      if (ytInfo.statistics?.videoCount)
        channel.videoCount = Number(ytInfo.statistics.videoCount);
      if (ytInfo.statistics?.subscriberCount)
        channel.subscriberCount = Number(ytInfo.statistics.subscriberCount);
      if (channel.deleted) channel.deleted = false;
    } else {
```

to:

```typescript
    if (ytInfo) {
      applyYoutubeChannelInfo(channel, ytInfo);
    } else {
```

- [ ] **Step 3: Add `updateChannelByHandle` function**

In `src/modules/youtube.ts`, add after `updateChannelFromYoutube` (after its closing `}`), before `validateChannelId`:

```typescript
export async function updateChannelByHandle(
  handle: string
): Promise<DocumentType<Channel> | null> {
  const youtube = getYoutubeApi();
  const response = await youtube.channels.list({
    part: ["snippet", "contentDetails", "statistics", "brandingSettings"],
    forHandle: handle,
    hl: "ja",
    maxResults: 1,
  });
  const ytInfo = response?.data?.items?.[0];
  if (!ytInfo?.id) return null;

  const channel =
    (await ChannelModel.findByChannelId(ytInfo.id)) ??
    new ChannelModel({ id: ytInfo.id });

  applyYoutubeChannelInfo(channel, ytInfo);
  channel.crawledAt = new Date();
  await channel.save();
  return channel;
}
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/youtube.ts
git commit -m "refactor(youtube): extract applyYoutubeChannelInfo; add updateChannelByHandle"
```

---

### Task 3: Update worker raid handlers to resolve handles

**Files:**
- Modify: `src/commands/worker.ts:131` (revert channelHandle destructure)
- Modify: `src/commands/worker.ts:698-762` (update both raid handlers)

- [ ] **Step 1: Add imports**

In `src/commands/worker.ts`, find the existing import from `../modules/youtube` and add `updateChannelByHandle`. Also ensure `ChannelModel` is imported from `../models/Channel`.

Add to the youtube import:

```typescript
import { updateChannelByHandle } from "../modules/youtube";
```

And ensure ChannelModel is imported:

```typescript
import ChannelModel from "../models/Channel";
```

(If these imports already exist in some form, adjust accordingly — do not duplicate.)

- [ ] **Step 2: Add `resolveRaidName` helper function**

Add a module-level function before the function that uses it (before `handleJob`):

```typescript
async function resolveRaidName(name: string): Promise<string> {
  if (!name.startsWith("@")) return name;
  const channel = await ChannelModel.findByHandle(name);
  if (channel) return channel.name;
  const fetched = await updateChannelByHandle(name);
  if (fetched) return fetched.name;
  return name;
}
```

- [ ] **Step 3: Revert channelHandle destructure**

In `src/commands/worker.ts`, change line 131 from:

```typescript
  const { name: channelName, avatarUrl: channelAvatarUrl, customUrl: channelHandle } =
    await video.getChannel();
```

to:

```typescript
  const { name: channelName, avatarUrl: channelAvatarUrl } =
    await video.getChannel();
```

- [ ] **Step 4: Update IncomingRaid handler**

Replace the `addIncomingRaidBannerAction` case (lines 698-727). The `payload` construction needs `Promise.all` because `resolveRaidName` is async:

```typescript
          case "addIncomingRaidBannerAction": {
            if (isReplay) break;
            const payload: Raid[] = await Promise.all(
              groupedActions[type].map(async (action) => {
                return {
                  id: action.actionId,
                  targetId: action.targetId,
                  // sourceVideoId: ,
                  // sourceChannelId: ,
                  sourceName: await resolveRaidName(action.sourceName),
                  sourcePhoto: action.sourcePhoto,
                  originVideoId: mc.videoId,
                  originChannelId: mc.channelId,
                  originName: channelName,
                  originPhoto: channelAvatarUrl,
                  timestamp: new Date(),
                };
              })
            );
            await RaidModel.bulkWrite(
              payload.map((raid) => ({
                updateOne: {
                  filter: {
                    originVideoId: raid.originVideoId,
                    sourceName: raid.sourceName,
                  },
                  update: { $set: raid },
                  upsert: true,
                },
              }))
            );
            break;
          }
```

- [ ] **Step 5: Update OutgoingRaid handler**

Replace the `addOutgoingRaidBannerAction` case (lines 729-762). Same async pattern:

```typescript
          case "addOutgoingRaidBannerAction": {
            if (isReplay) break;
            const payload: Raid[] = await Promise.all(
              groupedActions[type].map(async (action) => {
                return {
                  outgoingId: action.actionId,
                  outgoingTargetId: action.targetId,
                  sourceVideoId: mc.videoId,
                  sourceChannelId: mc.channelId,
                  sourceName: channelName,
                  sourcePhoto: channelAvatarUrl,
                  originVideoId: action.targetVideoId,
                  // originChannelId: ,
                  originName: await resolveRaidName(action.targetName),
                  originPhoto: action.targetPhoto,
                  timestamp: new Date(),
                };
              })
            );
            await RaidModel.bulkWrite(
              payload.map((raid) => ({
                updateOne: {
                  filter: {
                    originVideoId: raid.originVideoId,
                    sourceName: raid.sourceName,
                  },
                  update: { $set: raid },
                  upsert: true,
                },
              }))
            );
            for (const raid of payload) {
              await VideoModel.noticeFromRaid(raid);
            }
            break;
          }
```

- [ ] **Step 6: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/commands/worker.ts
git commit -m "fix(worker): resolve @handle to display name in raid handlers"
```
