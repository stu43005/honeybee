# YouTube Official Video Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three crawler rounds that discover videos through official YouTube channels — channel RSS feed polling, members-only uploads playlist (UUMO) scanning, and existence probing for videos stuck at `Missing` — plus one extra candidate query so heuristically-`Missing` streams get re-checked.

**Architecture:** Three agenda jobs registered in `src/commands/crawler.ts`, each implemented as a one-round function in `src/components/youtube-discovery/`. Every round follows the shape `renewPubsubSubscriptions()` already uses: take the N least-recently-processed rows, handle each with spacing between outbound requests, always advance the timestamp. Discovery writes go through one new `VideoModel` static that creates (never updates) unknown videos; metadata hydration is left entirely to the existing `crawler youtube update` job so this subsystem's quota cost stays a constant.

**Tech Stack:** TypeScript (ESM, NodeNext), Typegoose/Mongoose 8.2.1, Agenda 6.2.4, axios 1.6, googleapis 173, Jest 29 with `ts-jest` ESM preset.

**Spec:** `docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md`

---

## Research Already Completed

These were verified before planning. Do **not** re-derive them; they are stated here so tasks can rely on them.

| Fact                                                                                                                                                   | Evidence                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Agenda's default `lockLifetime` is **10 minutes**                                                                                                      | `node_modules/agenda/dist/index.js:15` — `defaultLockLifetime: 10 * 60 * 1000`                                                 |
| A job whose run exceeds `lockLifetime` without `touch()` is killed by agenda                                                                           | `node_modules/agenda/dist/JobProcessor.js:429-449`                                                                             |
| Missed runs do not accumulate: `nextRunAt = lastRunAt + interval`                                                                                      | `node_modules/agenda/dist/utils/nextRunAt.js:44-51`                                                                            |
| googleapis enables retries by default; gaxios retries GET 3× on 429/5xx                                                                                | `node_modules/googleapis-common/build/src/apirequest.js:259`, `node_modules/gaxios/build/esm/src/retry.js:20-60`               |
| Per-call retry override goes in the **second** argument                                                                                                | `Resource$Playlistitems` in `node_modules/googleapis/build/src/apis/youtube/v3.js` builds `parameters.options` from arg 2 only |
| `insertMany(..., { ordered: false })` inserts the rest when some rows are duplicates; error carries `writeErrors[i].code === 11000` and `insertedDocs` | `node_modules/mongoose/lib/model.js:3296-3339`                                                                                 |
| `insertMany` runs schema validation and applies defaults + timestamps                                                                                  | `node_modules/mongoose/lib/model.js:3144`, `3159`, `3223-3225`                                                                 |
| This repo uses **axios**, never `fetch`                                                                                                                | 10 source files import axios; zero `fetch(` call sites                                                                         |

**Worst-case round durations** are 3.4 min (feed), 4.3 min (members), 1.7 min (existence probe) — all far below the 10-minute default lock. Therefore **no task sets `lockLifetime` and no task calls `job.touch()`**, matching `renewPubsubSubscriptions()`.

---

## File Structure

| File                                                           | Responsibility                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/constants.ts` (modify)                                    | 8 new tuning constants                                                         |
| `src/models/Channel.ts` (modify)                               | 4 new optional fields, 3 new indexes, 3 new candidate-query statics            |
| `src/models/Video.ts` (modify)                                 | 1 new partial index, `noticeUnknownVideos()`, `findExistenceProbeCandidates()` |
| `src/components/youtube-discovery/oembed.ts` (create)          | Zero-quota existence probing: URL building, status-code classification         |
| `src/modules/youtube.ts` (modify)                              | `updateVideoFromPlaylist()` — the only new googleapis call site                |
| `src/components/youtube-discovery/feed-poll.ts` (create)       | One feed-poll round                                                            |
| `src/components/youtube-discovery/members-poll.ts` (create)    | One members round: probe phase then scan phase                                 |
| `src/components/youtube-discovery/existence-probe.ts` (create) | One existence-probe round over two buckets                                     |
| `src/commands/crawler.ts` (modify)                             | Register the three agenda jobs; add the sixth candidate query                  |

Tests sit beside their implementation (`*.spec.ts`), matching the repo layout.

---

## Conventions That Apply To Every Task

- **ESM imports always carry `.js`**, even for `.ts` sources (NodeNext resolution).
- **Tests use true-ESM Jest**: `jest.unstable_mockModule(...)` followed by top-level `await import(...)`. `jest.mock` does not hoist here. Any `process.env` a module reads at eval time must be assigned **before** the first dynamic import.
- **All comments, `describe` and `it` strings are English.**
- Run a single test file with `npm run test -- <path>`; add `-t "<name>"` to filter.
- Commit messages follow the repo style: `type(scope): lowercase description`.

---

### Task 1: Tuning constants

**Files:**

- Modify: `src/constants.ts` (append after the existing `YOUTUBE_API_TIMEOUT_MS` block)

No test: these are literal declarations with no behavior. Later tasks import them and assert against them, which is what proves they exist and are wired correctly.

- [ ] **Step 1: Add the constants**

Append to `src/constants.ts`:

```ts
// --- YouTube official video discovery (src/components/youtube-discovery/) ---

// Channels fetched in one feed-poll round. On the 2-minute schedule that is 600
// channels/hour. Discovery latency is one rotation plus the feed's 15-minute
// edge cache, so the one-hour target holds up to 450 subscribed channels; 300
// channels land around 45 minutes. Raise this if the subscription list grows
// past that — the feed costs no quota, only outbound requests.
export const YOUTUBE_FEED_POLL_BATCH_SIZE = 20;

// Gap between two outbound requests inside any discovery round. Both endpoints
// served 10 req/s for 10 seconds and 120-concurrent bursts without a single
// 429, so 4 req/s keeps a 2.5x margin below what was actually verified.
export const YOUTUBE_DISCOVERY_REQUEST_SPACING_MS = 250;

// Per-request timeout for the channel RSS feed. A healthy response takes about
// 100 ms; this is generous enough to ride out a slow edge node while keeping a
// fully stalled round inside agenda's 10 minute lock.
export const YOUTUBE_FEED_TIMEOUT_MS = 10 * 1000;

// Per-request timeout for oEmbed probes. Measured latency is 40-50 ms; same
// reasoning as the feed timeout.
export const YOUTUBE_OEMBED_TIMEOUT_MS = 10 * 1000;

// Channels whose members-only uploads playlist is read in one round. Each read
// costs one quota unit, so on the 5-minute schedule this is 4320 units/day.
// That is what the 10000-unit daily budget can spare once every existing
// consumer is counted, not just the two scheduled jobs: the pubsub notification
// handler hydrates each newly inserted video outside any cap, and the raid
// handle lookup and the moderator commands are uncapped too. The buffer left
// over absorbs the ones that cannot be bounded in advance.
export const YOUTUBE_MEMBERS_POLL_BATCH_SIZE = 15;

// Channels probed per round for whether a members-only uploads playlist exists.
// Costs no quota; 3 per round is 864 probes/day, enough to re-probe every
// channel well inside the TTL below.
export const YOUTUBE_MEMBERS_PROBE_BATCH_SIZE = 3;

// How far ahead a CONCLUSIVE probe pushes the channel's next probe. Whether a
// channel offers memberships almost never changes, so a channel that newly
// opens them is picked up within a week and asking more often buys nothing.
export const YOUTUBE_MEMBERS_PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// How far ahead an INCONCLUSIVE probe pushes it instead (a 5xx, a timeout, a
// network error). A channel with no conclusion is excluded from the playlist
// scan, so pushing a failure out by the full week would hide that channel's
// members-only videos until then — and on first rollout every channel takes
// that path. An hour keeps the blast radius in hours, and still pushes a
// persistently failing channel far enough back that it cannot reclaim a probe
// slot every round.
export const YOUTUBE_MEMBERS_PROBE_RETRY_MS = 60 * 60 * 1000;

// Videos each of the two buckets contributes to one existence-probe round.
// Two buckets x 5 x 288 rounds/day = 2880 probes/day, all quota-free. Only
// videos YouTube no longer returns are probed: for the ones marked Missing by a
// timeout heuristic the video still exists, so oEmbed would answer 200 every
// time and teach us nothing.
export const YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE = 5;

