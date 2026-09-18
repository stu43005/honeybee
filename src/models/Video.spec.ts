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
