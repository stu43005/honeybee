# Daily videos index — design

**Date:** 2026-07-12
**Status:** Draft (awaiting review)
**Area:** `src/components/chats-archive/`, `docs/data-contract/`

## 1. Overview

Replace the daily **leaderboard** family with a single per-day **daily videos**
list. The previous design
([2026-07-11-frontend-video-index-expansion-design.md](2026-07-11-frontend-video-index-expansion-design.md))
shipped two ranked files per JST day — `data/leaderboard/maxviewers/{date}.json`
and `data/leaderboard/likes/{date}.json`, each a metric-specific top-50. That
approach is being withdrawn: ranking is a presentation concern the frontend can
do itself.

Instead, `chats-archive` writes one file per JST calendar day listing **all
streams that actually started that day** (excluding `upcoming`). The per-video
summary already carries `viewers`, `maxViewers`, `likes`, and `premiere` (added
in the previous revision and unchanged here), so `vchat-web` sorts the full list
client-side to render any leaderboard it wants.

The already-shipped `data/leaderboard/**` output is treated as unused: its
writer, tests, data-contract document, scheduled job, and README index row are
removed outright. No consumer migration is needed.

This new file also completes the replacement of `root-index` (`data/index.json`)
by the newer per-purpose index files: its `live` array is superseded by
`realtime.json` + `upcoming.json`, and its `past` array is superseded by the
per-day `daily-videos/{date}.json` files. Accordingly, `root-index`'s
**data-contract document is marked deprecated** here, while its **writer code is
kept unchanged for now** (no output or shape change) so existing readers keep
working during the frontend transition.

## 2. Goals / non-goals

**Goals**

- Add a per-JST-day `data/daily-videos/{YYYY-MM-DD}.json` file listing every
  started, non-upcoming stream of that day (full list, no ranking, no cap).
- Refresh today + yesterday (JST) every 10 minutes.
- Remove the daily leaderboard writer, its tests, its Agenda job, its
  data-contract document, and its README index row.
- Mark the `root-index` data-contract document deprecated (superseded by
  realtime/upcoming/daily-videos), keeping its writer code and output unchanged.
- Document the new output in `docs/data-contract/`.

**Non-goals**

- No change to `realtime.json`, `upcoming.json`, `channel-index`, or
  `buildVideoSummary`. The four summary fields the previous revision added stay
  exactly as they are; this design reuses them and adds no new summary field.
- No change to the `root-index` **writer or its `data/index.json` output** — the
  code stays as-is (its removal is out of scope for this design). Only its
  data-contract document is annotated deprecated (§7).
- No change to the per-video `video-meta.json` / `.jsonl` writer.
- No new data source. Every field surfaced is already populated on the `Video`
  model.
- No server-side ranking, filtering by metric, or top-N truncation. Sorting is
  entirely a frontend concern.
- No cleanup/migration of the already-written `data/leaderboard/**` files on S3.
  They are treated as unused and left in place; the frontend simply stops
  reading them. (See §9 Non-goals / Accepted limitations.)
- No backfill of arbitrary historical dates on a schedule. The scheduled job
  refreshes today + yesterday only; the single-date core serves manual/CLI
  regeneration.
- No deployment/rollback/mixed-version orchestration beyond the data-contract's
  standard two-version coexistence window.

## 3. Output file (`data/daily-videos/{YYYY-MM-DD}.json`)

`{YYYY-MM-DD}` is the JST calendar date.

```ts
interface DailyVideos {
  date: string; // "YYYY-MM-DD" in JST — the day this file lists
  snapshotAt: string; // ISO 8601 instant this file was generated
  videos: VideoSummaryWithChannel[]; // started, non-upcoming streams of that day
}
```

`VideoSummaryWithChannel` is the existing shared summary shape produced by
`buildVideoSummary` (see [build-video-summary.ts](../../../src/components/chats-archive/build-video-summary.ts)),
including the optional `viewers` / `maxViewers` / `likes` / `premiere` fields the
frontend sorts on.

**Day attribution and semantics**

- Each stream is attributed to exactly one JST day — the day its `availableAt`
  falls in. For a started stream, Holodex sets `availableAt` to its actual start,
  so this is the stream's **start day**.
- The list is **not** a per-day activity view. A stream that starts just before
  JST midnight and runs past it appears only in its start day's file, carrying
  its whole-lifetime `maxViewers` / `likes` values. This is intended — honeybee
  stores only running lifetime peak/count per stream, not a time-bucketed
  series.
- Query range for a date `D`: `[D 00:00 Asia/Tokyo, (D+1) 00:00 Asia/Tokyo)`
  converted to UTC via `moment-timezone`, matched against `availableAt`.

**Qualification**

