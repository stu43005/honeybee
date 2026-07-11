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
      .mockReturnValue(fakeQuery(docs));

    const result = await queryLiveVideos();

    expect(spy).toHaveBeenCalledWith(48);
    expect(result.map((d) => d.id)).toEqual(["a", "b"]);
  });
});
