# Frontend Video Index Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four new frontend-facing JSON outputs (realtime live index, upcoming index, and daily maxViewers / likes leaderboards) written by the `chats-archive` component, and surface `viewers`/`maxViewers`/`likes`/`premiere` into the shared per-video summary.

**Architecture:** Pure builder functions (filter/sort/partition over arrays of `Video` documents) are unit-tested in isolation; thin orchestrator functions do the Mongo query and atomic file write. Two new Agenda jobs in `src/components/chats-archive.ts` drive generation (realtime+upcoming every minute, leaderboards every 10 minutes over today+yesterday JST). All writes go through one atomic `mkdir → tmp → rename` helper. Data-contract markdown documents every new/changed output.

**Tech Stack:** TypeScript (ESM, NodeNext), Typegoose/Mongoose, Agenda, `moment-timezone`, `holodex.js` `VideoStatus`, Jest (ts-jest ESM).

**Reference (do not modify unless a task says so):** design at `docs/superpowers/specs/2026-07-11-frontend-video-index-expansion-design.md`. Existing writers to mirror: `src/components/chats-archive/gen-index-file.ts`, `src/components/chats-archive/build-video-summary.ts`.

**Conventions every task follows:**

- ESM source imports use `.js` extensions even for `.ts` files.
- Tests: `/// <reference types="jest" />` + imports from `@jest/globals`; place `*.spec.ts` beside the implementation.
- Model interactions are mocked with `jest.spyOn(VideoModel, "<staticMethod>")` (restored via `jest.restoreAllMocks()` in `afterEach`). This is a deliberate, repo-aligned deviation from the design's "`jest.mock` the model module" wording: it matches the repo's established model-test pattern (see `src/models/Channel.spec.ts`, which spies `ChannelModel.findByChannelId`) and mocks the model object's own static, so it is ESM-safe where module-namespace mocking/spying is not.
- Video summaries are typed `Record<string, unknown>` throughout, matching `buildVideoSummary`'s existing return type and the existing `gen-index-file.ts` / `gen-channel-index-file.ts` writers; the concrete field set is owned by `buildVideoSummary`, and the data-contract docs are the normative field-shape reference for consumers.
- Final verification per task runs `npm run build` (tsc type-check) and `npm run lint`, plus the task's own Jest file. All three must pass before the commit step.
- Commit each task separately. Use `git add <explicit paths>` — never `git add -A`.

---

### Task 1: Surface viewers/maxViewers/likes/premiere in the shared summary

**Files:**

- Modify: `src/components/chats-archive/build-video-summary.ts`
- Test: `src/components/chats-archive/build-video-summary.spec.ts` (create)

The four fields already exist on the `Video` model (`viewers`, `maxViewers`, `likes` as `number`, `premiere` as `boolean`). `buildVideoSummary` currently copies a fixed set of optional date keys with an "emit only when `!= null`" loop; extend that loop's key tuple with the four new keys. The `as const` tuple keeps the keys type-checked against `Video`.

- [ ] **Step 1: Write the failing test**

Create `src/components/chats-archive/build-video-summary.spec.ts`:

```ts
/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { VideoStatus } from "holodex.js";
import { buildVideoSummary } from "./build-video-summary.js";

function makeVideo(overrides: Record<string, unknown> = {}) {
  return {
    id: "vid001",
    title: "Test stream",
    channelId: "UCchan",
    status: VideoStatus.Live,
    duration: 0,
    availableAt: new Date("2026-07-11T08:00:00.000Z"),
    hbStats: { chatsArchiveVersion: 2 },
    getChannel: async () => ({ id: "UCchan", name: "Chan", avatarUrl: null }),
    ...overrides,
  } as any;
}

describe("buildVideoSummary new fields", () => {
  it("emits viewers, maxViewers, likes, premiere when present", async () => {
    const summary = await buildVideoSummary(
      makeVideo({ viewers: 100, maxViewers: 250, likes: 42, premiere: true })
    );
    expect(summary).toMatchObject({
      viewers: 100,
      maxViewers: 250,
      likes: 42,
      premiere: true,
    });
  });

  it("emits viewers: 0 for a finished stream", async () => {
    const summary = await buildVideoSummary(
      makeVideo({ status: VideoStatus.Past, viewers: 0, maxViewers: 300 })
    );
    expect(summary.viewers).toBe(0);
    expect(summary.maxViewers).toBe(300);
  });

  it("omits fields that are undefined or null", async () => {
    const summary = await buildVideoSummary(
      makeVideo({
        viewers: undefined,
        maxViewers: null,
        likes: undefined,
        premiere: undefined,
      })
    );
    expect("viewers" in summary).toBe(false);
    expect("maxViewers" in summary).toBe(false);
    expect("likes" in summary).toBe(false);
    expect("premiere" in summary).toBe(false);
  });

  it("emits the new fields on the channel-less summary too", async () => {
    const summary = await buildVideoSummary(
      makeVideo({ maxViewers: 500, likes: 12 }),
      { includeChannel: false }
    );
    expect("channel" in summary).toBe(false);
    expect(summary).toMatchObject({ maxViewers: 500, likes: 12 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/components/chats-archive/build-video-summary.spec.ts`
Expected: the `viewers`/`maxViewers`/`likes`/`premiere` tests FAIL (summary lacks those fields).

- [ ] **Step 3: Extend the key tuple**

In `src/components/chats-archive/build-video-summary.ts`, replace this loop header:

```ts
  for (const key of [
    "scheduledStart",
    "actualStart",
    "actualEnd",
    "publishedAt",
  ] as const) {
```

with:

```ts
  for (const key of [
    "scheduledStart",
    "actualStart",
    "actualEnd",
    "publishedAt",
    "viewers",
    "maxViewers",
    "likes",
    "premiere",
  ] as const) {
```

Leave the loop body (`const val = video[key]; if (val !== undefined && val !== null) summary[key] = val;`) unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/components/chats-archive/build-video-summary.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify build + lint**

