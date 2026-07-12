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
});
