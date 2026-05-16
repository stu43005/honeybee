# chats-archive JSONL Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add machine-readable JSONL + JSON outputs (`data/videos/{videoId}.{jsonl,meta.json}`, `data/index.json`, `data/channels/{channelId}.json`) to the manager's `chats-archive` component, alongside the existing HTML. A future SPA frontend (separate project, out of scope) will consume these artifacts.

**Architecture:** Additive-only changes to three control-layer files plus one Typegoose model field plus one new shared helper file. Each `archiveVideo` run writes HTML + JSONL concurrently from the same merged cursor, then writes `meta.json`, then bumps `Video.hbStats.chatsArchiveVersion` to `2` (conditional skip when already `>= 2`). `genIndexFile` and `genChannelIndexFile` each gain one extra `JSON.stringify` write inside their existing video loops, sharing a `buildVideoSummary` helper.

**Tech Stack:** TypeScript (NodeNext ESM), Typegoose 12 / mongoose 8.2.1, node `fs/promises` (`fs.rm`, `fs.rename`), `stream/promises` (`finished`), existing `multiCursorOrderedPeek` helper. No new runtime dependencies.

**Reference spec:** [docs/superpowers/specs/2026-05-10-chats-archive-jsonl-output-design.md](../specs/2026-05-10-chats-archive-jsonl-output-design.md)

**User-imposed constraints:**

- No unit tests. Manual verification only at end of plan.
- Every code change must pass `npm run build`, `npm run lint`, `npm run format:check` before commit.
- No `git add -A` / `git add .` — stage by exact path.
- No `npm install` to "ensure" a version — verify presence in `node_modules` first.
- Code comments must not reference this plan/spec (no `§`, `Task N`, "see plan", "依規格"). Commit-message bodies also forbidden from such references.

**Pre-flight verified (not a task):** Mongoose `8.2.1` `Model.updateOne({ id }, { $set: { "hbStats.chatsArchiveVersion": 2 } })` on a document with undefined `hbStats` creates the parent sub-doc and sets the leaf (`setDottedPath()` walks the path; verified at `node_modules/mongoose/lib/helpers/path/setDottedPath.js:23-24`). Sibling defaults (`handled`, `errorCount`) are NOT populated on a non-upsert update (`setDefaultsOnInsert()` only runs on upserts). The existing codebase already uses dotted-path `$set` and `$inc` against `hbStats.*` in `src/models/Video.ts:497-498` (`Video.updateResult`) and `src/components/video-stats.ts` (`recalcVideoHbStats`, `incVideoHbStats`); Task 4's `updateOne` matches that convention.

---

## Task 1: Add `chatsArchiveVersion` field to `Stats` sub-class

**Files:**

- Modify: `src/models/Video.ts` (the `Stats` class around lines 27–42)
- No tests (per user constraints).

- [ ] **Step 1: Read the current `Stats` class**

Read `src/models/Video.ts` with `offset: 25, limit: 22`.

Expected: see `Stats` class containing `@prop` for `handled`, `errorCount`, `totalSuperChatAmountJpy`, `totalMembers`, `totalGifts`.

- [ ] **Step 2: Add the new property**

Edit `src/models/Video.ts`. Replace:

```ts
  @prop()
  totalGifts?: number;
}
```

With:

```ts
  @prop()
  totalGifts?: number;

  @prop()
  chatsArchiveVersion?: number;
}
```

(No `default` — undefined remains the legacy value for documents not yet re-archived.)

- [ ] **Step 3: Validate**

Run in parallel:

```bash
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all three exit 0. If `format:check` complains, run `npm run format` then re-run `format:check`.

- [ ] **Step 4: Commit**

```bash
git add src/models/Video.ts
git commit -m "$(cat <<'EOF'
feat(video): add hbStats.chatsArchiveVersion field

Marker for chats-archive output format version. Undefined / 1 = legacy
HTML-only archive; 2 = HTML plus JSONL/meta.json artifacts under data/.
Set by archive-video.ts after successful artifact generation.

EOF
)"
```

---

## Task 2: Create shared `build-video-summary.ts` helper

**Why this task exists:** The `VideoSummary` shape is a spec-defined shared interface used by both `data/index.json` and `data/channels/{channelId}.json`. Duplicating its construction across two callsites would silently drift when the shape evolves; extracting once into a named module satisfies the project's "files that change together should live together" guideline. The helper holds real transformation logic (channel resolve, conditional fields, defaults), so this is not a logic-free abstraction.

**Files:**

- Create: `src/components/chats-archive/build-video-summary.ts`
- No tests (per user constraints).

- [ ] **Step 1: Create the file**

Write `src/components/chats-archive/build-video-summary.ts` with:

```ts
import type { DocumentType } from "@typegoose/typegoose";
import ChannelModel from "../../models/Channel.js";
import type { Video } from "../../models/Video.js";

