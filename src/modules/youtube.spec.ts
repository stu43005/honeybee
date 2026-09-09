/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { VideoStatus } from "holodex.js";

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
const { default: ChannelModel } = await import("../models/Channel.js");
const { updateVideoFromYoutube } = await import("./youtube.js");

// A minimal mutable stand-in for a Video document.
function fakeVideo(overrides: Record<string, unknown>) {
  return {
    id: "vid",
    save: jest
      .fn<(options?: { validateBeforeSave?: boolean }) => Promise<unknown>>()
      .mockResolvedValue(undefined),
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
      .mockImplementation(((id: string) =>
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
      .mockImplementation((() => gone) as any);
    mockVideosList.mockResolvedValue({ data: { items: [foundItem("gone1")] } });

    await updateVideoFromYoutube(["gone1"]);

    expect(gone.deleted).toBe(false);
    expect(gone.detectedDeletionAt).toBeUndefined();
  });

  it("marks a lone deleted video when the response has empty items", async () => {
    const gone = fakeVideo({ id: "gone1", deleted: false });
    jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation((() => gone) as any);
    // A resolved 200 with no items = every requested id is gone (not an error).
    mockVideosList.mockResolvedValue({ data: { items: [] } });

    await updateVideoFromYoutube(["gone1"]);

    expect(gone.deleted).toBe(true);
    expect(gone.detectedDeletionAt).toBeInstanceOf(Date);
    const firstDetection = gone.detectedDeletionAt;

    // A second still-missing empty-items crawl keeps the original detection time.
    await updateVideoFromYoutube(["gone1"]);
    expect(gone.detectedDeletionAt).toBe(firstDetection);
  });

  it("skips a never-seen id that is already gone (no phantom record)", async () => {
    // findByVideoId returns null (never tracked); YouTube omits it (deleted).
    const findSpy = jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation((() => null) as any);
    mockVideosList.mockResolvedValue({ data: { items: [] } });

    // No `new VideoModel(...).save()` is attempted (that would need a DB and fail
    // validation for the missing channelId/title), so this resolves cleanly with
    // an empty result rather than throwing.
    const result = await updateVideoFromYoutube(["neverseen1"]);

    expect(result).toEqual([]);
    expect(findSpy).toHaveBeenCalledWith("neverseen1");
  });
});

describe("updateVideoFromYoutube validateBeforeSave", () => {
  it("saves a vanished video without validation so the verdict lands", async () => {
    // A raid placeholder: written by a validator-bypassing upsert, so it can
    // never satisfy the required channelId/title and would fail every save.
    const gone = fakeVideo({
      id: "gone1",
      channelId: "",
      title: "",
      status: VideoStatus.New,
      deleted: false,
    });
    jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation((() => gone) as any);
    mockVideosList.mockResolvedValue({ data: { items: [] } });

    await updateVideoFromYoutube(["gone1"]);

    expect(gone.save).toHaveBeenCalledWith({ validateBeforeSave: false });
    // status and crawledAt are what take it out of the two unbounded
    // candidate queries.
    expect(gone.status).toBe(VideoStatus.Missing);
    expect(gone.deleted).toBe(true);
    expect(gone.crawledAt).toBeInstanceOf(Date);
  });

  it("validates the save when YouTube still returns the video", async () => {
    const found = fakeVideo({ id: "found1" });
    jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation((() => found) as any);
    mockVideosList.mockResolvedValue({
      data: { items: [foundItem("found1")] },
    });

    await updateVideoFromYoutube(["found1"]);

    expect(found.save).toHaveBeenCalledWith({ validateBeforeSave: true });
  });

  it("keeps the tombstone behavior for a fully populated video", async () => {
    const gone = fakeVideo({
      id: "gone2",
      channelId: "UCabcdefghijklmnopqrstuv",
      title: "A real title",
      deleted: false,
    });
    jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation((() => gone) as any);
    // Resolving the channel keeps the id out of the follow-up channel update,
    // so channels.list is never reached from this test.
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation((() => ({ id: "UCabcdefghijklmnopqrstuv" })) as any);
    mockVideosList.mockResolvedValue({ data: { items: [] } });

    const result = await updateVideoFromYoutube(["gone2"]);

    expect(gone.deleted).toBe(true);
    expect(gone.detectedDeletionAt).toBeInstanceOf(Date);
    expect(result).toEqual([gone]);
  });
});