Run: `npm run build && npm run lint`
Expected: both succeed with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/chats-archive/build-video-summary.ts src/components/chats-archive/build-video-summary.spec.ts
git commit -m "feat(chats-archive): add viewers/maxViewers/likes/premiere to video summary"
```

---

### Task 2: Atomic data-file write helper

**Files:**

- Create: `src/components/chats-archive/write-data-file.ts`
- Test: `src/components/chats-archive/write-data-file.spec.ts` (create)

Extract the `mkdir → write tmp → rename` pattern (currently inlined in `gen-index-file.ts`) into a reusable helper the three new writers share. `dataFilePath(...segments)` resolves a path under `${CHAT_ARCHIVE_DIR}/data/` and asserts the dir is configured; `writeDataFile(absPath, data)` performs the atomic write and is env-free so it can be tested against a real temp directory.

- [ ] **Step 1: Write the failing test**

Create `src/components/chats-archive/write-data-file.spec.ts`:

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it } from "@jest/globals";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeDataFile } from "./write-data-file.js";

describe("writeDataFile", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  });

  it("creates parent dirs and writes JSON with a trailing newline", async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-write-"));
    const target = path.join(dir, "nested", "out.json");
    await writeDataFile(target, { a: 1, b: [2, 3] });
    const text = await fsp.readFile(target, "utf-8");
    expect(text).toBe('{"a":1,"b":[2,3]}\n');
  });

  it("leaves no .tmp sibling behind after a successful write", async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-write-"));
    const target = path.join(dir, "out.json");
    await writeDataFile(target, { ok: true });
    await expect(fsp.access(`${target}.tmp`)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/components/chats-archive/write-data-file.spec.ts`
Expected: FAIL — cannot find module `./write-data-file.js`.

- [ ] **Step 3: Write the helper**

Create `src/components/chats-archive/write-data-file.ts`:

```ts
import assert from "node:assert";
import fsp from "node:fs/promises";
import path from "node:path";
import { CHAT_ARCHIVE_DIR } from "../../constants.js";

/**
 * Resolve a path under `${CHAT_ARCHIVE_DIR}/data/…`. Asserts the archive
 * directory is configured; callers run only inside the `if (CHAT_ARCHIVE_DIR)`
 * guard, so the assertion never fires in practice.
 */
export function dataFilePath(...segments: string[]): string {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  return path.join(CHAT_ARCHIVE_DIR, "data", ...segments);
}

/**
 * Write `data` as compact JSON (trailing newline) to `absPath` atomically:
 * create the parent directory, write a temp sibling, then rename it into place
 * so a reader never observes a partially written file.
 */
export async function writeDataFile(
  absPath: string,
  data: unknown
): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp`;
  await fsp.rm(tmp, { force: true });
  await fsp.writeFile(tmp, JSON.stringify(data) + "\n", "utf-8");
  await fsp.rename(tmp, absPath);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/components/chats-archive/write-data-file.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify build + lint**

Run: `npm run build && npm run lint`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/components/chats-archive/write-data-file.ts src/components/chats-archive/write-data-file.spec.ts
git commit -m "refactor(chats-archive): add atomic data-file write helper"
```

---

### Task 3: realtime + upcoming generator

**Files:**

- Create: `src/components/chats-archive/gen-realtime-file.ts`
- Test: `src/components/chats-archive/gen-realtime-file.spec.ts` (create)

`buildRealtimeIndex` and `buildUpcomingIndex` are pure functions over an array of `Video` documents plus a snapshot instant — these hold all the filter/sort/partition logic and are the unit-tested surface. `queryLiveVideos` is the model-touching fetch (unit-tested by spying `VideoModel.findLiveVideos`). `genRealtimeAndUpcomingFiles` is thin glue: one `queryLiveVideos()` fetch shared by both builders, but each file is stamped with **its own** `snapshotAt` taken immediately before that file is built/written and published via its own atomic write — the two files are not a joined snapshot. Realtime keeps only `live` status sorted by viewers desc (id asc tiebreak); upcoming splits `upcoming` status (soonest first) from streams that went live in the last 10 minutes (newest first). Explicit return-type interfaces on the builders describe each output shape inline.

The 48h upper bound on the `upcoming` list is enforced **at the fetch** — `findLiveVideos(48)` already bounds `availableAt` — so `buildUpcomingIndex` deliberately does **not** re-filter by 48h; it trusts its input is already window-bounded and only partitions by status / the 10-minute recently-started window. The builder tests therefore assert status partitioning and the 10-minute boundary, not the 48h cut (which belongs to `queryLiveVideos`, covered by its own spy test).

- [ ] **Step 1: Write the failing test**

Create `src/components/chats-archive/gen-realtime-file.spec.ts`:

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { VideoStatus } from "holodex.js";
import VideoModel from "../../models/Video.js";
import {
  buildRealtimeIndex,
  buildUpcomingIndex,
  queryLiveVideos,
} from "./gen-realtime-file.js";

function v(overrides: Record<string, unknown>) {
  return {
    id: "vid",
    title: "T",
    channelId: "UCc",
    status: VideoStatus.Live,
    duration: 0,
    availableAt: new Date("2026-07-11T08:00:00.000Z"),
    hbStats: { chatsArchiveVersion: 2 },
    getChannel: async () => ({ id: "UCc", name: "C" }),
    ...overrides,
  } as any;
}

// A stand-in for a mongoose Query: chainable and async-iterable.
function fakeQuery(docs: unknown[]) {
  const q: any = {
    populate: () => q,
    setOptions: () => q,
    async *[Symbol.asyncIterator]() {
      for (const d of docs) yield d;
    },
  };
  return q;
}

const SNAP = new Date("2026-07-11T09:00:00.000Z");

describe("buildRealtimeIndex", () => {
  it("keeps only live videos, sorted by viewers desc then id asc", async () => {
    const videos = [
      v({ id: "a", status: VideoStatus.Upcoming, viewers: 999 }),
      v({ id: "b", status: VideoStatus.Live, viewers: 50 }),
      v({ id: "c", status: VideoStatus.Live, viewers: 50 }),
      v({ id: "d", status: VideoStatus.Live, viewers: 200 }),
      v({ id: "e", status: VideoStatus.Live }), // viewers undefined -> treated as 0, last
    ];
    const out = await buildRealtimeIndex(videos, SNAP);
    expect(out.snapshotAt).toBe("2026-07-11T09:00:00.000Z");
    expect(out.live.map((s) => s.id)).toEqual(["d", "b", "c", "e"]);
  });
});

describe("buildUpcomingIndex", () => {
  it("splits upcoming vs recently-started at the 10-minute boundary", async () => {
    const videos = [
      v({
        id: "u1",
        status: VideoStatus.Upcoming,
        availableAt: new Date("2026-07-11T20:00:00.000Z"),
      }),
      v({
        id: "u2",
        status: VideoStatus.Upcoming,
        availableAt: new Date("2026-07-11T12:00:00.000Z"),
      }),
      // live, availableAt exactly 10 min before snapshot -> included
      v({
        id: "r_in",
        status: VideoStatus.Live,
        availableAt: new Date("2026-07-11T08:50:00.000Z"),
      }),
      // live, availableAt 1s past the window -> excluded
      v({
        id: "r_out",
        status: VideoStatus.Live,
        availableAt: new Date("2026-07-11T08:49:59.000Z"),
      }),
      // live, just started -> included, newest first
      v({
        id: "r_new",
        status: VideoStatus.Live,
        availableAt: new Date("2026-07-11T08:59:00.000Z"),
      }),
    ];
    const out = await buildUpcomingIndex(videos, SNAP);
    expect(out.snapshotAt).toBe("2026-07-11T09:00:00.000Z");
    expect(out.upcoming.map((s) => s.id)).toEqual(["u2", "u1"]); // soonest first
    expect(out.recentlyStarted.map((s) => s.id)).toEqual(["r_new", "r_in"]); // newest first
  });
});

describe("queryLiveVideos", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("fetches the live/upcoming set within a 48h window and returns them", async () => {
    const docs = [v({ id: "a" }), v({ id: "b" })];
    const spy = jest
      .spyOn(VideoModel, "findLiveVideos")
      .mockReturnValue(fakeQuery(docs) as any);

    const result = await queryLiveVideos();

    expect(spy).toHaveBeenCalledWith(48);
    expect(result.map((d) => d.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/components/chats-archive/gen-realtime-file.spec.ts`
