# chats-archive JSONL Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add machine-readable JSONL + JSON outputs (`data/videos/{videoId}.{jsonl,meta.json}`, `data/index.json`, `data/channels/{channelId}.json`) to the manager's `chats-archive` component, alongside the existing HTML. A future SPA frontend (separate project, out of scope) will consume these artifacts.

**Architecture:** Additive-only changes to three control-layer files plus one Typegoose model field. Each `archiveVideo` run writes HTML + JSONL concurrently from the same merged cursor, then writes `meta.json`, then bumps `Video.hbStats.chatsArchiveVersion` to `2` (conditional skip when already `>= 2`). `genIndexFile` and `genChannelIndexFile` each gain one extra `JSON.stringify` write inside their existing video loops.

**Tech Stack:** TypeScript (NodeNext ESM), Typegoose 12 / mongoose 8.2.1, node `fs/promises` (`fs.rm`, `fs.rename`), existing `multiCursorOrderedPeek` helper. No new runtime dependencies.

**Reference:** [docs/superpowers/specs/2026-05-10-chats-archive-jsonl-output-design.md](../specs/2026-05-10-chats-archive-jsonl-output-design.md)

**User-imposed constraints:**

- No unit tests. Manual verification only at end of plan.
- Every code change must pass `npm run build`, `npm run lint`, `npm run format:check` before commit.
- No `git add -A` / `git add .` — stage by exact path.
- No `npm install` to "ensure" a version — verify presence in `node_modules` first.
- Code comments must not contain `§`, `spec`, `plan`, `Task N` or similar references back to this plan/spec.

---

## Pre-flight: Research mongoose `$set` dotted-path behavior

### Task 1: Verify mongoose dotted-path `$set` semantics

**Why this task exists:** The spec calls `VideoModel.updateOne({ id }, { $set: { "hbStats.chatsArchiveVersion": 2 } })` on documents where `hbStats` may be `undefined`. The CLAUDE.md global rule and the `chats-archive` spec both require verifying mongoose behavior against `node_modules/mongoose` (version pinned to `~8.2.0`, resolved to `8.2.1`) before coding. The implementer must NOT skip this step.

**Files:**

- Read: `node_modules/mongoose/lib/model.js` (search for `updateOne` / `castUpdate`)
- Read: `node_modules/mongoose/lib/helpers/update/castUpdate.js`
- No files modified in this task — produces a written research note that informs Task 5.

- [ ] **Step 1: Confirm mongoose version**

Run: `grep '"version"' node_modules/mongoose/package.json | head -1`

Expected output: `"version": "8.2.1",`

If the version is not 8.2.x, STOP and ask the user — the plan was written against 8.2.1 and behavior may differ.

- [ ] **Step 2: Dispatch a research subagent**

Use the Agent tool with `subagent_type: general-purpose`, `model: haiku`, and this prompt:

```
Read node_modules/mongoose source (version 8.2.1) and answer:

1. When calling Model.updateOne({ id: "VID" }, { $set: { "hbStats.chatsArchiveVersion": 2 } }) on a document whose `hbStats` is undefined (the parent sub-doc does not exist), does mongoose:
   (a) successfully create the parent sub-document and set the leaf value, OR
   (b) throw / reject because the parent path is missing, OR
   (c) silently no-op?

2. Does this $set operation trigger schema default population for the sibling fields of `hbStats` that have `default: 0` in the Typegoose @prop definition (e.g. `handled`, `errorCount`)? Or does it only write the explicitly-set leaf?

3. Are there any version-specific gotchas in mongoose 8.x for dotted-path $set on nested sub-documents (vs 7.x or 6.x)?

Look at lib/model.js (updateOne), lib/helpers/update/castUpdate.js, and any sub-doc cast helpers. Quote the relevant code (file:line). Do not rely on docs alone — read the source.

Return a ≤300-word report: behavior, citation, gotchas.
```

