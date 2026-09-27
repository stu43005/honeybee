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
  default: {
    get: mockGet,
    // Same test axios itself applies: an object carrying `isAxiosError: true`.
    isAxiosError: (error: unknown): boolean =>
      typeof error === "object" &&
      error !== null &&
      (error as { isAxiosError?: unknown }).isAxiosError === true,
  },
}));
jest.unstable_mockModule("node:timers/promises", () => ({
  setTimeout: mockSleep,
}));
jest.unstable_mockModule("googleapis", () => ({
  google: { youtube: mockYoutube },
}));

const { default: ChannelModel } = await import("#models/Channel.js");
const { default: VideoModel } = await import("#models/Video.js");
const { pollChannelFeeds } = await import("./feed-poll.js");
const {
  YOUTUBE_FEED_POLL_BATCH_SIZE,
  YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES,
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_FEED_TIMEOUT_MS,
} = await import("#constants.js");

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

// What axios rejects with when the server answered with a non-2xx status: the
// response is attached.
function httpError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

// What axios rejects with when the request timed out: there is no response,
// and the code is ECONNABORTED under axios's default transitional settings.
function timeoutError() {
  return Object.assign(
    new Error(`timeout of ${YOUTUBE_FEED_TIMEOUT_MS}ms exceeded`),
    { isAxiosError: true, code: "ECONNABORTED" }
  );
}

// The channel ids this test's rounds requested, in order.
function requestedChannels(): string[] {
  return mockGet.mock.calls.map(([url]) => url.slice(url.indexOf("=") + 1));
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

  it("logs an http failure as one line, not as the whole error object", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1"]);
    // What axios actually rejects with. Handing the object itself to
    // console.warn makes node print all of it: the config, the request, the
    // socket, and the HTML error page YouTube served — around a hundred lines
    // for one transient 404, of which this feed produces dozens a day.
    mockGet.mockRejectedValue(
      Object.assign(new Error("Request failed with status code 404"), {
        isAxiosError: true,
        config: { url: "https://www.youtube.com/feeds/videos.xml" },
        request: { socket: { _hadError: false } },
        response: {
          status: 404,
          data: "<html><title>Error 404 (Not Found)!!1</title></html>",
        },
      })
    );

    await pollChannelFeeds();

    expect(warn.mock.calls).toEqual([
      ["Feed poll failed for [UC1]:", "Request failed with status code 404"],
    ]);
  });

  it("keeps the whole error when the failure is not an http one", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1"]);
    // Nothing above the transport knows what this is, so its stack is the only
    // thing that can explain it and must survive.
    const bug = new TypeError("entry.published is not a function");
    mockGet.mockRejectedValue(bug);

    await pollChannelFeeds();

    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0]?.[1]).toBe(bug);
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

  it("stops the round after three http failures in a row", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const stamped = fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    mockGet
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(404))
      .mockResolvedValue({ data: feedXml("UC4", []) });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    expect(YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES).toBe(3);
    expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3"]);
    // The three that were tried are stamped like any failure; the two behind
    // them keep their old stamp and so stay at the front of the rotation.
    expect(stamped.map((write) => write.id)).toEqual(["UC1", "UC2", "UC3"]);
    expect(warn.mock.calls).toEqual([
      ["Feed poll failed for [UC1]:", "Request failed with status code 404"],
      ["Feed poll failed for [UC2]:", "Request failed with status code 500"],
      ["Feed poll failed for [UC3]:", "Request failed with status code 404"],
      [
        "Feed poll: stopping round after 3 consecutive HTTP failures, 2 channels deferred",
      ],
    ]);
  });

  it("does not wait for the spacing once the round is stopped", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4"]);
    mockGet.mockRejectedValue(httpError(404));

    await pollChannelFeeds();

    // One gap after each of the first two requests, none after the third.
    expect(mockSleep.mock.calls).toEqual([
      [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS],
      [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS],
    ]);
  });

  it("hands the deferred channels to the next round first", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    mockGet
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404))
      .mockResolvedValue({ data: feedXml("UC4", []) });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();
    mockGet.mockClear();
    await pollChannelFeeds();

    // The fake drops stamped channels, standing in for the real sort putting
    // them last, so the second round sees exactly the two left unstamped.
    expect(requestedChannels()).toEqual(["UC4", "UC5"]);
  });

  it("neither counts nor clears the run on a timeout", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    mockGet
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(timeoutError())
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404))
      .mockResolvedValue({ data: feedXml("UC5", []) });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    // The timeout left the count at one, so the next two http failures make
    // three and the round stops before UC5.
    expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3", "UC4"]);
  });

  it("does not count timeouts toward the stop", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const stamped = fakeChannels(["UC1", "UC2", "UC3", "UC4"]);
    mockGet
      .mockRejectedValueOnce(timeoutError())
      .mockRejectedValueOnce(timeoutError())
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValue({ data: feedXml("UC4", []) });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3", "UC4"]);
    expect(stamped.map((write) => write.id)).toEqual([
      "UC1",
      "UC2",
      "UC3",
      "UC4",
    ]);
  });

  it("clears the run when a feed is served in between", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const stamped = fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    mockGet
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404))
      .mockResolvedValueOnce({ data: feedXml("UC3", []) })
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404));
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    expect(stamped.map((write) => write.id)).toEqual([
      "UC1",
      "UC2",
      "UC3",
      "UC4",
      "UC5",
    ]);
  });

  it("clears the run on a 2xx body that is not a feed", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    mockGet
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404))
      .mockResolvedValueOnce({ data: "<html>nope</html>" })
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404));

    await pollChannelFeeds();

    expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  });

  it("clears the run on a 2xx even when writing its videos fails", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    mockGet
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404))
      .mockResolvedValueOnce({ data: feedXml("UC3", ["v1"]) })
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404));
    const notice = jest
      .spyOn(VideoModel, "noticeUnknownVideos")
      .mockRejectedValue(new Error("write concern error"));

    await pollChannelFeeds();

    // The write did run and fail; the backend had still served the feed.
    expect(notice.mock.calls.map((call) => call[0].length)).toEqual([1]);
    expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  });

  it("still logs the stop when the last channel trips it", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3"]);
    mockGet.mockRejectedValue(httpError(404));

    await pollChannelFeeds();

    expect(warn.mock.calls).toEqual([
      ["Feed poll failed for [UC1]:", "Request failed with status code 404"],
      ["Feed poll failed for [UC2]:", "Request failed with status code 404"],
      ["Feed poll failed for [UC3]:", "Request failed with status code 404"],
      [
        "Feed poll: stopping round after 3 consecutive HTTP failures, 0 channels deferred",
      ],
    ]);
  });

  it("starts every round with a fresh count", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    mockGet
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404))
      .mockResolvedValue({ data: feedXml("UC5", []) });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);
    // First round: two channels, both refused, so it ends with the count at two.
    jest.spyOn(ChannelModel, "findFeedPollCandidates").mockResolvedValueOnce([
      { id: "UC1", name: "Channel UC1" },
      { id: "UC2", name: "Channel UC2" },
    ] as never);

    await pollChannelFeeds();
    mockGet.mockClear();
    // Second round: one more refusal, then feeds. A count carried over from the
    // first round would reach three here and stop after UC3.
    await pollChannelFeeds();

    expect(requestedChannels()).toEqual(["UC3", "UC4", "UC5"]);
  });
});
