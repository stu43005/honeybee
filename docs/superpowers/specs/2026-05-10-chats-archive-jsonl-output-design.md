# chats-archive JSONL Output — Design Spec

Date: 2026-05-10
Topic: Add machine-readable JSON/JSONL outputs to `chats-archive` so a separate
SPA frontend (out of scope here) can render archives dynamically. Existing HTML
output is preserved unchanged for parallel operation.

---

## 1. Scope

In addition to the existing HTML files, the manager service writes three new
artifact types under `CHAT_ARCHIVE_DIR/data/`. The `data/videos/` and
`data/channels/` subtrees are flat (no channel/date prefix) so an SPA can
look up by `videoId` or `channelId` alone, without needing the channel
mapping the existing HTML paths embed:

```text
{CHAT_ARCHIVE_DIR}/
├── {channelId}/{date}_{videoId}.html        ← existing (untouched)
├── {channelId}/index.html                   ← existing (untouched)
├── index.html                               ← existing (untouched)
└── data/
    ├── index.json                           ← new
    ├── channels/{channelId}.json            ← new
    └── videos/
        ├── {videoId}.jsonl                  ← new (one chat row per line)
        └── {videoId}.meta.json              ← new
```

Out of scope:

- The SPA frontend itself (separate repo, separate deployment).
- S3 upload from manager: the existing `CHAT_ARCHIVE_DIR` cronjob handles sync;
  manager writes only to local disk.
- Backfill of historic archives: only newly archived videos (and the next
  scheduled regeneration of `index.json` / `channels/*.json`) get JSON output.
  Pre-existing HTML remains the only artifact for older videos.
- HTML deprecation: HTML is preserved indefinitely under this spec; removal is
  a future PR.

## 2. JSONL row schema (`data/videos/{videoId}.jsonl`)

Each line is a JSON object whose **first key is always `type`** (discriminator).
Fields mirror the corresponding Mongo doc but include only the subset the
existing HTML actually renders. The following fields are always omitted, even
if present on the source doc:

- `isReplay` — internal-only.
- `originVideoId`, `originChannelId` — videoId is implicit in the file name;
  channelId is in `meta.json`. Repeating per row is wasteful.
- All `hb*` fields — internal manager bookkeeping.

`timestamp` is serialized as an ISO 8601 string (the result of `Date.toISOString()`).

### 2.1 Common author fields

Applied to: `chat`, `superChat`, `superSticker`, `membership`,
`membershipGift`, `membershipGiftPurchase`, `milestone`.

| Field             | Type                                                          |
| ----------------- | ------------------------------------------------------------- |
| `id`              | `string`                                                      |
| `timestamp`       | ISO 8601 string                                               |
| `authorName?`     | `string`                                                      |
| `authorPhoto?`    | `string`                                                      |
| `authorChannelId` | `string`                                                      |
| `authorType`      | `"owner" \| "moderator" \| "member" \| "verified" \| "other"` |
| `membership?`     | `string`                                                      |
| `isVerified`      | `boolean`                                                     |
| `isOwner`         | `boolean`                                                     |
| `isModerator`     | `boolean`                                                     |

### 2.2 Per-type fields

| `type`                   | Additional fields                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `chat`                   | `message: string`                                                                                                                      |
| `superChat`              | `message: string \| null`, `amount: number`, `currency: string`, `jpyAmount: number`, `significance?: number`, `color?: string`        |
| `superSticker`           | `text?: string`, `image: string`, `amount: number`, `currency: string`, `jpyAmount: number`, `significance?: number`, `color?: string` |
| `membership`             | `level?: string`, `since?: string`                                                                                                     |
| `membershipGift`         | `senderName?: string`                                                                                                                  |
| `membershipGiftPurchase` | `amount: number` (gift count)                                                                                                          |
| `milestone`              | `message: string \| null`, `level?: string`, `duration?: number`, `since?: string`                                                     |

### 2.3 Types without common author fields

Polls and raids are not authored by a chat user; they have their own field set.

**`poll`**

| Field        | Type                                          |
| ------------ | --------------------------------------------- |
| `id`         | `string`                                      |
| `timestamp`  | ISO 8601 string (= `updatedAt`)               |
| `createdAt?` | ISO 8601 string                               |
| `question?`  | `string`                                      |
| `choices`    | `Array<{ text: string, voteRatio?: number }>` |
| `voteCount?` | `number`                                      |

