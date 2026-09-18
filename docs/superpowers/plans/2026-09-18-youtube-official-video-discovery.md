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

| File                                                           | Responsibility                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/constants.ts` (modify)                                    | 10 new tuning constants                                                             |
| `src/models/Channel.ts` (modify)                               | 4 new optional fields, 3 new indexes, 3 new candidate-query statics                 |
| `src/models/Video.ts` (modify)                                 | 1 new partial index, `noticeUnknownVideos()`, `findExistenceProbeCandidates()`      |
| `src/components/youtube-discovery/oembed.ts` (create)          | Zero-quota existence probing: URL building, status-code classification              |
| `src/modules/youtube.ts` (modify)                              | `updateVideoFromPlaylist()` — the only new googleapis call site                     |
| `src/modules/youtube-playlist-transport.spec.ts` (create)      | Retry and error-body behavior, observed at the HTTP layer via `nock`                |
| `src/components/youtube-discovery/feed-poll.ts` (create)       | One feed-poll round                                                                 |
| `src/components/youtube-discovery/members-poll.ts` (create)    | One members round: probe phase then scan phase                                      |
| `src/components/youtube-discovery/existence-probe.ts` (create) | One existence-probe round over two buckets                                          |
| `src/commands/crawler.ts` (modify)                             | Register the three agenda jobs; lift the candidate list out and add the sixth query |
| `src/commands/crawler-candidates.spec.ts` (create)             | That the sixth query survives the 100-id cap, which depends on its position         |

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
    const calls: { and: unknown[]; sort: unknown[]; limit: number[] } = {
      and: [],
      sort: [],
      limit: [],
    };
    const chain: Record<string, unknown> = {};
    chain.and = (clauses: unknown[]) => {
      // Spread, so the recorded value is the list of clauses rather than a
      // list of calls each holding a list — the assertions below read as the
      // filter that reaches Mongo.
      calls.and.push(...clauses);
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

type StoredVideo = Record<string, unknown> & { id: string };

/**
 * A stateful collection whose `insertMany` reproduces the three behaviors this
 * code depends on, all of them confirmed against the installed mongoose:
 * documents other than the failing ones are still inserted under
 * `ordered: false`; a unique-index collision surfaces as a rejection carrying
 * `writeErrors[].code === 11000` plus `insertedDocs`; and schema validation runs
 * per document, so an invalid one is skipped while the rest go in.
 *
 * `onAfterFind` is the seam for the race: it fires once the difference query has
 * already answered, which is exactly the window where another writer can create
 * the same video.
 */
function fakeCollection(
  initial: StoredVideo[],
  onAfterFind?: (store: Map<string, StoredVideo>) => void
) {
  const store = new Map(initial.map((doc) => [doc.id, { ...doc }]));

  jest.spyOn(VideoModel, "find").mockImplementation(((filter: {
    id: { $in: string[] };
  }) => ({
    select: () => {
      const found = filter.id.$in
        .filter((id) => store.has(id))
        .map((id) => ({ id }));
      onAfterFind?.(store);
      return Promise.resolve(found);
    },
  })) as never);

  jest.spyOn(VideoModel, "insertMany").mockImplementation(((
    docs: StoredVideo[]
  ) => {
    const writeErrors: { code: number; index: number }[] = [];
    const insertedDocs: StoredVideo[] = [];
    docs.forEach((doc, index) => {
      // The schema marks title and channelId required, and mongoose validates
      // each document before inserting it. An invalid one is dropped without
      // taking the batch down with it.
      if (!doc.title || !doc.channelId) return;
      if (store.has(doc.id)) {
        writeErrors.push({ code: 11000, index });
        return;
      }
      store.set(doc.id, { ...doc });
      insertedDocs.push(doc);
    });
    if (writeErrors.length > 0) {
      return Promise.reject(
        Object.assign(new Error("E11000 duplicate key error"), {
          writeErrors,
          insertedDocs,
        })
      ) as never;
    }
    return Promise.resolve(insertedDocs) as never;
  }) as never);

  return store;
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

  it("inserts the rest of the batch when one row is a duplicate", async () => {
    // The difference query answers "neither is known", then another writer
    // creates aaa before the insert lands.
    const store = fakeCollection([], (current) => {
      current.set("aaa", { id: "aaa", title: "Already there" });
    });

    await expect(
      VideoModel.noticeUnknownVideos([ENTRY_A, ENTRY_B])
    ).resolves.toBeUndefined();

    // One collision must not cost the other row its insert.
    expect(store.has("bbb")).toBe(true);
    expect(store.size).toBe(2);
  });

  it("leaves an already-hydrated document completely alone", async () => {
    const hydrated = {
      id: "bbb",
      title: "Real title from videos.list",
      channelId: "UC1",
      status: VideoStatus.Past,
      crawledAt: new Date("2026-09-03T00:00:00.000Z"),
    };
    // The race in full: the difference query says bbb is unknown, and before
    // the insert runs, pubsub creates it and the crawler hydrates it.
    const store = fakeCollection([], (current) => {
      current.set("bbb", { ...hydrated });
    });

    await VideoModel.noticeUnknownVideos([ENTRY_B]);

    // An upsert would have reset crawledAt and overwritten the title here,
    // costing a redundant hydration. An insert simply loses the race.
    expect(store.get("bbb")).toEqual(hydrated);
  });

  it("refuses an entry with no title while its batch mates go in", async () => {
    const store = fakeCollection([]);

    await VideoModel.noticeUnknownVideos([
      { videoId: "ccc", title: "", channelId: "UC1" },
      ENTRY_B,
    ]);

    // Validators run on insert, unlike on every upsert path in this model. A
    // document like this one would otherwise be written and then fail every
    // save() it was ever part of.
    expect(store.has("ccc")).toBe(false);
    expect(store.has("bbb")).toBe(true);
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

  it("falls back to the current time only when the source omits one", async () => {
    const store = fakeCollection([]);

    await VideoModel.noticeUnknownVideos([
      { videoId: "ddd", title: "No date", channelId: "UC1" },
    ]);

    // availableAt is required with no default, so something has to go in. It is
    // a starting value that hydration overwrites; the source time is preferred
    // because it is indexed, and "now" is the only honest stand-in when the
    // source gave nothing.
    expect(store.get("ddd")?.availableAt).toBeInstanceOf(Date);
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

describe("Video.findMissingRecheckCandidates", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("selects the Missing videos the existence probe deliberately skips", async () => {
    const filters: unknown[] = [];
    const sorts: unknown[] = [];
    const limits: number[] = [];
    jest.spyOn(VideoModel, "find").mockImplementation(((filter: unknown) => {
      filters.push(filter);
      return {
        sort: (order: unknown) => {
          sorts.push(order);
          return {
            limit: (n: number) => {
              limits.push(n);
              return { select: () => Promise.resolve([]) };
            },
          };
        },
      };
    }) as never);

    await VideoModel.findMissingRecheckCandidates(2);

    // The complement of the probe's `deleted: true`: these videos are still on
    // YouTube, so only videos.list can tell whether the stream has since
    // started or finally ended. `$in: [null, false]` rather than `$ne: true`
    // keeps the equality shape the index can use, and matches documents where
    // the field was never written.
    expect(filters[0]).toEqual({
      status: VideoStatus.Missing,
      deleted: { $in: [null, false] },
    });
    expect(sorts[0]).toEqual({ crawledAt: 1 });
    expect(limits[0]).toBe(2);
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

  /**
   * The Missing videos the existence probe deliberately leaves alone: the ones
   * a timeout heuristic marked, whose `deleted` was never set because YouTube
   * still returns them.
   *
   * An oEmbed probe cannot help here — the video is there, so it would answer
   * 200 forever and bounce the document New → Missing on every rotation. Only
   * videos.list can see whether the stream finally started or ended, so these
   * join the hydration candidate list instead and never leave Missing until
   * something really changed.
   */
  public static findMissingRecheckCandidates(
    this: ReturnModelType<typeof Video>,
    limit: number
  ) {
    return this.find({
      status: VideoStatus.Missing,
      // `$in` rather than `$ne: true`, to keep the equality shape the index can
      // use; it also matches documents where the field was never written.
      deleted: { $in: [null, false] },
    })
      .sort({ crawledAt: 1 })
      .limit(limit);
  }
```

