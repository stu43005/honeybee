# Daily videos index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the daily maxviewers/likes leaderboard output with a per-JST-day `data/daily-videos/{YYYY-MM-DD}.json` list of all started (non-upcoming) streams, refreshed every 10 minutes (today+yesterday) plus a 12-hour finalize pass for long-running / recently-terminated streams, so the frontend can sort the full list client-side.

**Architecture:** A new `gen-daily-videos-file.ts` in `src/components/chats-archive/` holds the query/build/write logic and two drivers (`genDailyVideos` = today+yesterday, `genDailyVideosFinalize` = older start-dates of still-live / recently-ended / recently-deleted streams, excluding today+yesterday so the two Agenda jobs write disjoint files). A new `Video.detectedDeletionAt` timestamp (managed in `youtube.ts`) drives the finalize "recently deleted" branch. The shared `writeDataFile` helper is hardened to use per-call unique temp names. The old leaderboard writer/job/tests/doc are removed; `root-index`'s data-contract doc is marked deprecated (writer kept).

**Tech Stack:** TypeScript (ESM, NodeNext), Typegoose/Mongoose, Agenda, moment-timezone, Jest (ts-jest, ESM).

**Spec:** [docs/superpowers/specs/2026-07-12-daily-videos-index-design.md](../specs/2026-07-12-daily-videos-index-design.md)

**Conventions for every task below:**

- ESM: import sibling modules with a `.js` extension even though the file is `.ts`.
- Run a single test file with: `npm run test -- <path>` (append `-t "<name>"` to filter).
- Full validation before declaring a task done: `npm run build` (tsc), `npm run lint`, and the task's `npm run test -- <file>`.
- Commit with concrete file paths (no `git add -A`).

---

### Task 1: Harden `writeDataFile` with per-call unique temp names

**Files:**

- Modify: `src/components/chats-archive/write-data-file.ts`
- Test: `src/components/chats-archive/write-data-file.spec.ts`

- [ ] **Step 1: Update the failing test for the unique-temp behavior**

Replace the second `it` block in `src/components/chats-archive/write-data-file.spec.ts` (the "leaves no .tmp sibling behind after a successful write" test) with a version that no longer assumes the fixed `<path>.tmp` name — it asserts that after a successful write no sibling ending in `.tmp` remains in the directory:

```ts
it("leaves no temp sibling behind after a successful write", async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-write-"));
  const target = path.join(dir, "out.json");
  await writeDataFile(target, { ok: true });
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.endsWith(".tmp"));
  expect(leftovers).toEqual([]);
});
```

Also add a third `it` that verifies the writer uses a **per-call unique** temp
name (not the fixed `<path>.tmp`) by spying on `fsp.writeFile` and inspecting the
temp path it receives. Add `jest` to the imports from `@jest/globals`
(`import { afterEach, describe, expect, it, jest } from "@jest/globals";`):

```ts
it("writes via a per-call unique temp name, not a fixed .tmp", async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-write-"));
  const target = path.join(dir, "out.json");
  const writeSpy = jest.spyOn(fsp, "writeFile");
  await writeDataFile(target, { ok: true });
  const tmpArg = writeSpy.mock.calls[0][0] as string;
  expect(tmpArg).not.toBe(`${target}.tmp`); // not the old fixed name
  expect(tmpArg.startsWith(`${target}.`)).toBe(true);
  expect(tmpArg.endsWith(".tmp")).toBe(true);
  expect(tmpArg).toContain(String(process.pid));
  writeSpy.mockRestore();
});
```

Leave the first `it` ("creates parent dirs and writes JSON with a trailing newline") unchanged.

- [ ] **Step 2: Run the tests to see the unique-name test fail (red)**

Run: `npm run test -- src/components/chats-archive/write-data-file.spec.ts`
Expected: the two existing-style tests PASS, but the new "writes via a per-call unique temp name" test FAILS because the current writer uses the fixed `${target}.tmp` name (`tmpArg` equals `${target}.tmp`). This confirms the new test actually pins the behavior we are about to change.

- [ ] **Step 3: Change the writer to a unique temp name**

In `src/components/chats-archive/write-data-file.ts`, add a `randomUUID` import and replace the fixed temp name + `rm` with a unique per-call temp name. The full updated `writeDataFile` body:

```ts
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import assert from "node:assert";
import { CHAT_ARCHIVE_DIR } from "../../constants.js";
```

```ts
export async function writeDataFile(
  absPath: string,
  data: unknown
): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  // Per-call unique temp name: two writers racing the same output path each own
  // their own temp file, so an interleaved write can never corrupt a shared temp
  // and the atomic rename is the only contended step.
  const tmp = `${absPath}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data) + "\n", "utf-8");
  await fsp.rename(tmp, absPath);
}
```

Keep `dataFilePath` unchanged. Preserve the existing JSDoc on `writeDataFile` but update its wording to mention the unique temp name (drop the "fixed `<path>.tmp`" phrasing).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/components/chats-archive/write-data-file.spec.ts`
Expected: PASS (all three `it` blocks, including the new unique-temp-name one).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run build && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/chats-archive/write-data-file.ts src/components/chats-archive/write-data-file.spec.ts
git commit -m "refactor(chats-archive): unique temp name in writeDataFile"
```

---

### Task 2: Add `Video.detectedDeletionAt` field, partial index, and refresh the availableAt_all comment

**Files:**

- Modify: `src/models/Video.ts` (field near `deleted?: boolean;`, new `@index(...)` near the existing `hbEnd`/Missing index, comment on the `availableAt_all` index)

This task has no unit test of its own — it is a schema/metadata change verified by tsc and consumed by Tasks 3–5. Correctness is asserted through those tasks' tests.

- [ ] **Step 1: Add the `detectedDeletionAt` field**

In `src/models/Video.ts`, immediately after the `public deleted?: boolean;` property, add:

```ts
  @prop()
  public detectedDeletionAt?: Date;
