# chats-archive: Remove HTML Output — Design Spec

Date: 2026-05-26
Topic: Strip all HTML generation from the `chats-archive` component. The
machine-readable JSON/JSONL artifacts under `CHAT_ARCHIVE_DIR/data/` (added in
the 2026-05-10 spec) become the only output. The web UI is now handled by the
separate `vchat-web` project, which consumes the JSON files.

---

## 1. Scope

In scope:

- Delete all TSX templates and HTML-writing code paths in
  `src/components/chats-archive/`.
- Keep `data/index.json`, `data/channels/{channelId}.json`,
  `data/videos/{videoId}.jsonl`, and `data/videos/{videoId}.meta.json` output
  intact, with one behavioral change to the empty-video case (see §4.4).
- Inline the small number of types/helpers that currently live in TSX files
  but are still required by the JSON output path.

Out of scope:

- Cleanup of legacy HTML files already on disk. They remain untouched at their
  existing paths; only new HTML stops being produced. A future cleanup may be
  handled by the external sync / cron job that already manages
  `CHAT_ARCHIVE_DIR`.
- Any change to the `vchat-web` consumer.
- Any change to the agenda job names or frequencies in
  `src/components/chats-archive.ts`.
- Any change to the JSON/JSONL schema beyond §4.4 (empty-video meta.json).
- Any change to `archiveVersion`; the value stays at `2`.

## 2. Output layout (final state)

```text
{CHAT_ARCHIVE_DIR}/
├── {channelId}/{date}_{videoId}.html        ← legacy, no longer (re)generated
├── {channelId}/index.html                   ← legacy, no longer (re)generated
├── index.html                               ← legacy, no longer (re)generated
└── data/
    ├── index.json                           ← regenerated every 10 min
    ├── channels/{channelId}.json            ← regenerated every 10 min
    └── videos/
        ├── {videoId}.jsonl                  ← per archive run, when there
        │                                       is at least one row
        └── {videoId}.meta.json              ← per archive run, always written
                                                (zero-aggregate variant when
                                                no rows)
```

Legacy HTML paths are mentioned only for completeness; this design adds no
code that reads, writes, or deletes them.

## 3. Files removed

The following files are deleted in their entirety:

- `src/components/chats-archive/templates/ChannelIndexPage.tsx`
- `src/components/chats-archive/templates/IndexPage.tsx`
- `src/components/chats-archive/templates/VideoArchive.tsx`
- `src/components/chats-archive/templates/VideoCard.tsx`
- `src/components/chats-archive/templates/format.tsx`

The empty `templates/` directory is also removed.

No file outside `src/components/chats-archive/` imports from `templates/`
(verified by repo-wide grep at design time); removing them cannot break
external call sites.

## 4. Files modified

### 4.1 `src/components/chats-archive/archive-video.ts`

Currently this file:

1. Imports `getTimestamp`, `getVideoPath` from `./templates/format.js`.
2. Imports `renderChatRow`, `renderVideoArchiveShell`, `ChatRowDoc`,
   `CurrencyAgg` from `./templates/VideoArchive.js`.
3. Opens two write streams (`.html.tmp` and `.jsonl.tmp`), interleaves
   `renderChatRow` writes with `JSON.stringify(row)` writes, and renames in
   the order html → jsonl → meta.

After this change:

- Remove all imports from `./templates/*`.
- Inline the following into `archive-video.ts`:
  - The `ChatRowDoc` type (currently exported from `VideoArchive.tsx`). It is
    a `DocumentType<Chat | SuperChat | SuperSticker | Membership |
MembershipGift | MembershipGiftPurchase | Milestone | Poll | Raid>`
    discriminated union.
  - The `CurrencyAgg` interface (currently `{ currency, amount, jpyAmount }`).
  - The `getTimestamp` helper (currently in `format.tsx`). It reads
    `timestamp`, then `updatedAt`, then `createdAt`, then the `_id`'s
    `getTimestamp()` and returns a `Date`.
- `getOutputFilePaths` returns `{ jsonl, meta }` only. The `html` key is gone.
- Delete the html write stream, all `renderChatRow` / `renderVideoArchiveShell`
  calls, and the `head` / `tail` shell strings.
