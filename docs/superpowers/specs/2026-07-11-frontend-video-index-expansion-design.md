# Frontend video index expansion — design

**Date:** 2026-07-11
**Status:** Draft (awaiting review)
**Area:** `src/components/chats-archive/`, `docs/data-contract/`

## 1. Overview

Extend the set of frontend-facing JSON index files that `chats-archive`
writes under `${CHAT_ARCHIVE_DIR}/data/` (synced to S3, consumed by
`vchat-web`). Four additions:

1. **realtime** (`data/realtime.json`) — currently-live streams only,
   sorted by live viewer count, with a data snapshot timestamp.
2. **upcoming** (`data/upcoming.json`) — two lists: scheduled
   (`status=upcoming`) streams within a 48h window, plus streams that
   went live in the last 10 minutes, with a data snapshot timestamp.
3. **daily maxViewers leaderboard**
   (`data/leaderboard/maxviewers/{YYYY-MM-DD}.json`) — the day's top 50
   streams by peak concurrent viewers, keyed by JST calendar date.
4. **daily likes leaderboard**
   (`data/leaderboard/likes/{YYYY-MM-DD}.json`) — the day's top 50
   streams by like count, keyed by JST calendar date.

To support these, the shared per-video summary produced by
`buildVideoSummary` gains four new optional fields: `viewers`,
`maxViewers`, `likes`, `premiere`. These already exist on the `Video`
model; they are simply surfaced into the summary output. Because the
summary is shared, `root-index` and `channel-index` also carry the new
fields (an additive revision to each).

## 2. Goals / non-goals

**Goals**

- Add `viewers`, `maxViewers`, `likes`, `premiere` to the shared video
  summary shape.
- Produce `realtime.json` and `upcoming.json` every minute.
- Produce daily `maxviewers` and `likes` leaderboards, refreshing today's
  and yesterday's JST files every 10 minutes.
- Document all new/changed outputs in `docs/data-contract/`.

**Non-goals**

- No change to the per-video `video-meta.json` / `.jsonl` writer
  (`archive-video.ts`). The new summary fields land only in the
  index/leaderboard family, not in `video-meta`.
- No new data source. All four surfaced fields are already populated on
  the `Video` model by existing ingestion paths (see §8).
- No backfill of leaderboards for arbitrary historical dates on a
  schedule. The scheduled job only refreshes today + yesterday; a
  single-date function exists for manual/CLI regeneration but no batch
  backfill is scheduled.
- No deployment/rollback/mixed-version orchestration considerations
  beyond the data-contract's standard two-version coexistence window.

## 3. Shared summary change (`buildVideoSummary`)

`src/components/chats-archive/build-video-summary.ts` adds four optional
fields, emitted only when the underlying value is neither `undefined` nor
`null` (matching the existing convention used for `scheduledStart`,
`actualStart`, etc.):

| Field        | Type    | Source (`Video`)   | Notes                                                   |
| ------------ | ------- | ------------------ | ------------------------------------------------------- |
| `viewers`    | number  | `video.viewers`    | Live concurrent viewers; reset to `0` on stream finish. |
| `maxViewers` | number  | `video.maxViewers` | Peak concurrent viewers; persists after finish.         |
| `likes`      | number  | `video.likes`      | Like count; persists after finish.                      |
| `premiere`   | boolean | `video.premiere`   | True for YouTube premieres.                             |

Emission is value-driven (`!= null`), so a live stream carries
`viewers`, an ended stream carries `viewers: 0`, and a stream whose field
was never populated omits the key entirely. This function is used by
`gen-index-file.ts` (root-index), `gen-channel-index-file.ts`
(channel-index), and the new realtime/upcoming/leaderboard builders, so
all five outputs share one shape.

**Reader compatibility for root-index / channel-index.** Because the
shared summary feeds root-index and channel-index, those two existing
files gain the four fields too. This is a purely additive change under
the data-contract's Path A (all four fields optional; no rename, type,
semantic, encoding, unit, or ordering change), so it is a new revision
within version 1, not a version bump. The existing `root-index` and
`channel-index` reader-guidance sections already instruct readers to
**ignore unknown extra fields (forward compatibility)**, which is the
contract every consumer (only `vchat-web`) is built against; a strict
reader that rejected unknown keys would already be violating the
published contract. No reader migration, dual-writer, or shape audit is
therefore required beyond the contract's standard two-version
coexistence window during regeneration. Rollback is symmetric and needs
no special handling: reverting the writer simply stops emitting the four
optional keys, which readers already tolerate as absent.