Save the subagent's report verbatim to a temporary file at the root of the repo, e.g. `/tmp/mongoose-set-research.md`, so Task 5 can reference it.

- [ ] **Step 3: Decision gate**

If the subagent confirms behavior (a) — `$set` on dotted path with undefined parent creates the parent and writes the leaf, no unwanted default population — proceed to Task 2.

If behavior is (b) or (c), STOP and update the spec §3.1 "Mongoose `$set` on dotted paths" section to describe the workaround (e.g. `findOneAndUpdate` with `upsert: false` plus a fallback `save()`, or a two-step `$setOnInsert` + `$set`), then return here.

- [ ] **Step 4: Commit research artifact**

```bash
# Only if the report is small (<5 KB) AND the user wants it in repo history;
# otherwise leave at /tmp/. Default: do NOT commit the research file.
```

No commit by default. Move to Task 2.

---

## Task 2: Add `chatsArchiveVersion` field to `Stats` sub-class

**Files:**

- Modify: `src/models/Video.ts` (lines 27–42, the `Stats` class)
- No tests (per user constraints).

- [ ] **Step 1: Read the current `Stats` class**

Run: Read `src/models/Video.ts` with `offset: 25, limit: 22`.

Expected: see the existing `Stats` class with `@prop` for `handled`, `errorCount`, `totalSuperChatAmountJpy`, `totalMembers`, `totalGifts`.

- [ ] **Step 2: Add the new property**

Edit `src/models/Video.ts`:

Replace:

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

(No `default` — undefined remains the legacy value for documents not yet re-archived under this change.)

- [ ] **Step 3: Validate**

Run in parallel:

```bash
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all three exit 0. If `format:check` complains, run `npm run format` and re-run `format:check`.

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

## Task 3: Extend raid cursor and add stale `.tmp` cleanup

**Files:**

- Modify: `src/components/chats-archive/archive-video.ts` (raid cursor at line 182–185; add cleanup at the top of `archiveVideo`)
- No tests (per user constraints).

- [ ] **Step 1: Read current `archive-video.ts`**

Read the full file (213 lines, single read OK).

- [ ] **Step 2: Extend the raid cursor query**

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

- [ ] **Step 3: Add stale `.tmp` cleanup near the top of `archiveVideo`**

Locate the block after `getOutputFilePath(video)` and `mkdir`, before the `createWriteStream` call (around lines 121–125):

```ts
const outputFilePath = getOutputFilePath(video);
await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });
const ws = fs.createWriteStream(`${outputFilePath}.tmp`, {
  encoding: "utf-8",
});
```

Replace with:

```ts
const outputFilePath = getOutputFilePath(video);
const jsonlPath = path.join(
  CHAT_ARCHIVE_DIR!,
  "data",
  "videos",
  `${videoId}.jsonl`
);
const metaPath = path.join(
  CHAT_ARCHIVE_DIR!,
  "data",
  "videos",
  `${videoId}.meta.json`
);
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

The `!` after `CHAT_ARCHIVE_DIR` is safe because the `assert(CHAT_ARCHIVE_DIR, ...)` at the top of `getOutputFilePath` runs before this code; if the constant were null we would have already thrown. (If TypeScript complains about the non-null assertion under strict mode, add an explicit assert just before the `path.join` calls.)

- [ ] **Step 4: Validate**

Run in parallel:

```bash
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all three exit 0. Note: the build will still compile because the next tasks add the consumers of `jsonlWs` / `jsonlPath` / `metaPath`; if any of those names triggers an unused-variable lint error, the lint will be re-checked at the end of Task 5 after they are consumed. For now expect `lint` to pass (unused locals are typically warn, not error) — if it errors, mark this task's `lint` step deferred until Task 5 lands.

- [ ] **Step 5: Commit**

```bash
git add src/components/chats-archive/archive-video.ts
git commit -m "$(cat <<'EOF'
feat(chats-archive): extend raid cursor and add tmp cleanup