```

- [ ] **Step 2: Add the partial index for the finalize "recently deleted" branch**

In `src/models/Video.ts`, directly after the existing `hbEnd` partial index block (the one with `partialFilterExpression: { status: VideoStatus.Missing }`), add a matching partial index on `detectedDeletionAt`:

```ts
@index(
  { detectedDeletionAt: 1 },
  {
    partialFilterExpression: {
      status: VideoStatus.Missing,
    },
  }
)
```

- [ ] **Step 3: Refresh the `availableAt_all` index comment**

In `src/models/Video.ts`, update the comment above the `availableAt_all` index so it no longer references the removed leaderboard. Replace the existing comment block:

```ts
// Non-partial companion to the partial availableAt index above: serves
// availableAt range queries that are NOT restricted to live/upcoming (the
// daily leaderboard scans a JST-day availableAt window across all statuses).
// The partial index cannot serve those, so this one covers every status.
@index({ availableAt: 1 }, { name: "availableAt_all" })
```

with:

```ts
// Non-partial companion to the partial availableAt index above: serves
// availableAt range queries that are NOT restricted to live/upcoming (the
// daily-videos writer scans a JST-day availableAt window across all statuses).
// The partial index cannot serve those, so this one covers every status.
@index({ availableAt: 1 }, { name: "availableAt_all" })
```

- [ ] **Step 4: Typecheck and lint**

Run: `npm run build && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/models/Video.ts
git commit -m "feat(video): add detectedDeletionAt field and partial index"
```

---

### Task 3: Maintain `detectedDeletionAt` on deleted transitions in `youtube.ts`

**Files:**

- Modify: `src/modules/youtube.ts:149-153`
- Test (create): `src/modules/youtube.spec.ts`

`video.deleted` is written in exactly one place — `updateVideoFromYoutube` — so the timestamp is set once when a video is first detected deleted and cleared when it reappears.

- [ ] **Step 1: Write the failing test**

Create `src/modules/youtube.spec.ts`. It mocks `googleapis` (so no real API call), sets `GOOGLE_API_KEY` before dynamically importing the module under test, and spies on `VideoModel.findByVideoId` to return stateful fake video docs. A batch of two ids is requested; the API returns only one item, so the other id takes the "not found → deleted" branch.

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";

// This repo runs true-ESM Jest, so a module mock must use
// jest.unstable_mockModule + a dynamic import of the module under test
// (jest.mock does not hoist under ESM — see src/modules/redis.spec.ts).
// GOOGLE_API_KEY must be set before importing ANYTHING that reaches
// constants.ts (VideoModel -> ChannelModel -> constants.ts reads the env at
// module-eval time), because getYoutubeApi() asserts it — so VideoModel is
// imported dynamically too, after the assignment. VideoModel is only spied,
// not mocked.
process.env.GOOGLE_API_KEY = "test-key";

const mockVideosList = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("googleapis", () => ({
  google: {
    youtube: () => ({
      videos: { list: mockVideosList },
      channels: { list: jest.fn() },
    }),
  },
}));

const { default: VideoModel } = await import("../models/Video.js");
const { updateVideoFromYoutube } = await import("./youtube.js");

// A minimal mutable stand-in for a Video document.
function fakeVideo(overrides: Record<string, unknown>) {
  return {
    id: "vid",
    save: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

// A found YouTube item with no liveStreamingDetails -> "uploaded video" branch,
// and no channelId so the channel-lookup path is skipped.
function foundItem(id: string) {
  return {
    id,
    snippet: { title: "Found" },
    status: {},
    statistics: {},
    contentDetails: {},
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  mockVideosList.mockReset();
});

describe("updateVideoFromYoutube detectedDeletionAt", () => {
  it("sets detectedDeletionAt once when a video is first detected deleted", async () => {
    const found = fakeVideo({ id: "found1" });
    const gone = fakeVideo({ id: "gone1", deleted: false });
    jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation((async (id: string) =>
        id === "found1" ? found : gone) as any);
    mockVideosList.mockResolvedValue({
      data: { items: [foundItem("found1")] },
    });

    await updateVideoFromYoutube(["found1", "gone1"]);

    expect(gone.deleted).toBe(true);
    expect(gone.detectedDeletionAt).toBeInstanceOf(Date);
    const firstDetection = gone.detectedDeletionAt;

    // A second still-missing crawl must NOT overwrite the original detection time.
    await updateVideoFromYoutube(["found1", "gone1"]);
    expect(gone.detectedDeletionAt).toBe(firstDetection);
  });

  it("clears detectedDeletionAt when a deleted video reappears", async () => {
    const gone = fakeVideo({
      id: "gone1",
      deleted: true,
      detectedDeletionAt: new Date("2026-07-10T00:00:00.000Z"),
    });
    jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation((async () => gone) as any);
    mockVideosList.mockResolvedValue({ data: { items: [foundItem("gone1")] } });

    await updateVideoFromYoutube(["gone1"]);

    expect(gone.deleted).toBe(false);
    expect(gone.detectedDeletionAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/modules/youtube.spec.ts`
Expected: FAIL — the first test fails because `gone.detectedDeletionAt` is `undefined` (the writer does not yet set it); the second fails because it is not cleared.