The resulting summary interface (superset, all four new fields optional):

```ts
interface VideoSummaryWithChannel {
  id: string;
  title: string;
  channel: { id: string; name: string; avatarUrl?: string };
  status: string; // holodex VideoStatus
  duration: number; // seconds
  availableAt: string; // ISO 8601
  archiveVersion: number;
  stats: { superChatTotalJpy: number; memberCount: number; giftCount: number };
  scheduledStart?: string; // ISO 8601
  actualStart?: string; // ISO 8601
  actualEnd?: string; // ISO 8601
  publishedAt?: string; // ISO 8601
  viewers?: number; // NEW
  maxViewers?: number; // NEW
  likes?: number; // NEW
  premiere?: boolean; // NEW
}
```

The channel-less variant (`VideoSummaryNoChannel`, used by
channel-index) gains the same four optional fields and omits `channel`.

## 4. realtime (`data/realtime.json`)

```ts
interface RealtimeIndex {
  snapshotAt: string; // ISO 8601; when this snapshot was generated
  live: VideoSummaryWithChannel[]; // status=live only, sorted desc by viewers
}
```

**Generation**

- Query: `VideoModel.findLiveVideos(48)` (already excludes `hbIgnore`),
  populate `channel`, `readPreference: "secondaryPreferred"`.
- Filter to `status === Live`.
- Sort descending by `viewers ?? 0`; ties and missing viewer counts keep
  a stable order (streams with no reported viewers sink to the bottom).
- `snapshotAt` is the generation wall-clock time (ISO 8601).
- No top-N cap: the concurrently-live set is naturally bounded.

## 5. upcoming (`data/upcoming.json`)

```ts
interface UpcomingIndex {
  snapshotAt: string; // ISO 8601
  upcoming: VideoSummaryWithChannel[]; // status=upcoming, within 48h window
  recentlyStarted: VideoSummaryWithChannel[]; // status=live, availableAt within last 10 min
}
```

**Generation**

- Shares one `findLiveVideos(48)` query pass with realtime (see §7): the
  48h upper bound is applied via the `maxUpcomingHours` argument, which
  bounds `availableAt`. Sharing the fetch is purely an efficiency measure
  (one DB round-trip instead of two); each file carries its **own**
  `snapshotAt`.
- **Cross-file consistency is explicitly not guaranteed.** The two files
  are published independently (each via its own tmp+rename in §7), so a
  reader may momentarily observe `realtime.json` from one generation and
  `upcoming.json` from the previous one if a run is interrupted between
  the two renames. This is acceptable and requires no cross-file publish
  protocol: the frontend consumes the two files on separate views (a
  "now live" view vs. an "upcoming / just started" view), and the only
  overlap — a stream appearing in both `realtime.live` and
  `upcoming.recentlyStarted` for up to a minute during the live
  transition — is harmless and self-correcting on the next run. Readers
  must therefore treat each file's `snapshotAt` as authoritative for
  that file only and must not join the two files assuming a shared
  instant.
- `upcoming`: `status === Upcoming`. The 48h bound (matching the existing
  root-index behaviour) keeps far-future standing free-chat rooms out of
  the list.
- `recentlyStarted`: `status === Live` AND
  `availableAt >= snapshotAt - 10min`. Holodex sets `availableAt` to a
  stream's actual start once live (falling back to scheduled start
  otherwise), so this captures streams that transitioned
  upcoming→live within the last 10 minutes, letting them linger on the
  upcoming page briefly. Premieres are included when their `availableAt`
  falls in the window.
- Ordering: `upcoming` ascending by `availableAt` (soonest first);
  `recentlyStarted` descending by `availableAt` (most recent first).

## 6. daily leaderboards (`data/leaderboard/{metric}/{YYYY-MM-DD}.json`)

One file-type covering two metrics; `{metric}` is `maxviewers` or
`likes`, `{YYYY-MM-DD}` is the JST calendar date.