export async function buildVideoSummary(
  video: DocumentType<Video>
): Promise<Record<string, unknown>> {
  const channel = await ChannelModel.findByChannelId(video.channelId);
  const channelObj: Record<string, unknown> = channel
    ? { id: channel.id, name: channel.name }
    : { id: video.channelId, name: video.channelId };
  if (channel?.avatarUrl !== undefined && channel?.avatarUrl !== null) {
    channelObj.avatarUrl = channel.avatarUrl;
  }
  const summary: Record<string, unknown> = {
    id: video.id,
    title: video.title,
    channel: channelObj,
    status: video.status,
    duration: video.duration,
    availableAt: video.availableAt,
    archiveVersion: video.hbStats?.chatsArchiveVersion ?? 1,
    stats: {
      superChatTotalJpy: video.hbStats?.totalSuperChatAmountJpy ?? 0,
      memberCount: video.hbStats?.totalMembers ?? 0,
      giftCount: video.hbStats?.totalGifts ?? 0,
    },
  };
  for (const key of [
    "description",
    "scheduledStart",
    "actualStart",
    "actualEnd",
    "publishedAt",
  ] as const) {
    const val = video[key];
    if (val !== undefined && val !== null) summary[key] = val;
  }
  return summary;
}
```

Notes on this code:

- `ChannelModel.findByChannelId(video.channelId)` is used directly (not `video.getChannel()`) because `getChannel()` calls `assert(channel, "Unable to get the channel.")` and throws when the channel row is missing. The SPA-facing JSON should degrade gracefully for newly-crawled videos whose channel row has not been populated yet, so we read the channel ourselves and fall through to the `{ id: channelId, name: channelId }` shape when not found.
- This means an extra `findByChannelId` round trip per video summary (not reusing the loop's `populate("channel")`). Trade-off accepted: existing HTML loops only populate `channel` for `renderVideoCard`; the JSON summary needs a real null check, and a 1-query-per-video cost on the index pages (≤96 videos for live+past, ≤100 per channel) is bounded. If profiling shows this matters later, batch via `ChannelModel.find({ id: { $in: [...] } })` in a separate optimization PR.
- Dates are passed through as `Date` objects. `JSON.stringify` invokes `Date.prototype.toJSON` which produces ISO 8601 strings — no custom serializer.
- The optional-fields loop covers `description` and the four optional `Date` fields; `keyof Video` keeps the tuple type-checked, so a key typo fails `tsc` instead of being silently swallowed.
- The top-level `channelId` field is intentionally omitted; consumers read `channel.id` (same value, no redundancy).
- `??` defaults for `archiveVersion` / `stats.*` match the existing HTML `VideoCard`'s `?? 0` semantics so SPA card output matches HTML card output byte-for-byte at the numeric level.

- [ ] **Step 2: Validate**

Run in parallel:

```bash
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all three exit 0. The file is referenced only by Tasks 5/6 — TypeScript may warn about an unused export but it is a module export, not a local, so `no-unused-vars` does not apply.

- [ ] **Step 3: Commit**

```bash
git add src/components/chats-archive/build-video-summary.ts
git commit -m "$(cat <<'EOF'
feat(chats-archive): add shared buildVideoSummary helper

Single source of truth for the SPA-facing VideoSummary shape consumed
by data/index.json and data/channels/{channelId}.json. Centralizes
channel resolution, optional-field stripping, archiveVersion default
(1 when hbStats.chatsArchiveVersion is undefined), and stats defaults
(0 for missing SC/member/gift totals).

EOF
)"
```

---

## Task 3: Update `RaidCells` in `templates/VideoArchive.tsx` to render outgoing raids

**Why this task exists:** Task 4 extends the raid cursor with `$or` so outgoing raids reach the loop. The HTML emit branch needs a template that can render both directions; otherwise outgoing raids would either be skipped (incomplete archive) or rendered with `sourceName` referring to the current channel (self-referential nonsense).

**Files:**

- Modify: `src/components/chats-archive/templates/VideoArchive.tsx` (the `RaidCells` function around lines 379–400)
- No tests (per user constraints).

- [ ] **Step 1: Read the current `RaidCells` function**

Read `src/components/chats-archive/templates/VideoArchive.tsx` with `offset: 379, limit: 25`.

Expected: see the current `RaidCells` rendering `sourceName` / `sourcePhoto` unconditionally.

- [ ] **Step 2: Replace `RaidCells` with the direction-aware version**

Replace:

```tsx
function RaidCells({
  doc,
  video,
}: {
  doc: DocumentType<Raid>;
  video: DocumentType<Video>;
}) {
  return (
    <>
      <td>
        <FormattedTimestamp video={video} timestamp={getTimestamp(doc)} />
      </td>
      <td></td>
      <td></td>
      <td>
        <AuthorPhoto src={doc.sourcePhoto} />
      </td>
      <td>{doc.sourceName ?? ""}</td>
      <td>{doc.sourceName ?? ""} and their viewers just joined. Say hello!</td>
    </>
  );
}
```

With:

```tsx
function RaidCells({
  doc,
  video,
}: {
  doc: DocumentType<Raid>;
  video: DocumentType<Video>;
}) {
  const isOutgoing = doc.sourceVideoId === video.id;
  const name = isOutgoing ? doc.originName : doc.sourceName;
  const photo = isOutgoing ? doc.originPhoto : doc.sourcePhoto;
  const message = isOutgoing
    ? `Sending you to ${name ?? ""}`
    : `${name ?? ""} and their viewers just joined. Say hello!`;
  return (
    <>
      <td>
        <FormattedTimestamp video={video} timestamp={getTimestamp(doc)} />
      </td>
      <td></td>
      <td></td>
      <td>
        <AuthorPhoto src={photo} />
      </td>
      <td>{name ?? ""}</td>
      <td>{message}</td>
    </>
  );
}
```

Notes:

- `isOutgoing` keys off `doc.sourceVideoId === video.id`. This is the same condition the JSONL emitter uses (in Task 4) to dispatch `raid` vs `raidOutgoing`.
- A doc whose `sourceVideoId` matches the current video is outgoing; everything else (including the typical case `originVideoId === video.id`) renders as incoming. If neither field matches (should not occur given the extended cursor), the doc still renders as incoming with whatever `sourceName` it carries — this is defensive, not a real code path.
- Incoming output is byte-identical to the previous version: same wording, same photo source, same name column.

- [ ] **Step 3: Validate**

Run in parallel:

```bash
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all three exit 0. If `format:check` complains, run `npm run format` then re-run.

- [ ] **Step 4: Commit**

```bash
git add src/components/chats-archive/templates/VideoArchive.tsx
git commit -m "$(cat <<'EOF'
feat(chats-archive): render outgoing raids in the HTML archive

RaidCells now branches on doc.sourceVideoId === video.id. Outgoing
raids render the destination channel (originName / originPhoto) with
the message "Sending you to <originName>"; incoming raids preserve
the existing wording and field references. Pairs with the next change
which extends the raid cursor to fetch both directions.

EOF
)"
```

---

## Task 4: All `archive-video.ts` changes — extend raid cursor, JSONL emit, meta.json, renames, version bump

**Why this task is a single commit:** the changes touch one file in three logical sections (pre-loop setup, cursor body, post-loop tail). The ESLint config has `@typescript-eslint/no-unused-vars: "error"`, so any intermediate commit that introduces `jsonlWs` / `jsonlPath` / `metaPath` without their consumers would hard-fail lint and violate the "every commit must pass lint" constraint. Landing all three sections together keeps every commit green.

**Files:**

- Modify: `src/components/chats-archive/archive-video.ts`
- No tests (per user constraints).

- [ ] **Step 1: Read the current file**

Read `src/components/chats-archive/archive-video.ts` (full file, 213 lines).

- [ ] **Step 2: Add the new imports**

Add the stream-finished helper after the existing `import fsp from "node:fs/promises";` line:

```ts
import { finished } from "node:stream/promises";
```

Add the shared summary builder + the `setIfDefine` utility after the existing `./templates/format.js` import:

```ts
import { setIfDefine } from "../../util.js";
import { buildVideoSummary } from "./build-video-summary.js";
```

Add `type` re-exports to each existing model import so the per-case casts in Step 7 can name the class. Change the existing default-only imports:

```ts
import ChatModel from "../../models/Chat.js";
import MembershipModel from "../../models/Membership.js";
import MembershipGiftModel from "../../models/MembershipGift.js";
import MembershipGiftPurchaseModel from "../../models/MembershipGiftPurchase.js";
import MilestoneModel from "../../models/Milestone.js";
import PollModel from "../../models/Poll.js";
import RaidModel from "../../models/Raid.js";
import SuperChatModel from "../../models/SuperChat.js";
import SuperStickerModel from "../../models/SuperSticker.js";
```

To:

```ts
import ChatModel, { type Chat } from "../../models/Chat.js";
import MembershipModel, { type Membership } from "../../models/Membership.js";
import MembershipGiftModel, {
  type MembershipGift,
} from "../../models/MembershipGift.js";
import MembershipGiftPurchaseModel, {
  type MembershipGiftPurchase,
} from "../../models/MembershipGiftPurchase.js";
import MilestoneModel, { type Milestone } from "../../models/Milestone.js";
import PollModel, { type Poll } from "../../models/Poll.js";
import RaidModel, { type Raid } from "../../models/Raid.js";
import SuperChatModel, { type SuperChat } from "../../models/SuperChat.js";
import SuperStickerModel, {
  type SuperSticker,
} from "../../models/SuperSticker.js";
```

`ChannelModel` is NOT imported here — channel resolution moves into `buildVideoSummary`, which the post-loop tail calls directly.

- [ ] **Step 3: Update the `archiveVideo` signature to an options bag**

Replace the existing export:

```ts
export async function archiveVideo(videoId: string, job?: Job): Promise<void> {
```

With:

```ts
export async function archiveVideo(
  videoId: string,
  { job, isDirect = false }: { job?: Job; isDirect?: boolean } = {}
): Promise<void> {
```

`isDirect` propagates from the two index generators (`genIndexFile`,
`genChannelIndexFile`) when the function is invoked from the dev runner
against a production Mongo; the cursor-tail `updateOne` (added in Step 6)
gates on `!isDirect` so a dev run cannot bump the persistent
`hbStats.chatsArchiveVersion`. The default `{ }` keeps the existing
production callers' ergonomics close to the old shape — only the agenda
shim in `src/components/chats-archive.ts` (which passes `job`) needs a
parallel update; see Step 9.

- [ ] **Step 4: Extend the raid cursor query**

Replace:

```ts
const raidCursor = RaidModel.find({ originVideoId: videoId })
  .sort({ timestamp: 1 })
  .setOptions({ readPreference: "secondaryPreferred" })
  .cursor();
```

With:

```ts
const raidCursor = RaidModel.find({
  $or: [{ originVideoId: videoId }, { sourceVideoId: videoId }],
})
  .sort({ timestamp: 1 })
  .setOptions({ readPreference: "secondaryPreferred" })
  .cursor();
```

- [ ] **Step 5: Expand `getOutputFilePath` to return all three paths**

Replace the existing helper (around lines 29–32):

```ts
function getOutputFilePath(video: DocumentType<Video>): string {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  return path.join(CHAT_ARCHIVE_DIR, getVideoPath(video));
}
```

With:

```ts
function getOutputFilePaths(video: DocumentType<Video>): {
  html: string;
  jsonl: string;
  meta: string;
} {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  return {
    html: path.join(CHAT_ARCHIVE_DIR, getVideoPath(video)),
    jsonl: path.join(CHAT_ARCHIVE_DIR, "data", "videos", `${video.id}.jsonl`),
    meta: path.join(
      CHAT_ARCHIVE_DIR,
      "data",
      "videos",
      `${video.id}.meta.json`
    ),
  };
}
```

This consolidates path construction in one place: the `CHAT_ARCHIVE_DIR` assert runs once and all three output paths share the same root resolution. The function name pluralizes to signal the change of return shape.

- [ ] **Step 6: Replace the pre-loop setup block**

Find lines 121–125 (the `outputFilePath` / `mkdir` / `createWriteStream` block). Replace:

```ts
const outputFilePath = getOutputFilePath(video);
await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });
const ws = fs.createWriteStream(`${outputFilePath}.tmp`, {
  encoding: "utf-8",
});
```

With:

```ts
const {
  html: outputFilePath,
  jsonl: jsonlPath,
  meta: metaPath,
} = getOutputFilePaths(video);

