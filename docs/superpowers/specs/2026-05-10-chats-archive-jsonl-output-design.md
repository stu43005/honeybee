# chats-archive JSONL Output — Design Spec

Date: 2026-05-10
Topic: Add machine-readable JSON/JSONL outputs to `chats-archive` so a separate
SPA frontend (out of scope here) can render archives dynamically. Existing HTML
output is preserved unchanged for parallel operation.

---

## 1. Scope

In addition to the existing HTML files, the manager service writes three new
artifact types under `CHAT_ARCHIVE_DIR/data/`:

```
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

**`raid`** — emitted only when `doc.originVideoId === currentVideoId`
(raid received by this video).

| Field              | Type            |
| ------------------ | --------------- |
| `id`               | `string`        |
| `timestamp`        | ISO 8601 string |
| `sourceVideoId?`   | `string`        |
| `sourceChannelId?` | `string`        |
| `sourceName`       | `string`        |
| `sourcePhoto?`     | `string`        |

**`raidOutgoing`** — emitted only when `doc.sourceVideoId === currentVideoId`
(raid sent from this video). Sourced from the same `Raid` model.

| Field              | Type            |
| ------------------ | --------------- |
| `id?`              | `string`        |
| `timestamp`        | ISO 8601 string |
| `originVideoId`    | `string`        |
| `originChannelId?` | `string`        |
| `originName?`      | `string`        |
| `originPhoto?`     | `string`        |

A `Raid` document in which neither side matches `currentVideoId` is not
expected (the cursor query is keyed by `originVideoId` / `sourceVideoId`
matching `currentVideoId`); should one appear, drop it without emitting a row.

### 2.4 Row types not emitted

The Mongo collections `BannerAction`, `ModeChange`, `Placeholder`,
`BanAction`, `RemoveChatAction` have no rendering in the existing HTML
(`ChatRow` dispatcher in `templates/VideoArchive.tsx` covers exactly the 9
types above) and are not emitted in JSONL. Filtering happens in the cursor
loop by checking the `type` discriminator returned by `multiCursorOrderedPeek`.

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
  `hbStats`, `hbRecordReplay`, `hbIgnore`).
- `aggregates` is computed by manager during the same cursor pass that writes
  JSONL. Counters increment on each emitted row by `type`. `currencyTable` and
  `jpyTotal` reuse the existing currency `$group` aggregation already run by
  the HTML path; the SuperChat + SuperSticker paths both contribute to it
  (same as today).
- `totalGiftAmount` is the sum of `amount` across `membershipGiftPurchase`
  rows.

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
  "stats": {
    "superChatTotalJpy?": 0,
    "memberCount?": 0,
    "giftCount?": 0,
  },
}
```

`stats` is sourced from `Video.hbStats.{totalSuperChatAmountJpy,totalMembers,totalGifts}`
but renamed so SPA consumers do not see internal naming. The three sub-fields
remain optional because `Video.hbStats` is itself optional. `stats` is always
present (possibly `{}`); SPA may default missing values to 0.

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
4. `for await` over the merged cursor (`multiCursorOrderedPeek`) for each row:
   - HTML path unchanged: `renderChatRow(...)` → htmlWs.
   - JSONL path: filter to the 9 emitted types; for `Raid` docs, dispatch to
     either `raid` or `raidOutgoing` based on whether `sourceVideoId` or
     `originVideoId` matches `currentVideoId`; build the output object
     according to §2; `JSON.stringify(obj) + "\n"` → jsonlWs.
   - Increment the matching counter in an in-memory `aggregates` object.
   - `job?.touch()` keepalive uses the current condition (unchanged).
5. After cursor exhaustion:
   - Close htmlWs and jsonlWs.
   - Write `data/videos/{videoId}.meta.json.tmp` (video + channel + aggregates
     - reused currency totals).
   - `fs.rename` each `.tmp` → final name. Renames are independent; if any
     fails, the others succeed and the failed one stays as `.tmp` (next archive
     run regenerates from scratch).

Each `.tmp` rename is atomic per-file. There is no cross-file atomicity
guarantee, but a partially written `.tmp` is never visible under its final
name, so the SPA never observes a half-written JSONL or stale meta.

### 5.2 Per-channel (`genChannelIndexFile`)

Same loop iterates the channel's videos once and writes both:

- `{channelId}/index.html.tmp` (existing).
- `data/channels/{channelId}.json.tmp` (new).

`fs.rename` each at the end.

### 5.3 Top index (`genIndexFile`)

Same loop iterates live + past videos once and writes both:

- `index.html.tmp` (existing).
- `data/index.json.tmp` (new).

`fs.rename` each at the end.

## 6. Code organization

No new modules, no new template files, no new type files. Three control-layer
files take small additive changes:

- `src/components/chats-archive/archive-video.ts`
  - Cursor loop gains a JSONL-emit branch and aggregate counters.
  - End of function writes `meta.json`.
- `src/components/chats-archive/gen-index-file.ts`
  - After the live + past video loop, stringify the same `VideoSummary` list
    and write `data/index.json`.
- `src/components/chats-archive/gen-channel-index-file.ts`
  - After the channel's video loop, stringify the same `VideoSummary` list
    and write `data/channels/{channelId}.json`.

Row-to-output transformation and summary-object construction live inline in
these three files (~100 lines total). The shape is small enough that
extracting a helper would be logic-free wrapping (forbidden by project
"avoid logic-free abstractions" rule); inline keeps the data flow visible
alongside the cursor and rename logic.

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
