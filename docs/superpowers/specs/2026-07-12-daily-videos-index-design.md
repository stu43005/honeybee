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

**"Superseded" is a forward-preference marker, not an immediate backend cutover.**
The no-loss guarantee rests solely on the `root-index` writer being **retained,
not removed**: `data/index.json` keeps being published unchanged, so no reader
loses anything and the frontend migrates at its own pace with no forced switch
that could produce 404s. This spec does **not** claim `daily-videos` is a
coverage-equivalent drop-in for `root-index`'s `past`: they are deliberately
different slices — `root-index`'s `past` is a recently-**ended** window
(`findRecentlyEndedVideos(48)`), whereas `daily-videos` buckets each stream by
its start day (`availableAt`) and refreshes only today + yesterday. A
long-running stream that started before yesterday but ended recently is therefore
in `root-index`'s `past` but not in the scheduled `daily-videos` today/yesterday
files. Reconciling those slices into whatever "recent past" view the frontend
wants (e.g. reading additional day files, or continuing to read `root-index` for
the recently-ended set) is a **frontend composition choice, out of scope here**.
Deep-history backfill of arbitrary past dates also stays out of scope (§2).

## 2. Goals / non-goals

**Goals**

- Add a per-JST-day `data/daily-videos/{YYYY-MM-DD}.json` file listing every
  started, non-upcoming stream of that day (full list, no ranking, no cap).
- Refresh today + yesterday (JST) every 10 minutes.
- Add a second, every-12h "finalize" pass that re-refreshes the start-day files
  of streams that are still live from before yesterday, or that ended / were
  detected deleted within the trailing finalize window (48h — the overlap budget
  is explained in §5) — so long-running / late-finalizing streams' lifetime
  metrics do not freeze stale in an out-of-window day file.
- Add a `detectedDeletionAt` timestamp to the `Video` model, set once when a
  video is first detected deleted and cleared when it reappears, to drive the
  finalize pass's "recently deleted" branch.
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
- No backfill of arbitrary historical dates on a schedule. The 10-minute job
  refreshes today + yesterday; the 12-hour finalize job additionally refreshes
  only the start dates of streams still live / ended / detected-deleted in its
  window — never a blanket sweep of old dates. The single-date core serves
  manual/CLI regeneration of any one date.
- No deployment/rollback/mixed-version orchestration beyond the data-contract's
  standard two-version coexistence window — **except** the leaderboard removal,
  which deliberately skips that window because its output is unused (§9).

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

**Metric freshness**

- Each entry's `viewers` / `maxViewers` / `likes` reflect the `Video` model at
  the moment the day's file was last regenerated, not necessarily the stream's
  final values. The 10-minute pass keeps today + yesterday fresh; the 12-hour
  finalize pass (§5) re-refreshes older day files while their streams are still
  live, and once more after they end or are detected deleted, so a long-running
  stream's frozen metrics are corrected within ≤12h of the change and finalized
  after it ends. For a currently-live stream, the authoritative up-to-the-minute
  value is `realtime.json`; the day file is a periodically-refreshed snapshot.

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
- `genDailyVideosFinalize(job?)` — the 12-hour finalize pass (§5). Queries the
  streams whose start-day files may hold stale metrics (still-live-from-before-
  yesterday, ended within 12h, or detected-deleted within 12h — full filter in
  §5), maps each to its JST start date (`moment.tz(availableAt,"Asia/Tokyo")
.format("YYYY-MM-DD")`), builds the **distinct** date set, drops today and
  yesterday from it (those are owned by `genDailyVideos`, keeping the two jobs'
  written date sets disjoint — §5), and calls `genDailyVideosFile` for each
  remaining date, `job?.touch()` after each.

All writes reuse the shared `writeDataFile` / `dataFilePath` atomic writer.