await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });
await fsp.mkdir(path.dirname(jsonlPath), { recursive: true });

await Promise.all([
  fsp.rm(`${outputFilePath}.tmp`, { force: true }),
  fsp.rm(`${jsonlPath}.tmp`, { force: true }),
  fsp.rm(`${metaPath}.tmp`, { force: true }),
]);

const ws = fs.createWriteStream(`${outputFilePath}.tmp`, {
  encoding: "utf-8",
});
const jsonlWs = fs.createWriteStream(`${jsonlPath}.tmp`, {
  encoding: "utf-8",
});
```

- [ ] **Step 7: Replace the cursor loop**

Find the loop starting `let no = 0;` (around line 187) through the `ws.end(tail);` (line 205) and the empty-archive / rename block (lines 207–212). Replace the entire block:

```ts
  let no = 0;
  for await (const doc of multiCursorOrderedPeek<ChatRowDoc>(
    ownerChatCursor,
    moderatorChatCursor,
    superChatCursor,
    superStickerCursor,
    membershipCursor,
    membershipGiftCursor,
    membershipGiftPurchaseCursor,
    milestoneCursor,
    pollCursor,
    raidCursor
  )) {
    no++;
    ws.write(await renderChatRow({ doc, no, video }));
    await job?.touch();
  }

  ws.end(tail);

  if (no === 0) {
    await fsp.unlink(`${outputFilePath}.tmp`);
    return;
  }
  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
}
```

With:

```ts
  let no = 0;
  const aggregates = {
    chatCount: 0,
    superChatCount: 0,
    superStickerCount: 0,
    membershipCount: 0,
    giftCount: 0,
    giftPurchaseCount: 0,
    totalGiftAmount: 0,
    milestoneCount: 0,
    pollCount: 0,
    raidCount: 0,
  };

  for await (const doc of multiCursorOrderedPeek<ChatRowDoc>(
    ownerChatCursor,
    moderatorChatCursor,
    superChatCursor,
    superStickerCursor,
    membershipCursor,
    membershipGiftCursor,
    membershipGiftPurchaseCursor,
    milestoneCursor,
    pollCursor,
    raidCursor
  )) {
    no++;
    ws.write(await renderChatRow({ doc, no, video }));

    const row = buildJsonlRow(doc, videoId);
    if (row) {
      jsonlWs.write(JSON.stringify(row) + "\n");
      bumpAggregate(aggregates, doc);
    }

    await job?.touch();
  }

  ws.end(tail);
  jsonlWs.end();
  await Promise.all([finished(ws), finished(jsonlWs)]);

  if (no === 0) {
    await Promise.all([
      fsp.rm(`${outputFilePath}.tmp`, { force: true }),
      fsp.rm(`${jsonlPath}.tmp`, { force: true }),
    ]);
    return;
  }

  const meta = {
    ...(await buildVideoSummary(video)),
    aggregates: {
      ...aggregates,
      currencyTable: currencies,
      jpyTotal: jpySum,
    },
  };

  await fsp.writeFile(`${metaPath}.tmp`, JSON.stringify(meta) + "\n", "utf-8");

  // Rename in three steps so SPA, which fetches meta.json first, never sees
  // meta.json without its sibling .jsonl in place at the final name.
  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
  await fsp.rename(`${jsonlPath}.tmp`, jsonlPath);
  await fsp.rename(`${metaPath}.tmp`, metaPath);

  if (!isDirect && (video.hbStats?.chatsArchiveVersion ?? 0) < 2) {
    await VideoModel.updateOne(
      { id: videoId },
      { $set: { "hbStats.chatsArchiveVersion": 2 } }
    );
  }
}
```

The `!isDirect` guard suppresses the Mongo write when the dev runner is
exercising `archiveVideo` against a production database (`isDirect=true`).
Local artifacts on disk are still produced; only the persistent
`chatsArchiveVersion` bump is skipped so a dev run cannot mutate the
deployed `Video` document's flag.

- [ ] **Step 8: Append helper functions at the bottom of the file**

After the closing `}` of `archiveVideo` (now the last function in the file), append:

```ts
type JsonlRow = { type: string; [key: string]: unknown };