// The availableAt boundary splitting recent Missing videos from old ones. A
// video that vanished in the last two weeks is far likelier to return than one
// gone for years, and the split stops the much larger old population from
// starving the recent one.
export const YOUTUBE_EXISTENCE_PROBE_RECENT_MS = 14 * 24 * 60 * 60 * 1000;
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat(constants): add youtube discovery tuning values"
```

---

### Task 2: Channel fields, indexes and candidate queries

**Files:**

- Modify: `src/models/Channel.ts`
- Test: `src/models/Channel.spec.ts` (append to the existing file)

- [ ] **Step 1: Write the failing tests**

Append to `src/models/Channel.spec.ts`:

```ts
describe("Channel discovery candidate queries", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Captures the arguments the static hands to find()/and()/sort()/limit()
  // without touching a database. Each method returns the same recorder so the
  // chain keeps working.
  function recordQuery() {
    const calls: { and: unknown[][]; sort: unknown[]; limit: number[] } = {
      and: [],
      sort: [],
      limit: [],
    };
    const chain: Record<string, unknown> = {};
    chain.and = (clauses: unknown[]) => {
      calls.and.push(clauses);
      return chain;
    };
    chain.sort = (order: unknown) => {
      calls.sort.push(order);
      return chain;
    };
    chain.limit = (n: number) => {
      calls.limit.push(n);
      return chain;
    };
    chain.select = () => chain;
    jest.spyOn(ChannelModel, "findSubscribed").mockReturnValue(chain as never);
    return calls;
  }

  it("orders feed candidates by the oldest fetch and caps the batch", () => {
    const calls = recordQuery();

    ChannelModel.findFeedPollCandidates(7);

    expect(calls.sort).toEqual([{ feedCrawledAt: 1 }]);
    expect(calls.limit).toEqual([7]);
    // Never-fetched channels must be eligible, so the query cannot demand an
    // existing timestamp.
    expect(calls.and).toEqual([]);
  });

  it("selects members-probe candidates whose next probe time has arrived", () => {
    const now = new Date("2026-09-18T00:00:00.000Z");
    const calls = recordQuery();

    ChannelModel.findMembersProbeCandidates(3, now);

    expect(calls.and).toEqual([
      {
        $or: [
          { membersProbeNextAt: null },
          { membersProbeNextAt: { $lt: now } },
        ],
      },
    ]);
    expect(calls.sort).toEqual([{ membersProbeNextAt: 1 }]);
    expect(calls.limit).toEqual([3]);
  });

  it("scans only channels already known to have a members playlist", () => {
    const calls = recordQuery();

    ChannelModel.findMembersPollCandidates(15);

    expect(calls.and).toEqual([{ hasMembersPlaylist: true }]);
    expect(calls.sort).toEqual([{ membersCrawledAt: 1 }]);
    expect(calls.limit).toEqual([15]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/models/Channel.spec.ts -t "Channel discovery candidate queries"`
Expected: FAIL — `ChannelModel.findFeedPollCandidates is not a function`.

- [ ] **Step 3: Add the four fields**

In `src/models/Channel.ts`, insert after the existing `pubsubExpiresAt` property:

```ts
  /** When we last fetched this channel's RSS feed. */
  @prop()
  public feedCrawledAt?: Date;

  /**
   * Whether the channel has a members-only uploads playlist. Stays unset until
   * a probe reaches a conclusion, and the playlist scan only accepts `true`, so
   * an unset channel is never scanned.
   */
  @prop()
  public hasMembersPlaylist?: boolean;

  /**
   * Earliest time the existence probe may run for this channel again. A
   * conclusive answer pushes it out by the long TTL, an inconclusive one by the
   * short retry — storing the deadline rather than the last attempt is what
   * stops a failed re-probe from renewing a stale verdict for another week.
   */
  @prop()
  public membersProbeNextAt?: Date;

  /** When we last read the members-only uploads playlist. */
  @prop()
  public membersCrawledAt?: Date;
```

- [ ] **Step 4: Add the three indexes**

In `src/models/Channel.ts`, add below the existing `@index({ pubsubExpiresAt: 1, pubsubRequestedAt: 1 })` decorator:

```ts
@index({ feedCrawledAt: 1 })
@index({ membersProbeNextAt: 1 })
@index({ hasMembersPlaylist: 1, membersCrawledAt: 1 })
```

- [ ] **Step 5: Add the three candidate statics**

In `src/models/Channel.ts`, insert after `findPubsubRenewalCandidates`:

```ts
  /**
   * Channels whose RSS feed is due a fetch: the least recently fetched first,
   * with never-fetched channels (null sorts first) ahead of them.
   */
  public static findFeedPollCandidates(
    this: ReturnModelType<typeof Channel>,
    limit: number
  ) {
    return this.findSubscribed()
      .sort({ feedCrawledAt: 1 })
      .limit(limit)
      .select("id name");
  }

  /**
   * Channels due an existence probe for their members-only uploads playlist.
   * The stored timestamp is a deadline, not a history: a conclusive answer sets
   * it a week out and an inconclusive one an hour out, so this single
   * comparison gives both a long cache for answers and a short retry for
   * failures.
   */
  public static findMembersProbeCandidates(
    this: ReturnModelType<typeof Channel>,
    limit: number,
    now: Date = new Date()
  ) {
    return this.findSubscribed()
      .and([
        {
          $or: [
            { membersProbeNextAt: null },
            { membersProbeNextAt: { $lt: now } },
          ],
        },
      ])
      .sort({ membersProbeNextAt: 1 })
      .limit(limit)
      .select("id name");
  }

  /**
   * Channels whose members-only uploads playlist should be read. Restricted to
   * a confirmed `true` so channels without memberships never consume a slot
   * that costs a quota unit; that keeps the daily spend equal to the batch size
   * regardless of how many channels have no members playlist.
   */
  public static findMembersPollCandidates(
    this: ReturnModelType<typeof Channel>,
    limit: number
  ) {
    return this.findSubscribed()
      .and([{ hasMembersPlaylist: true }])
      .sort({ membersCrawledAt: 1 })
      .limit(limit)
      .select("id name");
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- src/models/Channel.spec.ts`
Expected: PASS, including the pre-existing `waitForCrawl` tests.

- [ ] **Step 7: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/models/Channel.ts src/models/Channel.spec.ts
git commit -m "feat(channel): track feed and members-playlist rotation state"
```

---

### Task 3: Video discovery write path and probe buckets

**Files:**

- Modify: `src/models/Video.ts`
- Test: `src/models/Video.spec.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/models/Video.spec.ts`:

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { VideoStatus } from "holodex.js";
import VideoModel from "./Video.js";

type Entry = Parameters<typeof VideoModel.noticeUnknownVideos>[0][number];

const ENTRY_A: Entry = {
  videoId: "aaa",
  title: "Title A",
  channelId: "UC1",
  publishedAt: new Date("2026-09-01T00:00:00.000Z"),
};
const ENTRY_B: Entry = {
  videoId: "bbb",
  title: "Title B",
  channelId: "UC1",
  publishedAt: new Date("2026-09-02T00:00:00.000Z"),
};

// Stands in for the existence query: reports which ids the collection already
// holds, so the difference step can be observed.
function stubKnownIds(ids: string[]) {
  return jest.spyOn(VideoModel, "find").mockReturnValue({
    select: () => Promise.resolve(ids.map((id) => ({ id }))),
  } as never);
}

describe("Video.noticeUnknownVideos", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("writes nothing when every entry is already known", async () => {
    stubKnownIds(["aaa", "bbb"]);
    const insertMany = jest
      .spyOn(VideoModel, "insertMany")
      .mockResolvedValue([] as never);

    await VideoModel.noticeUnknownVideos([ENTRY_A, ENTRY_B]);

    expect(insertMany).not.toHaveBeenCalled();
  });

  it("creates only the entries the collection does not have", async () => {
    stubKnownIds(["aaa"]);
    const insertMany = jest
      .spyOn(VideoModel, "insertMany")
      .mockResolvedValue([] as never);

    await VideoModel.noticeUnknownVideos([ENTRY_A, ENTRY_B]);

    const [docs, options] = insertMany.mock.calls[0] as [
      { id: string; title: string; channelId: string; availableAt: Date }[],
      { ordered: boolean },
    ];
    expect(docs).toEqual([
      {
        id: "bbb",
        title: "Title B",
        channelId: "UC1",
        availableAt: new Date("2026-09-02T00:00:00.000Z"),
      },
    ]);
    // Unordered, so one duplicate cannot stop the rest of the batch.
    expect(options).toEqual({ ordered: false });
  });

  it("treats a duplicate key as a normal outcome rather than an error", async () => {
    stubKnownIds([]);
    const duplicate = Object.assign(new Error("E11000 duplicate key"), {
      writeErrors: [{ code: 11000, index: 0 }],
      insertedDocs: [{ id: "bbb" }],
    });
    jest.spyOn(VideoModel, "insertMany").mockRejectedValue(duplicate as never);

    await expect(
      VideoModel.noticeUnknownVideos([ENTRY_A, ENTRY_B])
    ).resolves.toBeUndefined();
  });

  it("rethrows a write failure that is not a duplicate key", async () => {
    stubKnownIds([]);
    const failure = Object.assign(new Error("connection lost"), {
      writeErrors: [{ code: 91, index: 0 }],
      insertedDocs: [],
    });
    jest.spyOn(VideoModel, "insertMany").mockRejectedValue(failure as never);

    await expect(VideoModel.noticeUnknownVideos([ENTRY_A])).rejects.toThrow(
      "connection lost"
    );
  });

  it("does nothing at all for an empty entry list", async () => {
    const find = jest.spyOn(VideoModel, "find");
    const insertMany = jest.spyOn(VideoModel, "insertMany");

    await VideoModel.noticeUnknownVideos([]);

    expect(find).not.toHaveBeenCalled();
    expect(insertMany).not.toHaveBeenCalled();
  });
});

describe("Video.findExistenceProbeCandidates", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function recordFind() {
    const filters: unknown[] = [];
    jest.spyOn(VideoModel, "find").mockImplementation(((filter: unknown) => {
      filters.push(filter);
      return {
        sort: () => ({ limit: () => ({ select: () => Promise.resolve([]) }) }),
      };
    }) as never);
    return filters;
  }

  it("asks only for deleted Missing videos that have no pending refresh", async () => {
    const filters = recordFind();
    const now = new Date("2026-09-18T00:00:00.000Z");

    await VideoModel.findExistenceProbeCandidates(true, 5, now);

    expect(filters[0]).toEqual({
      status: VideoStatus.Missing,
      deleted: true,
      crawledAt: { $ne: null },
      availableAt: { $gte: new Date("2026-09-04T00:00:00.000Z") },
    });
  });

  it("splits the old bucket on the same boundary", async () => {
    const filters = recordFind();
    const now = new Date("2026-09-18T00:00:00.000Z");

    await VideoModel.findExistenceProbeCandidates(false, 5, now);

    expect(filters[0]).toEqual({
      status: VideoStatus.Missing,
      deleted: true,
      crawledAt: { $ne: null },
      availableAt: { $lt: new Date("2026-09-04T00:00:00.000Z") },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/models/Video.spec.ts`
Expected: FAIL — `VideoModel.noticeUnknownVideos is not a function`.

- [ ] **Step 3: Add the partial index**

In `src/models/Video.ts`, add below the existing `@index({ detectedDeletionAt: 1 }, ...)` decorator:

```ts
// Serves both existence-probe buckets (equality on `deleted`, range on
// `availableAt`) and the re-check query for heuristically-Missing videos, which
// skips `availableAt` entirely. Both sort on `crawledAt` after a range, so both
// fall back to an in-memory sort — but their limits are 5 and 2, which makes it
// a top-k sort with constant memory rather than a full one.
@index(
  { deleted: 1, availableAt: 1, crawledAt: 1 },
  {
    partialFilterExpression: {
      status: VideoStatus.Missing,
    },
  }
)
```

- [ ] **Step 4: Add the discovery entry type and the two statics**

In `src/models/Video.ts`, add this exported interface just above the `Video` class:

```ts
/**
 * One video as an official discovery source reports it. The RSS feed and
 * `playlistItems.list` both supply exactly these four values, which is the
 * whole reason neither path needs a `videos.list` call to create a document.
 */
export interface DiscoveredVideo {
  videoId: string;
  title: string;
  channelId: string;
  publishedAt?: Date;
}
```

Then add these statics to the class, in the `#region update methods` section after `noticeFromRaid`:

```ts
  /**
   * Creates the videos this collection has never seen and leaves every existing
   * document untouched.
   *
   * Two layers, answering two different problems. The lookup is an
   * optimisation: a feed round carries 15 entries of which nearly all are
   * already known, and sending those to the database is pure waste. The insert
   * is where correctness lives: between the lookup and the write, pubsub or
   * another discovery round can create the very same video and hydrate it, and
   * an insert simply loses that race against the unique index instead of
   * overwriting a title or resetting `crawledAt`.
   *
   * Unlike every upsert path in this file, this runs schema validators, so a
   * document missing `title` or `channelId` is refused at the boundary rather
   * than written and then failing every later `save()`.
   */
  public static async noticeUnknownVideos(
    this: ReturnModelType<typeof Video>,
    entries: DiscoveredVideo[]
  ): Promise<void> {
    if (entries.length === 0) return;

    const ids = entries.map((entry) => entry.videoId);
    const known = new Set(
      (await this.find({ id: { $in: ids } }).select("id")).map(
        (video) => video.id
      )
    );
    const unknown = entries.filter((entry) => !known.has(entry.videoId));
    if (unknown.length === 0) return;

    const docs = unknown.map((entry) => ({
      id: entry.videoId,
      title: entry.title,
      channelId: entry.channelId,
      // `availableAt` is required with no default. It is only a starting value
      // — updateVideoFromYoutube overwrites it with actualStart/scheduledStart
      // /publishedAt — but it is indexed, so the source's real publish time
      // beats "now" for the feed entries that are already days old.
      availableAt: entry.publishedAt ?? new Date(),
    }));

    try {
      await this.insertMany(docs, { ordered: false });
    } catch (error) {
      // A duplicate key is the expected outcome of losing the race described
      // above, not a failure worth reporting. Anything else is real.
      const writeErrors = (error as { writeErrors?: { code?: number }[] })
        .writeErrors;
      const onlyDuplicates =
        Array.isArray(writeErrors) &&
        writeErrors.length > 0 &&
        writeErrors.every((writeError) => writeError.code === 11000);
      if (!onlyDuplicates) throw error;
    }
  }

  /**
   * One bucket of the existence probe: videos YouTube stopped returning,
   * split by whether they became available within the recent window so the far
   * larger old population cannot starve the recent one.
   *
   * `crawledAt: { $ne: null }` excludes documents with a pending hydration
   * request. A null there means someone (pubsub, via noticeFromNotification)
   * asked for a refresh that `crawler youtube update` has not served yet, and
   * null sorts first — so without this the probe would preferentially grab
   * exactly those documents and overwrite the request with its own timestamp.
   */
  public static findExistenceProbeCandidates(
    this: ReturnModelType<typeof Video>,
    recent: boolean,
    limit: number,
    now: Date = new Date()
  ) {
    const boundary = new Date(
      now.getTime() - YOUTUBE_EXISTENCE_PROBE_RECENT_MS
    );
    return this.find({
      status: VideoStatus.Missing,
      deleted: true,
      crawledAt: { $ne: null },
      availableAt: recent ? { $gte: boundary } : { $lt: boundary },
    })
      .sort({ crawledAt: 1 })
      .limit(limit)
      .select("id crawledAt");
  }
```

Add the constant import at the top of `src/models/Video.ts`, extending the existing import from `../constants.js` if one is present or adding it next to the other imports:

```ts
import { YOUTUBE_EXISTENCE_PROBE_RECENT_MS } from "../constants.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- src/models/Video.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/models/Video.ts src/models/Video.spec.ts
git commit -m "feat(video): create unknown videos and query existence-probe buckets"
```

---

### Task 4: oEmbed existence probe

**Files:**

- Create: `src/components/youtube-discovery/oembed.ts`
- Test: `src/components/youtube-discovery/oembed.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/components/youtube-discovery/oembed.spec.ts`:

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { AxiosError } from "axios";

const mockGet = jest.fn<(url: string, config: unknown) => Promise<unknown>>();

jest.unstable_mockModule("axios", () => {
  const isAxiosError = (error: unknown) =>
    !!error && (error as AxiosError).isAxiosError === true;
  return {
    default: { get: mockGet, isAxiosError },
    isAxiosError,
  };
});

const { probeVideo, probePlaylist } = await import("./oembed.js");
const { YOUTUBE_OEMBED_TIMEOUT_MS } = await import("../../constants.js");

function httpError(status: number): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    "ERR_BAD_REQUEST",
    undefined,
    {},
    { status } as never
  );
}

describe("oEmbed probing", () => {
  afterEach(() => {
    mockGet.mockReset();
  });

  it("percent-encodes the target url inside the query string", async () => {
    mockGet.mockResolvedValue({ status: 200, data: { title: "x" } });

    await probeVideo("dQw4w9WgXcQ");

    const [url, config] = mockGet.mock.calls[0] as [
      string,
      { timeout: number },
    ];
    // The inner "?v=" must be encoded, otherwise YouTube sees a truncated url
    // parameter and the probe answers about the wrong thing.
    expect(url).toBe(
      "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json"
    );
    expect(config.timeout).toBe(YOUTUBE_OEMBED_TIMEOUT_MS);
  });

  it("builds the playlist url from the playlist id", async () => {
    mockGet.mockResolvedValue({ status: 200, data: { title: "x" } });

    await probePlaylist("UUMOabc");

    expect(mockGet.mock.calls[0]?.[0]).toBe(
      "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fplaylist%3Flist%3DUUMOabc&format=json"
    );
  });

  it("reads 200 as present", async () => {
    mockGet.mockResolvedValue({ status: 200, data: { title: "x" } });

    await expect(probeVideo("abc")).resolves.toEqual({ kind: "present" });
  });

  it("reads 404 as absent", async () => {
    mockGet.mockRejectedValue(httpError(404));

    await expect(probeVideo("abc")).resolves.toEqual({ kind: "absent" });
  });

  it("reads 400 as absent as well, since a malformed id is not reachable", async () => {
    mockGet.mockRejectedValue(httpError(400));

    await expect(probeVideo("!!!")).resolves.toEqual({ kind: "absent" });
  });

  it("reads any other status as inconclusive rather than absent", async () => {
    mockGet.mockRejectedValue(httpError(503));

    const result = await probeVideo("abc");

    expect(result.kind).toBe("unknown");
  });

  it("reads a transport failure as inconclusive", async () => {
    mockGet.mockRejectedValue(new Error("socket hang up"));

    const result = await probeVideo("abc");

    expect(result).toEqual({ kind: "unknown", message: "socket hang up" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/components/youtube-discovery/oembed.spec.ts`
Expected: FAIL — cannot find module `./oembed.js`.

- [ ] **Step 3: Write the implementation**

Create `src/components/youtube-discovery/oembed.ts`:

```ts
import axios from "axios";
import { YOUTUBE_OEMBED_TIMEOUT_MS } from "../../constants.js";

const OEMBED_URL = "https://www.youtube.com/oembed";

/**
 * What one probe learned. `absent` and `unknown` are deliberately different:
 * only `absent` is an answer ("YouTube will not serve this"), while `unknown`
 * means the question was never answered, and callers must not treat the two
 * the same — a failed request is not evidence that a video is gone.
 */
export type OembedResult =
  | { kind: "present" }
  | { kind: "absent" }
  | { kind: "unknown"; message: string };

function oembedUrl(target: string): string {
  // URLSearchParams percent-encodes the nested "?v=" / "?list=", which a plain
  // template string would leave as a second query parameter.
  const params = new URLSearchParams({ url: target, format: "json" });
  return `${OEMBED_URL}?${params.toString()}`;
}

async function probe(target: string): Promise<OembedResult> {
  try {
    await axios.get(oembedUrl(target), {
      timeout: YOUTUBE_OEMBED_TIMEOUT_MS,
    });
    return { kind: "present" };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      // 404 is "no such video/playlist, or it is private"; 400 is a malformed
      // id. Neither is reachable, and neither will become reachable by asking
      // again, so both are a conclusive absence.
      if (status === 404 || status === 400) return { kind: "absent" };
      return { kind: "unknown", message: error.message };
    }
    return {
      kind: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Whether a video is currently reachable on YouTube. */
export function probeVideo(videoId: string): Promise<OembedResult> {
  return probe(`https://www.youtube.com/watch?v=${videoId}`);
}

/** Whether a playlist exists and is publicly addressable. */
export function probePlaylist(playlistId: string): Promise<OembedResult> {
  return probe(`https://www.youtube.com/playlist?list=${playlistId}`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/components/youtube-discovery/oembed.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/youtube-discovery/oembed.ts src/components/youtube-discovery/oembed.spec.ts
git commit -m "feat(discovery): classify oembed answers into present, absent and unknown"
```

---

### Task 5: Read a playlist through the Data API

**Files:**

- Modify: `src/modules/youtube.ts`
- Test: `src/modules/youtube.spec.ts` (append to the existing file)

- [ ] **Step 1: Extend the googleapis mock and write the failing tests**

In `src/modules/youtube.spec.ts`, add a `playlistItems` mock alongside the existing ones. Change the mock block near the top to:

```ts
const mockVideosList = jest.fn<() => Promise<unknown>>();
const mockChannelsList = jest.fn<() => Promise<unknown>>();
const mockPlaylistItemsList = jest.fn<() => Promise<unknown>>();
const mockYoutube = jest.fn(() => ({
  videos: { list: mockVideosList },
  channels: { list: mockChannelsList },
  playlistItems: { list: mockPlaylistItemsList },
}));
```

Extend the import of the module under test to include the new function:

```ts
const {
  getYoutubeApi,
  updateVideoFromYoutube,
  updateChannelFromYoutube,
  updateVideoFromPlaylist,
} = await import("./youtube.js");
```

Then append these tests:

```ts
describe("updateVideoFromPlaylist", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockPlaylistItemsList.mockReset();
  });

  function playlistItem(videoId: string) {
    return {
      snippet: {
        title: `Title ${videoId}`,
        // The channel that added the item to the playlist, which is NOT what
        // should be persisted.
        channelId: "UC-adder",
        videoOwnerChannelId: "UC-owner",
        // When it was added to the playlist, also not what should be persisted.
        publishedAt: "2020-01-01T00:00:00Z",
      },
      contentDetails: {
        videoId,
        videoPublishedAt: "2026-09-10T12:00:00Z",
      },
    };
  }

  it("asks for one page and disables retries in the request options", async () => {
    mockPlaylistItemsList.mockResolvedValue({ data: { items: [] } });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await updateVideoFromPlaylist("UUMOabc");

    const [params, options] = mockPlaylistItemsList.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(params).toEqual({
      part: ["snippet", "contentDetails"],
      playlistId: "UUMOabc",
      maxResults: 50,
    });
    // Retries must sit in the SECOND argument: googleapis builds its request
    // options from that one only, and anything left in the first argument is
    // sent to YouTube as a query parameter while retries keep happening.
    expect(options).toEqual({ retry: false });
  });

  it("maps the owner channel and the video publish time, not the playlist ones", async () => {
    mockPlaylistItemsList.mockResolvedValue({
      data: { items: [playlistItem("vid1")] },
    });
    const notice = jest
      .spyOn(VideoModel, "noticeUnknownVideos")
      .mockResolvedValue(undefined);

    await updateVideoFromPlaylist("UUMOabc");

    expect(notice.mock.calls[0]?.[0]).toEqual([
      {
        videoId: "vid1",
        title: "Title vid1",
        channelId: "UC-owner",
        publishedAt: new Date("2026-09-10T12:00:00Z"),
      },
    ]);
  });

  it("drops items that lack the fields a document requires", async () => {
    mockPlaylistItemsList.mockResolvedValue({
      data: {
        items: [
          playlistItem("vid1"),
          { snippet: { title: "No id" }, contentDetails: {} },
        ],
      },
    });
    const notice = jest
      .spyOn(VideoModel, "noticeUnknownVideos")
      .mockResolvedValue(undefined);

    await updateVideoFromPlaylist("UUMOabc");

    expect(
      (notice.mock.calls[0]?.[0] as { videoId: string }[]).map(
        (entry) => entry.videoId
      )
    ).toEqual(["vid1"]);
  });

  it("reports a 403 as quota exhaustion so the caller can stop the round", async () => {
    mockPlaylistItemsList.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { response: { status: 403 } })
    );

    await expect(updateVideoFromPlaylist("UUMOabc")).resolves.toEqual({
      ok: false,
      kind: "quotaExceeded",
      message: "Forbidden",
    });
  });

  it("reports a 404 playlist without claiming the quota is gone", async () => {
    mockPlaylistItemsList.mockRejectedValue(
      Object.assign(new Error("Not Found"), { response: { status: 404 } })
    );

    await expect(updateVideoFromPlaylist("UUMOabc")).resolves.toEqual({
      ok: false,
      kind: "notFound",
      message: "Not Found",
    });
  });

  it("reports any other failure as a plain error", async () => {
    mockPlaylistItemsList.mockRejectedValue(new Error("socket hang up"));

    await expect(updateVideoFromPlaylist("UUMOabc")).resolves.toEqual({
      ok: false,
      kind: "error",
      message: "socket hang up",
    });
  });

  it("returns ok when the page was read", async () => {
    mockPlaylistItemsList.mockResolvedValue({
      data: { items: [playlistItem("vid1")] },
    });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await expect(updateVideoFromPlaylist("UUMOabc")).resolves.toEqual({
      ok: true,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/modules/youtube.spec.ts -t "updateVideoFromPlaylist"`
Expected: FAIL — `updateVideoFromPlaylist is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/modules/youtube.ts`, add the import of the entry type by extending the existing `VideoModel` import line:

```ts
import VideoModel, {
  type DiscoveredVideo,
  type Video,
} from "../models/Video.js";
```

Then append this function:

```ts
/**
 * Result of reading one playlist page. Returned rather than thrown so a caller
 * looping over channels can tell "this one playlist is gone" apart from "the
 * whole key is out of quota", which is the only failure that should stop a
 * round.
 */
export type PlaylistScanResult =
  | { ok: true }
  | { ok: false; kind: "quotaExceeded"; message: string }
  | { ok: false; kind: "notFound"; message: string }
  | { ok: false; kind: "error"; message: string };

/**
 * Reads the first page of a playlist and creates whatever videos are new.
 *
 * Takes a playlist id, not a channel id: the playlist is the entire input, and
 * hardcoding one channel's members-only playlist would make the function
 * useless for any other playlist.
 *
 * Does NOT hydrate metadata. `playlistItems.list` carries no
 * liveStreamingDetails, duration, uploadStatus or statistics, so the videos are
 * created bare and the existing `crawler youtube update` job fills them in
 * within its fixed budget — which is what keeps this subsystem's quota cost a
 * constant instead of scaling with how much is discovered.
 */
export async function updateVideoFromPlaylist(
  playlistId: string
): Promise<PlaylistScanResult> {
  const youtube = getYoutubeApi();
  try {
    const response = await youtube.playlistItems.list(
      {
        part: ["snippet", "contentDetails"],
        playlistId,
        maxResults: 50,
      },
      // Retries belong in this second argument; googleapis assembles its
      // request options from it alone. They are off because every attempt costs
      // a quota unit even when it fails, and the rotation is already the retry
      // — a channel that fails keeps its place in line and comes back next lap.
      { retry: false }
    );

    const entries: DiscoveredVideo[] = [];
    for (const item of response?.data?.items ?? []) {
      const videoId = item.contentDetails?.videoId;
      const title = item.snippet?.title;
      // The owner of the video, not whoever added it to the playlist. For an
      // auto-generated uploads playlist these agree, but only this one is right
      // in general.
      const channelId = item.snippet?.videoOwnerChannelId;
      if (!videoId || !title || !channelId) continue;
      const publishedAt = item.contentDetails?.videoPublishedAt;
      entries.push({
        videoId,
        title,
        channelId,
        publishedAt: publishedAt ? new Date(publishedAt) : undefined,
      });
    }

    await VideoModel.noticeUnknownVideos(entries);
    return { ok: true };
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    const message = error instanceof Error ? error.message : String(error);
    // 403 from the Data API means the key cannot make this call at all — out of
    // quota, or restricted. Either way every following call in this round would
    // fail the same way, so it is reported distinctly. It is also not in
    // gaxios's retry range, so it arrives immediately rather than after three
    // silent retries.
    if (status === 403) return { ok: false, kind: "quotaExceeded", message };
    if (status === 404) return { ok: false, kind: "notFound", message };
    return { ok: false, kind: "error", message };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/modules/youtube.spec.ts`
Expected: PASS, including every pre-existing test in that file.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube.ts src/modules/youtube.spec.ts
git commit -m "feat(youtube): read a playlist page without retries and create new videos"
```

---

### Task 6: Feed poll round

**Files:**

- Create: `src/components/youtube-discovery/feed-poll.ts`
- Test: `src/components/youtube-discovery/feed-poll.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/components/youtube-discovery/feed-poll.spec.ts`:

```ts
/// <reference types="jest" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockGet = jest.fn<(url: string, config: unknown) => Promise<unknown>>();
const mockSleep = jest.fn<(ms: number) => Promise<void>>();

jest.unstable_mockModule("axios", () => ({
  default: { get: mockGet },
}));
jest.unstable_mockModule("node:timers/promises", () => ({
  setTimeout: mockSleep,
}));

const { default: ChannelModel } = await import("../../models/Channel.js");
const { default: VideoModel } = await import("../../models/Video.js");
const { pollChannelFeeds } = await import("./feed-poll.js");
const {
  YOUTUBE_FEED_POLL_BATCH_SIZE,
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_FEED_TIMEOUT_MS,
} = await import("../../constants.js");

function feedXml(channelId: string, videoIds: string[]): string {
  const entries = videoIds
    .map(
      (id) => `<entry>
        <yt:videoId>${id}</yt:videoId>
        <yt:channelId>${channelId}</yt:channelId>
        <title>Title ${id}</title>
        <published>2026-09-10T12:00:00+00:00</published>
      </entry>`
    )
    .join("");
  return `<?xml version="1.0"?>
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
          xmlns="http://www.w3.org/2005/Atom">
      <yt:channelId>${channelId}</yt:channelId>
      ${entries}
    </feed>`;
}

// A stateful stand-in for the channel collection: writes are recorded so a
// second round can be asserted to see the timestamps the first round left.
function fakeChannels(ids: string[]) {
  const stamped: { id: string; feedCrawledAt: Date }[] = [];
  jest
    .spyOn(ChannelModel, "findFeedPollCandidates")
    .mockImplementation((() =>
      Promise.resolve(
        ids
          .filter((id) => !stamped.some((write) => write.id === id))
          .map((id) => ({ id, name: `Channel ${id}` }))
      )) as never);
  jest.spyOn(ChannelModel, "updateOne").mockImplementation(((
    filter: { id: string },
    update: { $set: { feedCrawledAt: Date } }
  ) => {
    stamped.push({ id: filter.id, feedCrawledAt: update.$set.feedCrawledAt });
    return Promise.resolve({ acknowledged: true }) as never;
  }) as never);
  return stamped;
}

describe("pollChannelFeeds", () => {
  beforeEach(() => {
    mockSleep.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockGet.mockReset();
    mockSleep.mockReset();
  });

  it("requests the real channel feed url with a timeout", async () => {
    fakeChannels(["UC1"]);
    mockGet.mockResolvedValue({ data: feedXml("UC1", ["v1"]) });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    const [url, config] = mockGet.mock.calls[0] as [
      string,
      { timeout: number; responseType: string },
    ];
    // The pubsub topic url has an extra "/xml" segment and returns a 463-byte
    // static document with no entries — it must not be used here.
    expect(url).toBe("https://www.youtube.com/feeds/videos.xml?channel_id=UC1");
    expect(config.timeout).toBe(YOUTUBE_FEED_TIMEOUT_MS);
  });

  it("asks for one batch of the configured size", async () => {
    const spy = jest
      .spyOn(ChannelModel, "findFeedPollCandidates")
      .mockResolvedValue([] as never);

    await pollChannelFeeds();

    expect(spy.mock.calls.map((call) => call[0])).toEqual([
      YOUTUBE_FEED_POLL_BATCH_SIZE,
    ]);
  });

  it("hands every parsed entry to the discovery write path", async () => {
    fakeChannels(["UC1"]);
    mockGet.mockResolvedValue({ data: feedXml("UC1", ["v1", "v2"]) });
    const notice = jest
      .spyOn(VideoModel, "noticeUnknownVideos")
      .mockResolvedValue(undefined);

    await pollChannelFeeds();

    expect(notice.mock.calls[0]?.[0]).toEqual([
      {
        videoId: "v1",
        title: "Title v1",
        channelId: "UC1",
        publishedAt: new Date("2026-09-10T12:00:00.000Z"),
      },
      {
        videoId: "v2",
        title: "Title v2",
        channelId: "UC1",
        publishedAt: new Date("2026-09-10T12:00:00.000Z"),
      },
    ]);
  });

  it("never spends quota: discovery writes only, no videos.list", async () => {
    fakeChannels(["UC1"]);
    mockGet.mockResolvedValue({ data: feedXml("UC1", ["v1"]) });
    const notice = jest
      .spyOn(VideoModel, "noticeUnknownVideos")
      .mockResolvedValue(undefined);

    await pollChannelFeeds();

    // The whole quota argument rests on this: the round writes to the database
    // and stops. Hydration is the existing crawler job's fixed budget.
    expect(notice).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("spaces the requests and does not wait after the last one", async () => {
    fakeChannels(["UC1", "UC2", "UC3"]);
    mockGet.mockResolvedValue({ data: feedXml("UC1", []) });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    expect(mockSleep.mock.calls).toEqual([
      [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS],
      [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS],
    ]);
  });

  it("stamps a failing channel anyway so it cannot hold the front of the queue", async () => {
    const stamped = fakeChannels(["UC1", "UC2"]);
    mockGet
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue({ data: feedXml("UC2", []) });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    // Both were stamped, and the failure did not stop the round.
    expect(stamped.map((write) => write.id)).toEqual(["UC1", "UC2"]);

    // Second round: the fake drops already-stamped channels, standing in for
    // the real sort putting them last. UC1 must not come back immediately.
    mockGet.mockClear();
    await pollChannelFeeds();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("skips a body that is not a feed but still stamps the channel", async () => {
    const stamped = fakeChannels(["UC1"]);
    mockGet.mockResolvedValue({ data: "<html>nope</html>" });
    const notice = jest
      .spyOn(VideoModel, "noticeUnknownVideos")
      .mockResolvedValue(undefined);

    await pollChannelFeeds();

    expect(notice).not.toHaveBeenCalled();
    expect(stamped.map((write) => write.id)).toEqual(["UC1"]);
  });

  it("does nothing when no channel is due", async () => {
    fakeChannels([]);

    await pollChannelFeeds();

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSleep).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/components/youtube-discovery/feed-poll.spec.ts`
Expected: FAIL — cannot find module `./feed-poll.js`.

- [ ] **Step 3: Write the implementation**

Create `src/components/youtube-discovery/feed-poll.ts`:

```ts
import axios from "axios";
import { setTimeout as sleep } from "node:timers/promises";
import {
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_FEED_POLL_BATCH_SIZE,
  YOUTUBE_FEED_TIMEOUT_MS,
} from "../../constants.js";
import ChannelModel from "../../models/Channel.js";
import VideoModel, { type DiscoveredVideo } from "../../models/Video.js";
import { parseNotification } from "../../modules/youtube-pubsub/atom.js";

// Note the missing "/xml" compared with the pubsub topic url: that one is a
// static document describing the hub and carries no entries at all. This is the
// address of the real per-channel feed.
const FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";

/**
 * One feed-poll round: take the least recently fetched channels, read each
 * one's RSS feed, and create whatever videos are new.
 *
 * The batch size is a constant rather than a function of how many channels are
 * subscribed. That is what makes the outbound request rate predictable: more
 * channels stretch the rotation instead of widening each round.
 *
 * Reuses the pubsub notification parser — a notification body and this feed are
 * the same Atom document, and every entry carries the videoId, channelId, title
 * and published time a document needs.
 */
export async function pollChannelFeeds(): Promise<void> {
  const candidates = await ChannelModel.findFeedPollCandidates(
    YOUTUBE_FEED_POLL_BATCH_SIZE
  );

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];
    try {
      const response = await axios.get<string>(`${FEED_URL}${channel.id}`, {
        timeout: YOUTUBE_FEED_TIMEOUT_MS,
        // Without this axios would try to guess, and an XML body can come back
        // parsed into an object that the Atom parser cannot read.
        responseType: "text",
      });
      const entries = parseNotification(response.data);
      if (!entries) {
        console.warn(`Feed poll: body is not a feed for [${channel.id}]`);
      } else {
        const discovered: DiscoveredVideo[] = entries.flatMap((entry) =>
          entry.type === "video"
            ? [
                {
                  videoId: entry.videoId,
                  title: entry.title,
                  channelId: entry.channelId,
                  publishedAt: entry.published,
                },
              ]
            : []
        );
        await VideoModel.noticeUnknownVideos(discovered);
      }
    } catch (error) {
      // One channel's failure must not cost the rest of the round theirs.
      console.warn(`Feed poll failed for [${channel.id}]:`, error);
    }

    // Stamped whether or not anything above worked. A channel that always fails
    // would otherwise stay at the head of the rotation and consume a slot every
    // round forever; stamping drops it to the back instead.
    await ChannelModel.updateOne(
      { id: channel.id },
      { $set: { feedCrawledAt: new Date() } }
    );

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/components/youtube-discovery/feed-poll.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/youtube-discovery/feed-poll.ts src/components/youtube-discovery/feed-poll.spec.ts
git commit -m "feat(discovery): poll channel feeds and create the videos they carry"
```

---

### Task 7: Members poll round

**Files:**

- Create: `src/components/youtube-discovery/members-poll.ts`
- Test: `src/components/youtube-discovery/members-poll.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/components/youtube-discovery/members-poll.spec.ts`:

```ts
/// <reference types="jest" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

type OembedResult = Awaited<
  ReturnType<typeof import("./oembed.js").probePlaylist>
>;
type PlaylistScanResult = Awaited<
  ReturnType<typeof import("../../modules/youtube.js").updateVideoFromPlaylist>
>;

const mockProbePlaylist =
  jest.fn<(playlistId: string) => Promise<OembedResult>>();
const mockUpdateVideoFromPlaylist =
  jest.fn<(playlistId: string) => Promise<PlaylistScanResult>>();
const mockSleep = jest.fn<(ms: number) => Promise<void>>();

jest.unstable_mockModule("./oembed.js", () => ({
  probePlaylist: mockProbePlaylist,
  probeVideo: jest.fn(),
}));
jest.unstable_mockModule("../../modules/youtube.js", () => ({
  updateVideoFromPlaylist: mockUpdateVideoFromPlaylist,
}));
jest.unstable_mockModule("node:timers/promises", () => ({
  setTimeout: mockSleep,
}));

const { default: ChannelModel } = await import("../../models/Channel.js");
const { pollMembersPlaylists } = await import("./members-poll.js");
const {
  YOUTUBE_MEMBERS_POLL_BATCH_SIZE,
  YOUTUBE_MEMBERS_PROBE_BATCH_SIZE,
  YOUTUBE_MEMBERS_PROBE_TTL_MS,
  YOUTUBE_MEMBERS_PROBE_RETRY_MS,
} = await import("../../constants.js");

type ChannelRow = {
  id: string;
  hasMembersPlaylist?: boolean;
  membersProbeNextAt?: Date;
  membersCrawledAt?: Date;
};

// A stateful channel collection: the probe phase writes into it and the same
// data drives the candidate queries, so "is this channel eligible next round"
// is observable rather than assumed.
function fakeChannels(rows: ChannelRow[], now: () => Date) {
  const store = new Map(rows.map((row) => [row.id, { ...row }]));

  jest.spyOn(ChannelModel, "findMembersProbeCandidates").mockImplementation(((
    limit: number
  ) =>
    Promise.resolve(
      [...store.values()]
        .filter(
          (row) =>
            row.membersProbeNextAt == null || row.membersProbeNextAt < now()
        )
        .sort(
          (a, b) =>
            (a.membersProbeNextAt?.getTime() ?? 0) -
            (b.membersProbeNextAt?.getTime() ?? 0)
        )
        .slice(0, limit)
        .map((row) => ({ id: row.id }))
    )) as never);

  jest.spyOn(ChannelModel, "findMembersPollCandidates").mockImplementation(((
    limit: number
  ) =>
    Promise.resolve(
      [...store.values()]
        .filter((row) => row.hasMembersPlaylist === true)
        .slice(0, limit)
        .map((row) => ({ id: row.id }))
    )) as never);

  jest.spyOn(ChannelModel, "updateOne").mockImplementation(((
    filter: { id: string },
    update: { $set: Partial<ChannelRow> }
  ) => {
    Object.assign(store.get(filter.id) ?? {}, update.$set);
    return Promise.resolve({ acknowledged: true }) as never;
  }) as never);

  return store;
}

describe("pollMembersPlaylists", () => {
  const NOW = new Date("2026-09-18T00:00:00.000Z");
  let current = NOW;

  beforeEach(() => {
    current = NOW;
    jest.useFakeTimers({ doNotFake: ["performance"] });
    jest.setSystemTime(NOW);
    mockSleep.mockResolvedValue(undefined);
    mockUpdateVideoFromPlaylist.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    mockProbePlaylist.mockReset();
    mockUpdateVideoFromPlaylist.mockReset();
    mockSleep.mockReset();
  });

  it("derives the members playlist id from the channel id", async () => {
    fakeChannels([{ id: "UC-hM6YJuNYVAmUWxeIr9FeA" }], () => current);
    mockProbePlaylist.mockResolvedValue({ kind: "present" });

    await pollMembersPlaylists();

    expect(mockProbePlaylist.mock.calls[0]?.[0]).toBe(
      "UUMO-hM6YJuNYVAmUWxeIr9FeA"
    );
  });

  it("asks each phase for its own batch size", async () => {
    const probeSpy = jest
      .spyOn(ChannelModel, "findMembersProbeCandidates")
      .mockResolvedValue([] as never);
    const scanSpy = jest
      .spyOn(ChannelModel, "findMembersPollCandidates")
      .mockResolvedValue([] as never);

    await pollMembersPlaylists();

    expect(probeSpy.mock.calls[0]?.[0]).toBe(YOUTUBE_MEMBERS_PROBE_BATCH_SIZE);
    expect(scanSpy.mock.calls[0]?.[0]).toBe(YOUTUBE_MEMBERS_POLL_BATCH_SIZE);
  });

  it("caches a conclusive present answer for the full ttl", async () => {
    const store = fakeChannels([{ id: "UC1" }], () => current);
    mockProbePlaylist.mockResolvedValue({ kind: "present" });

    await pollMembersPlaylists();

    expect(store.get("UC1")?.hasMembersPlaylist).toBe(true);
    expect(store.get("UC1")?.membersProbeNextAt).toEqual(
      new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_TTL_MS)
    );
  });

  it("caches a conclusive absent answer and never spends quota on it", async () => {
    const store = fakeChannels([{ id: "UC1" }], () => current);
    mockProbePlaylist.mockResolvedValue({ kind: "absent" });

    await pollMembersPlaylists();

    expect(store.get("UC1")?.hasMembersPlaylist).toBe(false);
    expect(store.get("UC1")?.membersProbeNextAt).toEqual(
      new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_TTL_MS)
    );
    expect(mockUpdateVideoFromPlaylist).not.toHaveBeenCalled();
  });

  it("retries an inconclusive first probe in an hour, not in a week", async () => {
    const store = fakeChannels([{ id: "UC1" }], () => current);
    mockProbePlaylist.mockResolvedValue({
      kind: "unknown",
      message: "socket hang up",
    });

    await pollMembersPlaylists();

    // Still unknown, so the scan phase must keep ignoring it...
    expect(store.get("UC1")?.hasMembersPlaylist).toBeUndefined();
    // ...which is exactly why the retry may not be a week away: on first
    // rollout every channel takes this path.
    expect(store.get("UC1")?.membersProbeNextAt).toEqual(
      new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS)
    );

    current = new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS + 1);
    jest.setSystemTime(current);
    mockProbePlaylist.mockClear();

    await pollMembersPlaylists();

    expect(mockProbePlaylist).toHaveBeenCalledTimes(1);
  });

  it("does not renew a stale verdict when a re-probe fails", async () => {
    const store = fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: false,
          membersProbeNextAt: new Date(NOW.getTime() - 1),
        },
      ],
      () => current
    );
    mockProbePlaylist.mockResolvedValue({
      kind: "unknown",
      message: "503",
    });

    await pollMembersPlaylists();

    // An hour, not another week — otherwise repeated failures could keep an
    // expired "no memberships" answer alive indefinitely.
    expect(store.get("UC1")?.membersProbeNextAt).toEqual(
      new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS)
    );
    expect(store.get("UC1")?.hasMembersPlaylist).toBe(false);

    current = new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS + 1);
    jest.setSystemTime(current);
    mockProbePlaylist.mockClear();
    await pollMembersPlaylists();
    expect(mockProbePlaylist).toHaveBeenCalledTimes(1);

    current = new Date(current.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS + 1);
    jest.setSystemTime(current);
    mockProbePlaylist.mockClear();
    await pollMembersPlaylists();
    expect(mockProbePlaylist).toHaveBeenCalledTimes(1);
  });

  it("scans the playlists of channels already known to have one", async () => {
    const store = fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 60_000),
        },
      ],
      () => current
    );

    await pollMembersPlaylists();

    expect(
      mockUpdateVideoFromPlaylist.mock.calls.map((call) => call[0])
    ).toEqual(["UUMO1"]);
    expect(store.get("UC1")?.membersCrawledAt).toEqual(NOW);
  });

  it("stops the round on quota exhaustion but keeps what it already stamped", async () => {
    const store = fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
        {
          id: "UC2",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
        {
          id: "UC3",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
        {
          id: "UC4",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
      ],
      () => current
    );
    mockUpdateVideoFromPlaylist
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        kind: "quotaExceeded",
        message: "Forbidden",
      });

    await pollMembersPlaylists();

    expect(
      mockUpdateVideoFromPlaylist.mock.calls.map((call) => call[0])
    ).toEqual(["UUMO1", "UUMO2", "UUMO3"]);
    expect(store.get("UC1")?.membersCrawledAt).toEqual(NOW);
    expect(store.get("UC2")?.membersCrawledAt).toEqual(NOW);
    expect(store.get("UC3")?.membersCrawledAt).toEqual(NOW);
    expect(store.get("UC4")?.membersCrawledAt).toBeUndefined();
  });

  it("keeps going after a non-quota scan failure", async () => {
    const store = fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
        {
          id: "UC2",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
      ],
      () => current
    );
    mockUpdateVideoFromPlaylist
      .mockResolvedValueOnce({
        ok: false,
        kind: "notFound",
        message: "Not Found",
      })
      .mockResolvedValueOnce({ ok: true });

    await pollMembersPlaylists();

    expect(mockUpdateVideoFromPlaylist).toHaveBeenCalledTimes(2);
    expect(store.get("UC1")?.membersCrawledAt).toEqual(NOW);
    expect(store.get("UC2")?.membersCrawledAt).toEqual(NOW);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/components/youtube-discovery/members-poll.spec.ts`
Expected: FAIL — cannot find module `./members-poll.js`.

- [ ] **Step 3: Write the implementation**

Create `src/components/youtube-discovery/members-poll.ts`:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import {
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_MEMBERS_POLL_BATCH_SIZE,
  YOUTUBE_MEMBERS_PROBE_BATCH_SIZE,
  YOUTUBE_MEMBERS_PROBE_RETRY_MS,
  YOUTUBE_MEMBERS_PROBE_TTL_MS,
} from "../../constants.js";
import ChannelModel from "../../models/Channel.js";
import { updateVideoFromPlaylist } from "../../modules/youtube.js";
import { probePlaylist } from "./oembed.js";

/**
 * A channel's members-only uploads playlist id. YouTube derives it from the
 * channel id: UC<suffix> owns UU<suffix> for public uploads and UUMO<suffix>
 * for members-only ones.
 */
function membersPlaylistId(channelId: string): string {
  return `UUMO${channelId.slice(2)}`;
}

/**
 * Phase one: find out which channels have a members-only playlist at all.
 * Costs no quota, so it can run over every subscribed channel; its whole
 * purpose is to keep the quota-spending phase below from wasting slots on
 * channels that have no such playlist.
 */
async function probeRound(now: Date): Promise<void> {
  const candidates = await ChannelModel.findMembersProbeCandidates(
    YOUTUBE_MEMBERS_PROBE_BATCH_SIZE,
    now
  );

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];
    const result = await probePlaylist(membersPlaylistId(channel.id));

    // The deadline carries the answer's shelf life. A conclusive answer is
    // good for a week because whether a channel offers memberships almost
    // never changes. An inconclusive one taught us nothing, so it only defers
    // the question by an hour — the scan phase ignores channels with no
    // verdict, and on first rollout every channel starts without one, so a
    // week-long deferral here would hide a whole cohort's members-only videos
    // for a week after any transient outage.
    const update: { membersProbeNextAt: Date; hasMembersPlaylist?: boolean } =
      result.kind === "unknown"
        ? {
            membersProbeNextAt: new Date(
              now.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS
            ),
          }
        : {
            membersProbeNextAt: new Date(
              now.getTime() + YOUTUBE_MEMBERS_PROBE_TTL_MS
            ),
            hasMembersPlaylist: result.kind === "present",
          };

    await ChannelModel.updateOne({ id: channel.id }, { $set: update });

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}

/**
 * Phase two: read the members-only playlists. This is the only part of the
 * discovery subsystem that spends quota, one unit per channel, which is why the
 * batch size alone determines the daily cost.
 */
async function scanRound(now: Date): Promise<void> {
  const candidates = await ChannelModel.findMembersPollCandidates(
    YOUTUBE_MEMBERS_POLL_BATCH_SIZE
  );

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];
    const result = await updateVideoFromPlaylist(membersPlaylistId(channel.id));

    if (!result.ok && result.kind === "quotaExceeded") {
      // Quota is global state: every remaining channel would fail the same
      // way. Stop here and leave them for the next round with their timestamps
      // untouched, so they keep their place at the front of the rotation.
      console.warn(
        `Members poll stopped at [${channel.id}]: ${result.message}`
      );
      return;
    }
    if (!result.ok) {
      console.warn(
        `Members poll failed for [${channel.id}] (${result.kind}): ${result.message}`
      );
    }

    // Stamped on failure too, for the same reason the feed round does it: a
    // channel that always fails must drop to the back rather than reclaim a
    // slot every round.
    await ChannelModel.updateOne(
      { id: channel.id },
      { $set: { membersCrawledAt: now } }
    );

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}

/** One members round: probe for playlists that exist, then read the known ones. */
export async function pollMembersPlaylists(): Promise<void> {
  const now = new Date();
  await probeRound(now);
  await scanRound(now);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/components/youtube-discovery/members-poll.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/youtube-discovery/members-poll.ts src/components/youtube-discovery/members-poll.spec.ts
git commit -m "feat(discovery): probe for members playlists and scan the ones that exist"
```

---

### Task 8: Existence probe round

**Files:**

- Create: `src/components/youtube-discovery/existence-probe.ts`
- Test: `src/components/youtube-discovery/existence-probe.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/components/youtube-discovery/existence-probe.spec.ts`:

```ts
/// <reference types="jest" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { VideoStatus } from "holodex.js";

type OembedResult = Awaited<
  ReturnType<typeof import("./oembed.js").probeVideo>
>;

const mockProbeVideo = jest.fn<(videoId: string) => Promise<OembedResult>>();
const mockSleep = jest.fn<(ms: number) => Promise<void>>();

jest.unstable_mockModule("./oembed.js", () => ({
  probeVideo: mockProbeVideo,
  probePlaylist: jest.fn(),
}));
jest.unstable_mockModule("node:timers/promises", () => ({
  setTimeout: mockSleep,
}));

const { default: VideoModel } = await import("../../models/Video.js");
const { probeMissingVideos } = await import("./existence-probe.js");
const { YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE } =
  await import("../../constants.js");

const STAMP = new Date("2026-09-01T00:00:00.000Z");

// Records the update filters and payloads so the compare-and-set guard can be
// asserted directly rather than inferred.
function recordUpdates() {
  const updates: { filter: Record<string, unknown>; update: unknown }[] = [];
  jest.spyOn(VideoModel, "updateOne").mockImplementation(((
    filter: Record<string, unknown>,
    update: unknown
  ) => {
    updates.push({ filter, update });
    return Promise.resolve({ matchedCount: 1 }) as never;
  }) as never);
  return updates;
}

function stubBuckets(recent: string[], old: string[]) {
  jest
    .spyOn(VideoModel, "findExistenceProbeCandidates")
    .mockImplementation(((isRecent: boolean) =>
      Promise.resolve(
        (isRecent ? recent : old).map((id) => ({ id, crawledAt: STAMP }))
      )) as never);
}

describe("probeMissingVideos", () => {
  beforeEach(() => {
    mockSleep.mockResolvedValue(undefined);
    mockProbeVideo.mockResolvedValue({ kind: "absent" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockProbeVideo.mockReset();
    mockSleep.mockReset();
  });

  it("queries both buckets with the configured size", async () => {
    const spy = jest
      .spyOn(VideoModel, "findExistenceProbeCandidates")
      .mockResolvedValue([] as never);

    await probeMissingVideos();

    expect(spy.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [true, YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE],
      [false, YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE],
    ]);
  });

  it("fills one bucket even when the other is empty", async () => {
    stubBuckets([], ["old1", "old2"]);
    recordUpdates();

    await probeMissingVideos();

    expect(mockProbeVideo.mock.calls.map((call) => call[0])).toEqual([
      "old1",
      "old2",
    ]);
  });

  it("restores a video that answers 200 and asks for a fresh hydration", async () => {
    stubBuckets(["v1"], []);
    const updates = recordUpdates();
    mockProbeVideo.mockResolvedValue({ kind: "present" });

    await probeMissingVideos();

    expect(updates[0]?.update).toEqual({
      $set: { status: VideoStatus.New, crawledAt: null },
      $unset: { deleted: "", detectedDeletionAt: "" },
    });
  });

  it("only advances the timestamp when the video is still gone", async () => {
    stubBuckets(["v1"], []);
    const updates = recordUpdates();
    mockProbeVideo.mockResolvedValue({ kind: "absent" });

    await probeMissingVideos();

    const update = updates[0]?.update as { $set: Record<string, unknown> };
    expect(update.$set.status).toBeUndefined();
    expect(update.$set.crawledAt).toBeInstanceOf(Date);
  });

  it("pins every write to the state the candidate query returned", async () => {
    stubBuckets(["v1"], []);
    const updates = recordUpdates();

    await probeMissingVideos();

    // Without these three the result of a probe issued seconds ago could
    // overwrite a document somebody else has since restored or flagged for
    // re-hydration. Agenda's job lock does not serialise different writers.
    expect(updates[0]?.filter).toEqual({
      id: "v1",
      status: VideoStatus.Missing,
      deleted: true,
      crawledAt: STAMP,
    });
  });

  it("spaces the probes and does not wait after the last one", async () => {
    stubBuckets(["v1"], ["v2"]);
    recordUpdates();

    await probeMissingVideos();

    expect(mockSleep).toHaveBeenCalledTimes(1);
  });

  it("keeps going when one probe throws", async () => {
    stubBuckets(["v1", "v2"], []);
    recordUpdates();
    mockProbeVideo
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ kind: "absent" });

    await probeMissingVideos();

    expect(mockProbeVideo).toHaveBeenCalledTimes(2);
  });

  it("does nothing when neither bucket has a candidate", async () => {
    stubBuckets([], []);
    const updates = recordUpdates();

    await probeMissingVideos();

    expect(mockProbeVideo).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/components/youtube-discovery/existence-probe.spec.ts`
Expected: FAIL — cannot find module `./existence-probe.js`.

- [ ] **Step 3: Write the implementation**

Create `src/components/youtube-discovery/existence-probe.ts`:

```ts
import { VideoStatus } from "holodex.js";
import { setTimeout as sleep } from "node:timers/promises";
import {
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE,
} from "../../constants.js";
import VideoModel from "../../models/Video.js";
import { probeVideo } from "./oembed.js";

/**
 * One existence-probe round over both buckets.
 *
 * Only videos YouTube stopped returning are probed. The other way a video ends
 * up Missing is a timeout heuristic — a stream that never started, or one that
 * stopped without being ended — and those videos are still on YouTube, so an
 * existence probe would answer 200 every single time, flip them back to New,
 * and have the state machine put them straight back to Missing. Those go
 * through `crawler youtube update`'s candidate list instead, where videos.list
 * can actually see whether the stream changed.
 */
export async function probeMissingVideos(): Promise<void> {
  // Two buckets, because videos that vanished long ago vastly outnumber recent
  // ones and a single query would let them take every slot.
  const buckets = await Promise.all([
    VideoModel.findExistenceProbeCandidates(
      true,
      YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE
    ),
    VideoModel.findExistenceProbeCandidates(
      false,
      YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE
    ),
  ]);
  const candidates = buckets.flat();

  for (let index = 0; index < candidates.length; index++) {
    const video = candidates[index];
    try {
      const result = await probeVideo(video.id);

      // Pinned to the state the query returned. A probe takes a round trip, and
      // in that window pubsub can request a re-hydration or another path can
      // restore the video; writing unconditionally would erase either one.
      // No match means somebody else got there first with a newer view, so the
      // result is simply dropped.
      const filter = {
        id: video.id,
        status: VideoStatus.Missing,
        deleted: true,
        crawledAt: video.crawledAt,
      };

      if (result.kind === "present") {
        // Back to New with no crawledAt, which is how the existing crawler job
        // is asked to hydrate it.
        await VideoModel.updateOne(filter, {
          $set: { status: VideoStatus.New, crawledAt: null },
          $unset: { deleted: "", detectedDeletionAt: "" },
        });
      } else {
        // Still gone, or the question went unanswered. Either way it moves to
        // the back of the rotation.
        await VideoModel.updateOne(filter, {
          $set: { crawledAt: new Date() },
        });
      }
    } catch (error) {
      console.warn(`Existence probe failed for [${video.id}]:`, error);
    }

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/components/youtube-discovery/existence-probe.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/youtube-discovery/existence-probe.ts src/components/youtube-discovery/existence-probe.spec.ts
git commit -m "feat(discovery): probe deleted videos for a return and pin the write"
```

---

### Task 9: Wire the rounds into the crawler

**Files:**

- Modify: `src/commands/crawler.ts`

No new test file: this task only registers schedules and adds one query to an existing list. The round bodies are covered by Tasks 6-8, and the new query's behavior is asserted in Step 1 below against the real candidate-list code.

- [ ] **Step 1: Add the re-check query to the candidate list**

In `src/commands/crawler.ts`, inside `JOB_YOUTUBE_UPDATE_VIDEOS`, insert this entry into the `new Set<string>([...])` literal **between** the `findRecentlyEndedVideos(1)` block and the final `findLiveVideos()` block:

```ts
        // Streams a timeout heuristic marked Missing: the scheduled start came
        // and went, or the stream stopped without being ended. The video is
        // still on YouTube, so only videos.list can tell whether it has since
        // started or finally ended, and nothing else re-checks it — the one
        // query above that touches Missing is limited to hbEnd within the hour.
        // Two per round because the hit rate is low and the population large:
        // for most of them YouTube never does fill in actualEnd. It sits ahead
        // of the live query below because that one covers every upcoming and
        // live video and would otherwise fill the slice on its own, leaving
        // this with nothing.
        ...mapToId(
          await VideoModel.find({
            status: VideoStatus.Missing,
            deleted: { $in: [null, false] },
          })
            .sort({ crawledAt: 1 })
            .limit(2)
            .select("id")
        ),
```

- [ ] **Step 2: Verify the existing crawler still compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Register the three discovery jobs**

In `src/commands/crawler.ts`, add these imports alongside the existing ones:

```ts
import { pollChannelFeeds } from "../components/youtube-discovery/feed-poll.js";
import { pollMembersPlaylists } from "../components/youtube-discovery/members-poll.js";
import { probeMissingVideos } from "../components/youtube-discovery/existence-probe.js";
```

Then add this block at the end of the `//#region youtube` section, just before `//#endregion youtube`:

```ts
// None of these three set a lockLifetime or call job.touch(). Their worst
// cases are 3.4, 4.3 and 1.7 minutes — every request carries a timeout and
// retries are off — which stays well inside agenda's 10 minute default, the
// same reasoning the pubsub renewal job relies on.

const JOB_YOUTUBE_FEED_POLL = "crawler youtube feed poll";
agenda.define(JOB_YOUTUBE_FEED_POLL, async (_job: Job): Promise<void> => {
  await pollChannelFeeds();
});
// Two minutes covers 600 channels an hour, and the feed's own 15 minute edge
// cache means polling any single channel faster than that would return the
// same bytes anyway.
void agenda.every("2 minutes", JOB_YOUTUBE_FEED_POLL);

const JOB_YOUTUBE_MEMBERS_POLL = "crawler youtube members poll";
agenda.define(JOB_YOUTUBE_MEMBERS_POLL, async (_job: Job): Promise<void> => {
  await pollMembersPlaylists();
});
void agenda.every("5 minutes", JOB_YOUTUBE_MEMBERS_POLL);

const JOB_YOUTUBE_EXISTENCE_PROBE = "crawler youtube existence probe";
agenda.define(JOB_YOUTUBE_EXISTENCE_PROBE, async (_job: Job): Promise<void> => {
  await probeMissingVideos();
});
void agenda.every("5 minutes", JOB_YOUTUBE_EXISTENCE_PROBE);
```

- [ ] **Step 4: Verify types, lint and the whole suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: no type errors, no lint errors, all tests pass.

- [ ] **Step 5: Verify the build produces a runnable crawler**

Run: `npm run build`
Expected: build succeeds and `dist/commands/crawler.js` exists.

- [ ] **Step 6: Commit**

```bash
git add src/commands/crawler.ts
git commit -m "feat(crawler): schedule the discovery rounds and re-check stuck streams"
```

---

## Done When

- `npm test`, `npx tsc --noEmit`, `npm run lint` and `npm run build` all pass.
- `crawler youtube feed poll`, `crawler youtube members poll` and `crawler youtube existence probe` are defined and scheduled in `src/commands/crawler.ts`.
- The discovery path never calls `updateVideoFromYoutube` — the test in Task 6 Step 1 ("never spends quota") fails if anyone adds it back.