- `availableAt` within the JST-day range above.
- `actualStart` exists (is set / non-null). This is the definition of "actually
  started": upcoming and never-started streams have no `actualStart` and are
  excluded, while live and finished streams are included. Using `actualStart`
  existence rather than a `status` enumeration is robust to a stream whose
  `status` has not yet been reconciled but which has a start time.
- Exclude `uploadedVideo === true` and `hbIgnore === true`.
- **No** metric filter and **no** top-N cap: every qualifying stream is included.

**Ordering**

- `videos` sorted by `availableAt` **descending** (most recent start first),
  breaking ties by ascending `id` so output is deterministic across runs. This
  is only a stable default; the frontend re-sorts by whatever metric it renders.

**Empty day**

- If a date has zero qualifying streams, the writer still emits a valid file with
  `videos: []`. This lets a reader distinguish "no data yet" (404) from
  "computed, nobody qualified" (empty array).

## 4. Generation module (`gen-daily-videos-file.ts`)

New file `src/components/chats-archive/gen-daily-videos-file.ts`:

- `jstDayRangeUtc(date)` — returns the UTC `[start, end)` instants for a
  `YYYY-MM-DD` JST day. Moved here from the deleted `gen-leaderboard-file.ts`
  (it is used only by this module).
- `dailyVideosFilter(date)` — builds the Mongo filter: `availableAt` in the JST
  range, `actualStart: { $exists: true, $ne: null }`, `uploadedVideo: { $ne:
true }`, `hbIgnore: { $ne: true }`.
- `queryDailyVideos(date)` — runs the filter with `.populate("channel")` and
  `readPreference: "secondaryPreferred"`, collecting the cursor into an array.
- `buildDailyVideos(date, videos, snapshotAt)` — sorts by `availableAt`
  descending with an ascending-`id` tie-break, maps each doc through
  `buildVideoSummary`, and returns the `DailyVideos` object.
- `genDailyVideosFile(date)` — captures `snapshotAt = new Date()`, calls the
  query + build, and writes via the existing `writeDataFile(dataFilePath(
"daily-videos", `${date}.json`), ...)` atomic tmp+rename helper.
- `genDailyVideos(job?)` — derives today and yesterday from one captured
  `moment.tz("Asia/Tokyo")` so the pair cannot straddle JST midnight between two
  reads, calls `genDailyVideosFile` for each, and renews the Agenda lock with
  `job?.touch()` after each file.

All writes reuse the shared `writeDataFile` / `dataFilePath` atomic writer
(`mkdir -p` parent → write `<path>.tmp` → atomic `rename`), identical to the
existing index writers.

## 5. Scheduling (`src/components/chats-archive.ts`)

Inside the existing `if (CHAT_ARCHIVE_DIR)` block:

- **Remove** the `chats archive leaderboard` Agenda job registration.
- **Add** `chats archive daily-videos` — `agenda.every("10 minutes", ...)` whose
  handler calls `genDailyVideos(job)` (passing the Agenda job so the lock is
  renewed between the two files).
- In the `isMain(import.meta)` direct-run block, replace the leaderboard
  generator call with a single `genDailyVideos()` invocation (no job), so a
  manual CLI run regenerates today + yesterday alongside the existing index and
  realtime/upcoming generators.

**Concurrency — single writer per job.** Correctness relies on Agenda never
running two overlapping invocations of the same named job. Agenda registers each
`every(...)` name as one Mongo-backed job document and takes a per-job lock
before dispatching, so a run is not re-dispatched while a prior run of that name
is still in flight — even if `manager` were scaled. Each run is a full,
idempotent regeneration from current DB state writing a disjoint file set, so at
any moment there is exactly one writer per file and successive runs publish in
schedule order. These runs are sub-second (two indexed range queries plus two
small JSON writes); `job.touch()` after each file renews the lock so a slow run
cannot let its lock lapse mid-run.

**Direct-run is outside the Agenda lock — a manual-only path.** The
`isMain(import.meta)` direct-run invocation is a developer/operator regeneration
tool, not a second scheduled writer, and it shares the same fixed-`<path>.tmp`
writer (`writeDataFile`) as every other generator in this component
(`gen-index-file`, `gen-realtime-file`, …). Two writers targeting one file's
temp path concurrently could corrupt that temp or fail the rename, so the
single-writer property is an **operational invariant**: the direct-run path must
not be executed while the scheduled `chats archive daily-videos` job is enabled
(i.e. against a live `manager`). This constraint is not new to daily-videos — it
is the established convention for the existing generators, which use the same
shared writer and the same direct-run block; daily-videos introduces no
per-writer lock or unique-temp machinery, to stay consistent with them.

## 6. Removed leaderboard assets