**Shared-writer hardening (`write-data-file.ts`).** `writeDataFile` currently
writes to a fixed `<path>.tmp` sibling before the atomic `rename`. A fixed temp
name is unsafe if two processes ever write the same output path concurrently
(the direct-run path vs. the scheduled job — see §5): their interleaved writes to
the one shared temp file could publish a corrupt file, or one `rm`/`rename` could
race the other. This design changes `writeDataFile` to write to a **per-call
unique temp name** (`<path>.<pid>.<random>.tmp`) and `rename` that into place, so
each writer owns its own temp file and the final `rename` is the only contended
step. `rename` is atomic, so a reader never observes a torn or corrupt file. This
is a pure robustness change to the shared helper (all generators —
`gen-index-file`, `gen-realtime-file`, this one — benefit); the published output
bytes for any single writer are unchanged. It adds **no** cross-process lock and
does **not** by itself guarantee publication ordering between two concurrent
writers — see §5 for the residual stale-write behaviour and why it is accepted.

## 5. Scheduling (`src/components/chats-archive.ts`)

Inside the existing `if (CHAT_ARCHIVE_DIR)` block:

- **Remove** the `chats archive leaderboard` Agenda job registration.
- **Add** `chats archive daily-videos` — `agenda.every("10 minutes", ...)` whose
  handler calls `genDailyVideos(job)` (passing the Agenda job so the lock is
  renewed between the two files).
- **Add** `chats archive daily-videos finalize` — `agenda.every("12 hours", ...)`
  whose handler calls `genDailyVideosFinalize(job)`. A distinct job name (hence a
  distinct Agenda lock) from the 10-minute job; the two write disjoint date sets
  (see below), so they never contend for the same file.
- In the `isMain(import.meta)` direct-run block, replace the leaderboard
  generator call with `genDailyVideos()` followed by `genDailyVideosFinalize()`
  (both no-job), so a manual CLI run regenerates today + yesterday plus any
  older finalize-eligible day alongside the existing index and realtime/upcoming
  generators.

**Finalize pass — which streams, which dates (12h job).** The finalize query
selects, with `readPreference: "secondaryPreferred"`, streams that have an
`actualStart` (started), are not `uploadedVideo` and not `hbIgnore`, and match
**any** of these three branches (all timestamps compared against one captured
`now`):

- `status === Live` AND `availableAt < startOfYesterday` (JST) — a stream still
  live whose start day already fell out of the 10-minute today+yesterday window;
  its lifetime metrics keep growing and would otherwise freeze. No time
  lower-bound: every still-live stream is caught on every run regardless of how
  long since the last one.
- `status === Past` AND `actualEnd >= now − 48h` — a stream that ended recently;
  one refresh captures its final metrics.
- `status === Missing` AND `detectedDeletionAt >= now − 48h` — a stream detected
  deleted recently; it will get no further metric updates, so its day file is
  finalized at the last known values.

**The Past/Missing lower bound is 48h, not the 12h run interval, to give an
overlap budget for missed or delayed runs.** A terminal stream (ended / deleted)
is only ever eligible for finalize during this trailing window; unlike the Live
branch it is never revisited afterwards. Selecting a window 4× the run interval
means the finalize job can be delayed, skipped, or fail for up to ~36h and still
re-pick a stream that ended/was-deleted just after the last successful run. Each
run is a full, idempotent regeneration, so the overlapping re-selection across
consecutive runs is harmless; the only cost is regenerating a few extra
recently-terminated dates. Downtime beyond ~36h is an accepted residual (§9),
recoverable with a manual single-date regeneration.

Each matched stream maps to its JST start date; the pass regenerates the
**distinct** set of those dates **minus today and yesterday** (owned by the
10-minute job). This keeps the two scheduled jobs' written file sets disjoint.
The `status === Past` branch is served by the existing `actualEnd` partial index
(`status: Past`) and the `status === Live` branch by the existing partial
`availableAt` index (`status ∈ LiveStatus`). The `status === Missing` branch
filters on `detectedDeletionAt`, which no current index covers, so this design
**adds** a partial index `{ detectedDeletionAt: 1 }` with
`partialFilterExpression: { status: "missing" }` (mirroring the existing
`actualEnd`/`hbEnd` partial indexes) so the branch does not degrade to a full
scan of all historical missing videos as they accumulate.

**Deletion timestamp (`detectedDeletionAt`) — `Video` model + `youtube.ts`.**
The finalize pass's "recently deleted" branch needs to know _when_ a video was
first detected deleted. A new optional `detectedDeletionAt?: Date` `@prop()` is
added to the `Video` model. `video.deleted` is written in exactly one place —
`updateVideoFromYoutube` in `src/modules/youtube.ts` — so the timestamp is
maintained there and only there, on the two `deleted` transitions:

- When a video is found missing from the YouTube response and was **not** already
  `deleted`, set `detectedDeletionAt = now` **once** (guarding on the pre-write
  `deleted` value so repeated crawls of a still-missing video do not overwrite
  the original detection time), then set `deleted = true`.
- When a previously-`deleted` video reappears, clear `detectedDeletionAt`
  (`undefined`) alongside setting `deleted = false`.

This is independent of `Channel.deleted` (a separate field, unaffected).

**Concurrency — single writer per job.** Correctness relies on Agenda never
running two overlapping invocations of the same named job. Agenda registers each
`every(...)` name as one Mongo-backed job document and takes a per-job lock
before dispatching, so a run is not re-dispatched while a prior run of that name
is still in flight — even if `manager` were scaled. Each run is a full,
idempotent regeneration from current DB state. The 10-minute job and the 12-hour
finalize job are **different** Agenda names (different locks), but by
construction they write **disjoint date sets** — the 10-minute job owns today +
yesterday, the finalize job explicitly drops those two dates — so no file has two
scheduled writers and successive runs of each job publish in schedule order.
These runs are sub-second (a few indexed range queries plus small JSON writes);
`job.touch()` after each file renews the lock so a normal run cannot let its lock
lapse mid-run.

**Concurrent writers — no corruption, bounded stale-write accepted.** Two writers
can, in rare cases, target the same `daily-videos/{date}.json`: (a) a manual
`isMain(import.meta)` direct-run — a developer/operator tool that runs **outside**
the Agenda lock — racing a scheduled run; or (b) an Agenda run whose per-job lock
lapses under degradation (a stalled secondary, blocked filesystem, or an
unusually large day pushing a query past the lock lifetime before the first
`job.touch()`), letting a second run of the same job start while the first is
still writing. The unique-temp hardening (§4) guarantees no reader ever observes
a torn or corrupt file in either case. It does **not** guarantee publication
ordering: each run captures its own `snapshotAt` and re-queries the DB, so a
slower older run can `rename` after a newer one and briefly republish staler
content (advertising an older `snapshotAt`). This residual is **accepted, not
fixed with a lock or `snapshotAt` compare-and-swap** (§9): both triggers are rare
(a manual/scheduled collision, or a lock lapse under degradation), the stale
window is bounded to one scheduled interval (≤10 min for the frequent job) and
self-heals on the next run, and a cross-process publication guard would be
disproportionate and inconsistent with every other generator's lock-free writer.

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

**Added index.** A partial index `{ detectedDeletionAt: 1 }` with
`partialFilterExpression: { status: "missing" }` is added to the `Video` model to
serve the finalize job's recently-deleted branch (§5), so it stays fast as
historical missing videos accumulate.

## 7. Data-contract paperwork (`docs/data-contract/`)

**New file-type document (version 1, revision r0):**

- `daily-videos.md` — path pattern `data/daily-videos/{YYYY-MM-DD}.json`, writer
  `src/components/chats-archive/gen-daily-videos-file.ts`, shape from §3.
  Includes: path pattern, writer, version field policy, a revision-history table
  (one r0 row; Date is the implementation date, PR is the merging PR number or
  the `—` placeholder if not known at authoring time — matching the existing
  bootstrap docs), the TypeScript interface, a cumulative
  JSON example, and a reader-guidance section documenting `date` and
  `snapshotAt` as always-present, `videos: []` for a computed-empty day, the
  `availableAt`-descending default order (with the note that consumers may
  re-sort client-side), and the metric-freshness contract (§3): a day file is
  refreshed every 10 min while it is today/yesterday, then at least every 12h
  while it still contains a live stream and typically once more shortly after such
  a stream ends or is detected deleted (barring an extended finalize outage — §9),
  so `viewers`/`maxViewers`/`likes` are a periodically refreshed snapshot —
  `realtime.json` is authoritative for a currently-live stream's instantaneous
  value.

**Removed file-type document:**

- `daily-leaderboard.md` — deleted (§6).