function buildJsonlRow(doc: ChatRowDoc, videoId: string): JsonlRow | null {
  switch (doc.collection.name) {
    case "chats": {
      const d = doc as DocumentType<Chat>;
      return makeAuthorRow("chat", d, {
        message: d.message,
      });
    }
    case "superchats": {
      const d = doc as DocumentType<SuperChat>;
      return makeAuthorRow("superChat", d, {
        message: d.message,
        amount: d.amount,
        currency: d.currency,
        jpyAmount: d.jpyAmount,
        ...setIfDefine("significance", d.significance),
        ...setIfDefine("color", d.color),
      });
    }
    case "superstickers": {
      const d = doc as DocumentType<SuperSticker>;
      return makeAuthorRow("superSticker", d, {
        ...setIfDefine("text", d.text),
        image: d.image,
        amount: d.amount,
        currency: d.currency,
        jpyAmount: d.jpyAmount,
        ...setIfDefine("significance", d.significance),
        ...setIfDefine("color", d.color),
      });
    }
    case "memberships": {
      const d = doc as DocumentType<Membership>;
      return makeAuthorRow("membership", d, {
        ...setIfDefine("level", d.level),
        ...setIfDefine("since", d.since),
      });
    }
    case "membershipgifts": {
      const d = doc as DocumentType<MembershipGift>;
      return makeAuthorRow("membershipGift", d, {
        ...setIfDefine("senderName", d.senderName),
      });
    }
    case "membershipgiftpurchases": {
      const d = doc as DocumentType<MembershipGiftPurchase>;
      return makeAuthorRow("membershipGiftPurchase", d, {
        amount: d.amount,
      });
    }
    case "milestones": {
      const d = doc as DocumentType<Milestone>;
      return makeAuthorRow("milestone", d, {
        message: d.message,
        ...setIfDefine("level", d.level),
        ...setIfDefine("duration", d.duration),
        ...setIfDefine("since", d.since),
      });
    }
    case "polls": {
      const d = doc as DocumentType<Poll>;
      return {
        type: "poll",
        id: d.id,
        timestamp: d.updatedAt,
        ...setIfDefine("createdAt", d.createdAt),
        ...setIfDefine("question", d.question),
        choices: d.choices.map((c) => ({
          text: c.text,
          ...setIfDefine("voteRatio", c.voteRatio),
        })),
        ...setIfDefine("voteCount", d.voteCount),
      };
    }
    case "raids": {
      const d = doc as DocumentType<Raid>;
      if (d.originVideoId === videoId) {
        return {
          type: "raid",
          ...setIfDefine("id", d.id),
          timestamp: d.timestamp,
          ...setIfDefine("sourceVideoId", d.sourceVideoId),
          ...setIfDefine("sourceChannelId", d.sourceChannelId),
          sourceName: d.sourceName,
          ...setIfDefine("sourcePhoto", d.sourcePhoto),
        };
      }
      if (d.sourceVideoId === videoId) {
        return {
          type: "raidOutgoing",
          ...setIfDefine("id", d.id),
          timestamp: d.timestamp,
          originVideoId: d.originVideoId,
          ...setIfDefine("originChannelId", d.originChannelId),
          ...setIfDefine("originName", d.originName),
          ...setIfDefine("originPhoto", d.originPhoto),
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function makeAuthorRow(
  type: string,
  d: unknown,
  extra: Record<string, unknown>
): JsonlRow {
  const r = d as Record<string, unknown>;
  return {
    type,
    id: r.id as string,
    timestamp: r.timestamp as Date,
    ...setIfDefine("authorName", r.authorName),
    ...setIfDefine("authorPhoto", r.authorPhoto),
    authorChannelId: r.authorChannelId,
    authorType: r.authorType,
    ...setIfDefine("membership", r.membership),
    isVerified: r.isVerified,
    isOwner: r.isOwner,
    isModerator: r.isModerator,
    ...extra,
  };
}

function bumpAggregate(
  agg: {
    chatCount: number;
    superChatCount: number;
    superStickerCount: number;
    membershipCount: number;
    giftCount: number;
    giftPurchaseCount: number;
    totalGiftAmount: number;
    milestoneCount: number;
    pollCount: number;
    raidCount: number;
  },
  doc: ChatRowDoc
): void {
  switch (doc.collection.name) {
    case "chats":
      agg.chatCount++;
      break;
    case "superchats":
      agg.superChatCount++;
      break;
    case "superstickers":
      agg.superStickerCount++;
      break;
    case "memberships":
      agg.membershipCount++;
      break;
    case "membershipgifts":
      agg.giftCount++;
      break;
    case "membershipgiftpurchases": {
      const d = doc as DocumentType<MembershipGiftPurchase>;
      agg.giftPurchaseCount++;
      agg.totalGiftAmount += d.amount;
      break;
    }
    case "milestones":
      agg.milestoneCount++;
      break;
    case "polls":
      agg.pollCount++;
      break;
    case "raids":
      agg.raidCount++;
      break;
  }
}
```

Notes on serialization:

- All `Date` fields (per-row `timestamp`, poll `createdAt`, `meta.json` top-level date fields like `availableAt` / `scheduledStart`) are emitted as raw `Date` objects. `JSON.stringify` invokes `Date.prototype.toJSON` which returns the same ISO 8601 string as `Date.prototype.toISOString()` would. No custom serializer is used.
- `setIfDefine(key, value)` (imported from `../../util.js`) strips both `undefined` and `null` — Typegoose returns `undefined` for missing optionals, but lean/projected docs can surface `null`; either way the key is omitted.
- `buildJsonlRow` and `bumpAggregate` both switch on `doc.collection.name` so the discriminator logic stays in lock-step. Each case casts the input to its `DocumentType<Model>` so the extra-field construction and aggregate increment access typed fields (e.g. `d.amount: number`) without ad-hoc cast.
- `makeAuthorRow` accepts `d: unknown` and casts to `Record<string, unknown>` once internally so the seven author-bearing call sites pass the typed `d` directly with no boundary cast. The shared field names (`id`, `timestamp`, `authorName`, ...) make a typed parameter overconstrained for marginal gain.
- The first key of every row object is `type`. V8 preserves property insertion order in `JSON.stringify`, so SPA can parse `type` from the leading bytes.

- [ ] **Step 9: Update the agenda-shim call site**

`src/components/chats-archive.ts` invokes `archiveVideo` in the
production agenda path with positional `(videoId, job)` args. Adjust it
to the new options-bag shape.

Replace:

```ts
await archiveVideo(videoId, job);
```

With:

```ts
await archiveVideo(videoId, { job });
```

- [ ] **Step 10: Validate**

Run in parallel:

```bash
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all three exit 0. If `format:check` complains, run `npm run format` then re-run.

- [ ] **Step 11: Commit**

```bash
git add src/components/chats-archive/archive-video.ts
git commit -m "$(cat <<'EOF'
feat(chats-archive): emit JSONL, meta.json, and bump archive version

Per-video archive run now writes three artifacts atomically:
- {channelId}/{date}_{videoId}.html (existing behavior preserved)
- data/videos/{videoId}.jsonl (one chat row per line)
- data/videos/{videoId}.meta.json (VideoSummary shape + aggregates)

Behavior changes inside archiveVideo:
- Raid cursor query extends to $or [originVideoId, sourceVideoId] so
  outgoing raids reach the loop. HTML renders both directions via the
  updated RaidCells template; JSONL splits into raid / raidOutgoing.
- Aggregates (chatCount, superChatCount, ..., totalGiftAmount, raidCount)
  are computed in the cursor loop and embedded in meta.json alongside
  the precomputed currencyTable / jpyTotal.
- Stale .tmp siblings from prior failed runs are removed before opening
  write streams.
- Three renames happen in order: .html, then .jsonl, then .meta.json
  (SPA fetches meta.json first; the order guarantees .jsonl is at its
  final name when meta.json appears).
- After all renames succeed, Video.hbStats.chatsArchiveVersion is set
  to 2 via Model.updateOne. The write is skipped when the in-memory
  loaded value is already >= 2 (no redundant Mongo round trips) or
  when archiveVideo was invoked with isDirect=true (dev-runner mode
  must not mutate production Video flags).
- archiveVideo signature shifts to an options bag
  (videoId, { job, isDirect }). The agenda shim in chats-archive.ts
  updates its single call site to the new shape.

EOF
)"
```

---

## Task 5: Write `data/index.json` from `genIndexFile`

**Files:**

- Modify: `src/components/chats-archive/gen-index-file.ts`
- No tests (per user constraints).

- [ ] **Step 1: Read the current file**

Read `src/components/chats-archive/gen-index-file.ts` (full file, 102 lines).

- [ ] **Step 2: Add the import**

After the existing `import { renderVideoCard } from "./templates/VideoCard.js";` line, insert:

```ts
import { buildVideoSummary } from "./build-video-summary.js";
```

- [ ] **Step 3: Initialize summary arrays alongside `channelIds`**

Replace:

```ts
const channelIds = new Set<string>();
```

With:

```ts
const channelIds = new Set<string>();
const liveSummaries: Array<Record<string, unknown>> = [];
const pastSummaries: Array<Record<string, unknown>> = [];
```

- [ ] **Step 4: Collect summaries inside both `for await` loops**

In the **first** loop (live videos), the body currently ends with:

```ts
ws.write(
  await renderVideoCard({
    video,
    channel: await video.getChannel(),
    basePath: "",
    hbStats: video.hbStats,
  })
);
if (isDirect) await archiveVideo(video.id);
```

Insert a new line **immediately after** `ws.write(...)` (still inside the loop body, before the `if (isDirect) ...`):

```ts
liveSummaries.push(await buildVideoSummary(video));
```

In the **second** loop (past / recently-ended videos), the body ends with the analogous block. Insert in the same position:

```ts
pastSummaries.push(await buildVideoSummary(video));
```

Both `if (isDirect) await archiveVideo(video.id);` lines (one per loop)
must also be updated to pass the options-bag form so the dev runner's
`isDirect` flag propagates into `archiveVideo`. Replace each occurrence
of:

```ts
if (isDirect) await archiveVideo(video.id);
```

With:

```ts
if (isDirect) await archiveVideo(video.id, { isDirect: true });
```

- [ ] **Step 5: Write `data/index.json` after the loops, before the per-channel iteration**

Replace:

```ts
  ws.end(tail);
  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);

  for (const channelId of channelIds) {
```

With:

```ts
  ws.end(tail);

  const dataIndexPath = path.join(CHAT_ARCHIVE_DIR, "data", "index.json");
  await fsp.mkdir(path.dirname(dataIndexPath), { recursive: true });
  await fsp.rm(`${dataIndexPath}.tmp`, { force: true });
  await fsp.writeFile(
    `${dataIndexPath}.tmp`,
    JSON.stringify({ live: liveSummaries, past: pastSummaries }) + "\n",
    "utf-8"
  );

  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
  await fsp.rename(`${dataIndexPath}.tmp`, dataIndexPath);

  for (const channelId of channelIds) {
```

- [ ] **Step 6: Validate**

Run in parallel:

```bash
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all three exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/chats-archive/gen-index-file.ts
git commit -m "$(cat <<'EOF'
feat(chats-archive): write data/index.json alongside index.html

Same loops over live + past videos now collect VideoSummary entries
via buildVideoSummary; after the HTML index closes, writes
data/index.json with { live, past } arrays. Both file renames run in
order .html then .json so the legacy HTML artifact stays the primary
fallback if the JSON write fails.

EOF
)"
```

---

## Task 6: Write `data/channels/{channelId}.json` from `genChannelIndexFile`

**Files:**

- Modify: `src/components/chats-archive/gen-channel-index-file.ts`
- No tests (per user constraints).

- [ ] **Step 1: Read the current file**

Read `src/components/chats-archive/gen-channel-index-file.ts` (full file, 65 lines).

- [ ] **Step 2: Add the import**

After the existing `import { renderVideoCard } from "./templates/VideoCard.js";` line, insert:

```ts
import { buildVideoSummary } from "./build-video-summary.js";
```

- [ ] **Step 3: Initialize `summaries` alongside `count`**

Replace:

```ts
let count = 0;
```

With:

```ts
let count = 0;
const summaries: Array<Record<string, unknown>> = [];
```

- [ ] **Step 4: Collect summaries inside the `for await` loop**

Inside the loop body, immediately after `ws.write(await renderVideoCard({...}))` and before `if (isDirect) await archiveVideo(video.id)`, insert:

```ts
summaries.push(await buildVideoSummary(video));
```

Also update the `archiveVideo` call so the dev runner's `isDirect` flag
propagates into the inner archive run. Replace:

```ts
if (isDirect) await archiveVideo(video.id);
```

With:

```ts
if (isDirect) await archiveVideo(video.id, { isDirect: true });
```

- [ ] **Step 5: Replace the tail block**

Replace:

```ts
  ws.end(tail);

  if (count === 0) {
    await fsp.unlink(`${outputFilePath}.tmp`);
    return;
  }
  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
}
```

With:

```ts
  ws.end(tail);

  const dataChannelPath = path.join(
    CHAT_ARCHIVE_DIR,
    "data",
    "channels",
    `${channelId}.json`
  );
  await fsp.mkdir(path.dirname(dataChannelPath), { recursive: true });

  if (count === 0) {
    await Promise.all([
      fsp.rm(`${outputFilePath}.tmp`, { force: true }),
      fsp.rm(`${dataChannelPath}.tmp`, { force: true }),
    ]);
    return;
  }

  const channelOut: Record<string, unknown> = {
    id: channel.id,
    name: channel.name,
  };
  if (channel.avatarUrl !== undefined && channel.avatarUrl !== null) {
    channelOut.avatarUrl = channel.avatarUrl;
  }
  await fsp.rm(`${dataChannelPath}.tmp`, { force: true });
  await fsp.writeFile(
    `${dataChannelPath}.tmp`,
    JSON.stringify({ channel: channelOut, videos: summaries }) + "\n",
    "utf-8"
  );

  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
  await fsp.rename(`${dataChannelPath}.tmp`, dataChannelPath);
}
```

- [ ] **Step 6: Validate**

Run in parallel:

```bash
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all three exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/chats-archive/gen-channel-index-file.ts
git commit -m "$(cat <<'EOF'
feat(chats-archive): write data/channels/{channelId}.json

Per-channel JSON output mirrors the per-channel HTML — the existing
video loop now also collects VideoSummary entries. After both writes
complete, the .html is renamed first and the .json second. The
empty-channel branch unlinks both .tmp files.

EOF
)"
```

---

## Task 7: Final manual verification (USER ACTION)

This task does not execute any code changes. It documents the manual verification steps the user runs locally to confirm the implementation works end-to-end. The Implementer subagent should NOT mark this complete — it remains pending until the user confirms.

**Files:**

- None (verification only).

- [ ] **Step 1: Pre-flight environment**

Ensure local Mongo replica set is running and `MONGO_URI` is set in `.env`. `CHAT_ARCHIVE_DIR` should point to a writable empty directory (e.g. `/tmp/chats-archive-new`).

- [ ] **Step 2: Build and run**

```bash
npm run build
CHAT_ARCHIVE_DIR=/tmp/chats-archive-new node --env-file=.env dist/components/chats-archive.js
```

Expected: dev runner walks live + past videos, produces three artifact families.

- [ ] **Step 3: Verify file presence**

```bash
ls -la /tmp/chats-archive-new/
ls -la /tmp/chats-archive-new/data/
ls -la /tmp/chats-archive-new/data/videos/ | head
ls -la /tmp/chats-archive-new/data/channels/ | head
```

Expected: `index.html`, `index.json` under `data/`, per-channel HTML in `{channelId}/index.html`, per-channel JSON in `data/channels/{channelId}.json`, per-video HTML in `{channelId}/{date}_{videoId}.html`, per-video JSONL + meta in `data/videos/{videoId}.{jsonl,meta.json}`.

- [ ] **Step 4: Verify JSONL row count vs meta aggregates**

Pick one video with substantial chat:

```bash
VID=<videoId>
LINES=$(wc -l < /tmp/chats-archive-new/data/videos/${VID}.jsonl)
echo "JSONL lines: $LINES"
jq '.aggregates | .chatCount + .superChatCount + .superStickerCount + .membershipCount + .giftCount + .giftPurchaseCount + .milestoneCount + .pollCount + .raidCount' /tmp/chats-archive-new/data/videos/${VID}.meta.json
```

Expected: both numbers equal.

- [ ] **Step 5: Verify no internal field leaks**

```bash
grep -E '"(hbStats|hbStatus|hbStart|hbEnd|hbCleanedAt|hbErrorCode|hbReplica|hbRecordReplay|hbIgnore|isReplay|originVideoId|originChannelId)"' /tmp/chats-archive-new/data/videos/${VID}.jsonl | head
```

Expected: zero hits (note: `originVideoId` is allowed inside `raidOutgoing` rows; if the grep returns lines, confirm they all come from `raidOutgoing` and refer to the destination video, not the current video).

- [ ] **Step 6: Verify first key is `type` and per-type field set**

```bash
head -5 /tmp/chats-archive-new/data/videos/${VID}.jsonl | jq -r 'keys[0]'
```

Expected: five `type` lines.

Spot-check field sets:

```bash
jq -c 'select(.type == "chat") | keys' /tmp/chats-archive-new/data/videos/${VID}.jsonl | sort -u | head -3
jq -c 'select(.type == "superChat") | keys' /tmp/chats-archive-new/data/videos/${VID}.jsonl | sort -u | head -3
jq -c 'select(.type == "membership") | keys' /tmp/chats-archive-new/data/videos/${VID}.jsonl | sort -u | head -3
```

Expected: each row-type's key set matches the spec's per-type field list — no missing required field, no extra fields beyond what the spec lists.

- [ ] **Step 7: Verify currency table and jpy total**

```bash
jq '.aggregates.currencyTable, .aggregates.jpyTotal' /tmp/chats-archive-new/data/videos/${VID}.meta.json
```

Expected: open the corresponding `{channelId}/{date}_{videoId}.html` in a browser, find the currency table at the top, and confirm: each `currency / amount / jpyAmount` row matches a row in the JSON `currencyTable`; `jpyTotal` matches the HTML's "sum (JPY)" total cell.

- [ ] **Step 8: Verify raid + raidOutgoing dispatch**

```bash
jq -c 'select(.type == "raid" or .type == "raidOutgoing")' /tmp/chats-archive-new/data/videos/${VID}.jsonl
```

If output exists, inspect at least one of each type: `raid` rows have `sourceName` plus optional `sourcePhoto / sourceVideoId / sourceChannelId`; `raidOutgoing` rows have `originVideoId` plus optional `originName / originPhoto / originChannelId`.

- [ ] **Step 9: Verify empty-archive cleanup**

Pick a video with zero matching chat in Mongo, then invoke `archiveVideo(videoId)` directly (e.g. via a one-off dev-runner script). Confirm:

- No `.html`, `.jsonl`, `.meta.json`, or `.tmp` files exist for that video under `{channelId}/` or `data/videos/`.
- `Video.hbStats.chatsArchiveVersion` for it remains undefined (or its prior value).

- [ ] **Step 10: Verify rename order and version bump**

After a normal `archiveVideo` run for a freshly archived video:

```bash
ls -la /tmp/chats-archive-new/<channelId>/<date>_${VID}.html /tmp/chats-archive-new/data/videos/${VID}.jsonl /tmp/chats-archive-new/data/videos/${VID}.meta.json
stat -f '%m %N' /tmp/chats-archive-new/data/videos/${VID}.meta.json /tmp/chats-archive-new/data/videos/${VID}.jsonl
```

Expected: all three files exist, no `.tmp` siblings. `meta.json` mtime ≥ `.jsonl` mtime.

In `mongosh`:

```js
db.videos.findOne({ id: "<videoId>" }, { "hbStats.chatsArchiveVersion": 1 });
```

Expected: `chatsArchiveVersion` is **unchanged** (likely `undefined` or
the prior value) — the dev runner invokes `archiveVideo` with
`isDirect=true`, which intentionally suppresses the `updateOne` so a
local test cannot mutate the deployed Video flag.

To validate the bump path itself, run a one-off Node invocation that
calls `archiveVideo` without `isDirect`:

```bash
CHAT_ARCHIVE_DIR=/tmp/chats-archive-new node --env-file=.env -e "import('./dist/components/chats-archive/archive-video.js').then(m => m.archiveVideo('<videoId>'))"
```

After that command completes, re-query Mongo and confirm
`chatsArchiveVersion: 2`.

- [ ] **Step 11: Verify `index.json` and channel JSON contents**

```bash
jq '.live | length, .past | length' /tmp/chats-archive-new/data/index.json
jq '.live[0]' /tmp/chats-archive-new/data/index.json
jq '.channel, (.videos | length)' /tmp/chats-archive-new/data/channels/<channelId>.json
jq '.videos[0] | {id, archiveVersion, stats}' /tmp/chats-archive-new/data/channels/<channelId>.json
```

Expected:

- `live` + `past` lengths match the live + past sections of `index.html`.
- A freshly archived video shows `archiveVersion: 2`; a legacy video (not re-archived under this change) shows `archiveVersion: 1`.
- `stats.superChatTotalJpy / memberCount / giftCount` match the "SC / Members / Gifts" numbers in that video's HTML card footer on the channel page.

- [ ] **Step 12: Verify idempotency (re-run on a v2 video)**

```bash
cp /tmp/chats-archive-new/data/videos/${VID}.jsonl /tmp/${VID}.jsonl.before
cp /tmp/chats-archive-new/data/videos/${VID}.meta.json /tmp/${VID}.meta.json.before
```

In `mongosh` start the profiler:

```js
db.setProfilingLevel(2);
```

Re-run `archiveVideo` for that video **without** `isDirect` (the dev
runner's `isDirect=true` always skips the `updateOne`, so it cannot
validate the skip-if-v2 path):

```bash
CHAT_ARCHIVE_DIR=/tmp/chats-archive-new node --env-file=.env -e "import('./dist/components/chats-archive/archive-video.js').then(m => m.archiveVideo('${VID}'))"
```

After completion:

```bash
cmp /tmp/${VID}.jsonl.before /tmp/chats-archive-new/data/videos/${VID}.jsonl
cmp /tmp/${VID}.meta.json.before /tmp/chats-archive-new/data/videos/${VID}.meta.json
```

Expected: both `cmp` calls exit 0 (no output) — content is byte-identical when no new chat has arrived.

In `mongosh`:

```js
db.system.profile
  .find({
    ns: "<dbname>.videos",
    op: "update",
    "command.u.$set": { $exists: true },
  })
  .sort({ ts: -1 })
  .limit(5)
  .pretty();
```

Expected: no `updateOne` against the `videos` collection setting `hbStats.chatsArchiveVersion` for any video that was already at v2 before the re-run.

- [ ] **Step 13: Verify stray `.tmp` cleanup**

```bash
touch /tmp/chats-archive-new/data/videos/<videoId>.jsonl.tmp
```

Re-run `archiveVideo` for that videoId. Confirm:

- The stray `.tmp` is gone after the run.
- Only the three final-name files remain for that video.

- [ ] **Step 14: Report**

Once steps 1–13 pass, report success to the user. Any regression: capture the failing step output, report it, and STOP — do NOT mark the plan complete.