**`raid`** — emitted when `doc.originVideoId === currentVideoId`
(raid received by this video). The `Raid.id` field is `string | undefined` on
the model, so `id` is optional here.

| Field              | Type            |
| ------------------ | --------------- |
| `id?`              | `string`        |
| `timestamp`        | ISO 8601 string |
| `sourceVideoId?`   | `string`        |
| `sourceChannelId?` | `string`        |
| `sourceName`       | `string`        |
| `sourcePhoto?`     | `string`        |

**`raidOutgoing`** — emitted when `doc.sourceVideoId === currentVideoId`
(raid sent from this video). Sourced from the same `Raid` model. This is a
new feature relative to the existing HTML, which renders only incoming raids;
to surface outgoing raids, the existing single-direction raid cursor must be
extended (see §5.1 step 4 for the query change).

| Field              | Type            |
| ------------------ | --------------- |
| `id?`              | `string`        |
| `timestamp`        | ISO 8601 string |
| `originVideoId`    | `string`        |
| `originChannelId?` | `string`        |
| `originName?`      | `string`        |
| `originPhoto?`     | `string`        |

If a `Raid` document matches both sides (would be unusual but theoretically
possible), it is emitted as `raid` (incoming takes precedence). If a document
matches neither side it is dropped (should not occur given the extended
query).

### 2.4 Row types not emitted, and discriminator mapping

The Mongo collections `BannerAction`, `ModeChange`, `Placeholder`,
`BanAction`, `RemoveChatAction` have no rendering in the existing HTML
(`ChatRow` dispatcher in `templates/VideoArchive.tsx` covers exactly the 9
types above) and are not emitted in JSONL.

`multiCursorOrderedPeek` yields raw Mongo documents with no `type` field; the
existing HTML dispatcher branches on `doc.collection.name`. The JSONL emit
branch uses the same property and maps it to the output `type` string:

| `doc.collection.name`     | JSONL `type`                                 |
| ------------------------- | -------------------------------------------- |
| `chats`                   | `chat`                                       |
| `superchats`              | `superChat`                                  |
| `superstickers`           | `superSticker`                               |
| `memberships`             | `membership`                                 |
| `membershipgifts`         | `membershipGift`                             |
| `membershipgiftpurchases` | `membershipGiftPurchase`                     |
| `milestones`              | `milestone`                                  |
| `polls`                   | `poll`                                       |
| `raids`                   | `raid` or `raidOutgoing` (per §2.3 dispatch) |

Any other collection name is dropped without emitting a row.

## 3. `data/videos/{videoId}.meta.json` schema

```jsonc
{
  "video": {
    "id": "...",
    "title": "...",
    "channelId": "...",
    "description?": "...",
    "status": "...",
    "duration": 0,
    "availableAt": "ISO 8601",
    "scheduledStart?": "ISO 8601",
    "actualStart?": "ISO 8601",
    "actualEnd?": "ISO 8601",
    "publishedAt?": "ISO 8601",
  },
  "channel": {
    "id": "...",
    "name": "...",
    "avatarUrl?": "...",
  },
  "aggregates": {
    "chatCount": 0,
    "superChatCount": 0,
    "superStickerCount": 0,
    "membershipCount": 0,
    "giftCount": 0,
    "giftPurchaseCount": 0,
    "totalGiftAmount": 0,
    "milestoneCount": 0,
    "pollCount": 0,
    "raidCount": 0,
    "currencyTable": [{ "currency": "JPY", "amount": 0, "jpyAmount": 0 }],
    "jpyTotal": 0,
  },
}
```

Rules:

- All `hb*` fields on the source `Video` document are dropped
  (`hbStatus`, `hbStart`, `hbEnd`, `hbCleanedAt`, `hbReplica`, `hbErrorCode`,
  `hbStats`, `hbRecordReplay`, `hbIgnore`). The exception is the new
  `Video.hbStats.chatsArchiveVersion` field (see §3.1), which is surfaced
  via `VideoSummary.archiveVersion` (§4.1) — but never under the `hb*`
  name in any output.