```ts
interface Leaderboard {
  date: string; // "YYYY-MM-DD" in JST
  snapshotAt: string; // ISO 8601
  metric: "maxViewers" | "likes";
  entries: VideoSummaryWithChannel[]; // top 50, sorted desc by metric
}
```

**Day attribution and leaderboard semantics**

- This is a **start-date leaderboard ranked by lifetime metric**, not a
  per-day activity leaderboard. Each stream is attributed to exactly one
  JST day — the day its `availableAt` falls in — and is ranked by its
  full-lifetime `maxViewers` / `likes` value as stored on the `Video`
  model (peak concurrent viewers, cumulative likes). The ranked metric is
  **not** re-scoped to the calendar day.
- Consequence, stated deliberately: a stream that starts just before JST
  midnight and reaches its peak viewers or most likes after midnight
  stays only in the start day's file with its whole-lifetime metric; it
  does not also appear in the next day's leaderboard. This is intended —
  honeybee stores only the running lifetime peak/count per stream, not a
  time-bucketed series, so a true per-day-windowed metric is not
  computable from existing data and is out of scope. The data-contract
  document and reader guidance describe the file as start-date +
  lifetime-metric so consumers do not read it as same-day activity.
- Query range for a date `D`:
  `[D 00:00 Asia/Tokyo, (D+1) 00:00 Asia/Tokyo)` converted to UTC via
  `moment-timezone`, matched against `availableAt`.

**Qualification and ordering**

- `metric > 0` (the `maxViewers` or `likes` field respectively).
- Exclude `uploadedVideo === true` and `hbIgnore === true`.
- Status is not filtered (any stream available that day qualifies if its
  metric is positive).
- Sort descending by the metric; take the first 50.
- Populate `channel`; entries reuse the shared summary shape.

**Core function and scheduling**

- Core: `genLeaderboardFile(date: string, metric: "maxViewers" | "likes")`
  writes one file for one JST date + metric.
- Scheduled driver: compute "today" and "yesterday" from the current JST
  time, then call the core for each of the 2 dates × 2 metrics = 4 files
  per run. Refreshing yesterday keeps a stream that crossed JST midnight
  (max stream length ~12h) accurate until it ends.
- The single-date core also serves manual CLI regeneration; no scheduled
  historical backfill.

**Empty day**

- If a date has zero qualifying streams, the writer still emits a valid
  file with `entries: []`. This is deterministic and lets a reader
  distinguish "no data yet" (404) from "computed, nobody qualified"
  (empty array).

## 7. Scheduling and file writing

Two new Agenda jobs registered in `src/components/chats-archive.ts`
(guarded by the existing `if (CHAT_ARCHIVE_DIR)` block, alongside the
current `chats archive` and `chats archive index` jobs):

- `chats archive realtime` — `agenda.every("1 minutes", ...)`. One job
  invocation performs a single `findLiveVideos(48)` query and writes both
  `realtime.json` and `upcoming.json` (each file stamped with its own
  `snapshotAt` at write time).
- `chats archive leaderboard` — `agenda.every("10 minutes", ...)`.
  Refreshes today + yesterday × both metrics.

All writes use the existing atomic pattern: write to `<path>.tmp`, then
`rename` into place; `mkdir -p` the parent directory first.

**Concurrency and stale-write safety.** These jobs inherit the same
guarantees as the existing `chats archive` (1 min) and `chats archive
index` (10 min) jobs, which already run at these cadences without extra
locking. Agenda registers each `every(...)` name as a single Mongo-backed
job document and holds a per-job lock (default `lockLifetime` 10 minutes)
while a run is in flight, so a slow invocation of a given job is not
re-dispatched until it finishes or its lock expires — the same job never
runs two overlapping invocations. `manager` runs these periodics as a
single instance. Consequently, for any one output file there is at most
one writer at a time and invocations of the same job are serialized in
schedule order, so a newer generation cannot be overwritten by an older
one. (The realtime job and the leaderboard job write disjoint file sets,
so they never contend for the same path.) No additional per-file lock or
monotonic `snapshotAt` guard is introduced; adding one would duplicate a
guarantee Agenda already provides for the existing jobs. If `manager` is
ever scaled to multiple replicas, Agenda's Mongo job lock still prevents
concurrent execution of the same named job across instances.