**Deprecated file-type document (doc-only annotation, no shape/version change):**

- `root-index.md` — add a **Deprecated** status banner at the top. The banner
  states that `data/index.json` is superseded by the newer per-purpose files —
  `live` by `realtime.json` + `upcoming.json`, and the per-day started-videos
  purpose of `past` by `daily-videos/{date}.json` — **but must not present
  `past → daily-videos` as a mechanical 1:1 swap**: it explicitly warns that
  `daily-videos` is start-day-bucketed and does **not** preserve `past`'s
  "recently-ended within 48h" semantics (a long-running stream that started
  before yesterday but ended recently is in `past` but not in the scheduled
  today/yesterday `daily-videos` files), that composing an equivalent recent-past
  view is a frontend concern out of scope here, and that the `root-index` writer
  is retained so readers needing the recently-ended set keep working. Add one
  revision-history row recording the deprecation as a documentation-only change
  (no field, shape, or version change; the writer still emits version 1). No
  edits to the shape, example, or reader-guidance beyond the banner + history row.

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
- Finalize selection, in three parts (the Mongo query is mocked in unit tests, so
  the filter's selectivity is proven by asserting the exact filter object rather
  than by running it against a DB):
  - the filter builder asserts the **exact** filter object — the three `$or`
    branches (live-before-yesterday; `Past` with `actualEnd >= now − 48h`;
    `Missing` with `detectedDeletionAt >= now − 48h`) plus the non-matching
    controls encoded as clauses: `actualStart: { $exists: true, $ne: null }`
    (excludes never-started), `uploadedVideo`/`hbIgnore` `$ne: true`, and the
    ended/deleted lower bound at **exactly `now − 48h`** (anything older, or a
    `Missing` stream without a recent `detectedDeletionAt`, is excluded);
  - the date mapper asserts distinct JST start dates **minus today and
    yesterday**, with today/yesterday control docs and a duplicate;
  - the driver (`genDailyVideosFinalize`) integration test asserts it regenerates
    exactly those dates (structurally on the set passed to `genDailyVideosFile`)
    and renews the Agenda lock after each file.

`youtube.spec.ts` (or the existing youtube module test) covers `detectedDeletionAt`
via a stateful fake `Video`: a first missing-from-response crawl sets
`detectedDeletionAt` and `deleted = true`; a second still-missing crawl leaves the
original `detectedDeletionAt` unchanged (set-once); a later reappearing crawl
clears `detectedDeletionAt` and sets `deleted = false`.

`write-data-file.spec.ts` is updated for the unique-temp change (§4): assert the
published file still lands atomically with the exact content, and that the temp
sibling no longer uses a fixed `<path>.tmp` name (so any existing assertion on
the literal temp filename is relaxed to match the `<path>.<pid>.<random>.tmp`
pattern). No behavioral change to the published bytes is expected.

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

- **Concern:** writers of a `daily-videos/{date}.json` file share `writeDataFile`
  with no cross-process publication guard, so two overlapping writers can `rename`
  a staler snapshot after a fresher one and briefly republish older content
  (older `snapshotAt`). Overlap can arise from (a) a manual direct-run racing a
  scheduled run, or (b) an Agenda run whose per-job lock lapses under degradation,
  letting a second run of the same job start before the first finishes.
  **Decision:** accepted; unique-temp writes (§4) prevent torn/corrupt files, but
  no lock or `snapshotAt` compare-and-swap is added to enforce publication
  ordering.
  **Rationale:** normal operation has exactly one scheduled writer per file (the
  10-minute and 12-hour jobs write disjoint dates, and each job's Agenda lock
  serialises its own runs), so overlap needs either a rare manual/scheduled
  collision or a rare lock lapse under degradation; the stale window is bounded to
  one scheduled interval (≤10 min for the frequent job) and self-heals on the next
  run; and a cross-process publication guard would be disproportionate to this
  bounded, self-correcting effect and inconsistent with every other generator's
  lock-free writer.