- `aggregates` is computed by manager during the same cursor pass that writes
  JSONL. Counters increment on each emitted row by `type`. `currencyTable` and
  `jpyTotal` reuse the existing currency `$group` aggregation already run by
  the HTML path; the SuperChat + SuperSticker paths both contribute to it
  (same as today).
- `totalGiftAmount` is the sum of `amount` across `membershipGiftPurchase`
  rows.
- `raidCount` increments once per emitted raid row (covering both `raid` and
  `raidOutgoing`).
- `chatCount` is deduplicated by `chat.id`. The cursor merges
  `ownerChatCursor` and `moderatorChatCursor` and a chat that is both owner
  and moderator would otherwise be counted (and emitted) twice. JSONL emit
  keeps an in-memory `Set<string>` of seen `chat.id` values; on a duplicate,
  skip emit and skip the counter increment. (The existing HTML inherits the
  same potential duplication and is left as-is — the only change in behavior
  is JSONL-side dedup; HTML row count is unaffected.)
- `poll.timestamp` in JSONL is the value returned by `getTimestamp(pollDoc)`,
  which falls through to `updatedAt` for Poll documents. Cursor sorting also
  uses `updatedAt: 1`, so emit order matches the existing HTML.

### 3.1 Archive format version write-back

A new field is added to the `Video.hbStats` Typegoose sub-schema:

```ts
chatsArchiveVersion?: number;
```

Semantics:

- Absent / `undefined` / `1` — the archive for this video was produced by an
  older code path that emits HTML only. SPA must fall back to the existing
  `.html` artifact.
- `2` — `archiveVideo` has successfully produced all three new artifacts
  (`{videoId}.jsonl`, `{videoId}.meta.json`, plus the existing HTML); the
  SPA may load `data/videos/{videoId}.{jsonl,meta.json}`.

The value is bumped to `2` by `archiveVideo` only after **all** renames in
§5.1 step 6 complete successfully (i.e., the three final-name files are in
place on disk). The bump is a `VideoModel.updateOne({ id: videoId }, { $set:
{ "hbStats.chatsArchiveVersion": 2 } })` call. If any rename fails, the
version is not bumped and the SPA continues to see the prior value.

No backfill: existing videos retain `undefined` until they are re-archived.
The `manager` service does not run a separate version-bump job for historic
data.

## 4. `data/index.json` and `data/channels/{channelId}.json`

### 4.1 `VideoSummary`

Shared shape used by both files:

```jsonc
{
  "id": "...",
  "title": "...",
  "channelId": "...",
  "channel": {
    "id": "...",
    "name": "...",
    "avatarUrl?": "...",
  },
  "status": "...",
  "scheduledStart?": "ISO 8601",
  "availableAt": "ISO 8601",
  "archiveVersion": 1,
  "stats": {
    "superChatTotalJpy": 0,
    "memberCount": 0,
    "giftCount": 0,
  },
}
```

`archiveVersion` is sourced from `Video.hbStats.chatsArchiveVersion` (see
§3.1). Defaults to `1` when undefined. SPA branches on this value to decide
whether to fetch JSON artifacts (`>= 2`) or fall back to the legacy HTML
artifact (`< 2`).

`stats` is sourced from `Video.hbStats.{totalSuperChatAmountJpy,totalMembers,totalGifts}`
but renamed so SPA consumers do not see internal naming. All three sub-fields
are always present as `number`, defaulting to `0` when `Video.hbStats` (or
the sub-field) is undefined — matching the existing HTML `VideoCard` which
renders `?? 0` in all three positions. `stats` itself is always present.

`VideoSummary.channel` is sourced from `await video.getChannel()` (the same
call existing HTML pages use). `avatarUrl` is omitted from the `channel`
object when undefined.

### 4.2 `data/index.json`

```jsonc
{
  "live": [VideoSummary, ...],
  "past": [VideoSummary, ...]
}
```

Same query partitioning the existing HTML index uses (`live` = videos in
upcoming/live status, `past` = archived). Order matches the HTML.

### 4.3 `data/channels/{channelId}.json`

```jsonc
{
  "channel": { "id": "...", "name": "...", "avatarUrl?": "..." },
  "videos": [VideoSummary, ...]
}
```

Channel is the single channel; `videos` is the same list the existing
per-channel HTML iterates.