- `src/components/chats-archive/gen-leaderboard-file.ts` and its
  `gen-leaderboard-file.spec.ts` — deleted. `jstDayRangeUtc` is preserved by
  moving it into `gen-daily-videos-file.ts` (§4).
- `docs/data-contract/daily-leaderboard.md` — deleted.
- `docs/data-contract/README.md` §2 index — the daily-leaderboard row is
  replaced by a daily-videos row (§7).
- The `chats archive leaderboard` Agenda job and its direct-run call — removed
  (§5).

**Retained index.** The `availableAt_all` non-partial index on the `Video` model
(added for the leaderboard's all-status JST-day range scan) is **kept** —
daily-videos issues the same JST-day `availableAt` range query and depends on it.
Only its explanatory comment is updated to describe the daily-videos day-range
scan instead of the leaderboard.

## 7. Data-contract paperwork (`docs/data-contract/`)

**New file-type document (version 1, revision r0):**

- `daily-videos.md` — path pattern `data/daily-videos/{YYYY-MM-DD}.json`, writer
  `src/components/chats-archive/gen-daily-videos-file.ts`, shape from §3.
  Includes: path pattern, writer, version field policy, a revision-history table
  (one r0 row with concrete Date/PR), the TypeScript interface, a cumulative
  JSON example, and a reader-guidance section documenting `date` and
  `snapshotAt` as always-present, `videos: []` for a computed-empty day, and the
  `availableAt`-descending default order (with the note that consumers may
  re-sort client-side).

**Removed file-type document:**

- `daily-leaderboard.md` — deleted (§6).

**Deprecated file-type document (doc-only annotation, no shape/version change):**

- `root-index.md` — add a **Deprecated** status banner at the top explaining
  that `data/index.json` is superseded (`live` → `realtime.json` +
  `upcoming.json`; `past` → `daily-videos/{date}.json`) and that the writer is
  retained for now so existing readers keep working. Add one revision-history
  row recording the deprecation as a documentation-only change (no field, shape,
  or version change; the writer still emits version 1). No edits to the shape,
  example, or reader-guidance beyond the banner + history row.

**Index update:**

- `README.md` §2 file-type index — replace the daily-leaderboard row with a
  daily-videos row at active version 1, and mark the root-index row deprecated.

**No change** to `realtime.md`, `upcoming.md`, or `channel-index.md`: the shared
summary shape is unchanged by this design.

Writer source, JSDoc, and commit messages must describe field shapes inline and
must not reference the contract documents (data-contract §8.1 anti-leak rule).

## 8. Testing

`gen-daily-videos-file.spec.ts` (mirrors the deleted leaderboard spec's
structure, using `jest.mock` on the model module and stateful fakes where DB
state transitions are observed):

- Qualification: a stream with no `actualStart` (upcoming) is excluded; a live
  stream and a finished stream (both with `actualStart`) are included;
  `uploadedVideo === true` and `hbIgnore === true` are excluded.
- JST day attribution: a stream whose `availableAt` is just before/after JST
  midnight is placed in the correct day's file (structural assertion on the
  UTC range boundaries via `jstDayRangeUtc`).
- Ordering: `videos` is `availableAt`-descending with an ascending-`id`
  tie-break — asserted structurally on a set including two streams sharing an
  `availableAt`.
- Empty day: zero qualifying streams emits `{ ..., videos: [] }`, not a 404 /
  missing file.

Each `it` carries at least one structural assertion (`toEqual` / ordering /
snapshot), awaits the async summary build, and uses stateful fakes for any
observed DB state transition, per project test conventions.

## 9. Non-goals / Accepted limitations

- **Concern:** already-written `data/leaderboard/**` files remain on S3 after the
  writer is removed.
  **Decision:** not cleaned up.
  **Rationale:** the user confirmed the leaderboard output was never wired into
  the frontend, so the stale files are inert — no reader observes them, and a
  storage-cleanup mechanism would be disproportionate to the impact.

- **Concern:** removing the leaderboard writer, Agenda job, and its data-contract
  document outright skips the standard two-version coexistence/deprecation window
  — a still-deployed or rolled-back reader expecting `data/leaderboard/**` would
  lose future refreshes and its contract doc simultaneously.
  **Decision:** removed outright, with no coexistence window or deprecation
  period for the leaderboard output.
  **Rationale:** the user confirmed the leaderboard output was never consumed by
  any reader (frontend or external), so there is no reader whose contract the
  removal could break; keeping a deprecated writer/job/doc alive purely to honour
  a coexistence window for an output nobody reads would be disproportionate. This
  is scoped to the leaderboard output specifically — the actively-read
  `root-index` is instead only deprecated with its writer retained (§1, §7), not
  removed.

## 10. Open questions

None outstanding.