- **Concern:** the finalize pass selects terminal (ended/deleted) streams by a
  fixed trailing time window (`now − 48h`), with no durable
  `lastSuccessfulFinalizeAt` checkpoint. If the finalize job is down or delayed
  for longer than the window's overlap budget (~36h beyond one run), a stream
  that ended or was detected deleted during the outage can fall out of the window
  before the next run and never get its final metric refresh.
  **Decision:** accepted; the 48h window (4× the 12h interval) is the only
  recovery buffer — no persisted checkpoint / advance-on-success machinery is
  added.
  **Rationale:** the still-live branch has no lower bound and always self-heals on
  the next run; only terminal streams are exposed, and only under a finalize
  outage exceeding ~36h — a rare, operationally visible event — after which a
  single-date manual regeneration recovers the affected file. A durable
  checkpoint would be disproportionate to this residual and matches the project's
  standing preference against hardening rare-outage edges.

- **Concern:** once a frontend release depends on `daily-videos`, deployment /
  rollback ordering is unspecified — rolling the backend back to before this
  change stops producing `daily-videos` (a required dependency), and the removed
  leaderboard writer/job is not retained as a fallback, so a partial rollout or
  rollback could serve 404s / stale views.
  **Decision:** out of scope; no publish-before-read invariant, retained-writer
  coexistence window, or frontend-fallback mechanism is specified here beyond the
  standard additive-feature deploy order (ship the writer before any reader).
  **Rationale:** this is the deployment / rollback / mixed-version class of
  concern the project has standingly ruled disproportionate to enforce in a spec;
  the new output is purely additive and the retained `root-index` remains a
  natural fallback, so release sequencing is an operational/release-process matter
  rather than a design invariant this document must encode.

- **Concern:** the finalize pass only recognizes terminal `Missing` streams via
  the deletion branch (`detectedDeletionAt >= now − 48h`). A started stream can
  instead become `Missing` through a heuristic in `updateVideoFromYoutube` while
  it still exists on YouTube (e.g. live for 2+ days with no viewers, or a
  scheduled stream overslept 48h) — that path runs the found branch and never
  sets `detectedDeletionAt`. Such a stream is no longer `Live`, is not `Past`,
  and has no `detectedDeletionAt`, so once its start day leaves the 10-minute
  today/yesterday window the finalize pass will not pick it up, and its start-day
  file can keep showing the stream as `live` with metrics frozen at its
  last-live snapshot.
  **Decision:** accepted; the finalize `Missing` branch keys only on
  `detectedDeletionAt` (real deletions). No general "became missing" timestamp is
  added and no `hbEnd`-based branch is introduced.
  **Rationale:** this needs the intersection of a long-running stream (2+ days),
  a heuristic Missing transition rather than a real deletion, and its start day
  having already rolled out of the frequent window — a rare edge. A dead stream's
  `maxViewers`/`likes` are already at their effectively-final values, so the
  leaderboard inputs are essentially correct; only the `status` field is stale.
  Generalizing the timestamp (rename + multiple set/clear sites) would be
  disproportionate to this residual and matches the project's standing preference
  against hardening rare edges.

- **Concern:** ignored-channel exclusion in `dailyVideosFilter` /
  `finalizeFilter` keys on the denormalized `Video.hbIgnore` flag
  (`hbIgnore: { $ne: true }`). That flag is propagated from `Channel.hbIgnore`
  opportunistically during a later video crawl (`youtube.ts`), and setting a
  channel ignored (`set-channel is-ignore`) does not synchronously backfill
  existing `Video` documents or regenerate already-written day files. So a video
  whose channel became ignored after it was last crawled can still appear in
  daily-videos, and older `daily-videos/{date}.json` files are not retroactively
  purged.
  **Decision:** accepted; exclusion continues to use the denormalized
  `Video.hbIgnore` flag with no authoritative channel-join or synchronous
  backfill added by this design.
  **Rationale:** this is a pre-existing, project-wide denormalization — the
  removed leaderboard writer used the byte-identical `hbIgnore: { $ne: true }`
  filter, and `root-index`, `channel-index`, cleanup, and the worker all rely on
  the same `Video.hbIgnore` mechanism. daily-videos faithfully reuses the
  established pattern; making only daily-videos authoritative would be
  inconsistent with every other index output and a project-wide change out of
  scope for this feature.

## 10. Open questions

None outstanding.