Expected: FAIL — cannot find module `./gen-realtime-file.js`.

- [ ] **Step 3: Write the builders and orchestrator**

Create `src/components/chats-archive/gen-realtime-file.ts`:

```ts
import type { Job } from "agenda";
import type { DocumentType } from "@typegoose/typegoose";
import { VideoStatus } from "holodex.js";
import VideoModel, { type Video } from "../../models/Video.js";
import { buildVideoSummary } from "./build-video-summary.js";
import { dataFilePath, writeDataFile } from "./write-data-file.js";

// A stream that has just gone live lingers on the upcoming page for this long
// after its availableAt, so viewers who saw it as upcoming can still find it.
const RECENTLY_STARTED_WINDOW_MS = 10 * 60 * 1000;

type VideoDoc = DocumentType<Video>;

// Each entry is a video summary (see build-video-summary.ts) with a shared base
// of always-present keys plus optional fields including viewers/maxViewers/likes.
interface RealtimeIndex {
  snapshotAt: string; // ISO 8601 instant this file was generated
  live: Record<string, unknown>[]; // status "live", sorted desc by viewers
}

interface UpcomingIndex {
  snapshotAt: string; // ISO 8601 instant this file was generated
  upcoming: Record<string, unknown>[]; // status "upcoming", soonest first
  recentlyStarted: Record<string, unknown>[]; // status "live", started <10 min ago, newest first
}

function byIdAsc(a: VideoDoc, b: VideoDoc): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function summarize(
  videos: VideoDoc[]
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const video of videos) out.push(await buildVideoSummary(video));
  return out;
}

export async function buildRealtimeIndex(
  videos: VideoDoc[],
  snapshotAt: Date
): Promise<RealtimeIndex> {
  const live = videos
    .filter((video) => video.status === VideoStatus.Live)
    .sort((a, b) => (b.viewers ?? 0) - (a.viewers ?? 0) || byIdAsc(a, b));
  return { snapshotAt: snapshotAt.toISOString(), live: await summarize(live) };
}

export async function buildUpcomingIndex(
  videos: VideoDoc[],
  snapshotAt: Date
): Promise<UpcomingIndex> {
  const cutoff = snapshotAt.getTime() - RECENTLY_STARTED_WINDOW_MS;
  const upcomingDocs = videos
    .filter((video) => video.status === VideoStatus.Upcoming)
    .sort(
      (a, b) =>
        a.availableAt.getTime() - b.availableAt.getTime() || byIdAsc(a, b)
    );
  const recentlyStartedDocs = videos
    .filter(
      (video) =>
        video.status === VideoStatus.Live &&
        video.availableAt.getTime() >= cutoff
    )
    .sort(
      (a, b) =>
        b.availableAt.getTime() - a.availableAt.getTime() || byIdAsc(a, b)
    );
  return {
    snapshotAt: snapshotAt.toISOString(),
    upcoming: await summarize(upcomingDocs),
    recentlyStarted: await summarize(recentlyStartedDocs),
  };
}

/** Fetch the current live + upcoming set (bounded to the next 48h). */
export async function queryLiveVideos(): Promise<VideoDoc[]> {
  const videos: VideoDoc[] = [];
  for await (const video of VideoModel.findLiveVideos(48)
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    videos.push(video);
  }
  return videos;
}

/**
 * Fetch the current live/upcoming set once, then publish `realtime.json` and
 * `upcoming.json` independently. Each file gets its own `snapshotAt` taken just
 * before it is built, and its own atomic write; readers must treat each file's
 * `snapshotAt` as authoritative for that file only and must not join the two.
 * The optional `job` renews the Agenda lock between the two writes so a slow
 * run cannot let its lock lapse mid-run.
 */
export async function genRealtimeAndUpcomingFiles(job?: Job): Promise<void> {
  const videos = await queryLiveVideos();
  const realtime = await buildRealtimeIndex(videos, new Date());
  await writeDataFile(dataFilePath("realtime.json"), realtime);
  await job?.touch();
  const upcoming = await buildUpcomingIndex(videos, new Date());
  await writeDataFile(dataFilePath("upcoming.json"), upcoming);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/components/chats-archive/gen-realtime-file.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify build + lint**

Run: `npm run build && npm run lint`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/components/chats-archive/gen-realtime-file.ts src/components/chats-archive/gen-realtime-file.spec.ts
git commit -m "feat(chats-archive): generate realtime and upcoming index files"
```

---

### Task 4: daily leaderboard generator

**Files:**

- Create: `src/components/chats-archive/gen-leaderboard-file.ts`
- Test: `src/components/chats-archive/gen-leaderboard-file.spec.ts` (create)

The query-shape logic and the ranking logic are both extracted into pure, unit-tested functions so nothing important lives only in an un-tested Mongo call:

- `jstDayRangeUtc(date)` maps a `YYYY-MM-DD` JST day to its UTC `[start, end)` bounds (pure).
- `leaderboardFilter(date, metric)` builds the Mongo filter (metric `> 0`, exclude `uploadedVideo`/`hbIgnore`, `availableAt` in the JST-day range) — pure, so the `metric > 0` and exclusion rules are asserted directly without a DB.
- `buildLeaderboard(date, metric, videos, snapshotAt)` sorts by the metric desc (id asc tiebreak), caps at 50, and builds summaries (pure).
- `queryLeaderboardVideos(date, metric)` runs `VideoModel.find(leaderboardFilter(...))` and is unit-tested by spying `VideoModel.find`.
- `genLeaderboardFile(date, metric)` = query → build → atomic write of one file.
- `genDailyLeaderboards` refreshes today + yesterday × both metrics, deriving **both** dates from a single captured `now` so it cannot straddle JST midnight between two clock reads.