Raid cursor now matches both originVideoId (incoming) and sourceVideoId
(outgoing) via $or. Outgoing raids will be consumed only by the JSONL
emitter to appear as raidOutgoing rows; HTML emission of outgoing raids
will be skipped in the next task to avoid self-referential rows.

Also unlink any leftover .tmp siblings before opening write streams so
a prior partially-failed run cannot leak state.

EOF
)"
```

---

## Task 4: Cursor-loop body — HTML outgoing-raid skip, JSONL emit, chat dedup, raid dispatch, aggregates

**Files:**

- Modify: `src/components/chats-archive/archive-video.ts` (cursor `for await` loop near lines 187–203)
- No tests (per user constraints).

- [ ] **Step 1: Add aggregate counters and dedup set before the `for await`**

Locate the `let no = 0;` line (around line 187). Replace:

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
```

With:

```ts
let no = 0;
const seenChatIds = new Set<string>();
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
  const collectionName = (doc as { collection: { name: string } }).collection
    .name;

  // Chat dedup: owner + moderator cursors can return the same document.
  if (collectionName === "chats") {
    const chatId = (doc as { id: string }).id;
    if (seenChatIds.has(chatId)) continue;
    seenChatIds.add(chatId);
  }

  // HTML side: skip outgoing raids (originVideoId !== videoId) so the
  // existing RaidCells does not produce self-referential rows.
  const isOutgoingRaid =
    collectionName === "raids" &&
    (doc as { originVideoId?: string }).originVideoId !== videoId;
  if (!isOutgoingRaid) {
    no++;
    ws.write(await renderChatRow({ doc, no, video }));
  }

  // JSONL side: emit the row in the schema documented at the top of
  // this file (see top-of-file JSDoc — to be added in Task 5).
  const row = buildJsonlRow(doc, collectionName, videoId);
  if (row) {
    jsonlWs.write(JSON.stringify(row) + "\n");
    bumpAggregate(aggregates, row.type, doc);
  }

  await job?.touch();
}
```

- [ ] **Step 2: Add the two private helper functions and per-type row builders**

Append the following functions at the bottom of `src/components/chats-archive/archive-video.ts` (after the closing `}` of `archiveVideo`):

