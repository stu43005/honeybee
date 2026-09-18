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
