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