```ts
type JsonlRow = { type: string; [key: string]: unknown };

function buildJsonlRow(
  doc: unknown,
  collectionName: string,
  videoId: string
): JsonlRow | null {
  switch (collectionName) {
    case "chats":
      return makeAuthorRow("chat", doc as Record<string, unknown>, {
        message: (doc as { message: string }).message,
      });
    case "superchats": {
      const d = doc as Record<string, unknown>;
      return makeAuthorRow("superChat", d, {
        message: d.message as string | null,
        amount: d.amount,
        currency: d.currency,
        jpyAmount: d.jpyAmount,
        ...optional("significance", d.significance),
        ...optional("color", d.color),
      });
    }
    case "superstickers": {
      const d = doc as Record<string, unknown>;
      return makeAuthorRow("superSticker", d, {
        ...optional("text", d.text),
        image: d.image,
        amount: d.amount,
        currency: d.currency,
        jpyAmount: d.jpyAmount,
        ...optional("significance", d.significance),
        ...optional("color", d.color),
      });
    }
    case "memberships": {
      const d = doc as Record<string, unknown>;
      return makeAuthorRow("membership", d, {
        ...optional("level", d.level),
        ...optional("since", d.since),
      });
    }
    case "membershipgifts": {
      const d = doc as Record<string, unknown>;
      return makeAuthorRow("membershipGift", d, {
        ...optional("senderName", d.senderName),
      });
    }
    case "membershipgiftpurchases": {
      const d = doc as Record<string, unknown>;
      return makeAuthorRow("membershipGiftPurchase", d, {
        amount: d.amount,
      });
    }
    case "milestones": {
      const d = doc as Record<string, unknown>;
      return makeAuthorRow("milestone", d, {
        message: d.message as string | null,
        ...optional("level", d.level),
        ...optional("duration", d.duration),
        ...optional("since", d.since),
      });
    }
    case "polls": {
      const d = doc as Record<string, unknown> & {
        choices: Array<{ text: string; voteRatio?: number }>;
      };
      const row: JsonlRow = {
        type: "poll",
        id: d.id as string,
        timestamp: (d.updatedAt as Date).toISOString(),
        ...optional(
          "createdAt",
          d.createdAt instanceof Date
            ? (d.createdAt as Date).toISOString()
            : undefined
        ),
        ...optional("question", d.question),
        choices: d.choices.map((c) => ({
          text: c.text,
          ...optional("voteRatio", c.voteRatio),
        })),
        ...optional("voteCount", d.voteCount),
      };
      return row;
    }
    case "raids": {
      const d = doc as Record<string, unknown>;
      const origin = d.originVideoId as string | undefined;
      const source = d.sourceVideoId as string | undefined;
      if (origin === videoId) {
        return {
          type: "raid",
          ...optional("id", d.id),
          timestamp: (d.timestamp as Date).toISOString(),
          ...optional("sourceVideoId", d.sourceVideoId),
          ...optional("sourceChannelId", d.sourceChannelId),
          sourceName: d.sourceName,
          ...optional("sourcePhoto", d.sourcePhoto),
        };
      }
      if (source === videoId) {
        return {
          type: "raidOutgoing",
          ...optional("id", d.id),
          timestamp: (d.timestamp as Date).toISOString(),
          originVideoId: d.originVideoId,
          ...optional("originChannelId", d.originChannelId),
          ...optional("originName", d.originName),
          ...optional("originPhoto", d.originPhoto),
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
  d: Record<string, unknown>,
  extra: Record<string, unknown>
): JsonlRow {
  return {
    type,
    id: d.id as string,
    timestamp: (d.timestamp as Date).toISOString(),
    ...optional("authorName", d.authorName),
    ...optional("authorPhoto", d.authorPhoto),
    authorChannelId: d.authorChannelId,
    authorType: d.authorType,
    ...optional("membership", d.membership),
    isVerified: d.isVerified,
    isOwner: d.isOwner,
    isModerator: d.isModerator,
    ...extra,
  };
}

function optional<K extends string>(
  key: K,
  value: unknown
): Partial<Record<K, unknown>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, unknown>);
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
  type: string,
  doc: unknown
): void {
  switch (type) {
    case "chat":
      agg.chatCount++;
      break;
    case "superChat":
      agg.superChatCount++;
      break;
    case "superSticker":
      agg.superStickerCount++;
      break;
    case "membership":
      agg.membershipCount++;
      break;
    case "membershipGift":
      agg.giftCount++;
      break;
    case "membershipGiftPurchase":
      agg.giftPurchaseCount++;
      agg.totalGiftAmount += (doc as { amount: number }).amount;
      break;
    case "milestone":
      agg.milestoneCount++;
      break;
    case "poll":
      agg.pollCount++;
      break;
    case "raid":
    case "raidOutgoing":
      agg.raidCount++;
      break;
  }
}
```

- [ ] **Step 3: Validate**

Run in parallel:

```bash
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all three exit 0. If lint complains about `optional` returning a wide type, the cast inside is intentional (we're constructing a record dynamically). Adjust the helper signature only if the linter actively errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/chats-archive/archive-video.ts
git commit -m "$(cat <<'EOF'
feat(chats-archive): emit JSONL rows alongside HTML

For each row in the merged cursor:
- Dedup chats by id (owner+moderator cursors can overlap)
- Skip HTML emission for outgoing raids (originVideoId !== videoId)
- Emit one JSONL line in the documented per-type shape
- Dispatch raid docs to either `raid` or `raidOutgoing` based on which
  side of the raid matches the current video
- Maintain an in-memory aggregates object for meta.json

EOF
)"
```

---