- [ ] **Step 3: Implement the transition logic**

In `src/modules/youtube.ts`, update the two `deleted` writes.

Replace line 149 (`if (video.deleted) video.deleted = false;`) with:

```ts
if (video.deleted) {
  video.deleted = false;
  video.detectedDeletionAt = undefined;
}
```

Replace the `else` branch (currently `video.status = VideoStatus.Missing;` then `video.deleted = true;`) with:

```ts
    } else {
      video.status = VideoStatus.Missing;
      if (!video.deleted) video.detectedDeletionAt = new Date();
      video.deleted = true;
    }
```

The `if (!video.deleted)` guard runs before `video.deleted = true`, so a repeated crawl of a still-missing video keeps the original detection time.

**Also handle the all-missing response.** Replace the early return
`const ytVideoItems = response?.data?.items; if (!ytVideoItems?.length) return [];`
with `const ytVideoItems = response?.data?.items ?? [];` so the per-video loop
still runs when the response has no items. Confirmed behavior (googleapis
173 / gaxios 7; YouTube Data API v3): API/quota/network errors **throw** before
this line, and `videos.list` returns HTTP 200 with nonexistent/deleted/private
ids omitted — so a resolved response with `items: []` means every requested id
is genuinely gone, not an error. Falling through lets a lone deleted video (or an
all-deleted batch) get `deleted = true` + `detectedDeletionAt` set (via the same
`else` branch), which the finalize "recently deleted" branch needs.

But **only transition records that already exist**: the crawler and the Discord
`crawl` command call this with brand-new ids too, and a never-before-seen id that
YouTube omits has no `channelId` / `title` to persist (the model requires both),
so creating `new VideoModel({ id })` for it and calling `save()` would fail
validation and abort the whole batch. So look up the existing doc first and, when
the id is both absent from the response and absent from the DB, `continue` (skip
it) instead of creating a phantom record:

```ts
const ytInfo = ytVideoItems.find((v) => v.id === targetVideo);
const existing = await VideoModel.findByVideoId(targetVideo);
if (!ytInfo && !existing) continue; // never-seen id already gone — nothing to record
const video = existing ?? new VideoModel({ id: targetVideo });
```

This also fixes the same latent validation abort that the pre-change code had for
a new-unknown missing id inside a mixed (partial) batch.

Add two regression tests: (1) an already-tracked lone deleted video with
`{ data: { items: [] } }` gets `deleted === true`, `detectedDeletionAt` a `Date`,
and a second empty-items crawl keeps the original detection time; (2) a
never-seen id (`findByVideoId` → `null`) with `{ data: { items: [] } }` is
skipped — `updateVideoFromYoutube` resolves to `[]` without throwing (no phantom
save).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/modules/youtube.spec.ts`
Expected: PASS (both `it` blocks).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run build && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube.ts src/modules/youtube.spec.ts
git commit -m "feat(youtube): track detectedDeletionAt on video deletion transitions"
```

---

### Task 4: Create `gen-daily-videos-file.ts` core (query, build, per-date + today/yesterday drivers)

**Files:**

- Create: `src/components/chats-archive/gen-daily-videos-file.ts`
- Test (create): `src/components/chats-archive/gen-daily-videos-file.spec.ts`

- [ ] **Step 1: Write the failing test for the pure helpers**

Create `src/components/chats-archive/gen-daily-videos-file.spec.ts` with tests for `jstDayRangeUtc`, `dailyVideosFilter`, and `buildDailyVideos`:

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { VideoStatus } from "holodex.js";
import VideoModel from "../../models/Video.js";

// True-ESM Jest: mock the first-party writer via unstable_mockModule + a dynamic
// import so the driver tests can assert the exact date files they would write
// without touching the filesystem or CHAT_ARCHIVE_DIR. VideoModel is only spied,
// so it stays a static import.
const writeDataFile = jest
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);
const dataFilePath = jest.fn((...segments: string[]) => segments.join("/"));

jest.unstable_mockModule("./write-data-file.js", () => ({
  writeDataFile,
  dataFilePath,
}));

const {
  buildDailyVideos,
  dailyVideosFilter,
  jstDayRangeUtc,
  queryDailyVideos,
} = await import("./gen-daily-videos-file.js");

function v(overrides: Record<string, unknown>) {
  return {
    id: "vid",
    title: "T",
    channelId: "UCc",
    status: VideoStatus.Past,
    duration: 0,
    availableAt: new Date("2026-07-11T08:00:00.000Z"),
    actualStart: new Date("2026-07-11T08:00:00.000Z"),
    hbStats: { chatsArchiveVersion: 2 },
    getChannel: () => Promise.resolve({ id: "UCc", name: "C" }),
    ...overrides,
  } as any;
}