## 5. Write flow

### 5.1 Per-video (`archiveVideo`)

1. Ensure directories: `mkdir -p {CHAT_ARCHIVE_DIR}/{channelId}` and
   `{CHAT_ARCHIVE_DIR}/data/videos`.
2. Open three write streams (each to a `.tmp` sibling):
   - `{channelId}/{date}_{videoId}.html.tmp` (existing).
   - `data/videos/{videoId}.jsonl.tmp` (new).
   - `meta.json` is buffered in memory until the cursor finishes; written at
     step 5.
3. Pre-aggregate currency totals via the existing Mongo `$group` (shared with
   HTML).
4. Extend the existing raid cursor query from `{ originVideoId: videoId }` to
   `{ $or: [{ originVideoId: videoId }, { sourceVideoId: videoId }] }` so
   outgoing raids are included. Sort remains `{ timestamp: 1 }`. The HTML
   `RaidCells` only reads `sourcePhoto` / `sourceName` / `timestamp`, so the
   extra outgoing rows render as empty cells in HTML; this is acceptable
   because HTML is consumed only as a fallback and SPA is the new primary
   surface. (If empty HTML rows are not acceptable, HTML emit must skip raid
   docs whose `originVideoId !== videoId`.)
5. `for await` over the merged cursor (`multiCursorOrderedPeek`) for each row:
   - HTML path unchanged: `renderChatRow(...)` → htmlWs.
   - JSONL path: drop documents whose collection name is not in §2.4's
     mapping table; for chats, dedupe by `id` (Set); for raid documents,
     dispatch to `raid` if `originVideoId === videoId`, else to
     `raidOutgoing` if `sourceVideoId === videoId`; build the output object
     per §2; `JSON.stringify(obj) + "\n"` → jsonlWs.
   - Increment the matching aggregate counter (after dedupe for chat).
   - `job?.touch()` keepalive uses the existing condition (unchanged).
6. After cursor exhaustion:
   - If `no === 0` (no rows emitted to HTML), unlink all three `.tmp` files
     and return without producing any final artifact (mirrors the existing
     HTML empty-archive behavior on line 207–210 of `archive-video.ts`).
   - Otherwise: close `htmlWs` and `jsonlWs`; write
     `data/videos/{videoId}.meta.json.tmp` (video + channel + aggregates +
     reused currency totals).
   - `fs.rename` each `.tmp` → final name **in this order**:
     `.html` → `.jsonl` → `.meta.json` (meta last). SPA convention is to
     fetch `meta.json` first; the ordering guarantees the corresponding
     `.jsonl` is already in place at its final name when SPA observes
     `meta.json`. Renames are independent; if a later rename fails, the
     earlier ones still committed and the failed one stays as `.tmp` to be
     regenerated on the next archive run.
7. After all three renames succeed, bump the version (§3.1):
   `await VideoModel.updateOne({ id: videoId }, { $set: { "hbStats.chatsArchiveVersion": 2 } })`.
   This step runs only on the success path; if any rename in step 6 fails,
   the version is not bumped.

Each `.tmp` rename is atomic per-file. With the rename order above the only
inconsistent state SPA can observe is "no `meta.json` yet but `.jsonl`
already in place" (harmless: SPA fetches `meta.json` first and skips on 404)
or "stale `meta.json` from a previous run still pointing at the previous
`.jsonl`" (also harmless, both files are from the same prior run).

### 5.2 Per-channel (`genChannelIndexFile`)

Same loop iterates the channel's videos once and writes both:

- `{channelId}/index.html.tmp` (existing).
- `data/channels/{channelId}.json.tmp` (new).

If the channel has no videos and the existing implementation skips the HTML
write, mirror that: unlink both `.tmp` files and return. Otherwise rename
`.html` first, then `.json`.

### 5.3 Top index (`genIndexFile`)

Same loop iterates live + past videos once and writes both:

- `index.html.tmp` (existing).
- `data/index.json.tmp` (new).

Rename `.html` first, then `.json`. (No empty-list short-circuit: top index
is always written, even if both `live` and `past` are empty.)

## 6. Code organization

No new modules, no new template files, no new type files. Four files take
small additive changes:

- `src/models/Video.ts`
  - Add `chatsArchiveVersion?: number` to the `Stats` sub-class (the existing
    `hbStats` property type), with no `default` so undefined remains the
    value for legacy documents.
- `src/components/chats-archive/archive-video.ts`
  - Cursor loop gains a JSONL-emit branch and aggregate counters.
  - Raid cursor query extended to `$or: [{ originVideoId }, { sourceVideoId }]`.
  - End of function writes `meta.json` and bumps
    `Video.hbStats.chatsArchiveVersion` to `2`.
- `src/components/chats-archive/gen-index-file.ts`
  - After the live + past video loop, stringify the same `VideoSummary` list
    (now including `archiveVersion`) and write `data/index.json`.
- `src/components/chats-archive/gen-channel-index-file.ts`
  - After the channel's video loop, stringify the same `VideoSummary` list
    (now including `archiveVersion`) and write `data/channels/{channelId}.json`.

Row-to-output transformation and summary-object construction live inline in
these three files (~100 lines total). The shape is small enough that
extracting a helper would be logic-free wrapping; inline keeps the data
flow visible alongside the cursor and rename logic.

Implementation must contain no source-comment references back to this design
document — no section markers, no `spec`/`plan` mentions, no `Task N`. The
JSONL field manifest exists in this spec to bound the implementation; the
resulting code should be self-explanatory from the field names alone.

## 7. Verification (manual)

No unit tests. Verify by running the `chats archive` agenda jobs locally
against a Mongo with real archive data and inspecting outputs:

1. `archiveVideo` produces all three artifacts:
   `{channelId}/{date}_{videoId}.html`,
   `data/videos/{videoId}.jsonl`,
   `data/videos/{videoId}.meta.json`.
2. JSONL line count equals the sum of `aggregates` counters.
3. Sample 5–10 random JSONL rows; confirm:
   - First key is `type`.
   - No `isReplay`, `originVideoId`, `originChannelId`, or `hb*` fields.
   - All declared fields per §2 are present (and only those).
4. Find one `Raid` document received by the video (`originVideoId === videoId`)
   and one sent from the video (`sourceVideoId === videoId`) if such test
   data exists; confirm they emit as `raid` and `raidOutgoing` respectively
   with the field sets in §2.3.
5. `meta.json` `aggregates.currencyTable` and `jpyTotal` match the values
   shown in the HTML currency table.
6. `data/index.json` `live` + `past` counts match the existing HTML index page.
7. `data/channels/{channelId}.json` `videos` count matches the existing
   per-channel HTML page; for each entry, `stats.superChatTotalJpy` /
   `memberCount` / `giftCount` match the SC / Members / Gifts numbers in the
   corresponding HTML card footer.
8. Find a video where a chat author has both `isOwner: true` and
   `isModerator: true` (insert a test row if none exists). Confirm the
   produced JSONL contains exactly one row for that `chat.id`, and
   `meta.json` `aggregates.chatCount` equals the unique-`id` count (no double
   counting from the merged owner/moderator cursors).
9. Run `archiveVideo` against a video whose cursors all return zero rows.
   Confirm no `.html`, `.jsonl`, `.meta.json`, or `.tmp` siblings are left
   behind under `{channelId}/{date}_{videoId}.*` or `data/videos/{videoId}.*`,
   and `Video.hbStats.chatsArchiveVersion` is **not** bumped.
10. After a normal `archiveVideo` run, `stat` the three artifacts; their
    `mtime` ordering must satisfy `.html ≤ .jsonl ≤ .meta.json` (rename
    order from §5.1 step 6). After the run, query the Video document and
    confirm `hbStats.chatsArchiveVersion === 2`.
11. Find a video that received a raid (`Raid.originVideoId === videoId`) and
    a video that sent a raid (`Raid.sourceVideoId === videoId`). Confirm the
    receiving video's JSONL contains a `raid` row with `sourceName` /
    `sourcePhoto` populated; the sending video's JSONL contains a
    `raidOutgoing` row with `originVideoId` / `originName` / `originPhoto`
    populated. `meta.json` `aggregates.raidCount` covers both row types.
12. In `data/index.json`, confirm a freshly archived video has
    `archiveVersion: 2` while a legacy video (no re-archive since this
    spec) has `archiveVersion: 1`.