## Task 5: Write `meta.json`, reorder renames, empty-archive parity, version bump

**Files:**

- Modify: `src/components/chats-archive/archive-video.ts` (the tail of `archiveVideo` from `ws.end(tail);` onward — currently lines 205–212)
- Modify: `src/components/chats-archive/archive-video.ts` (imports — add ChannelModel if not already imported)
- No tests (per user constraints).

- [ ] **Step 1: Confirm Channel import**

Run: `grep -n 'ChannelModel\|from "../../models/Channel' src/components/chats-archive/archive-video.ts`

If `ChannelModel` is not imported, you'll add the import in Step 3. If it is imported, skip the import addition.

- [ ] **Step 2: Read the current tail block**

Read `src/components/chats-archive/archive-video.ts` with `offset: 200, limit: 13`.

Expected current content:

```ts
  ws.end(tail);

  if (no === 0) {
    await fsp.unlink(`${outputFilePath}.tmp`);
    return;
  }
  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
}
```

- [ ] **Step 3: Add Channel import (only if missing per Step 1)**

If `ChannelModel` is not yet imported, insert near the other model imports:

```ts
import ChannelModel from "../../models/Channel.js";
```

(Place it alphabetically — between `ChatModel` and `MembershipModel`.)

- [ ] **Step 4: Replace the tail block**

Replace the block in Step 2 with:

```ts
  ws.end(tail);
  jsonlWs.end();

  if (no === 0) {
    await Promise.all([
      fsp.rm(`${outputFilePath}.tmp`, { force: true }),
      fsp.rm(`${jsonlPath}.tmp`, { force: true }),
    ]);
    return;
  }

  const channel = await ChannelModel.findByChannelId(video.channelId);
  const meta = {
    video: stripUndefined({
      id: video.id,
      title: video.title,
      channelId: video.channelId,
      description: video.description,
      status: video.status,
      duration: video.duration,
      availableAt: video.availableAt.toISOString(),
      scheduledStart: video.scheduledStart?.toISOString(),
      actualStart: video.actualStart?.toISOString(),
      actualEnd: video.actualEnd?.toISOString(),
      publishedAt: video.publishedAt?.toISOString(),
    }),
    channel: channel
      ? stripUndefined({
          id: channel.id,
          name: channel.name,
          avatarUrl: channel.avatarUrl,
        })
      : { id: video.channelId, name: video.channelId },
    aggregates: {
      ...aggregates,
      currencyTable: currencies,
      jpyTotal: jpySum,
    },
  };

  await fsp.writeFile(`${metaPath}.tmp`, JSON.stringify(meta) + "\n", "utf-8");

  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
  await fsp.rename(`${jsonlPath}.tmp`, jsonlPath);
  await fsp.rename(`${metaPath}.tmp`, metaPath);

  if ((video.hbStats?.chatsArchiveVersion ?? 0) < 2) {
    await VideoModel.updateOne(
      { id: videoId },
      { $set: { "hbStats.chatsArchiveVersion": 2 } }
    );
  }
}
```

- [ ] **Step 5: Add the `stripUndefined` helper**

Append at the very bottom of the file (after the helpers added in Task 4):

```ts
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k as keyof T] = v as T[keyof T];
  }
  return out;
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
git add src/components/chats-archive/archive-video.ts
git commit -m "$(cat <<'EOF'
feat(chats-archive): write meta.json and bump archive version

After the cursor loop:
- Close jsonlWs
- On empty archive (no === 0): unlink both .tmp files, no meta written
- Otherwise: build meta.json (video + channel + aggregates + currency
  table) and write it to .tmp
- Rename .html → .jsonl → .meta.json in that order so SPA can fetch
  meta.json first and trust the corresponding .jsonl is already at its
  final name
- Bump Video.hbStats.chatsArchiveVersion to 2 if the in-memory value
  is < 2; skip the Mongo write when already at or above 2

EOF
)"
```

---