- The main loop still uses `multiCursorOrderedPeek<ChatRowDoc>` over the same
  ten cursors and still writes one JSON line per row via `buildJsonlRow`.
- `currencies` and `jpySum` are still computed from `VideoStats` because they
  are embedded into `meta.json` under
  `aggregates.currencyTable` / `aggregates.jpyTotal`.
- Empty-video branch — see §4.4.
- Rename order at end-of-run: `jsonl.tmp → jsonl`, then `meta.tmp → meta`. The
  ordering preserves the existing invariant ("vchat-web fetches meta.json;
  meta must never appear without its sibling jsonl"). In the empty case there
  is no jsonl rename; only meta is renamed.

### 4.2 `src/components/chats-archive/gen-index-file.ts`

Currently this file:

1. Imports `renderIndexShell` and `renderVideoCard` from `./templates/…`.
2. Opens `index.html.tmp` write stream, writes `head` / per-video cards /
   `between` / per-video cards / `tail`.
3. Builds two summary arrays and writes `data/index.json`.
4. Renames `index.html.tmp → index.html`, then `index.json.tmp → index.json`.
5. Iterates collected channelIds and calls `genChannelIndexFile` for each.

After this change:

- Remove all imports from `./templates/*`.
- Remove the html write stream and all `head/between/tail` / `renderVideoCard`
  calls.
- The function still iterates `VideoModel.findLiveVideos(48)` and
  `findRecentlyEndedVideos(48)` with the same filters
  (skip-stale-Live and skip-future-Missing) and the same `isDirect` branches
  that call `recalcVideoHbStats` and `archiveVideo({ isDirect: true })`.
- For each video, the function still calls `buildVideoSummary(video)` (with
  default `includeChannel: true` for the index file) and pushes the result
  into `liveSummaries` or `pastSummaries`.
- The function still writes `data/index.json` with
  `{ live: liveSummaries, past: pastSummaries }`.
- Only one rename at the end (`index.json.tmp → index.json`); the html rename
  is gone.
- The per-channel fan-out via `genChannelIndexFile(channelId, { isDirect })`
  is unchanged.

### 4.3 `src/components/chats-archive/gen-channel-index-file.ts`

Currently this file:

1. Imports `renderChannelIndexShell` and `renderVideoCard` from `./templates/…`.
2. Opens `{channelId}/index.html.tmp` write stream, writes
   `head` / per-video cards / `tail`.
3. Builds a summary array and writes
   `data/channels/{channelId}.json`.
4. If `count === 0` removes both temp files and returns.
5. Otherwise renames html, then json.

After this change:

- Remove all imports from `./templates/*`.
- Remove the html write stream and the `head` / `tail` / `renderVideoCard`
  calls.
- The function still iterates the channel's most recent 100 videos (with
  `uploadedVideo: { $ne: true }` and the same `isDirect` branches calling
  `recalcVideoHbStats` and `archiveVideo({ isDirect: true })`).
- For each video, still call
  `buildVideoSummary(video, { includeChannel: false })` and push into
  `summaries`.
- Empty-channel branch (`count === 0`): still remove the json temp file and
  return; there is no html temp to remove.
- Otherwise still write `data/channels/{channelId}.json` containing the
  `{ id, name, avatarUrl?, videos }` shape, then rename json.

### 4.4 Empty-video meta.json (behavior change)

Currently, when `archiveVideo` finds zero rows (`no === 0`), it removes both
`.html.tmp` and `.jsonl.tmp` and returns early without writing meta.json.

After this change:

- Skip writing `.jsonl.tmp` (no file is renamed into place).
- Build `meta` exactly the same way as in the non-empty branch — no special
  case, no override:
  - `buildVideoSummary(video)` for the base fields.
  - `archiveVersion: 2`.
  - `aggregates`: the per-document counter object (whose fields are all `0`
    because the loop never ran and `bumpAggregate` was never called) plus
    `currencyTable: currencies` and `jpyTotal: jpySum` using **whatever the
    pre-loop VideoStats query returned**. The spec does NOT force these to
    empty/zero; it uses the same expressions as the non-empty branch. In
    practice, a video with zero archived rows is overwhelmingly likely to
    have an empty `currencies` array as well, but if VideoStats somehow has
    SuperChat/SuperSticker entries while the chat cursors return zero rows
    (e.g. data inconsistency), those values are preserved in the meta.json,
    not silently zeroed.

  The resulting object for a typical empty video therefore looks like:

  ```jsonc
  {
    // ...fields from buildVideoSummary(video)
    "archiveVersion": 2,
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
      "currencyTable": [], // = currencies; empty in the common case
      "jpyTotal": 0, // = jpySum; 0 in the common case
    },
  }
  ```

