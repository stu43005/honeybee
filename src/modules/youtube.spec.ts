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
const mockChannelsList = jest.fn<() => Promise<unknown>>();
const mockPlaylistItemsList = jest.fn<() => Promise<unknown>>();
const mockYoutube = jest.fn(() => ({
  videos: { list: mockVideosList },
  channels: { list: mockChannelsList },
  playlistItems: { list: mockPlaylistItemsList },
}));

jest.unstable_mockModule("googleapis", () => ({
  google: { youtube: mockYoutube },
}));

const { default: VideoModel } = await import("../models/Video.js");
const { default: ChannelModel } = await import("../models/Channel.js");
const {
  getYoutubeApi,
  updateVideoFromYoutube,
  updateChannelFromYoutube,
  updateVideoFromPlaylist,
} = await import("./youtube.js");
const { YOUTUBE_API_TIMEOUT_MS } = await import("../constants.js");

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

// A minimal mutable stand-in for a Channel document.
function fakeChannel(overrides: Record<string, unknown>) {
  return {
    id: "chan",
    save: jest
      .fn<(options?: { validateBeforeSave?: boolean }) => Promise<unknown>>()
      .mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function foundChannelItem(id: string) {
  return {
    id,
    snippet: { title: "A channel" },
    statistics: {},
    brandingSettings: {},
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  mockVideosList.mockReset();
  mockChannelsList.mockReset();
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
    // Spying the prototype observes a `new VideoModel(...).save()` attempt
    // directly. An empty result is not enough on its own: once per-video
    // errors are caught, a phantom save that rejects would be swallowed and
    // the result would still be empty.
    const protoSaveSpy = jest
      .spyOn(VideoModel.prototype, "save")
      .mockResolvedValue(undefined as never);
    mockVideosList.mockResolvedValue({ data: { items: [] } });

    const result = await updateVideoFromYoutube(["neverseen1"]);

    expect(protoSaveSpy).not.toHaveBeenCalled();
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

describe("updateVideoFromYoutube batch isolation", () => {
  it("keeps updating the rest of the batch when one video fails to save", async () => {
    const boom = fakeVideo({ id: "boom1" });
    boom.save.mockRejectedValue(new Error("save failed"));
    const ok = fakeVideo({ id: "ok1" });
    jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation(((id: string) =>
        id === "boom1" ? boom : ok) as any);
    mockVideosList.mockResolvedValue({
      data: { items: [foundItem("boom1"), foundItem("ok1")] },
    });
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await updateVideoFromYoutube(["boom1", "ok1"]);

    expect(ok.save).toHaveBeenCalled();
    expect(result).toEqual([ok]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("boom1"),
      expect.any(Error)
    );
  });
});

describe("updateChannelFromYoutube validateBeforeSave", () => {
  it("saves a vanished channel without validation so the verdict lands", async () => {
    const gone = fakeChannel({ id: "UCgone" });
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation((() => gone) as any);
    mockChannelsList.mockResolvedValue({ data: { items: [] } });

    await updateChannelFromYoutube(["UCgone"]);

    expect(gone.save).toHaveBeenCalledWith({ validateBeforeSave: false });
    expect(gone.deleted).toBe(true);
    expect(gone.crawledAt).toBeInstanceOf(Date);
  });

  it("validates the save when YouTube still returns the channel", async () => {
    const found = fakeChannel({ id: "UCfound" });
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation((() => found) as any);
    mockChannelsList.mockResolvedValue({
      data: { items: [foundChannelItem("UCfound")] },
    });

    await updateChannelFromYoutube(["UCfound"]);

    expect(found.save).toHaveBeenCalledWith({ validateBeforeSave: true });
    expect(found.name).toBe("A channel");
  });

  it("marks every channel when the whole batch is missing", async () => {
    const a = fakeChannel({ id: "UCa" });
    const b = fakeChannel({ id: "UCb" });
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation(((id: string) => (id === "UCa" ? a : b)) as any);
    mockChannelsList.mockResolvedValue({ data: { items: [] } });

    const result = await updateChannelFromYoutube(["UCa", "UCb"]);

    expect(a.deleted).toBe(true);
    expect(b.deleted).toBe(true);
    expect(result).toEqual([a, b]);
  });

  it("skips a never-seen channel that is already gone", async () => {
    // findByChannelId returns null (never tracked); YouTube omits it.
    const findSpy = jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation((() => null) as any);
    // Spying the prototype observes a `new ChannelModel(...).save()` attempt
    // directly. An empty result is not enough on its own: once per-channel
    // errors are caught, a phantom save that rejects would be swallowed and
    // the result would still be empty.
    const protoSaveSpy = jest
      .spyOn(ChannelModel.prototype, "save")
      .mockResolvedValue(undefined as never);
    mockChannelsList.mockResolvedValue({ data: { items: [] } });

    const result = await updateChannelFromYoutube(["UCneverseen"]);

    expect(protoSaveSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
    expect(findSpy).toHaveBeenCalledWith("UCneverseen");
  });
});

describe("updateChannelFromYoutube batch isolation", () => {
  it("keeps updating the rest of the batch when one channel fails to save", async () => {
    const boom = fakeChannel({ id: "UCboom" });
    boom.save.mockRejectedValue(new Error("save failed"));
    const ok = fakeChannel({ id: "UCok" });
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation(((id: string) =>
        id === "UCboom" ? boom : ok) as any);
    mockChannelsList.mockResolvedValue({
      data: {
        items: [foundChannelItem("UCboom"), foundChannelItem("UCok")],
      },
    });
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await updateChannelFromYoutube(["UCboom", "UCok"]);

    expect(ok.save).toHaveBeenCalled();
    expect(result).toEqual([ok]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("UCboom"),
      expect.any(Error)
    );
  });
});

describe("getYoutubeApi", () => {
  it("builds the client with an explicit request timeout", () => {
    getYoutubeApi();

    expect(mockYoutube).toHaveBeenCalledWith({
      version: "v3",
      auth: "test-key",
      timeout: YOUTUBE_API_TIMEOUT_MS,
    });
  });
});

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

  it("reports a 403 with reason quotaExceeded as quota exhaustion", async () => {
    mockPlaylistItemsList.mockRejectedValue(apiError(403, "quotaExceeded"));

    await expect(updateVideoFromPlaylist("UUMOabc")).resolves.toEqual({
      ok: false,
      kind: "quotaExceeded",
      message: "HTTP 403",
    });
  });

  it("does not stop the round for a rate-limit 403", async () => {
    // Rate limiting is not an exhausted budget, and stopping is reserved for
    // the one condition where every remaining channel is certain to fail.
    mockPlaylistItemsList.mockRejectedValue(apiError(403, "rateLimitExceeded"));

    const result = await updateVideoFromPlaylist("UUMOabc");

    expect(result).toEqual({ ok: false, kind: "error", message: "HTTP 403" });
  });

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