## Task 6: Write `data/index.json` from `genIndexFile`

**Files:**

- Modify: `src/components/chats-archive/gen-index-file.ts`
- No tests (per user constraints).

- [ ] **Step 1: Read the current file**

Read all 102 lines.

- [ ] **Step 2: Collect video summaries while iterating**

Find the line `const channelIds = new Set<string>();` (line 28). Replace with:

```ts
const channelIds = new Set<string>();
const liveSummaries: Array<Record<string, unknown>> = [];
const pastSummaries: Array<Record<string, unknown>> = [];
```

In the first `for await` block (live videos), find the `ws.write(...)` call. Immediately after that `ws.write` (still inside the `for` body, before the `if (isDirect) await archiveVideo(...)`), insert:

```ts
liveSummaries.push(await buildVideoSummary(video));
```

In the second `for await` block (past videos), do the same — insert after `ws.write(...)` and before the `archiveVideo` call:

```ts
pastSummaries.push(await buildVideoSummary(video));
```

- [ ] **Step 3: Write `data/index.json` after both loops, before the channel loop**

Find the line `ws.end(tail);` followed by the rename. Replace:

```ts
ws.end(tail);
await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
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
```

- [ ] **Step 4: Add `buildVideoSummary` helper at the bottom of the file**

Append after the closing `}` of `genIndexFile`:

```ts
async function buildVideoSummary(
  video: Awaited<ReturnType<typeof VideoModel.findByVideoId>>
): Promise<Record<string, unknown>> {
  if (!video) return {};
  const channel = await video.getChannel();
  const summary: Record<string, unknown> = {
    id: video.id,
    title: video.title,
    channelId: video.channelId,
    channel: channel
      ? {
          id: channel.id,
          name: channel.name,
          ...(channel.avatarUrl !== undefined
            ? { avatarUrl: channel.avatarUrl }
            : {}),
        }
      : { id: video.channelId, name: video.channelId },
    status: video.status,
    ...(video.scheduledStart !== undefined
      ? { scheduledStart: video.scheduledStart.toISOString() }
      : {}),
    availableAt: video.availableAt.toISOString(),
    archiveVersion: video.hbStats?.chatsArchiveVersion ?? 1,
    stats: {
      superChatTotalJpy: video.hbStats?.totalSuperChatAmountJpy ?? 0,
      memberCount: video.hbStats?.totalMembers ?? 0,
      giftCount: video.hbStats?.totalGifts ?? 0,
    },
  };
  return summary;
}
```

- [ ] **Step 5: Validate**

Run in parallel:

```bash
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all three exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/components/chats-archive/gen-index-file.ts
git commit -m "$(cat <<'EOF'
feat(chats-archive): write data/index.json alongside index.html

Same loop now collects a per-video summary while emitting HTML cards;
after the loops finish, writes data/index.json with { live, past }
arrays of VideoSummary. Summary includes archiveVersion (sourced from
Video.hbStats.chatsArchiveVersion, defaulting to 1) so the SPA can
branch between legacy HTML and new JSON artifacts.

EOF
)"
```

---

## Task 7: Write `data/channels/{channelId}.json` from `genChannelIndexFile`

**Files:**

- Modify: `src/components/chats-archive/gen-channel-index-file.ts`
- No tests (per user constraints).

- [ ] **Step 1: Read the current file**

Read all 65 lines.

- [ ] **Step 2: Add summary collection and JSON write**

Find the line `let count = 0;` (line 31). Replace with:

```ts
let count = 0;
const summaries: Array<Record<string, unknown>> = [];
```

Inside the `for await` block, immediately after the `ws.write(...)` call and before the `if (isDirect) await archiveVideo(...)`, insert:

```ts
summaries.push(await buildVideoSummary(video));
```