function fakeQuery(docs: unknown[]) {
  const q: any = {
    populate: () => q,
    setOptions: () => q,
    *[Symbol.asyncIterator]() {
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
});

describe("dailyVideosFilter", () => {
  it("filters by JST-day range, requires actualStart, excludes uploaded/ignored", () => {
    expect(dailyVideosFilter("2026-07-11")).toEqual({
      availableAt: {
        $gte: new Date("2026-07-10T15:00:00.000Z"),
        $lt: new Date("2026-07-11T15:00:00.000Z"),
      },
      actualStart: { $exists: true, $ne: null },
      uploadedVideo: { $ne: true },
      hbIgnore: { $ne: true },
    });
  });
});

describe("buildDailyVideos", () => {
  it("sorts by availableAt desc, ties by ascending id, stamps date/snapshot", async () => {
    const out = await buildDailyVideos(
      "2026-07-11",
      [
        v({ id: "early", availableAt: new Date("2026-07-11T02:00:00.000Z") }),
        v({
          id: "zeta_late",
          availableAt: new Date("2026-07-11T10:00:00.000Z"),
        }),
        v({
          id: "alpha_late",
          availableAt: new Date("2026-07-11T10:00:00.000Z"),
        }),
      ],
      SNAP
    );
    expect(out.videos.map((s) => s.id)).toEqual([
      "alpha_late",
      "zeta_late",
      "early",
    ]);
    expect(out.date).toBe("2026-07-11");
    expect(out.snapshotAt).toBe("2026-07-11T09:00:00.000Z");
  });

  it("emits an empty videos array for a day with no qualifying streams", async () => {
    const out = await buildDailyVideos("2026-07-11", [], SNAP);
    expect(out.videos).toEqual([]);
  });
});

describe("queryDailyVideos", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("queries VideoModel.find with the daily-videos filter and returns the docs", async () => {
    const docs = [v({ id: "a" }), v({ id: "b" })];
    const spy = jest.spyOn(VideoModel, "find").mockReturnValue(fakeQuery(docs));

    const result = await queryDailyVideos("2026-07-11");

    expect(spy).toHaveBeenCalledWith(dailyVideosFilter("2026-07-11"));
    expect(result.map((d) => d.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/components/chats-archive/gen-daily-videos-file.spec.ts`
Expected: FAIL with a module-not-found / missing-export error (the file does not exist yet).

- [ ] **Step 3: Implement the core module**

Note on the entry type: `videos` is typed `Record<string, unknown>[]`, matching
`buildVideoSummary`'s actual return type (`Promise<Record<string, unknown>>`) and
the existing `gen-realtime-file.ts` / (removed) `gen-leaderboard-file.ts`
interfaces. There is no `VideoSummaryWithChannel` TypeScript type in the codebase
— that name exists only in the data-contract docs as the documented JSON shape —
so do not invent one here; reuse the established `Record<string, unknown>[]`
convention.

Create `src/components/chats-archive/gen-daily-videos-file.ts`:

```ts
import type { Job } from "agenda";
import type { DocumentType } from "@typegoose/typegoose";
import moment from "moment-timezone";
import type { FilterQuery } from "mongoose";
import VideoModel, { type Video } from "../../models/Video.js";
import { buildVideoSummary } from "./build-video-summary.js";
import { dataFilePath, writeDataFile } from "./write-data-file.js";

const JST = "Asia/Tokyo";

type VideoDoc = DocumentType<Video>;

// Each entry is a video summary (see build-video-summary.ts); the full list of a
// JST day's started streams, availableAt-descending. The frontend re-sorts.
interface DailyVideos {
  date: string; // "YYYY-MM-DD" in JST — the day this file lists
  snapshotAt: string; // ISO 8601 instant this file was generated
  videos: Record<string, unknown>[];
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
 * Mongo filter for the streams listed on one JST day: available that day, having
 * actually started (`actualStart` set), and not an uploaded or ignored video.
 */
export function dailyVideosFilter(date: string): FilterQuery<Video> {
  const { start, end } = jstDayRangeUtc(date);
  return {
    availableAt: { $gte: start, $lt: end },
    actualStart: { $exists: true, $ne: null },
    uploadedVideo: { $ne: true },
    hbIgnore: { $ne: true },
  };
}

function byIdAsc(a: VideoDoc, b: VideoDoc): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export async function buildDailyVideos(
  date: string,
  videos: VideoDoc[],
  snapshotAt: Date
): Promise<DailyVideos> {
  const sorted = [...videos].sort(
    (a, b) => b.availableAt.getTime() - a.availableAt.getTime() || byIdAsc(a, b)
  );
  const out: Record<string, unknown>[] = [];
  for (const video of sorted) out.push(await buildVideoSummary(video));
  return { date, snapshotAt: snapshotAt.toISOString(), videos: out };
}

/** Fetch the started, non-upcoming streams available on one JST day. */
export async function queryDailyVideos(date: string): Promise<VideoDoc[]> {
  const videos: VideoDoc[] = [];
  for await (const video of VideoModel.find(dailyVideosFilter(date))
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    videos.push(video);
  }
  return videos;
}

/** Regenerate the daily-videos file for a single JST date. */
export async function genDailyVideosFile(date: string): Promise<void> {
  const snapshotAt = new Date();
  const videos = await queryDailyVideos(date);
  const daily = await buildDailyVideos(date, videos, snapshotAt);
  await writeDataFile(dataFilePath("daily-videos", `${date}.json`), daily);
}

/**
 * Refresh today + yesterday (JST). Both dates derive from one captured `now` so
 * the pair cannot straddle JST midnight between two reads. The optional `job`
 * renews the Agenda lock after each file.
 */
export async function genDailyVideos(job?: Job): Promise<void> {
  const now = moment.tz(JST);
  const today = now.clone().format("YYYY-MM-DD");
  const yesterday = now.clone().subtract(1, "day").format("YYYY-MM-DD");
  for (const date of [today, yesterday]) {
    await genDailyVideosFile(date);
    await job?.touch();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/components/chats-archive/gen-daily-videos-file.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run build && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/chats-archive/gen-daily-videos-file.ts src/components/chats-archive/gen-daily-videos-file.spec.ts
git commit -m "feat(chats-archive): daily-videos per-day query/build and today+yesterday driver"
```

---

### Task 5: Add the 12-hour finalize pass to `gen-daily-videos-file.ts`

**Files:**

- Modify: `src/components/chats-archive/gen-daily-videos-file.ts`
- Test: `src/components/chats-archive/gen-daily-videos-file.spec.ts`

- [ ] **Step 1: Write the failing test for `finalizeFilter` and `finalizeDates`**

Append these `describe` blocks to `src/components/chats-archive/gen-daily-videos-file.spec.ts`, and add `finalizeDates`, `finalizeFilter`, `queryFinalizeVideos`, and `genDailyVideosFinalize` to the dynamic-import destructuring at the top of the spec (the `const { ... } = await import("./gen-daily-videos-file.js");` block created in Task 4):

```ts
describe("finalizeFilter", () => {
  it("selects live-before-yesterday, ended-within-48h, deleted-within-48h", () => {
    // now = 2026-07-11T09:00:00Z. startOfYesterday (JST) = 2026-07-10 00:00 JST
    //   = 2026-07-09T15:00:00Z. windowStart = now - 48h = 2026-07-09T09:00:00Z.
    const now = new Date("2026-07-11T09:00:00.000Z");
    expect(finalizeFilter(now)).toEqual({
      actualStart: { $exists: true, $ne: null },
      uploadedVideo: { $ne: true },
      hbIgnore: { $ne: true },
      $or: [
        {
          status: VideoStatus.Live,
          availableAt: { $lt: new Date("2026-07-09T15:00:00.000Z") },
        },
        {
          status: VideoStatus.Past,
          actualEnd: { $gte: new Date("2026-07-09T09:00:00.000Z") },
        },
        {
          status: VideoStatus.Missing,
          detectedDeletionAt: { $gte: new Date("2026-07-09T09:00:00.000Z") },
        },
      ],
    });
  });
});

describe("finalizeDates", () => {
  it("returns distinct JST start dates minus today and yesterday", () => {
    // now = 2026-07-11T09:00 UTC -> JST today 2026-07-11, yesterday 2026-07-10.
    const now = new Date("2026-07-11T09:00:00.000Z");
    const dates = finalizeDates(
      [
        v({ id: "a", availableAt: new Date("2026-07-08T02:00:00.000Z") }), // 07-08 JST
        v({ id: "b", availableAt: new Date("2026-07-08T20:00:00.000Z") }), // 07-09 JST
        v({ id: "c", availableAt: new Date("2026-07-08T21:00:00.000Z") }), // 07-09 JST (dup)
        v({ id: "today", availableAt: new Date("2026-07-11T02:00:00.000Z") }), // 07-11 -> excluded
        v({ id: "yday", availableAt: new Date("2026-07-10T02:00:00.000Z") }), // 07-10 -> excluded
      ],
      now
    );
    expect([...dates].sort()).toEqual(["2026-07-08", "2026-07-09"]);
  });
});
```

**How the non-matching controls and the 48h boundary are covered.** Because
`VideoModel.find` is mocked in these unit tests (the Mongo query is never run
against a database), the filter's selectivity is proven by asserting the
**exact** object `finalizeFilter` builds — not by feeding it non-matching
documents. The `toEqual` above therefore pins every non-matching control:
`actualStart: { $exists: true, $ne: null }` excludes streams that never started;
`uploadedVideo: { $ne: true }` and `hbIgnore: { $ne: true }` exclude uploaded and
ignored videos; and the `$gte` lower bound of **exactly `now − 48h`**
(`2026-07-09T09:00:00.000Z`) is the ended/deleted boundary, so anything ended or
detected-deleted before it (`> 48h` ago) is outside the filter, and a `Missing`
stream without a recent `detectedDeletionAt` fails the `$gte` too. The date-level
controls (today/yesterday exclusion and de-duplication) are covered by the
`finalizeDates` test above and the `genDailyVideosFinalize` integration test
(Step 5).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/components/chats-archive/gen-daily-videos-file.spec.ts`
Expected: FAIL — `finalizeFilter` / `finalizeDates` are not exported yet.

- [ ] **Step 3: Implement the finalize functions**

In `src/components/chats-archive/gen-daily-videos-file.ts`, add the `VideoStatus` import and the finalize logic. Update the top imports to include `VideoStatus`:

```ts
import { VideoStatus } from "holodex.js";
```

Add, below `genDailyVideos`:

```ts
// Terminal (ended / detected-deleted) streams stay eligible for finalize for
// this long after the fact. 4× the 12h run interval gives an overlap budget so a
// delayed or missed finalize run still re-picks a stream that just ended.
const FINALIZE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Mongo filter for the finalize pass: started, non-uploaded, non-ignored streams
 * that are either still live from before yesterday, or ended / detected-deleted
 * within the trailing 48h window.
 */
export function finalizeFilter(now: Date): FilterQuery<Video> {
  const startOfYesterday = moment
    .tz(now, JST)
    .subtract(1, "day")
    .startOf("day")
    .toDate();
  const windowStart = new Date(now.getTime() - FINALIZE_WINDOW_MS);
  return {
    actualStart: { $exists: true, $ne: null },
    uploadedVideo: { $ne: true },
    hbIgnore: { $ne: true },
    $or: [
      { status: VideoStatus.Live, availableAt: { $lt: startOfYesterday } },
      { status: VideoStatus.Past, actualEnd: { $gte: windowStart } },
      {
        status: VideoStatus.Missing,
        detectedDeletionAt: { $gte: windowStart },
      },
    ],
  };
}

/** Distinct JST start dates of the given streams, excluding today and yesterday. */
export function finalizeDates(videos: VideoDoc[], now: Date): string[] {
  const nowJst = moment.tz(now, JST);
  const skip = new Set([
    nowJst.clone().format("YYYY-MM-DD"),
    nowJst.clone().subtract(1, "day").format("YYYY-MM-DD"),
  ]);
  const dates = new Set<string>();
  for (const video of videos) {
    const date = moment.tz(video.availableAt, JST).format("YYYY-MM-DD");
    if (!skip.has(date)) dates.add(date);
  }
  return [...dates];
}

/** Fetch the finalize-eligible streams (channel not populated: only dates used). */
export async function queryFinalizeVideos(now: Date): Promise<VideoDoc[]> {
  const videos: VideoDoc[] = [];
  for await (const video of VideoModel.find(finalizeFilter(now)).setOptions({
    readPreference: "secondaryPreferred",
  })) {
    videos.push(video);
  }
  return videos;
}

/**
 * The 12-hour finalize pass: regenerate the start-day files of streams still live
 * from before yesterday, or ended / detected-deleted within 48h — minus today
 * and yesterday, which the 10-minute job owns (keeping the two jobs' file sets
 * disjoint). The optional `job` renews the Agenda lock after each file.
 */
export async function genDailyVideosFinalize(job?: Job): Promise<void> {
  const now = new Date();
  const videos = await queryFinalizeVideos(now);
  for (const date of finalizeDates(videos, now)) {
    await genDailyVideosFile(date);
    await job?.touch();
  }
}
```

- [ ] **Step 4: Add a query test for `queryFinalizeVideos`**

Append to `src/components/chats-archive/gen-daily-videos-file.spec.ts`:

```ts
describe("queryFinalizeVideos", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("queries VideoModel.find with the finalize filter and returns the docs", async () => {
    const now = new Date("2026-07-11T09:00:00.000Z");
    const docs = [v({ id: "a" }), v({ id: "b" })];
    const spy = jest.spyOn(VideoModel, "find").mockReturnValue(fakeQuery(docs));

    const result = await queryFinalizeVideos(now);

    expect(spy).toHaveBeenCalledWith(finalizeFilter(now));
    expect(result.map((d) => d.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 5: Add the finalize driver integration test**

This proves `genDailyVideosFinalize` wires the query → date selection →
`genDailyVideosFile` correctly: it excludes today/yesterday and regenerates
exactly the matched older start dates. `VideoModel.find` is stubbed to return the
finalize docs for the finalize query (the filter carrying `$or`) and an empty set
for each per-date `queryDailyVideos` call; the mocked `dataFilePath`
(from Task 4's `unstable_mockModule`) records the date each regenerated file
targets. `jest.useFakeTimers()` pins `new Date()` so "today"/"yesterday" are
deterministic. Append to the spec:

```ts
describe("genDailyVideosFinalize", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    writeDataFile.mockClear();
    dataFilePath.mockClear();
  });

  it("regenerates exactly the matched older start dates, excluding today/yesterday", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-11T09:00:00.000Z"));
    const finalizeDocs = [
      v({ id: "old1", availableAt: new Date("2026-07-08T02:00:00.000Z") }), // 07-08 JST
      v({ id: "old2", availableAt: new Date("2026-07-08T20:00:00.000Z") }), // 07-09 JST
      v({ id: "old3", availableAt: new Date("2026-07-08T21:00:00.000Z") }), // 07-09 JST (dup)
      v({ id: "today", availableAt: new Date("2026-07-11T02:00:00.000Z") }), // excluded
      v({ id: "yday", availableAt: new Date("2026-07-10T02:00:00.000Z") }), // excluded
    ];
    // finalize query carries `$or`; per-date queryDailyVideos calls do not.
    jest
      .spyOn(VideoModel, "find")
      .mockImplementation(((filter: any) =>
        fakeQuery(filter?.$or ? finalizeDocs : [])) as any);
    const touch = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await genDailyVideosFinalize({ touch } as any);

    // dataFilePath is called once per regenerated date as ("daily-videos", "<date>.json").
    const writtenDates = dataFilePath.mock.calls
      .filter((c) => c[0] === "daily-videos")
      .map((c) => c[1]);
    expect([...writtenDates].sort()).toEqual([
      "2026-07-08.json",
      "2026-07-09.json",
    ]);
    expect(writeDataFile).toHaveBeenCalledTimes(2);
    // the Agenda lock is renewed after each regenerated file
    expect(touch).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- src/components/chats-archive/gen-daily-videos-file.spec.ts`
Expected: PASS (all `describe` blocks).

- [ ] **Step 7: Typecheck and lint**

Run: `npm run build && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/chats-archive/gen-daily-videos-file.ts src/components/chats-archive/gen-daily-videos-file.spec.ts
git commit -m "feat(chats-archive): 12h daily-videos finalize pass for long-running/terminal streams"
```

---

### Task 6: Register the daily-videos jobs in `chats-archive.ts` and update the direct-run block

**Files:**

- Modify: `src/components/chats-archive.ts`

This task swaps the leaderboard imports/registration for the two daily-videos jobs. It is verified by tsc/lint plus a build of the whole component (no dedicated unit test — Agenda wiring mirrors the existing `chats archive realtime` registration).

- [ ] **Step 1: Swap the import**

In `src/components/chats-archive.ts`, replace the leaderboard import (line 19):

```ts
import { genDailyLeaderboards } from "./chats-archive/gen-leaderboard-file.js";
```

with:

```ts
import {
  genDailyVideos,
  genDailyVideosFinalize,
} from "./chats-archive/gen-daily-videos-file.js";
```

- [ ] **Step 2: Swap the Agenda registration**

In the `if (CHAT_ARCHIVE_DIR)` block, replace the leaderboard job registration:

```ts
agenda.define("chats archive leaderboard", (job) => genDailyLeaderboards(job));
void agenda.every("1 hours", "chats archive leaderboard");
```

with the two daily-videos jobs:

```ts
agenda.define("chats archive daily-videos", (job) => genDailyVideos(job));
void agenda.every("10 minutes", "chats archive daily-videos");

agenda.define("chats archive daily-videos finalize", (job) =>
  genDailyVideosFinalize(job)
);
void agenda.every("12 hours", "chats archive daily-videos finalize");
```

- [ ] **Step 3: Update the direct-run block**

In the `if (isMain(import.meta))` block, replace the leaderboard call:

```ts
await genDailyLeaderboards();
```

with:

```ts
await genDailyVideos();
await genDailyVideosFinalize();
```

- [ ] **Step 4: Typecheck and lint**

Run: `npm run build && npm run lint`
Expected: no errors. (`gen-leaderboard-file.ts` still exists but is now unused; it is removed in Task 7.)

- [ ] **Step 5: Commit**

```bash
git add src/components/chats-archive.ts
git commit -m "feat(chats-archive): schedule daily-videos and 12h finalize jobs, drop leaderboard job"
```

---

### Task 7: Delete the leaderboard writer and its test

**Files:**

- Delete: `src/components/chats-archive/gen-leaderboard-file.ts`
- Delete: `src/components/chats-archive/gen-leaderboard-file.spec.ts`

`jstDayRangeUtc` (the only export the rest of the codebase still needed) was reintroduced in `gen-daily-videos-file.ts` in Task 4, and `chats-archive.ts` no longer imports the leaderboard module after Task 6, so these files have no remaining importers.

- [ ] **Step 1: Confirm there are no remaining external importers**

Run: `grep -rn "gen-leaderboard-file" src/ | grep -v '^src/components/chats-archive/gen-leaderboard-file\.'`
Expected: no matches. `grep -rn` prefixes each hit with its file path, so the `^…gen-leaderboard-file\.`-anchored `grep -v` drops only lines **from** the two `gen-leaderboard-file.*` files being deleted (e.g. the `.spec.ts` importing its own `./gen-leaderboard-file.js`). A real external importer such as `src/components/chats-archive.ts` has a different path prefix and is **not** filtered — any surviving line is a real importer that must be cleaned up before deleting the module.

- [ ] **Step 2: Delete the files**

```bash
git rm src/components/chats-archive/gen-leaderboard-file.ts src/components/chats-archive/gen-leaderboard-file.spec.ts
```

- [ ] **Step 3: Typecheck, lint, and run the full test suite**

Run: `npm run build && npm run lint && npm test`
Expected: no errors; no test references the deleted files.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(chats-archive): remove daily leaderboard writer"
```

---

### Task 8: Data-contract paperwork — add daily-videos, remove leaderboard, deprecate root-index

**Files:**

- Create: `docs/data-contract/daily-videos.md`
- Delete: `docs/data-contract/daily-leaderboard.md`
- Modify: `docs/data-contract/README.md` (§2 index table)
- Modify: `docs/data-contract/root-index.md` (deprecation banner + revision row)

- [ ] **Step 1: Create `docs/data-contract/daily-videos.md`**

Create the file mirroring the structure of the existing `realtime.md`. Assemble
it from the four parts below in order (each part is shown in its own fence to
avoid nested code fences — concatenate their contents into the single file).

Part 1 — header, revision history, and the `### Base shape (r0)` heading:

```markdown
# Daily videos index (`data/daily-videos/{YYYY-MM-DD}.json`)

**File path pattern:** `data/daily-videos/{YYYY-MM-DD}.json` (JST calendar date)
**Companion file:** none.
**Writer:** `src/components/chats-archive/gen-daily-videos-file.ts`
**Version field in JSON:** none at version 1 — readers detect version
defensively as `(json.version ?? 1)`.
**Current writer emits:** version 1, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                               |
| ------- | -------- | ---------- | --- | ----------------------------------------------------- |
| 1       | r0       | 2026-07-12 | —   | Initial per-JST-day list of started stream summaries. |

## version 1

### Base shape (r0)
```

Part 2 — the TypeScript interfaces, placed directly under `### Base shape (r0)`:

```ts
interface DailyVideos {
  date: string; // "YYYY-MM-DD" in JST — the day this file lists
  snapshotAt: string; // ISO 8601; when this file was generated
  videos: VideoSummaryWithChannel[]; // started streams of that day, availableAt desc
}

interface VideoSummaryWithChannel {
  id: string;
  title: string;
  channel: { id: string; name: string; avatarUrl?: string };
  status: string; // "new" | "upcoming" | "live" | "past" | "missing"
  duration: number; // seconds; 0 while a stream is live
  availableAt: string; // ISO 8601
  archiveVersion: number; // 1 = legacy, 2 = current archiver
  stats: { superChatTotalJpy: number; memberCount: number; giftCount: number };
  scheduledStart?: string; // ISO 8601
  actualStart?: string; // ISO 8601
  actualEnd?: string; // ISO 8601
  publishedAt?: string; // ISO 8601
  viewers?: number; // live concurrent viewers; 0 after finish
  maxViewers?: number; // peak concurrent viewers; persists after finish
  likes?: number; // like count; persists after finish
  premiere?: boolean; // true for YouTube premieres
}
```

Part 3 — add the heading `### Cumulative JSON example (r0)`, then this example:

```json
{
  "date": "2026-07-11",
  "snapshotAt": "2026-07-11T09:00:00.000Z",
  "videos": [
    {
      "id": "vid002",
      "title": "Later stream of the day",
      "channel": { "id": "UCbbbbbbbbbbbbbbbbbbbbbb", "name": "Channel B" },
      "status": "past",
      "duration": 3600,
      "availableAt": "2026-07-11T12:00:00.000Z",
      "archiveVersion": 2,
      "stats": { "superChatTotalJpy": 5000, "memberCount": 12, "giftCount": 1 },
      "actualStart": "2026-07-11T12:00:00.000Z",
      "actualEnd": "2026-07-11T13:00:00.000Z",
      "maxViewers": 6000,
      "likes": 900
    },
    {
      "id": "vid001",
      "title": "Earlier stream of the day",
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
      "actualStart": "2026-07-11T08:00:00.000Z",
      "viewers": 1234,
      "maxViewers": 1500,
      "likes": 320
    }
  ]
}
```

Part 4 — add the heading `### Reader guidance`, then these bullets:

```markdown
- **Version detection:** absence of a `version` key implies version 1.
- **Always present at root:** `date`, `snapshotAt`, `videos` (may be empty).
- **`videos: []`** means the day was computed and no stream qualified — distinct
  from a `404` (file not yet generated for that date).
- **Always present per entry:** `id`, `title`, `channel.id`, `channel.name`,
  `status`, `duration`, `availableAt`, `archiveVersion`, `stats.*`.
- **May be absent per entry:** `channel.avatarUrl`, `scheduledStart`,
  `actualStart`, `actualEnd`, `publishedAt`, `viewers`, `maxViewers`, `likes`,
  `premiere`.
- **Which streams are listed:** every stream that has actually started
  (`actualStart` set) and whose `availableAt` falls in this JST day, excluding
  streams that never started, uploaded videos, and ignored channels. A stream is
  placed in the day of its `availableAt`.
- **Ordering:** `videos` is sorted descending by `availableAt`, ties broken by
  ascending `id`. This is a stable default only; re-sort client-side as needed.
- **Metric freshness:** `viewers`/`maxViewers`/`likes` are a periodically
  refreshed snapshot, not necessarily final. A day file is refreshed every
  10 min while it is today/yesterday, then at least every 12h while it still
  contains a live stream and typically once more shortly after such a stream ends
  or is detected deleted (barring an extended finalize outage). For a currently
  live stream, `realtime.json` is authoritative for the instantaneous value.
- **Unknown extra fields:** ignore (forward compatibility).
```

- [ ] **Step 2: Delete `docs/data-contract/daily-leaderboard.md`**

```bash
git rm docs/data-contract/daily-leaderboard.md
```

- [ ] **Step 3: Update the README file-type index**

In `docs/data-contract/README.md` §2, replace the daily-leaderboard row:

```markdown
| [daily-leaderboard.md](./daily-leaderboard.md) | `data/leaderboard/{metric}/{YYYY-MM-DD}.json` | 1 |
```

with a daily-videos row:

```markdown
| [daily-videos.md](./daily-videos.md) | `data/daily-videos/{YYYY-MM-DD}.json` | 1 |
```

And mark the root-index row deprecated — replace:

```markdown
| [root-index.md](./root-index.md) | `data/index.json` | 1 |
```

with:

```markdown
| [root-index.md](./root-index.md) | `data/index.json` | 1 (deprecated) |
```

- [ ] **Step 4: Add the deprecation banner and revision row to `root-index.md`**

In `docs/data-contract/root-index.md`, immediately after the `# Root index ...`
title line, insert a deprecation banner:

```markdown
> **⚠️ Deprecated.** `data/index.json` is superseded by the newer per-purpose
> files — its `live` array by `realtime.json` + `upcoming.json`, and the per-day
> started-videos purpose of `past` by `daily-videos/{YYYY-MM-DD}.json`. This is
> **not** a mechanical 1:1 swap: `daily-videos` is bucketed by a stream's start
> day and does **not** preserve `past`'s "recently ended within 48h" semantics
> (a long-running stream that started before yesterday but ended recently is in
> `past` but not in the scheduled today/yesterday `daily-videos` files).
> Composing an equivalent recent-past view is a frontend concern. The writer is
> retained for now, so readers needing the recently-ended set keep working.
```

Then add a revision-history row to the existing table (documentation-only change,
no shape/version change):

```markdown
| 1 | r2 | 2026-07-12 | — | Marked deprecated; superseded by realtime/upcoming (live) and daily-videos (per-day started list). Writer unchanged, still emits version 1. |
```

Do not change the interface, JSON example, or reader-guidance sections.

- [ ] **Step 5: Verify the docs reference no spec/plan and links resolve**

Run: `grep -nE "§|\bspec\b|\bplan\b" docs/data-contract/daily-videos.md`
Expected: no matches (data-contract §8.1 anti-leak: docs must not reference the spec/plan).

Run: `grep -rn "daily-leaderboard" docs/data-contract/`
Expected: no matches (the removed doc is no longer linked).

- [ ] **Step 6: Commit**

```bash
git add docs/data-contract/daily-videos.md docs/data-contract/README.md docs/data-contract/root-index.md
git commit -m "docs(data-contract): add daily-videos, remove daily-leaderboard, deprecate root-index"
```

---

## Final validation

- [ ] **Full build, lint, and test suite**

Run: `npm run build && npm run lint && npm test`
Expected: all green; no references to the removed leaderboard module or doc remain.
