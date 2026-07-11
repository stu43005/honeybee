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
    getChannel: () => Promise.resolve({ id: "UCc", name: "C" }),
    ...overrides,
  } as any;
}

// A stand-in for a mongoose Query: chainable and async-iterable.
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
    const spy = jest.spyOn(VideoModel, "find").mockReturnValue(fakeQuery(docs));

    const result = await queryLeaderboardVideos("2026-07-11", "maxViewers");

    expect(spy).toHaveBeenCalledWith(
      leaderboardFilter("2026-07-11", "maxViewers")
    );
    expect(result.map((d) => d.id)).toEqual(["a", "b"]);
  });
});