- Write `meta.tmp` and rename to the final `meta.json`. No `.jsonl` file is
  produced for this video.
- The post-success `hbStats.chatsArchiveVersion` update (only in non-`isDirect`
  runs and only when `< 2`) still applies — an empty video is still a
  successfully processed video.

Implementation consequence: the meta-building code path is shared between
the empty and non-empty branches; both call the same `meta = { ... }`
construction with the same `currencies` / `jpySum` references. The empty
branch differs from the non-empty branch only in (a) skipping the `.jsonl`
rename and (b) not having any data in `.jsonl.tmp` to discard.

Consumer contract: vchat-web treats "meta.json present, jsonl absent" as
"video was processed but produced no rows". This is a strictly additive
change to the consumer surface: previously, the absence of both files meant
either "not yet processed" or "processed-but-empty"; now those two cases are
distinguishable.

### 4.5 `src/components/chats-archive.ts` (agenda wrapper)

No changes. Specifically:

- `agenda.define("chats archive", archiveAllChats)` and its
  `agenda.every("1 minutes", "chats archive")` schedule stay.
- `agenda.define("chats archive index", () => genIndexFile())` and its
  `agenda.every("10 minutes", "chats archive index")` schedule stay.
- The CLI entry under `if (isMain(import.meta))` still calls
  `genIndexFile({ isDirect: true })`. It remains the "regenerate all JSON
  data from scratch" command.

## 5. Things explicitly not changing

- `buildVideoSummary` — already pure data, no JSX.
- `archiveVersion: 2` on `video.hbStats.chatsArchiveVersion` (force-set by a
  recent commit).
- JSONL schema for individual rows (per the 2026-05-10 spec).
- `data/index.json` and `data/channels/{channelId}.json` schemas.
- S3 / external sync of `CHAT_ARCHIVE_DIR`.
- Mongo schema or any index.
- Any other component in `src/components/`.

## 6. Risks and tradeoffs

- **vchat-web rollout dependency.** Until vchat-web is deployed at the
  endpoint that previously served the static `index.html`, users hitting the
  old URL will see a stale page (the last HTML rendered before this PR).
  This is the deliberate consequence of "leave legacy HTML on disk": the user
  experience degrades gracefully to "last known state" rather than a 404
  while the new front-end is being deployed. The PR description should note
  this so deployment is coordinated.
- **Lost helper functions.** `getVideoPath`, `formatCurrency`,
  `FormattedTimestamp` are deleted alongside their TSX file. If any future
  feature needs them they can be recovered from git history; not preserving
  them avoids carrying dead code.
- **No backfill of zero-aggregate meta.json for old empty videos.** Videos
  previously archived as "empty" had no meta.json written. They will only
  acquire one if they are re-processed (e.g. via the CLI regenerate run).
  This is acceptable because the agenda task naturally re-runs any video
  whose `VideoStatsFlags.ChatsArchiveProcessed` flag has not yet been set;
  legacy empties without that flag will gain meta.json on the next pass.

## 7. Verification approach

The plan deriving from this spec will verify the change with:

- TypeScript build passes after removing `templates/` (no stale imports).
- ESLint passes.
- Jest unit tests pass.
- A manual / scripted invocation of `archiveVideo` against a real test video
  produces only `data/videos/{videoId}.jsonl` and
  `data/videos/{videoId}.meta.json`, and produces only meta.json (no jsonl)
  against a known-empty video.
- A manual / scripted invocation of `genIndexFile({ isDirect: true })`
  produces only `data/index.json` and `data/channels/*.json`, with no
  `index.html` / `{channelId}/index.html` newly created.