`moment-timezone` is imported directly (not `moment`) to guarantee the `Asia/Tokyo` zone data is loaded. An explicit `Leaderboard` return-type interface describes the output shape inline.

- [ ] **Step 1: Write the failing test**

Create `src/components/chats-archive/gen-leaderboard-file.spec.ts`:

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { VideoStatus } from "holodex.js";
import VideoModel from "../../models/Video.js";
import {
  buildLeaderboard,
  jstDayRangeUtc,
  leaderboardFilter,
  queryLeaderboardVideos,
} from "./gen-leaderboard-file.js";

function v(overrides: Record<string, unknown>) {
  return {
    id: "vid",
    title: "T",
    channelId: "UCc",
    status: VideoStatus.Past,
    duration: 0,
    availableAt: new Date("2026-07-11T08:00:00.000Z"),
    hbStats: { chatsArchiveVersion: 2 },
    getChannel: async () => ({ id: "UCc", name: "C" }),
    ...overrides,
  } as any;
}

// A stand-in for a mongoose Query: chainable and async-iterable.
function fakeQuery(docs: unknown[]) {
  const q: any = {
    populate: () => q,
    setOptions: () => q,
    async *[Symbol.asyncIterator]() {
      for (const d of docs) yield d;
    },
  };
  return q;
}

const SNAP = new Date("2026-07-11T09:00:00.000Z");

describe("jstDayRangeUtc", () => {
  it("maps a JST calendar day to its UTC [start, end) bounds", () => {
    const { start, end } = jstDayRangeUtc("2026-07-11");
    expect(start.toISOString()).toBe("2026-07-10T15:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-11T15:00:00.000Z");
  });

  it("attributes a near-JST-midnight stream to the correct day", () => {
    const { start, end } = jstDayRangeUtc("2026-07-11");
    const lateOn11 = new Date("2026-07-11T14:30:00.000Z"); // 23:30 JST on 2026-07-11
    const earlyOn12 = new Date("2026-07-11T15:30:00.000Z"); // 00:30 JST on 2026-07-12
    // late-on-the-11th falls inside the 11th's [start, end) range...
    expect(lateOn11.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(lateOn11.getTime()).toBeLessThan(end.getTime());
    // ...while just-past-midnight belongs to the next day (>= end), excluded here.
    expect(earlyOn12.getTime()).toBeGreaterThanOrEqual(end.getTime());
  });
});

describe("leaderboardFilter", () => {
  it("filters by JST-day range, positive metric, and excludes uploaded/ignored", () => {
    expect(leaderboardFilter("2026-07-11", "maxViewers")).toEqual({
      availableAt: {
        $gte: new Date("2026-07-10T15:00:00.000Z"),
        $lt: new Date("2026-07-11T15:00:00.000Z"),
      },
      uploadedVideo: { $ne: true },
      hbIgnore: { $ne: true },
      maxViewers: { $gt: 0 },
    });
  });

  it("uses the likes field when metric is likes", () => {
    expect(leaderboardFilter("2026-07-11", "likes")).toMatchObject({
      likes: { $gt: 0 },
    });
  });
});

describe("buildLeaderboard", () => {
  it("ranks by metric desc, caps at 50, and stamps date/metric/snapshot", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      v({ id: `v${String(i).padStart(2, "0")}`, maxViewers: 1000 - i })
    );
    const out = await buildLeaderboard("2026-07-11", "maxViewers", many, SNAP);
    expect(out.entries).toHaveLength(50);
    expect(out.entries[0].id).toBe("v00");
    expect(out.entries[49].id).toBe("v49");
    expect(out.date).toBe("2026-07-11");
    expect(out.metric).toBe("maxViewers");
    expect(out.snapshotAt).toBe("2026-07-11T09:00:00.000Z");
  });

  it("breaks equal-metric ties by ascending id", async () => {
    const out = await buildLeaderboard(
      "2026-07-11",
      "likes",
      [
        v({ id: "zeta", likes: 10 }),
        v({ id: "alpha", likes: 10 }),
        v({ id: "mid", likes: 20 }),
      ],
      SNAP
    );
    expect(out.entries.map((e) => e.id)).toEqual(["mid", "alpha", "zeta"]);
  });

  it("emits an empty entries array for a day with no qualifying streams", async () => {
    const out = await buildLeaderboard("2026-07-11", "maxViewers", [], SNAP);
    expect(out.entries).toEqual([]);
  });
});