Add the constant import at the top of `src/models/Video.ts`, extending the existing import from `../constants.js` if one is present or adding it next to the other imports:

```ts
import { YOUTUBE_EXISTENCE_PROBE_RECENT_MS } from "../constants.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- src/models/Video.spec.ts`
Expected: PASS, 11 tests.

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

const mockGet = jest.fn<(url: string, config: unknown) => Promise<unknown>>();

jest.unstable_mockModule("axios", () => ({
  default: { get: mockGet },
}));

const { probeVideo, probePlaylist } = await import("./oembed.js");
const { YOUTUBE_OEMBED_TIMEOUT_MS } = await import("../../constants.js");

describe("oEmbed probing", () => {
  afterEach(() => {
    mockGet.mockReset();
  });

  it("percent-encodes the target url inside the query string", async () => {
    mockGet.mockResolvedValue({ status: 200, data: { title: "x" } });

    await probeVideo("dQw4w9WgXcQ");

    const [url, config] = mockGet.mock.calls[0] as [
      string,
      { timeout: number; validateStatus: (status: number) => boolean },
    ];
    // The inner "?v=" must be encoded, otherwise YouTube sees a truncated url
    // parameter and the probe answers about the wrong thing.
    expect(url).toBe(
      "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json"
    );
    expect(config.timeout).toBe(YOUTUBE_OEMBED_TIMEOUT_MS);
    // Every status resolves, so one place classifies them all.
    expect(config.validateStatus(404)).toBe(true);
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

  it("does not read a non-200 success as present", async () => {
    // axios resolves for every 2xx, but only 200 was ever observed from this
    // endpoint and only 200 means the target is really there. Treating a 204 as
    // presence would resurrect a video or grant a seven-day positive verdict on
    // no evidence.
    mockGet.mockResolvedValue({ status: 204, data: "" });

    const result = await probeVideo("abc");

    expect(result.kind).toBe("unknown");
  });

  it("reads 404 as absent", async () => {
    mockGet.mockResolvedValue({ status: 404, data: "Not Found" });

    await expect(probeVideo("abc")).resolves.toEqual({ kind: "absent" });
  });

  it("reads 400 as a separate invalid-id answer, not as absent", async () => {
    mockGet.mockResolvedValue({ status: 400, data: "Bad Request" });

    // 400 means the id itself is malformed. Its two callers need different
    // things from that: the video probe treats it as unreachable, while the
    // membership probe must not turn it into a lasting "no memberships"
    // verdict.
    await expect(probeVideo("!!!")).resolves.toEqual({ kind: "invalid" });
  });

  it("reads any other status as inconclusive rather than absent", async () => {
    mockGet.mockResolvedValue({ status: 503, data: "" });

    const result = await probeVideo("abc");

    expect(result.kind).toBe("unknown");
  });

  it("reads a transport failure as inconclusive", async () => {
    mockGet.mockRejectedValue(new Error("socket hang up"));

    const result = await probeVideo("abc");

    expect(result).toEqual({ kind: "unknown", message: "socket hang up" });
  });

  it("classifies playlist answers on the same four outcomes", async () => {
    mockGet.mockResolvedValue({ status: 200, data: { title: "x" } });
    await expect(probePlaylist("UUMOabc")).resolves.toEqual({
      kind: "present",
    });

    mockGet.mockResolvedValue({ status: 404, data: "Not Found" });
    await expect(probePlaylist("UUMOabc")).resolves.toEqual({
      kind: "absent",
    });

    mockGet.mockResolvedValue({ status: 400, data: "Bad Request" });
    await expect(probePlaylist("UUMOabc")).resolves.toEqual({
      kind: "invalid",
    });
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
 * What one probe learned. The four outcomes are kept apart because the two
 * callers need different things from them:
 *
 * - `present` — 200, and only 200. The target is really there.
 * - `absent`  — 404. A real answer: YouTube will not serve this.
 * - `invalid` — 400. The id is malformed. Unreachable like `absent`, but it
 *   says nothing about whether a *well-formed* id would have existed, so the
 *   membership probe must not turn it into a lasting verdict.
 * - `unknown` — anything else, including transport failures. The question went
 *   unanswered; a failed request is not evidence that anything is gone.
 */
export type OembedResult =
  | { kind: "present" }
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "unknown"; message: string };

function oembedUrl(target: string): string {
  // URLSearchParams percent-encodes the nested "?v=" / "?list=", which a plain
  // template string would leave as a second query parameter.
  const params = new URLSearchParams({ url: target, format: "json" });
  return `${OEMBED_URL}?${params.toString()}`;
}

async function probe(target: string): Promise<OembedResult> {
  try {
    const response = await axios.get(oembedUrl(target), {
      timeout: YOUTUBE_OEMBED_TIMEOUT_MS,
      // Resolve for every status so the classification below is the single
      // place that decides, instead of axios throwing for some and not others.
      validateStatus: () => true,
    });
    // Exactly 200. This endpoint has only ever been observed answering 200 for
    // a reachable target, and treating some other 2xx as presence would
    // resurrect a video or grant a week-long positive verdict on no evidence.
    if (response.status === 200) return { kind: "present" };
    if (response.status === 404) return { kind: "absent" };
    if (response.status === 400) return { kind: "invalid" };
    return {
      kind: "unknown",
      message: `unexpected status ${response.status}`,
    };
  } catch (error) {
    // With validateStatus above, reaching here means no response arrived at
    // all — a timeout, DNS failure, socket reset.
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
Expected: PASS, 9 tests.

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
- Test: `src/modules/youtube-playlist-transport.spec.ts` (create — the retry and
  error-body behavior cannot be observed through a mocked googleapis module)

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

  // gaxios sets `status` on the error as well as on `response`, and the
  // YouTube body puts the machine-readable reason in error.errors[0].reason.
  function apiError(status: number, reason?: string) {
    return Object.assign(new Error(`HTTP ${status}`), {
      status,
      response: {
        status,
        data: reason ? { error: { errors: [{ reason }] } } : undefined,
      },
    });
  }

  it.each(["quotaExceeded", "rateLimitExceeded"] as const)(
    "reports a 403 with reason %s as quota exhaustion",
    async (reason) => {
      mockPlaylistItemsList.mockRejectedValue(apiError(403, reason));

      await expect(updateVideoFromPlaylist("UUMOabc")).resolves.toEqual({
        ok: false,
        kind: "quotaExceeded",
        message: "HTTP 403",
      });
    }
  );

  it("does not call an unreadable playlist a quota failure", async () => {
    // Documented for this endpoint. It describes one playlist, not the key, so
    // treating it as quota exhaustion would abandon every channel behind it.
    mockPlaylistItemsList.mockRejectedValue(
      apiError(403, "playlistItemsNotAccessible")
    );

    const result = await updateVideoFromPlaylist("UUMOabc");

    expect(result).toEqual({
      ok: false,
      kind: "error",
      message: "HTTP 403",
    });
  });

  it("does not guess quota exhaustion from a 403 with no reason", async () => {
    mockPlaylistItemsList.mockRejectedValue(apiError(403));

    const result = await updateVideoFromPlaylist("UUMOabc");

    // Continuing wastes a few units at worst; stopping wrongly costs the round.
    expect(result).toEqual({
      ok: false,
      kind: "error",
      message: "HTTP 403",
    });
  });

  it("reports a 404 playlist without claiming the quota is gone", async () => {
    mockPlaylistItemsList.mockRejectedValue(apiError(404));

    await expect(updateVideoFromPlaylist("UUMOabc")).resolves.toEqual({
      ok: false,
      kind: "notFound",
      message: "HTTP 404",
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

- [ ] **Step 2: Write the transport-level retry test**

This needs its own file. `youtube.spec.ts` replaces the whole googleapis module,
which is precisely the machinery under test here — mocking `playlistItems.list`
proves the option was passed, not that it had any effect. `nock` intercepts at
Node's http layer instead, so the real client runs and every attempt it makes is
counted. `nock` 13.5.4 is already a devDependency (previously unused in this
repo).

Create `src/modules/youtube-playlist-transport.spec.ts`:

```ts
/// <reference types="jest" />
import { afterAll, afterEach, describe, expect, it, jest } from "@jest/globals";
import nock from "nock";

process.env.GOOGLE_API_KEY = "test-key";

const { default: VideoModel } = await import("../models/Video.js");
const { updateVideoFromPlaylist } = await import("./youtube.js");

const API_HOST = "https://youtube.googleapis.com";

describe("updateVideoFromPlaylist transport behavior", () => {
  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    nock.restore();
  });

  it("makes exactly one request when the endpoint keeps failing", async () => {
    let attempts = 0;
    // Four interceptors, but only one may be consumed. googleapis turns retries
    // on by default and gaxios retries a GET three times on 5xx, so without
    // `retry: false` this call would burn four quota units and take four
    // timeouts plus backoff instead of one.
    nock(API_HOST)
      .persist()
      .get("/youtube/v3/playlistItems")
      .query(true)
      .reply(() => {
        attempts++;
        return [503, { error: { code: 503, message: "Service Unavailable" } }];
      });

    const result = await updateVideoFromPlaylist("UUMOabc");

    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("reads a real 403 body down to the reason", async () => {
    nock(API_HOST)
      .get("/youtube/v3/playlistItems")
      .query(true)
      .reply(403, {
        error: {
          code: 403,
          message:
            "The request cannot be completed because you have exceeded your quota.",
          errors: [
            {
              domain: "youtube.quota",
              reason: "quotaExceeded",
              message:
                "The request cannot be completed because you have exceeded your quota.",
            },
          ],
        },
      });

    const result = await updateVideoFromPlaylist("UUMOabc");

    // Proves the property path against a body shaped like the real one, rather
    // than against a hand-built error object.
    expect(result).toMatchObject({ ok: false, kind: "quotaExceeded" });
  });

  it("does not abandon the round for an unreadable playlist", async () => {
    nock(API_HOST)
      .get("/youtube/v3/playlistItems")
      .query(true)
      .reply(403, {
        error: {
          code: 403,
          message: "The request is not properly authorized.",
          errors: [
            {
              domain: "youtube.playlistItem",
              reason: "playlistItemsNotAccessible",
              message: "The request is not properly authorized.",
            },
          ],
        },
      });

    const result = await updateVideoFromPlaylist("UUMOabc");

    expect(result).toMatchObject({ ok: false, kind: "error" });
  });

  it("creates the videos a successful page carries", async () => {
    const notice = jest
      .spyOn(VideoModel, "noticeUnknownVideos")
      .mockResolvedValue(undefined);
    nock(API_HOST)
      .get("/youtube/v3/playlistItems")
      .query(true)
      .reply(200, {
        items: [
          {
            snippet: {
              title: "Real title",
              videoOwnerChannelId: "UC-owner",
            },
            contentDetails: {
              videoId: "vid1",
              videoPublishedAt: "2026-09-10T12:00:00Z",
            },
          },
        ],
      });

    const result = await updateVideoFromPlaylist("UUMOabc");

    expect(result).toEqual({ ok: true });
    expect(notice.mock.calls[0]?.[0]).toEqual([
      {
        videoId: "vid1",
        title: "Real title",
        channelId: "UC-owner",
        publishedAt: new Date("2026-09-10T12:00:00Z"),
      },
    ]);
  });
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `npm run test -- src/modules/youtube.spec.ts src/modules/youtube-playlist-transport.spec.ts`
Expected: FAIL — `updateVideoFromPlaylist is not a function`.

- [ ] **Step 4: Write the implementation**

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
    // gaxios puts the status on the error itself as well as on the response,
    // and googleapis-common passes its errors through unwrapped.
    const failure = error as {
      status?: number;
      response?: {
        status?: number;
        data?: { error?: { errors?: { reason?: string }[] } };
      };
    };
    const status = failure.status ?? failure.response?.status;
    const reason = failure.response?.data?.error?.errors?.[0]?.reason;
    const message = error instanceof Error ? error.message : String(error);

    // Not every 403 is a dead key. This endpoint documents
    // `playlistItemsNotAccessible` for a playlist the caller may not read,
    // which says nothing about the remaining channels — only the reasons that
    // describe an exhausted budget justify abandoning the round. Anything
    // unrecognised is reported as an ordinary failure: continuing then costs a
    // few wasted units at worst, whereas stopping on a single unreadable
    // playlist would silently halve a round's coverage.
    if (
      status === 403 &&
      (reason === "quotaExceeded" || reason === "rateLimitExceeded")
    ) {
      return { ok: false, kind: "quotaExceeded", message };
    }
    if (status === 404) return { ok: false, kind: "notFound", message };
    return { ok: false, kind: "error", message };
  }
}
```

- [ ] **Step 5: Run both test files to verify they pass**

Run: `npm run test -- src/modules/youtube.spec.ts src/modules/youtube-playlist-transport.spec.ts`
Expected: PASS, including every pre-existing test in `youtube.spec.ts`.

If the transport file reports more than one attempt, `retry: false` is in the
wrong argument — it belongs in the second one, and anything left in the first is
sent to YouTube as a query parameter while retries carry on.

- [ ] **Step 6: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/youtube.ts src/modules/youtube.spec.ts src/modules/youtube-playlist-transport.spec.ts
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

// Reached by VideoModel -> ChannelModel -> constants.ts at module-eval time.
process.env.GOOGLE_API_KEY = "test-key";

const mockGet = jest.fn<(url: string, config: unknown) => Promise<unknown>>();
const mockSleep = jest.fn<(ms: number) => Promise<void>>();
const mockVideosList = jest.fn<() => Promise<unknown>>();
// The Data API client factory. Nothing in this round may build one, so it is
// mocked purely to be asserted against.
const mockYoutube = jest.fn(() => ({
  videos: { list: mockVideosList },
  channels: { list: jest.fn() },
  playlistItems: { list: jest.fn() },
}));

jest.unstable_mockModule("axios", () => ({
  default: { get: mockGet },
}));
jest.unstable_mockModule("node:timers/promises", () => ({
  setTimeout: mockSleep,
}));
jest.unstable_mockModule("googleapis", () => ({
  google: { youtube: mockYoutube },
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

  it("never spends quota: no Data API client is ever built", async () => {
    fakeChannels(["UC1"]);
    mockGet.mockResolvedValue({ data: feedXml("UC1", ["v1"]) });
    // Deliberately NOT mocking noticeUnknownVideos: the real writer runs, with
    // only the database calls underneath it stubbed. Mocking the writer would
    // hide hydration added inside it, which is one of the two places it could
    // creep back in.
    jest.spyOn(VideoModel, "find").mockReturnValue({
      select: () => Promise.resolve([]),
    } as never);
    const insertMany = jest
      .spyOn(VideoModel, "insertMany")
      .mockResolvedValue([] as never);

    await pollChannelFeeds();

    // The whole quota argument of this design rests on the discovery path
    // writing to the database and stopping there. Asserting at the googleapis
    // boundary is what makes the check real: every route back to the Data API —
    // importing updateVideoFromYoutube here or calling it inside the writer —
    // goes through getYoutubeApi(), which builds the client via
    // google.youtube(). Zero constructions means zero units.
    expect(mockYoutube).not.toHaveBeenCalled();
    expect(mockVideosList).not.toHaveBeenCalled();
    // And the round did reach the write, so the assertion above is about a path
    // that actually ran rather than one that was never entered.
    expect(insertMany).toHaveBeenCalledTimes(1);
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

  it("keeps going when stamping one channel rejects", async () => {
    fakeChannels(["UC1", "UC2"]);
    mockGet.mockResolvedValue({ data: feedXml("UC1", []) });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);
    // The stamp is a separate write from the fetch, and its failure has its own
    // blast radius: unguarded, one rejected update ends the round and every
    // channel behind this one loses its turn.
    jest
      .spyOn(ChannelModel, "updateOne")
      .mockRejectedValueOnce(new Error("write concern error") as never)
      .mockResolvedValue({ acknowledged: true } as never);

    await pollChannelFeeds();

    expect(mockGet).toHaveBeenCalledTimes(2);
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

    // Its own try, for two reasons. It must run even when the block above threw
    // — a channel that always fails would otherwise stay at the head of the
    // rotation and consume a slot every round forever — and its own failure
    // must not escape either, or one rejected write would end the round and
    // skip every channel behind this one.
    try {
      await ChannelModel.updateOne(
        { id: channel.id },
        { $set: { feedCrawledAt: new Date() } }
      );
    } catch (error) {
      console.warn(`Feed poll could not stamp [${channel.id}]:`, error);
    }

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/components/youtube-discovery/feed-poll.spec.ts`
Expected: PASS, 9 tests.

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

  it.each(["present", "absent"] as const)(
    "does not re-probe a %s answer before the ttl expires",
    async (kind) => {
      fakeChannels([{ id: "UC1" }], () => current);
      mockProbePlaylist.mockResolvedValue({ kind });

      await pollMembersPlaylists();
      expect(mockProbePlaylist).toHaveBeenCalledTimes(1);

      // One second short of the deadline: still cached.
      current = new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_TTL_MS - 1000);
      jest.setSystemTime(current);
      mockProbePlaylist.mockClear();

      await pollMembersPlaylists();

      expect(mockProbePlaylist).not.toHaveBeenCalled();
    }
  );

  it("treats a malformed-id answer as inconclusive, not as a verdict", async () => {
    const store = fakeChannels([{ id: "UC1" }], () => current);
    // 400 says the id was rejected, which is not the same as "this channel has
    // no members playlist" — writing false here would suppress scanning for a
    // week on no evidence.
    mockProbePlaylist.mockResolvedValue({ kind: "invalid" });

    await pollMembersPlaylists();

    expect(store.get("UC1")?.hasMembersPlaylist).toBeUndefined();
    expect(store.get("UC1")?.membersProbeNextAt).toEqual(
      new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS)
    );
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

  it("keeps going when a timestamp write rejects", async () => {
    fakeChannels(
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
    // A database hiccup on one channel's write must not cost every channel
    // behind it its turn.
    jest
      .spyOn(ChannelModel, "updateOne")
      .mockRejectedValueOnce(new Error("write concern error") as never)
      .mockResolvedValue({ acknowledged: true } as never);

    await pollMembersPlaylists();

    expect(mockUpdateVideoFromPlaylist).toHaveBeenCalledTimes(2);
  });

  it("spaces requests across the phase boundary as well as inside a phase", async () => {
    fakeChannels(
      [
        { id: "UC1", hasMembersPlaylist: true },
        { id: "UC2", hasMembersPlaylist: true },
      ],
      () => current
    );
    mockProbePlaylist.mockResolvedValue({ kind: "present" });

    await pollMembersPlaylists();

    // Two probes and two scans: one gap inside each phase, one across the seam
    // between them. Both phases send from the same process, so the seam counts.
    expect(mockSleep).toHaveBeenCalledTimes(3);
  });

  it("does not pause on the phase boundary when nothing was probed", async () => {
    fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
      ],
      () => current
    );

    await pollMembersPlaylists();

    expect(mockProbePlaylist).not.toHaveBeenCalled();
    expect(mockSleep).not.toHaveBeenCalled();
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
async function probeRound(now: Date): Promise<number> {
  const candidates = await ChannelModel.findMembersProbeCandidates(
    YOUTUBE_MEMBERS_PROBE_BATCH_SIZE,
    now
  );

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];
    try {
      const result = await probePlaylist(membersPlaylistId(channel.id));

      // The deadline carries the answer's shelf life. Only `present` and
      // `absent` are answers, and they are good for a week because whether a
      // channel offers memberships almost never changes.
      //
      // Everything else — a malformed-id 400, a 5xx, a timeout — taught us
      // nothing, so it may only defer the question by an hour and must leave
      // any existing verdict alone. Both halves matter: the scan phase ignores
      // channels without a `true` verdict, so a week-long deferral would hide a
      // channel's members-only videos for a week after one transient failure,
      // and on first rollout every channel takes exactly that path. Writing a
      // verdict here instead would be worse still — repeated failures could
      // keep renewing an expired "no memberships" answer indefinitely.
      const conclusive = result.kind === "present" || result.kind === "absent";
      const update: { membersProbeNextAt: Date; hasMembersPlaylist?: boolean } =
        conclusive
          ? {
              membersProbeNextAt: new Date(
                now.getTime() + YOUTUBE_MEMBERS_PROBE_TTL_MS
              ),
              hasMembersPlaylist: result.kind === "present",
            }
          : {
              membersProbeNextAt: new Date(
                now.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS
              ),
            };

      await ChannelModel.updateOne({ id: channel.id }, { $set: update });
    } catch (error) {
      // Covers the write as well as the probe: a rejected update must not cost
      // the remaining candidates their turn.
      console.warn(`Members probe failed for [${channel.id}]:`, error);
    }

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }

  return candidates.length;
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
    let outOfQuota = false;
    try {
      const result = await updateVideoFromPlaylist(
        membersPlaylistId(channel.id)
      );

      if (!result.ok && result.kind === "quotaExceeded") {
        // Quota is global state: every remaining channel would fail the same
        // way, so the round stops after this one.
        console.warn(
          `Members poll stopped at [${channel.id}]: ${result.message}`
        );
        outOfQuota = true;
      } else if (!result.ok) {
        console.warn(
          `Members poll failed for [${channel.id}] (${result.kind}): ${result.message}`
        );
      }

      // Stamped on every outcome, the quota one included. This channel was
      // attempted and its unit is already spent, so it must move to the back of
      // the rotation like any other; only the channels never reached keep their
      // place at the front.
      await ChannelModel.updateOne(
        { id: channel.id },
        { $set: { membersCrawledAt: now } }
      );
    } catch (error) {
      // Covers the write as well as the scan, for the same reason as above.
      console.warn(`Members poll failed for [${channel.id}]:`, error);
    }

    if (outOfQuota) return;

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}

/** One members round: probe for playlists that exist, then read the known ones. */
export async function pollMembersPlaylists(): Promise<void> {
  const now = new Date();
  const probed = await probeRound(now);
  // The two phases hit different hosts but share this process's outbound
  // budget, so the gap applies across the seam too when both actually sent
  // something.
  if (probed > 0) await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
  await scanRound(now);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/components/youtube-discovery/members-poll.spec.ts`
Expected: PASS, 15 tests (the TTL case runs twice via `it.each`).

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
const RECENT_AVAILABLE = new Date("2026-09-17T00:00:00.000Z");
const OLD_AVAILABLE = new Date("2024-01-01T00:00:00.000Z");

type VideoDoc = Record<string, unknown> & { id: string };

// Enough of Mongo's comparison semantics for the filters this module builds.
// Keeping it this small is deliberate: it only needs to cover equality plus the
// three operators the candidate query and the guarded write actually use.
function matches(doc: VideoDoc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = doc[key];
    if (
      condition &&
      typeof condition === "object" &&
      !(condition instanceof Date)
    ) {
      const operators = condition as Record<string, unknown>;
      if ("$ne" in operators) return value !== operators.$ne;
      if ("$gte" in operators) {
        return value instanceof Date && value >= (operators.$gte as Date);
      }
      if ("$lt" in operators) {
        return value instanceof Date && value < (operators.$lt as Date);
      }
    }
    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }
    // A null condition matches a missing field too, as Mongo does.
    if (condition === null) return value === null || value === undefined;
    return value === condition;
  });
}

function applyUpdate(doc: VideoDoc, update: Record<string, unknown>): void {
  const set = update.$set as Record<string, unknown> | undefined;
  const unset = update.$unset as Record<string, unknown> | undefined;
  if (set) Object.assign(doc, set);
  if (unset) for (const key of Object.keys(unset)) delete doc[key];
}

/**
 * A stateful videos collection that honours the filters it is given. The real
 * candidate query runs against it, so the exclusion rules are exercised rather
 * than stubbed away, and `updateOne` only writes when its filter still matches
 * — which is the whole point of the guarded write.
 *
 * Reads return **detached copies**. A real query hands back a snapshot, and the
 * distinction is load-bearing here: the race tests mutate the stored document
 * while a probe is in flight, and if the candidate were the same object it
 * would change underneath the caller, so the guard would compare the new state
 * against itself and match — hiding the very bug these tests exist to catch.
 */
function fakeVideos(docs: VideoDoc[]) {
  const store = new Map(docs.map((doc) => [doc.id, { ...doc }]));

  jest.spyOn(VideoModel, "find").mockImplementation(((
    filter: Record<string, unknown>
  ) => ({
    sort: () => ({
      limit: (n: number) => ({
        select: () =>
          Promise.resolve(
            [...store.values()]
              .filter((doc) => matches(doc, filter))
              .sort(
                (a, b) =>
                  ((a.crawledAt as Date | undefined)?.getTime() ?? 0) -
                  ((b.crawledAt as Date | undefined)?.getTime() ?? 0)
              )
              .slice(0, n)
              // Detached, so a later mutation of the stored document cannot
              // reach back into the candidate the caller is holding.
              .map((doc) => ({ ...doc }))
          ),
      }),
    }),
  })) as never);

  jest.spyOn(VideoModel, "updateOne").mockImplementation(((
    filter: Record<string, unknown>,
    update: Record<string, unknown>
  ) => {
    const doc = store.get(filter.id as string);
    if (!doc || !matches(doc, filter)) {
      return Promise.resolve({ matchedCount: 0 }) as never;
    }
    applyUpdate(doc, update);
    return Promise.resolve({ matchedCount: 1 }) as never;
  }) as never);

  return store;
}

/** A deleted Missing video, the only kind this round is allowed to probe. */
function deletedMissing(id: string, availableAt: Date): VideoDoc {
  return {
    id,
    status: VideoStatus.Missing,
    deleted: true,
    detectedDeletionAt: STAMP,
    availableAt,
    crawledAt: STAMP,
  };
}

describe("probeMissingVideos", () => {
  beforeEach(() => {
    // The bucket split is "now minus fourteen days", so the fixtures below only
    // land in the buckets they are named for while the clock is held here.
    // Without this the suite would start failing once the real date moved past
    // RECENT_AVAILABLE's two-week window.
    jest.useFakeTimers({ doNotFake: ["performance"] });
    jest.setSystemTime(new Date("2026-09-18T00:00:00.000Z"));
    mockSleep.mockResolvedValue(undefined);
    mockProbeVideo.mockResolvedValue({ kind: "absent" });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    mockProbeVideo.mockReset();
    mockSleep.mockReset();
  });

  it("gives each bucket its own allocation", async () => {
    // Six recent and six old, against a bucket size of five: if the two
    // queries shared one allocation the older, far larger population would take
    // every slot and recent disappearances would never be probed.
    const recent = Array.from({ length: 6 }, (_, i) =>
      deletedMissing(`r${i}`, RECENT_AVAILABLE)
    );
    const old = Array.from({ length: 6 }, (_, i) =>
      deletedMissing(`o${i}`, OLD_AVAILABLE)
    );
    fakeVideos([...recent, ...old]);

    await probeMissingVideos();

    const probed = mockProbeVideo.mock.calls.map((call) => call[0]);
    expect(probed.filter((id) => id.startsWith("r"))).toHaveLength(
      YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE
    );
    expect(probed.filter((id) => id.startsWith("o"))).toHaveLength(
      YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE
    );
  });

  it("fills one bucket even when the other is empty", async () => {
    fakeVideos([
      deletedMissing("old1", OLD_AVAILABLE),
      deletedMissing("old2", OLD_AVAILABLE),
    ]);

    await probeMissingVideos();

    expect(mockProbeVideo.mock.calls.map((call) => call[0]).sort()).toEqual([
      "old1",
      "old2",
    ]);
  });

  it("never probes a video a timeout heuristic marked Missing", async () => {
    const store = fakeVideos([
      {
        id: "heuristic",
        status: VideoStatus.Missing,
        // No `deleted`: the stream is still on YouTube, so oEmbed would answer
        // 200 every time and the video would bounce New -> Missing forever.
        availableAt: RECENT_AVAILABLE,
        crawledAt: STAMP,
      },
    ]);

    await probeMissingVideos();

    expect(mockProbeVideo).not.toHaveBeenCalled();
    expect(store.get("heuristic")?.status).toBe(VideoStatus.Missing);
    expect(store.get("heuristic")?.crawledAt).toEqual(STAMP);
  });

  it("never probes a video that is already waiting for hydration", async () => {
    const store = fakeVideos([
      {
        ...deletedMissing("pending", RECENT_AVAILABLE),
        // A null crawledAt is pubsub's way of asking for a refresh. It also
        // sorts first, so without the exclusion this document would be the very
        // one the probe grabs — and a 404 would erase the request.
        crawledAt: null,
      },
    ]);

    await probeMissingVideos();

    expect(mockProbeVideo).not.toHaveBeenCalled();
    expect(store.get("pending")?.crawledAt).toBeNull();
  });

  it("restores a video that answers 200 and asks for a fresh hydration", async () => {
    const store = fakeVideos([deletedMissing("v1", RECENT_AVAILABLE)]);
    mockProbeVideo.mockResolvedValue({ kind: "present" });

    await probeMissingVideos();

    const doc = store.get("v1");
    expect(doc?.status).toBe(VideoStatus.New);
    expect(doc?.crawledAt).toBeNull();
    expect(doc).not.toHaveProperty("deleted");
    expect(doc).not.toHaveProperty("detectedDeletionAt");
  });

  it.each(["absent", "invalid", "unknown"] as const)(
    "only advances the timestamp for a %s answer",
    async (kind) => {
      const store = fakeVideos([deletedMissing("v1", RECENT_AVAILABLE)]);
      mockProbeVideo.mockResolvedValue(
        kind === "unknown" ? { kind, message: "503" } : { kind }
      );

      await probeMissingVideos();

      const doc = store.get("v1");
      expect(doc?.status).toBe(VideoStatus.Missing);
      expect(doc?.deleted).toBe(true);
      expect(doc?.crawledAt).toBeInstanceOf(Date);
      expect(doc?.crawledAt).not.toEqual(STAMP);
    }
  );

  it("drops a stale absent result rather than erasing a new refresh request", async () => {
    const store = fakeVideos([deletedMissing("v1", RECENT_AVAILABLE)]);
    // Between selection and the answer, pubsub re-announces the video and asks
    // for a refresh. The probe's own view is now out of date.
    mockProbeVideo.mockImplementation(() => {
      const doc = store.get("v1");
      if (doc) doc.crawledAt = null;
      return Promise.resolve({ kind: "absent" as const });
    });

    await probeMissingVideos();

    // The request survives; without the pinned filter the probe would have
    // written its own timestamp over it and the video would wait a whole
    // rotation — possibly weeks — to be looked at again.
    expect(store.get("v1")?.crawledAt).toBeNull();
  });

  it("drops a stale present result rather than reverting a restored video", async () => {
    const store = fakeVideos([deletedMissing("v1", RECENT_AVAILABLE)]);
    // Between selection and the answer, the video was hydrated and is now Past.
    mockProbeVideo.mockImplementation(() => {
      const doc = store.get("v1");
      if (doc) {
        doc.status = VideoStatus.Past;
        delete doc.deleted;
      }
      return Promise.resolve({ kind: "present" as const });
    });

    await probeMissingVideos();

    expect(store.get("v1")?.status).toBe(VideoStatus.Past);
  });

  it("spaces the probes and does not wait after the last one", async () => {
    fakeVideos([
      deletedMissing("v1", RECENT_AVAILABLE),
      deletedMissing("v2", OLD_AVAILABLE),
    ]);

    await probeMissingVideos();

    expect(mockSleep).toHaveBeenCalledTimes(1);
  });

  it("advances the timestamp even when the probe itself throws", async () => {
    const store = fakeVideos([
      deletedMissing("v1", RECENT_AVAILABLE),
      deletedMissing("v2", OLD_AVAILABLE),
    ]);
    mockProbeVideo
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ kind: "absent" });

    await probeMissingVideos();

    // Both were attempted, and the thrown one still moved to the back of the
    // rotation instead of reclaiming a slot every round.
    expect(mockProbeVideo).toHaveBeenCalledTimes(2);
    expect(store.get("v1")?.crawledAt).not.toEqual(STAMP);
  });

  it("keeps going when one write rejects", async () => {
    fakeVideos([
      deletedMissing("v1", RECENT_AVAILABLE),
      deletedMissing("v2", OLD_AVAILABLE),
    ]);
    const update = jest.spyOn(VideoModel, "updateOne");
    const original = update.getMockImplementation();
    update
      .mockRejectedValueOnce(new Error("write concern error") as never)
      .mockImplementation(original as never);

    await probeMissingVideos();

    // A rejected write must cost only its own candidate, not every candidate
    // behind it.
    expect(mockProbeVideo).toHaveBeenCalledTimes(2);
  });

  it("does nothing when neither bucket has a candidate", async () => {
    fakeVideos([]);

    await probeMissingVideos();

    expect(mockProbeVideo).not.toHaveBeenCalled();
    expect(mockSleep).not.toHaveBeenCalled();
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
  // One `now` for both queries, so the two buckets are split on exactly the
  // same boundary and no video can fall between them.
  const now = new Date();
  // Two buckets, because videos that vanished long ago vastly outnumber recent
  // ones and a single query would let them take every slot.
  const buckets = await Promise.all([
    VideoModel.findExistenceProbeCandidates(
      true,
      YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE,
      now
    ),
    VideoModel.findExistenceProbeCandidates(
      false,
      YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE,
      now
    ),
  ]);
  const candidates = buckets.flat();

  for (let index = 0; index < candidates.length; index++) {
    const video = candidates[index];

    // Only a 200 is evidence the video came back. Everything else — still
    // missing, malformed id, unanswered question, or a probe that threw — means
    // the same thing here: nothing to restore, so just move it to the back of
    // the rotation.
    let restore = false;
    try {
      restore = (await probeVideo(video.id)).kind === "present";
    } catch (error) {
      console.warn(`Existence probe failed for [${video.id}]:`, error);
    }

    // Pinned to the state the query returned. A probe takes a round trip, and
    // in that window pubsub can request a re-hydration or another path can
    // restore the video; writing unconditionally would erase either one. No
    // match means somebody else got there first with a newer view, so the
    // result is simply dropped rather than retried.
    const filter = {
      id: video.id,
      status: VideoStatus.Missing,
      deleted: true,
      crawledAt: video.crawledAt,
    };

    try {
      await VideoModel.updateOne(
        filter,
        restore
          ? {
              // Back to New with no crawledAt, which is how the existing
              // crawler job is asked to hydrate it.
              $set: { status: VideoStatus.New, crawledAt: null },
              $unset: { deleted: "", detectedDeletionAt: "" },
            }
          : { $set: { crawledAt: new Date() } }
      );
    } catch (error) {
      // Its own guard: a rejected write must not end the round and cost every
      // remaining candidate its turn.
      console.warn(`Existence probe could not write [${video.id}]:`, error);
    }

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/components/youtube-discovery/existence-probe.spec.ts`
Expected: PASS, 14 tests (the timestamp-only case runs three times via `it.each`).

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
- Test: `src/commands/crawler-candidates.spec.ts` (create)

The candidate list decides which videos get hydrated, and both the new query's
**position** and the 100-id cap are load-bearing — neither is something a type
check or a build can see. It currently lives inside `runCrawler()`, so Step 1
lifts it out unchanged to make it reachable from a test, and only then does
Step 4 add the query.

- [ ] **Step 1: Lift the candidate list out of `runCrawler()`**

In `src/commands/crawler.ts`, move `mapToId` and the whole `videoIds`
expression to module scope as an exported function. The body is unchanged —
same queries, same order, same limits, same `.slice(0, 100)`:

```ts
function mapToId(list: { id: string }[]): string[] {
  return list.map((item) => item.id);
}

/**
 * The videos one `crawler youtube update` round will hydrate.
 *
 * Exported for testing: the order of these queries is the actual priority
 * ordering, because `Set` keeps insertion order and `.slice(0, 100)` is what
 * finally decides. A query placed after the live one below can be starved
 * entirely, and nothing about that is visible to the compiler.
 */
export async function collectVideoUpdateCandidates(): Promise<string[]> {
  const videoIds = Array.from(
    new Set<string>([
      // These two sit first in the Set, so without a cap they fill the whole
      // 100-slot slice and push live videos out. Newest-first matters: _id is
      // immutable, so an ascending cap would keep re-selecting the same
      // oldest ids forever and starve newer videos behind them if those ids
      // never manage to save. Descending puts new videos first and lets
      // permanently unsavable ones fall past the cap instead of blocking
      // discovery, and it runs off the default _id index with no in-memory
      // sort stage. Documents that do save leave these queries on their own,
      // so nothing is skipped — only the order changes. The scheduled-start
      // query below stays unbounded on purpose: a stream about to go live has
      // to be fetched now, and that spike drains within a round.
      ...mapToId(
        await VideoModel.find({ status: VideoStatus.New })
          .sort({ _id: -1 })
          .limit(25)
          .select("id")
      ),
      ...mapToId(
        await VideoModel.find({ crawledAt: null })
          .sort({ _id: -1 })
          .limit(25)
          .select("id")
      ),
      ...mapToId(
        await VideoModel.findLiveVideos()
          .and([
            {
              actualStart: null,
              scheduledStart: {
                $lt: moment.tz("UTC").add(5, "minutes").toDate(),
                $gt: moment.tz("UTC").subtract(5, "minutes").toDate(),
              },
            },
          ])
          .select("id")
      ),
      ...mapToId(
        await VideoModel.findRecentlyEndedVideos(1)
          .sort({ crawledAt: 1 })
          .limit(5)
          .select("id")
      ),
      ...mapToId(
        await VideoModel.findLiveVideos()
          .sort({ crawledAt: 1 })
          .limit(100)
          .select("id")
      ),
    ])
  ).slice(0, 100);
  return videoIds;
}
```

Then replace the body of `JOB_YOUTUBE_UPDATE_VIDEOS` inside `runCrawler()` with:

```ts
agenda.define(JOB_YOUTUBE_UPDATE_VIDEOS, async (_job: Job): Promise<void> => {
  const videoIds = await collectVideoUpdateCandidates();
  const batch: string[][] = [];
  while (videoIds.length) batch.push(videoIds.splice(0, 50));
  await Promise.all(batch.map((perBatch) => updateVideoFromYoutube(perBatch)));
});
```

`mapToId` is no longer needed inside `runCrawler()`; the channel job below it
now uses the module-scope one.

- [ ] **Step 2: Verify the refactor changed nothing**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: no errors, all existing tests still pass. Nothing new is expected to
pass yet — this step only moved code.

- [ ] **Step 3: Write the failing test**

Create `src/commands/crawler-candidates.spec.ts`:

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { VideoStatus } from "holodex.js";

process.env.GOOGLE_API_KEY = "test-key";

const { default: VideoModel } = await import("../models/Video.js");
const { collectVideoUpdateCandidates } = await import("./crawler.js");

function idList(ids: string[]) {
  return ids.map((id) => ({ id }));
}

// Each query in the list is stubbed independently so the assembled result can
// be attributed to the right one.
function stubQueries(options: {
  newVideos?: string[];
  uncrawled?: string[];
  recheck?: string[];
  live?: string[];
}) {
  jest.spyOn(VideoModel, "find").mockImplementation(((filter: {
    status?: unknown;
    crawledAt?: unknown;
    deleted?: unknown;
  }) => {
    let rows: { id: string }[] = [];
    if (filter.status === VideoStatus.New) {
      rows = idList(options.newVideos ?? []);
    } else if (filter.crawledAt === null) {
      rows = idList(options.uncrawled ?? []);
    } else if (filter.status === VideoStatus.Missing) {
      rows = idList(options.recheck ?? []);
    }
    const chain = {
      sort: () => chain,
      limit: (n: number) => ({
        select: () => Promise.resolve(rows.slice(0, n)),
        // findMissingRecheckCandidates returns the query itself, so the caller
        // adds .select() after .limit().
      }),
      select: () => Promise.resolve(rows),
    };
    return chain;
  }) as never);

  const liveChain = {
    and: () => ({ select: () => Promise.resolve([]) }),
    sort: () => ({
      limit: (n: number) => ({
        select: () => Promise.resolve(idList(options.live ?? []).slice(0, n)),
      }),
    }),
  };
  jest.spyOn(VideoModel, "findLiveVideos").mockReturnValue(liveChain as never);
  jest.spyOn(VideoModel, "findRecentlyEndedVideos").mockReturnValue({
    sort: () => ({ limit: () => ({ select: () => Promise.resolve([]) }) }),
  } as never);
}

describe("collectVideoUpdateCandidates", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("includes heuristically-Missing videos without routing them through New", async () => {
    stubQueries({ recheck: ["miss1", "miss2"] });

    const ids = await collectVideoUpdateCandidates();

    // They arrive as candidates directly. Nothing had to flip their status to
    // New first, which is what would otherwise bounce them New -> Missing on
    // every rotation.
    expect(ids).toEqual(["miss1", "miss2"]);
  });

  it("keeps the re-check ids even when live videos could fill the whole slice", async () => {
    stubQueries({
      recheck: ["miss1", "miss2"],
      live: Array.from({ length: 200 }, (_, i) => `live${i}`),
    });

    const ids = await collectVideoUpdateCandidates();

    // The cap is 100 and the live query alone could supply more than that, so
    // this only holds because the re-check query is ordered ahead of it.
    expect(ids).toHaveLength(100);
    expect(ids.slice(0, 2)).toEqual(["miss1", "miss2"]);
  });

  it("still lets the live query fill the rest of the slice", async () => {
    stubQueries({
      recheck: ["miss1"],
      live: Array.from({ length: 200 }, (_, i) => `live${i}`),
    });

    const ids = await collectVideoUpdateCandidates();

    expect(ids).toHaveLength(100);
    expect(ids.filter((id) => id.startsWith("live"))).toHaveLength(99);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm run test -- src/commands/crawler-candidates.spec.ts`
Expected: FAIL — the first test reports `[]` because no query returns the
re-check ids yet.

- [ ] **Step 5: Add the re-check query to the candidate list**

In `collectVideoUpdateCandidates()`, insert this entry into the `new Set<string>([...])` literal **between** the `findRecentlyEndedVideos(1)` block and the final `findLiveVideos()` block:

```ts
      // Streams a timeout heuristic marked Missing: the scheduled start came
      // and went, or the stream stopped without being ended. The video is
      // still on YouTube, so only videos.list can tell whether it has since
      // started or finally ended, and nothing else re-checks it — the one
      // query above that touches Missing is limited to hbEnd within the hour.
      // They stay Missing throughout; nothing flips them to New first, so
      // there is no round trip through the two queries at the top of this
      // list.
      //
      // Two per round because the hit rate is low and the population large:
      // for most of them YouTube never does fill in actualEnd. The position
      // matters as much as the limit — the live query below covers every
      // upcoming and live video and would fill the slice on its own, so
      // anything after it would never be reached.
      ...mapToId(
        await VideoModel.findMissingRecheckCandidates(2).select("id")
      ),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test -- src/commands/crawler-candidates.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Register the three discovery jobs**

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

- [ ] **Step 8: Verify types, lint and the whole suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: no type errors, no lint errors, all tests pass.

- [ ] **Step 9: Verify the build produces a runnable crawler**

Run: `npm run build`
Expected: build succeeds and `dist/commands/crawler.js` exists.

- [ ] **Step 10: Commit**

```bash
git add src/commands/crawler.ts src/commands/crawler-candidates.spec.ts
git commit -m "feat(crawler): schedule the discovery rounds and re-check stuck streams"
```

---

## Done When

- `npm test`, `npx tsc --noEmit`, `npm run lint` and `npm run build` all pass.
- `crawler youtube feed poll`, `crawler youtube members poll` and `crawler youtube existence probe` are defined and scheduled in `src/commands/crawler.ts`.
- The discovery path never builds a Data API client — the feed-poll test
  "never spends quota" asserts zero calls to `google.youtube()`, so any route
  back to `videos.list` fails it.
- One `playlistItems.list` call makes exactly one HTTP request even against an
  endpoint that keeps failing — asserted at the transport layer with `nock`,
  which is the only place gaxios's retries are visible.
- A video a timeout heuristic marked Missing is never probed and never leaves
  `Missing`; it reaches `videos.list` through the candidate list instead.