Replace the tail block:

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

  const channelJson = {
    channel: {
      id: channel.id,
      name: channel.name,
      ...(channel.avatarUrl !== undefined
        ? { avatarUrl: channel.avatarUrl }
        : {}),
    },
    videos: summaries,
  };
  await fsp.rm(`${dataChannelPath}.tmp`, { force: true });
  await fsp.writeFile(
    `${dataChannelPath}.tmp`,
    JSON.stringify(channelJson) + "\n",
    "utf-8"
  );

  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
  await fsp.rename(`${dataChannelPath}.tmp`, dataChannelPath);
}
```

- [ ] **Step 3: Add a private copy of `buildVideoSummary`**

Append the same `buildVideoSummary` helper used in Task 6, at the bottom of `gen-channel-index-file.ts`. We deliberately duplicate the ~25-line function rather than extract a shared module: extracting would create a one-call-site logic-free wrapper (the helper is just a record builder and per the project's "avoid logic-free abstractions" rule, inline duplication is preferred at this size).

```ts
async function buildVideoSummary(
  video: Awaited<ReturnType<typeof VideoModel.findByVideoId>>
): Promise<Record<string, unknown>> {
  if (!video) return {};
  const channel = await video.getChannel();
  const summary: Record<string, unknown> = {
    id: video.id,
    title: video.title,
    channelId: video.channelId,
    channel: channel
      ? {
          id: channel.id,
          name: channel.name,
          ...(channel.avatarUrl !== undefined
            ? { avatarUrl: channel.avatarUrl }
            : {}),
        }
      : { id: video.channelId, name: video.channelId },
    status: video.status,
    ...(video.scheduledStart !== undefined
      ? { scheduledStart: video.scheduledStart.toISOString() }
      : {}),
    availableAt: video.availableAt.toISOString(),
    archiveVersion: video.hbStats?.chatsArchiveVersion ?? 1,
    stats: {
      superChatTotalJpy: video.hbStats?.totalSuperChatAmountJpy ?? 0,
      memberCount: video.hbStats?.totalMembers ?? 0,
      giftCount: video.hbStats?.totalGifts ?? 0,
    },
  };
  return summary;
}
```

- [ ] **Step 4: Validate**

Run in parallel:

```bash
npx tsc --noEmit
npm run lint
npm run format:check
```

Expected: all three exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/chats-archive/gen-channel-index-file.ts
git commit -m "$(cat <<'EOF'
feat(chats-archive): write data/channels/{channelId}.json

Per-channel JSON output mirrors per-channel HTML — same video loop now
collects summaries and writes a JSON object with channel info and the
videos[] list. Empty-channel branch unlinks both .tmp files.

EOF
)"
```

---

## Task 8: Final manual verification (USER ACTION)

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

- [ ] **Step 3: Verify file presence and structure**

```bash
ls -la /tmp/chats-archive-new/
ls -la /tmp/chats-archive-new/data/
ls -la /tmp/chats-archive-new/data/videos/ | head
ls -la /tmp/chats-archive-new/data/channels/ | head
```

Expected: `index.html`, `index.json` (under `data/`), per-channel HTML in `{channelId}/index.html`, per-channel JSON in `data/channels/{channelId}.json`, per-video HTML in `{channelId}/{date}_{videoId}.html`, per-video JSONL + meta in `data/videos/{videoId}.{jsonl,meta.json}`.

- [ ] **Step 4: Verify JSONL row count vs meta aggregates**

Pick one video with substantial chat:

```bash
VID=<videoId>
LINES=$(wc -l < /tmp/chats-archive-new/data/videos/${VID}.jsonl)
echo "JSONL lines: $LINES"
jq '.aggregates | .chatCount + .superChatCount + .superStickerCount + .membershipCount + .giftCount + .giftPurchaseCount + .milestoneCount + .pollCount + .raidCount' /tmp/chats-archive-new/data/videos/${VID}.meta.json
```

Expected: both numbers equal.

- [ ] **Step 5: Verify no `hb*` / `isReplay` / `originVideoId` / `originChannelId` leak**