describe("queryLeaderboardVideos", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("queries VideoModel.find with the leaderboard filter and returns the docs", async () => {
    const docs = [v({ id: "a", maxViewers: 5 }), v({ id: "b", maxViewers: 9 })];
    const spy = jest
      .spyOn(VideoModel, "find")
      .mockReturnValue(fakeQuery(docs) as any);

    const result = await queryLeaderboardVideos("2026-07-11", "maxViewers");

    expect(spy).toHaveBeenCalledWith(
      leaderboardFilter("2026-07-11", "maxViewers")
    );
    expect(result.map((d) => d.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/components/chats-archive/gen-leaderboard-file.spec.ts`
Expected: FAIL — cannot find module `./gen-leaderboard-file.js`.

- [ ] **Step 3: Write the helpers, builder, and orchestrator**

Create `src/components/chats-archive/gen-leaderboard-file.ts`:

```ts
import type { Job } from "agenda";
import type { DocumentType } from "@typegoose/typegoose";
import moment from "moment-timezone";
import type { FilterQuery } from "mongoose";
import VideoModel, { type Video } from "../../models/Video.js";
import { buildVideoSummary } from "./build-video-summary.js";
import { dataFilePath, writeDataFile } from "./write-data-file.js";

export type LeaderboardMetric = "maxViewers" | "likes";

const METRICS: readonly LeaderboardMetric[] = ["maxViewers", "likes"];
const LEADERBOARD_SIZE = 50;
const JST = "Asia/Tokyo";

// URL-friendly directory name for each metric.
const METRIC_DIR: Record<LeaderboardMetric, string> = {
  maxViewers: "maxviewers",
  likes: "likes",
};

type VideoDoc = DocumentType<Video>;

// Each entry is a video summary (see build-video-summary.ts); the ranked metric
// field (maxViewers or likes) is always present and > 0 for entries.
interface Leaderboard {
  date: string; // "YYYY-MM-DD" in JST — the day this file ranks
  snapshotAt: string; // ISO 8601 instant this file was generated
  metric: LeaderboardMetric; // which field entries are ranked by
  entries: Record<string, unknown>[]; // top 50, sorted desc by metric
}

/** UTC `[start, end)` instants covering the given `YYYY-MM-DD` JST calendar day. */
export function jstDayRangeUtc(date: string): { start: Date; end: Date } {
  const startOfDay = moment.tz(date, "YYYY-MM-DD", JST).startOf("day");
  return {
    start: startOfDay.toDate(),
    end: startOfDay.clone().add(1, "day").toDate(),
  };
}

/**
 * Mongo filter for the streams eligible for one JST day + metric: available
 * that day, a positive metric value, and not an uploaded or ignored video.
 */
export function leaderboardFilter(
  date: string,
  metric: LeaderboardMetric
): FilterQuery<Video> {
  const { start, end } = jstDayRangeUtc(date);
  const filter: FilterQuery<Video> = {
    availableAt: { $gte: start, $lt: end },
    uploadedVideo: { $ne: true },
    hbIgnore: { $ne: true },
  };
  filter[metric] = { $gt: 0 };
  return filter;
}

export async function buildLeaderboard(
  date: string,
  metric: LeaderboardMetric,
  videos: VideoDoc[],
  snapshotAt: Date
): Promise<Leaderboard> {
  const ranked = [...videos]
    .sort(
      (a, b) =>
        (b[metric] ?? 0) - (a[metric] ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    .slice(0, LEADERBOARD_SIZE);
  const entries: Record<string, unknown>[] = [];
  for (const video of ranked) entries.push(await buildVideoSummary(video));
  return { date, snapshotAt: snapshotAt.toISOString(), metric, entries };
}

/** Fetch the streams eligible for one JST day + metric. */
export async function queryLeaderboardVideos(
  date: string,
  metric: LeaderboardMetric
): Promise<VideoDoc[]> {
  const videos: VideoDoc[] = [];
  for await (const video of VideoModel.find(leaderboardFilter(date, metric))
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    videos.push(video);
  }
  return videos;
}

/** Regenerate one leaderboard file for a single JST date + metric. */
export async function genLeaderboardFile(
  date: string,
  metric: LeaderboardMetric
): Promise<void> {
  const videos = await queryLeaderboardVideos(date, metric);
  const leaderboard = await buildLeaderboard(date, metric, videos, new Date());
  await writeDataFile(
    dataFilePath("leaderboard", METRIC_DIR[metric], `${date}.json`),
    leaderboard
  );
}

/**
 * Refresh today + yesterday (JST) for both metrics. Both dates derive from one
 * captured `now` so the pair cannot straddle JST midnight between two reads.
 * The optional `job` renews the Agenda lock after each file so a slow run
 * cannot let its lock lapse mid-run.
 */
export async function genDailyLeaderboards(job?: Job): Promise<void> {
  const now = moment.tz(JST);
  const today = now.clone().format("YYYY-MM-DD");
  const yesterday = now.clone().subtract(1, "day").format("YYYY-MM-DD");
  for (const date of [today, yesterday]) {
    for (const metric of METRICS) {
      await genLeaderboardFile(date, metric);
      await job?.touch();
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/components/chats-archive/gen-leaderboard-file.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Verify build + lint**

Run: `npm run build && npm run lint`
Expected: both succeed. (If tsc rejects `filter[metric] = { $gt: 0 }`, the model field types are `number | undefined`; the assignment is valid because `metric` is `keyof`-constrained. Do not cast to `Record<string, unknown>`.)

- [ ] **Step 6: Commit**

```bash
git add src/components/chats-archive/gen-leaderboard-file.ts src/components/chats-archive/gen-leaderboard-file.spec.ts
git commit -m "feat(chats-archive): generate daily maxviewers/likes leaderboards"
```

---

### Task 5: Schedule the jobs and extend the direct-run path

**Files:**

- Modify: `src/components/chats-archive.ts`

Register two Agenda jobs in the existing `if (CHAT_ARCHIVE_DIR)` block and invoke both generators once in the `isMain` direct-run block. The job callbacks pass the Agenda `job` into each generator (`(job) => genX(job)`) so the generators can renew the lock via `job.touch()` between writes — the same lock-renewal pattern the existing `chats archive` job uses. The direct-run block calls the generators without a `job` (the `job?.touch()` calls become no-ops there).

- [ ] **Step 1: Add the generator imports**

In `src/components/chats-archive.ts`, immediately after the existing line
`import { genIndexFile } from "./chats-archive/gen-index-file.js";` add:

```ts
import { genRealtimeAndUpcomingFiles } from "./chats-archive/gen-realtime-file.js";
import { genDailyLeaderboards } from "./chats-archive/gen-leaderboard-file.js";
```

- [ ] **Step 2: Register the two Agenda jobs**

In the `if (CHAT_ARCHIVE_DIR)` block, find:

```ts
agenda.define("chats archive index", () => genIndexFile());
void agenda.every("10 minutes", "chats archive index");
```

Add directly after it:

```ts
agenda.define("chats archive realtime", (job) =>
  genRealtimeAndUpcomingFiles(job)
);
void agenda.every("1 minutes", "chats archive realtime");

agenda.define("chats archive leaderboard", (job) => genDailyLeaderboards(job));
void agenda.every("10 minutes", "chats archive leaderboard");
```

- [ ] **Step 3: Extend the direct-run block**

In the `isMain(import.meta)` block, find:

```ts
await genIndexFile({ isDirect: true });
```

Replace it with:

```ts
await genIndexFile({ isDirect: true });
await genRealtimeAndUpcomingFiles();
await genDailyLeaderboards();
```

- [ ] **Step 4: Verify build + lint**

Run: `npm run build && npm run lint`
Expected: both succeed.

- [ ] **Step 5: Verify the whole chats-archive test suite still passes**

Run: `npm run test -- src/components/chats-archive`
Expected: PASS (all spec files under the directory).

- [ ] **Step 6: Commit**

```bash
git add src/components/chats-archive.ts
git commit -m "feat(chats-archive): schedule realtime and leaderboard jobs"
```

---

### Task 6: Data-contract documents for the three new file types

**Files:**

- Create: `docs/data-contract/realtime.md`
- Create: `docs/data-contract/upcoming.md`
- Create: `docs/data-contract/daily-leaderboard.md`

Each new output is additive at the directory level (a new file-type document starting at version 1). Follow the structure of the existing `docs/data-contract/root-index.md`. Do not reference these markdown files from any source code (contract anti-leak rule); this task only writes markdown.

**PR column:** this change lands directly on `dev` with no pull request, so each new revision-history row uses `—` in the `PR` column — the same no-PR marker the existing bootstrap rows already use. `Date` is concrete (`2026-07-11`).

- [ ] **Step 1: Create `docs/data-contract/realtime.md`**

````markdown
# Realtime index (`data/realtime.json`)

**File path pattern:** `data/realtime.json`
**Companion file:** none.
**Writer:** `src/components/chats-archive/gen-realtime-file.ts`
**Version field in JSON:** none at version 1 — readers detect version
defensively as `(json.version ?? 1)`.
**Current writer emits:** version 1, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                 |
| ------- | -------- | ---------- | --- | --------------------------------------- |
| 1       | r0       | 2026-07-11 | —   | Initial realtime index of live streams. |

## version 1

### Base shape (r0)

```ts
interface RealtimeIndex {
  snapshotAt: string; // ISO 8601; when this snapshot was generated
  live: VideoSummaryWithChannel[]; // status "live" only, sorted desc by viewers
}

interface VideoSummaryWithChannel {
  id: string;
  title: string;
  channel: { id: string; name: string; avatarUrl?: string };
  status: string; // holodex VideoStatus; always "live" in this file
  duration: number; // seconds; 0 while a stream is live
  availableAt: string; // ISO 8601
  archiveVersion: number; // 1 = legacy, 2 = current archiver
  stats: { superChatTotalJpy: number; memberCount: number; giftCount: number };
  scheduledStart?: string; // ISO 8601
  actualStart?: string; // ISO 8601
  actualEnd?: string; // ISO 8601
  publishedAt?: string; // ISO 8601
  viewers?: number; // live concurrent viewers
  maxViewers?: number; // peak concurrent viewers so far
  likes?: number; // like count so far
  premiere?: boolean; // true for YouTube premieres
}
```

### Cumulative JSON example (r0)

```json
{
  "snapshotAt": "2026-07-11T09:00:00.000Z",
  "live": [
    {
      "id": "liveVid001",
      "title": "Currently live stream",
      "channel": {
        "id": "UCaaaaaaaaaaaaaaaaaaaaaa",
        "name": "Channel A",
        "avatarUrl": "https://yt3.googleusercontent.com/.../a.jpg"
      },
      "status": "live",
      "duration": 0,
      "availableAt": "2026-07-11T08:00:00.000Z",
      "archiveVersion": 2,
      "stats": { "superChatTotalJpy": 0, "memberCount": 0, "giftCount": 0 },
      "scheduledStart": "2026-07-11T08:00:00.000Z",
      "actualStart": "2026-07-11T08:01:12.000Z",
      "viewers": 1234,
      "maxViewers": 1500,
      "likes": 320
    }
  ]
}
```

### Reader guidance

- **Version detection:** absence of a `version` key implies version 1.
- **Always present at root:** `snapshotAt`, `live` (may be empty).
- **Always present per entry:** `id`, `title`, `channel.id`, `channel.name`,
  `status`, `duration`, `availableAt`, `archiveVersion`, `stats.*`.
- **May be absent per entry:** `channel.avatarUrl`, `scheduledStart`,
  `actualStart`, `actualEnd`, `publishedAt`, `viewers`, `maxViewers`,
  `likes`, `premiere`.
- **`status`:** always `"live"` in this file.
- **`snapshotAt`:** the instant this file was generated; authoritative for
  this file only. Do not join it with `upcoming.json` assuming a shared
  instant — the two files are published independently.
- **Ordering:** `live` is sorted descending by `viewers` (entries with no
  reported viewers sort last), ties broken by ascending `id`.
- **Regeneration cadence:** every minute.
- **Unknown extra fields:** ignore (forward compatibility).
````

- [ ] **Step 2: Create `docs/data-contract/upcoming.md`**

````markdown
# Upcoming index (`data/upcoming.json`)

**File path pattern:** `data/upcoming.json`
**Companion file:** none.
**Writer:** `src/components/chats-archive/gen-realtime-file.ts`
**Version field in JSON:** none at version 1 — readers detect version
defensively as `(json.version ?? 1)`.
**Current writer emits:** version 1, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                            |
| ------- | -------- | ---------- | --- | -------------------------------------------------- |
| 1       | r0       | 2026-07-11 | —   | Initial upcoming index (scheduled + just-started). |

## version 1

### Base shape (r0)

```ts
interface UpcomingIndex {
  snapshotAt: string; // ISO 8601
  upcoming: VideoSummaryWithChannel[]; // status "upcoming", within 48h, soonest first
  recentlyStarted: VideoSummaryWithChannel[]; // status "live", availableAt within last 10 min, newest first
}

interface VideoSummaryWithChannel {
  id: string;
  title: string;
  channel: { id: string; name: string; avatarUrl?: string };
  status: string; // holodex VideoStatus: "upcoming" in `upcoming`, "live" in `recentlyStarted`
  duration: number; // seconds; 0 for upcoming/just-started streams
  availableAt: string; // ISO 8601
  archiveVersion: number;
  stats: { superChatTotalJpy: number; memberCount: number; giftCount: number };
  scheduledStart?: string; // ISO 8601
  actualStart?: string; // ISO 8601
  actualEnd?: string; // ISO 8601
  publishedAt?: string; // ISO 8601
  viewers?: number;
  maxViewers?: number;
  likes?: number;
  premiere?: boolean;
}
```

### Cumulative JSON example (r0)

```json
{
  "snapshotAt": "2026-07-11T09:00:00.000Z",
  "upcoming": [
    {
      "id": "upcomingVid001",
      "title": "Scheduled stream",
      "channel": { "id": "UCbbbbbbbbbbbbbbbbbbbbbb", "name": "Channel B" },
      "status": "upcoming",
      "duration": 0,
      "availableAt": "2026-07-11T12:00:00.000Z",
      "archiveVersion": 1,
      "stats": { "superChatTotalJpy": 0, "memberCount": 0, "giftCount": 0 },
      "scheduledStart": "2026-07-11T12:00:00.000Z",
      "premiere": false
    }
  ],
  "recentlyStarted": [
    {
      "id": "liveVid001",
      "title": "Just went live",
      "channel": { "id": "UCaaaaaaaaaaaaaaaaaaaaaa", "name": "Channel A" },
      "status": "live",
      "duration": 0,
      "availableAt": "2026-07-11T08:59:00.000Z",
      "archiveVersion": 2,
      "stats": { "superChatTotalJpy": 0, "memberCount": 0, "giftCount": 0 },
      "scheduledStart": "2026-07-11T09:00:00.000Z",
      "actualStart": "2026-07-11T08:59:00.000Z",
      "viewers": 210
    }
  ]
}
```

### Reader guidance

- **Version detection:** absence of a `version` key implies version 1.
- **Always present at root:** `snapshotAt`, `upcoming`, `recentlyStarted`
  (either array may be empty).
- **Always present per entry:** `id`, `title`, `channel.id`, `channel.name`,
  `status`, `duration`, `availableAt`, `archiveVersion`, `stats.*`.
- **May be absent per entry:** `channel.avatarUrl`, `scheduledStart`,
  `actualStart`, `actualEnd`, `publishedAt`, `viewers`, `maxViewers`,
  `likes`, `premiere`.
- **`upcoming`:** streams with status `"upcoming"` whose `availableAt` is
  within the next 48 hours, sorted ascending by `availableAt` (soonest
  first).
- **`recentlyStarted`:** streams with status `"live"` whose `availableAt`
  is within the last 10 minutes (a grace window so a stream that just
  transitioned upcoming→live still shows here), sorted descending by
  `availableAt` (most recent first). A stream can briefly appear here and
  in `realtime.json` at the same time.
- **`snapshotAt`:** authoritative for this file only.
- **Regeneration cadence:** every minute.
- **Unknown extra fields:** ignore (forward compatibility).
````

- [ ] **Step 3: Create `docs/data-contract/daily-leaderboard.md`**

````markdown
# Daily leaderboard (`data/leaderboard/{metric}/{YYYY-MM-DD}.json`)

**File path pattern:** `data/leaderboard/{metric}/{YYYY-MM-DD}.json`, where
`{metric}` is `maxviewers` or `likes` and `{YYYY-MM-DD}` is a JST calendar
date.
**Companion file:** none.
**Writer:** `src/components/chats-archive/gen-leaderboard-file.ts`
**Version field in JSON:** none at version 1 — readers detect version
defensively as `(json.version ?? 1)`.
**Current writer emits:** version 1, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                        |
| ------- | -------- | ---------- | --- | ---------------------------------------------- |
| 1       | r0       | 2026-07-11 | —   | Initial daily maxViewers / likes leaderboards. |

## version 1

### Base shape (r0)

```ts
interface Leaderboard {
  date: string; // "YYYY-MM-DD" in JST — the day this file ranks
  snapshotAt: string; // ISO 8601; when this file was generated
  metric: "maxViewers" | "likes"; // which field entries are ranked by
  entries: VideoSummaryWithChannel[]; // top 50, sorted desc by `metric`
}

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
  viewers?: number;
  maxViewers?: number;
  likes?: number;
  premiere?: boolean;
}
```

### Cumulative JSON example (r0)

```json
{
  "date": "2026-07-11",
  "snapshotAt": "2026-07-11T09:00:00.000Z",
  "metric": "maxViewers",
  "entries": [
    {
      "id": "topVid001",
      "title": "Big collab stream",
      "channel": {
        "id": "UCaaaaaaaaaaaaaaaaaaaaaa",
        "name": "Channel A",
        "avatarUrl": "https://yt3.googleusercontent.com/.../a.jpg"
      },
      "status": "past",
      "duration": 7200,
      "availableAt": "2026-07-11T10:00:00.000Z",
      "archiveVersion": 2,
      "stats": {
        "superChatTotalJpy": 12345,
        "memberCount": 42,
        "giftCount": 7
      },
      "scheduledStart": "2026-07-11T10:00:00.000Z",
      "actualStart": "2026-07-11T10:01:00.000Z",
      "actualEnd": "2026-07-11T12:01:00.000Z",
      "maxViewers": 54000,
      "likes": 8900
    }
  ]
}
```

### Reader guidance

- **Version detection:** absence of a `version` key implies version 1.
- **Semantics — start-date leaderboard ranked by lifetime metric:** a
  stream is attributed to exactly one JST day (the day its `availableAt`
  falls in) and ranked by its full-lifetime `maxViewers` / `likes` value.
  The metric is **not** re-scoped to the calendar day; a stream that
  starts before JST midnight and peaks after midnight is ranked only in
  its start day's file, with its whole-lifetime metric. Do not read this
  as same-day activity.
- **File absence / empty day:** a date with no qualifying streams still
  produces a file with `entries: []`. A 404 means the file was never
  generated (e.g. a date outside the refresh window); an empty `entries`
  array means the day was computed and nobody qualified.
- **Qualification:** entries have the ranked metric `> 0` and exclude
  uploaded videos and ignored streams.
- **Always present at root:** `date`, `snapshotAt`, `metric`, `entries`.
- **Always present per entry:** `id`, `title`, `channel.id`,
  `channel.name`, `status`, `duration`, `availableAt`, `archiveVersion`,
  `stats.*`.
- **May be absent per entry:** `channel.avatarUrl`, `scheduledStart`,
  `actualStart`, `actualEnd`, `publishedAt`, `viewers`, `maxViewers`,
  `likes`, `premiere`. (The entry's ranked metric — `maxViewers` for the
  `maxviewers` file, `likes` for the `likes` file — is present and `> 0`
  for every entry, since qualification requires it.)
- **Ordering:** `entries` sorted descending by `metric`, ties broken by
  ascending `id`, truncated to the top 50.
- **Regeneration cadence:** today's and yesterday's JST files are
  refreshed every 10 minutes; older dates are not refreshed on a schedule.
- **Unknown extra fields:** ignore (forward compatibility).
````

- [ ] **Step 4: Verify the docs are well-formed**

Run: `npx prettier --check "docs/data-contract/realtime.md" "docs/data-contract/upcoming.md" "docs/data-contract/daily-leaderboard.md"`
Expected: reports all three files. If any is flagged, run `npx prettier --write` on the same three paths and re-check. (The `format:check` npm script only covers `src/`, so it will not inspect these docs.)

- [ ] **Step 5: Commit**

```bash
git add docs/data-contract/realtime.md docs/data-contract/upcoming.md docs/data-contract/daily-leaderboard.md
git commit -m "docs(data-contract): add realtime, upcoming, daily-leaderboard file types"
```

---

### Task 7: Data-contract revisions for the shared summary fields

**Files:**

- Modify: `docs/data-contract/root-index.md`
- Modify: `docs/data-contract/channel-index.md`
- Modify: `docs/data-contract/README.md`

The shared summary now carries four new optional fields, so `root-index` and `channel-index` get an additive revision r1 (version stays 1). The README file-type index gains the three new rows from Task 6.

Frozen-section rule for this task: the `### Base shape (r0)` interface and the r0 reader-guidance bullets are frozen — do **not** alter existing field names, types, optionality, or ordering there. What you **do** change is additive: add the new r1 revision-history row, add an `### Additive fields (r1)` subsection, append the four new fields to the reader guidance's "may be absent" bullet (annotated "since r1"), and regenerate the single cumulative JSON example to reflect r1 (adding the new optional fields and relabelling its heading `(r1)`). Regenerating the cumulative example is required by the contract's revision rules — the example is the current/rolling example for the version chapter, not frozen r0 text — so this is not a frozen-section violation.

**PR column:** this change lands directly on `dev` with no pull request, so the r1 revision-history rows use `—` in the `PR` column — the same no-PR marker the existing bootstrap rows already use. `Date` is concrete (`2026-07-11`).

- [ ] **Step 1: Add r1 to `root-index.md`**

1. Change the header line `**Current writer emits:** version 1, revision r0` to:

```
**Current writer emits:** version 1, revision r1
```

2. Add a row to the revision-history table (below the existing r0 row):

```
| 1       | r1       | 2026-07-11 | —   | Add optional `viewers`, `maxViewers`, `likes`, `premiere` to each video summary. |
```

3. Directly after the existing `### Base shape (r0)` fenced `ts` block (before `Reader version detection`), insert:

````markdown
### Additive fields (r1)

Each `VideoSummaryWithChannel` entry may additionally carry these optional
fields; all are absent when the underlying value was never populated:

```ts
interface VideoSummaryWithChannelR1 extends VideoSummaryWithChannel {
  viewers?: number; // live concurrent viewers; 0 after the stream finishes
  maxViewers?: number; // peak concurrent viewers; persists after finish
  likes?: number; // like count; persists after finish
  premiere?: boolean; // true for YouTube premieres
}
```
````

4. In the `### Reader guidance` section, replace the bullet:

```
- **May be absent per video summary:** `channel.avatarUrl`,
  `scheduledStart`, `actualStart`, `actualEnd`, `publishedAt`.
```

with:

```
- **May be absent per video summary:** `channel.avatarUrl`,
  `scheduledStart`, `actualStart`, `actualEnd`, `publishedAt`; and, since
  r1, `viewers`, `maxViewers`, `likes`, `premiere`.
```

5. In the `### Cumulative JSON example (r0)` block, add the new optional
   fields to the two example entries so the example reflects r1, and change
   the heading to `### Cumulative JSON example (r1)`. Specifically:
   - In the `live` entry (currently ends after `"actualStart": "2026-05-30T08:01:12.000Z"`), add `"viewers": 1234,` and `"maxViewers": 1500` inside that object.
   - In the `past` entry, add `"maxViewers": 6000,` and `"likes": 900` inside that object.

- [ ] **Step 2: Add r1 to `channel-index.md`**

Apply the same five edits as Step 1, adapted to this file:

1. Header `**Current writer emits:** version 1, revision r0` → `revision r1`.
2. Revision-history table gains:

```
| 1       | r1       | 2026-07-11 | —   | Add optional `viewers`, `maxViewers`, `likes`, `premiere` to each video summary. |
```

3. After the `### Base shape (r0)` `ts` block, insert:

````markdown
### Additive fields (r1)

Each `VideoSummaryNoChannel` entry may additionally carry these optional
fields; all are absent when the underlying value was never populated:

```ts
interface VideoSummaryNoChannelR1 extends VideoSummaryNoChannel {
  viewers?: number; // live concurrent viewers; 0 after the stream finishes
  maxViewers?: number; // peak concurrent viewers; persists after finish
  likes?: number; // like count; persists after finish
  premiere?: boolean; // true for YouTube premieres
}
```
````

4. In `### Reader guidance`, replace:

```
- **May be absent per video summary:** `scheduledStart`, `actualStart`,
  `actualEnd`, `publishedAt`. The entry has **no** `channel` field — to
  identify the channel, use the root `id` / `name` of the index file.
```

with:

```
- **May be absent per video summary:** `scheduledStart`, `actualStart`,
  `actualEnd`, `publishedAt`; and, since r1, `viewers`, `maxViewers`,
  `likes`, `premiere`. The entry has **no** `channel` field — to identify
  the channel, use the root `id` / `name` of the index file.
```

5. In the `### Cumulative JSON example (r0)` block, add `"maxViewers": 6000,`
   and `"likes": 900` to the single `videos[0]` entry, and change the heading
   to `### Cumulative JSON example (r1)`.

- [ ] **Step 3: Add the three new rows to `README.md` §2**

In the `## 2. File type index` table, after the existing
`channel-index.md` row, add:

```
| [realtime.md](./realtime.md)                     | `data/realtime.json`                          | 1                            |
| [upcoming.md](./upcoming.md)                     | `data/upcoming.json`                          | 1                            |
| [daily-leaderboard.md](./daily-leaderboard.md)   | `data/leaderboard/{metric}/{YYYY-MM-DD}.json` | 1                            |
```

- [ ] **Step 4: Verify formatting**

Run: `npx prettier --check "docs/data-contract/root-index.md" "docs/data-contract/channel-index.md" "docs/data-contract/README.md"`
Expected: all three pass. If any is flagged, run `npx prettier --write` on the same three paths and re-check. (The `format:check` npm script only covers `src/`.)

- [ ] **Step 5: Commit (with the data-source justification in the message body)**

No new data source is introduced — the four fields are already populated on the `Video` model — so the data-contract's data-source requirement is satisfied by citing the existing writers. Because this change lands on `dev` with no PR, that citation lives durably in the commit message **body** (it cites data sources, not the contract documents, so it does not trip the anti-leak rule):

```bash
git add docs/data-contract/root-index.md docs/data-contract/channel-index.md docs/data-contract/README.md
git commit -m "docs(data-contract): revise root/channel index for new summary fields" -m "Data source: no new source. viewers/maxViewers are set by Video.updateFromHolodex (Holodex liveViewers) and Video.updateFromMasterchat (watch-page viewCount); likes by Video.updateFromMasterchat (watch-page likes); premiere from Holodex stream metadata. This change only surfaces already-populated model fields into index output."
```

---

## Done criteria

- `viewers`, `maxViewers`, `likes`, `premiere` appear (when populated) in every summary produced by `buildVideoSummary`.
- `data/realtime.json` and `data/upcoming.json` regenerate every minute; `data/leaderboard/{maxviewers,likes}/{YYYY-MM-DD}.json` regenerate today + yesterday every 10 minutes.
- Running `node dist/index.js manager` registers the two new Agenda jobs; running the direct-run entry regenerates the full family once.
- `npm run build`, `npm run lint`, and `npm test` all pass.
- `docs/data-contract/` documents all four new/changed outputs; no source file references the contract markdown.
