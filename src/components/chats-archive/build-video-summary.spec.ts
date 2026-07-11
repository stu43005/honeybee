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
    getChannel: () =>
      Promise.resolve({ id: "UCchan", name: "Chan", avatarUrl: null }),
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