```bash
grep -E '"(hbStats|hbStatus|isReplay|originVideoId|originChannelId)"' /tmp/chats-archive-new/data/videos/${VID}.jsonl | head
```

Expected: zero hits.

- [ ] **Step 6: Verify first key is `type`**

```bash
head -5 /tmp/chats-archive-new/data/videos/${VID}.jsonl | jq -r 'keys[0]'
```

Expected: five `type` lines.

- [ ] **Step 7: Verify raid + raidOutgoing dispatch**

```bash
jq -c 'select(.type == "raid" or .type == "raidOutgoing")' /tmp/chats-archive-new/data/videos/${VID}.jsonl
```

If output exists, inspect at least one of each type and confirm: `raid` has `sourceName` + `sourcePhoto`; `raidOutgoing` has `originVideoId` + `originName` + `originPhoto`.

- [ ] **Step 8: Verify chat dedup (owner+moderator overlap)**

If you can find a chat author in the Mongo data with both `isOwner: true` and `isModerator: true`:

```bash
jq -r 'select(.type == "chat" and .isOwner and .isModerator) | .id' /tmp/chats-archive-new/data/videos/${VID}.jsonl | sort -u | wc -l
jq -r 'select(.type == "chat" and .isOwner and .isModerator) | .id' /tmp/chats-archive-new/data/videos/${VID}.jsonl | wc -l
```

Expected: both numbers equal (no duplicate `id`s).

- [ ] **Step 9: Verify empty-archive cleanup**

Pick a video that has zero chat data in Mongo and run `archiveVideo` directly. Confirm no `.html`, `.jsonl`, `.meta.json`, or `.tmp` files appear for that video, and `Video.hbStats.chatsArchiveVersion` for it is NOT set to 2.

- [ ] **Step 10: Verify rename order and version bump**

After a normal `archiveVideo` run for a fresh video:

```bash
ls -la /tmp/chats-archive-new/<channelId>/<date>_<videoId>.html /tmp/chats-archive-new/data/videos/${VID}.jsonl /tmp/chats-archive-new/data/videos/${VID}.meta.json
stat -f '%m %N' /tmp/chats-archive-new/data/videos/${VID}.meta.json /tmp/chats-archive-new/data/videos/${VID}.jsonl
```

Expected: all three files exist, no `.tmp` siblings. `meta.json` mtime ≥ `.jsonl` mtime.

In `mongosh`:

```js
db.videos.findOne({ id: "<videoId>" }, { "hbStats.chatsArchiveVersion": 1 });
```

Expected: `chatsArchiveVersion: 2`.

- [ ] **Step 11: Verify `index.json` and channel JSON**

```bash
jq '.live | length, .past | length' /tmp/chats-archive-new/data/index.json
jq '.live[0]' /tmp/chats-archive-new/data/index.json
jq '.channel, (.videos | length)' /tmp/chats-archive-new/data/channels/<channelId>.json
```

Expected: counts match the HTML index page; `archiveVersion` is `2` for freshly archived videos, `1` for legacy.

- [ ] **Step 12: Verify idempotency — re-run on v2 video**

Re-run the dev runner. Enable Mongo profiler before the run:

```js
db.setProfilingLevel(2);
```

After the second run completes:

```js
db.system.profile
  .find({ ns: "<dbname>.videos", op: "update" })
  .sort({ ts: -1 })
  .limit(5)
  .pretty();
```

Expected: no `updateOne` against `videos` collection setting `hbStats.chatsArchiveVersion` for videos already at v2.

- [ ] **Step 13: Verify stray `.tmp` cleanup**

```bash
touch /tmp/chats-archive-new/data/videos/<videoId>.jsonl.tmp
```

Re-run `archiveVideo` for that videoId. After the run, confirm the stray `.tmp` is gone and only the three final-name files remain.

- [ ] **Step 14: Report to user**

Once steps 1–13 pass, report success. Any regression: file an issue with the specific failing step output and STOP — do NOT mark the plan complete.