The `isMain(import.meta)` direct-run block in `chats-archive.ts` is
extended to invoke the realtime/upcoming generator and the leaderboard
generator once each (in addition to the existing `genIndexFile`), so a
manual CLI run regenerates the full family.

**Module layout** (`src/components/chats-archive/`)

- `build-video-summary.ts` — extended with the four fields.
- `gen-realtime-file.ts` — fetches live videos once, writes
  `realtime.json` and `upcoming.json`. Holds the live/upcoming/
  recently-started partition and sort logic.
- `gen-leaderboard-file.ts` — exports `genLeaderboardFile(date, metric)`
  (single file) and a driver that refreshes today + yesterday × both
  metrics.

## 8. Data source justification (data-contract §8.1)

No new data source is introduced; all four surfaced fields are already
populated on the `Video` model by existing code:

- `viewers`, `maxViewers` — set by `Video.updateFromHolodex` (from
  Holodex `liveViewers`) and `Video.updateFromMasterchat` (from watch-page
  `viewCount`). `updateResult` resets `viewers` to `0` on finish.
- `likes` — set by `Video.updateFromMasterchat` (watch-page `likes`).
- `premiere` — populated from Holodex stream metadata on the `Video`
  model.

Because the change surfaces already-present model fields into an index
output, the data-contract research report requirement is satisfied by
citing these existing writers; no external fetch is added.

## 9. Data-contract paperwork (`docs/data-contract/`)

All four outputs are additive at the directory level. Changes:

**New file-type documents (each starts at version 1, revision r0):**

- `realtime.md` — path `data/realtime.json`, writer
  `src/components/chats-archive/gen-realtime-file.ts`, shape from §4.
- `upcoming.md` — path `data/upcoming.json`, same writer, shape from §5.
- `daily-leaderboard.md` — path pattern
  `data/leaderboard/{metric}/{YYYY-MM-DD}.json`, writer
  `src/components/chats-archive/gen-leaderboard-file.ts`, shape from §6.
  Documents both metric paths and the empty-day behaviour.

Each new document includes: path pattern, writer, version field policy,
revision-history table (one r0 row with concrete Date/PR), the TypeScript
interface, a cumulative JSON example, and a reader-guidance section. The
snapshot timestamps (`snapshotAt`) and leaderboard `date` are documented
as always-present.

**Additive revisions to existing documents (version stays 1, add r1):**

- `root-index.md` — add r1 listing `viewers`, `maxViewers`, `likes`,
  `premiere` as optional per-video-summary fields ("May be absent …
  since r1"); regenerate the cumulative JSON example; add a
  revision-history row; update `Current writer emits` to `version 1,
revision r1`.
- `channel-index.md` — same r1 treatment for `VideoSummaryNoChannel`.

**Index update:**

- `README.md` §2 file-type index gains three rows (realtime, upcoming,
  daily-leaderboard), each at active version 1.

Writer source, JSDoc, and commit messages must describe field shapes
inline and must not reference the contract documents (data-contract §8.1
anti-leak rule).

## 10. Testing

- `build-video-summary.spec.ts` — each new field is emitted with a
  structural assertion when the model value is present, and omitted when
  `undefined`/`null`; `viewers: 0` for a finished stream is emitted.
- realtime builder — `live` filtered to `status=live`; descending
  `viewers` order asserted structurally (including a stream with missing
  viewers sorted last); `snapshotAt` present.
- upcoming builder — `upcoming` contains only `status=upcoming` within
  48h; `recentlyStarted` boundary asserted at exactly 10 minutes
  (a stream at `snapshotAt - 10min + ε` included, one just outside
  excluded); ordering asserted.
- leaderboard — JST day attribution across a stream whose `availableAt`
  is near JST midnight (belongs to the correct day); top-50 truncation;
  `metric > 0` filter; `uploadedVideo`/`hbIgnore` exclusion; empty-day
  emits `entries: []`.

Tests use `jest.mock` on the model module and stateful fakes where DB
state transitions are observed, per project test conventions.

## 11. Open questions

None outstanding. The upcoming `upcoming`-list window is fixed at 48h to
match root-index and exclude far-future standing free-chat rooms.
