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
  YOUTUBE_FEED_POLL_ATTEMPTS,
  YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS,
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

type Answer = Error | { data: string };

// Answers each channel's requests from its own script, one entry per request in
// order; once a script runs out its last entry repeats. Channels are told apart
// by the channel_id in the url, so the script does not depend on the order the
// round visits them in.
function scripted(answers: Record<string, Answer[]>): void {
  const counts = new Map<string, number>();
  mockGet.mockImplementation((url) => {
    const id = url.slice(url.indexOf("=") + 1);
    const script = answers[id];
    if (script === undefined) {
      return Promise.reject(new Error(`no scripted answer for ${id}`));
    }
    const count = counts.get(id) ?? 0;
    counts.set(id, count + 1);
    const answer = script[Math.min(count, script.length - 1)];
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  });
}

// A feed the origin actually served.
function served(channelId: string, videoIds: string[] = []): Answer {
  return { data: feedXml(channelId, videoIds) };
}

// An origin that refuses this channel on every attempt.
const refused: Answer[] = [httpError(404)];

// One channel id repeated once per attempt it is expected to use.
function times(channelId: string, count: number): string[] {
  return Array.from({ length: count }, () => channelId);
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

  it("logs a failed channel as one line carrying only its last error", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1"]);
    // What axios actually rejects with. Handing the object itself to
    // console.warn makes node print all of it: the config, the request, the
    // socket, and the HTML error page YouTube served — around a hundred lines
    // for one 404, of which the daily outage produces hundreds.
    const lastError = Object.assign(
      new Error("Request failed with status code 404"),
      {
        isAxiosError: true,
        config: { url: "https://www.youtube.com/feeds/videos.xml" },
        request: { socket: { _hadError: false } },
        response: {
          status: 404,
          data: "<html><title>Error 404 (Not Found)!!1</title></html>",
        },
      }
    );
    scripted({ UC1: [httpError(404), httpError(500), lastError] });

    await pollChannelFeeds();

    expect(YOUTUBE_FEED_POLL_ATTEMPTS).toBe(3);
    expect(requestedChannels()).toEqual(times("UC1", 3));
    // The two earlier failures leave no trace; only the last one is told.
    expect(warn.mock.calls).toEqual([
      [
        "Feed poll failed for [UC1] after 3 attempts:",
        "Request failed with status code 404",
      ],
    ]);
  });

  it("keeps the whole error when the failure is not an http one", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1"]);
    // Nothing above the transport knows what this is, so its stack is the only
    // thing that can explain it and must survive. Nor is it worth a retry.
    const bug = new TypeError("entry.published is not a function");
    scripted({ UC1: [bug] });

    await pollChannelFeeds();

    expect(requestedChannels()).toEqual(["UC1"]);
    expect(warn.mock.calls).toEqual([
      ["Feed poll failed for [UC1] after 1 attempts:", bug],
    ]);
  });

  it("retries an http failure and takes the feed once it is served", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const stamped = fakeChannels(["UC1"]);
    scripted({ UC1: [httpError(404), httpError(500), served("UC1", ["v1"])] });
    const notice = jest
      .spyOn(VideoModel, "noticeUnknownVideos")
      .mockResolvedValue(undefined);

    await pollChannelFeeds();

    expect(requestedChannels()).toEqual(times("UC1", 3));
    expect(
      notice.mock.calls.map((call) => call[0].map((v) => v.videoId))
    ).toEqual([["v1"]]);
    expect(warn.mock.calls).toEqual([]);
    // One gap before each retry; none after the round's only channel.
    expect(mockSleep.mock.calls).toEqual([
      [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS],
      [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS],
    ]);
    expect(stamped.map((write) => write.id)).toEqual(["UC1"]);
  });

  it("does not retry a timeout", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1"]);
    scripted({ UC1: [timeoutError(), served("UC1")] });

    await pollChannelFeeds();

    expect(requestedChannels()).toEqual(["UC1"]);
    expect(warn.mock.calls).toEqual([
      [
        "Feed poll failed for [UC1] after 1 attempts:",
        `timeout of ${YOUTUBE_FEED_TIMEOUT_MS}ms exceeded`,
      ],
    ]);
  });

  it("does not retry a 2xx whose body is not a feed", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1"]);
    scripted({ UC1: [{ data: "<html>nope</html>" }, served("UC1")] });

    await pollChannelFeeds();

    expect(requestedChannels()).toEqual(["UC1"]);
    expect(warn.mock.calls).toEqual([
      ["Feed poll: body is not a feed for [UC1]"],
    ]);
  });

  it("stops retrying at a timeout and does not count that channel", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4"]);
    scripted({
      UC1: [httpError(404), timeoutError()],
      UC2: refused,
      UC3: refused,
      UC4: [served("UC4")],
    });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    // UC1 ended on a timeout, so only UC2 and UC3 count: two, not three, and
    // the round reaches UC4.
    expect(requestedChannels()).toEqual([
      ...times("UC1", 2),
      ...times("UC2", 3),
      ...times("UC3", 3),
      "UC4",
    ]);
    expect(warn.mock.calls[0]).toEqual([
      "Feed poll failed for [UC1] after 2 attempts:",
      `timeout of ${YOUTUBE_FEED_TIMEOUT_MS}ms exceeded`,
    ]);
  });

  it("stops the round after three channels in a row run out of attempts", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const stamped = fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    scripted({
      UC1: refused,
      UC2: [httpError(500)],
      UC3: refused,
      UC4: [served("UC4")],
      UC5: [served("UC5")],
    });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    expect(YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES).toBe(3);
    expect(requestedChannels()).toEqual([
      ...times("UC1", 3),
      ...times("UC2", 3),
      ...times("UC3", 3),
    ]);
    // The three that were tried are stamped like any failure; the two behind
    // them keep their old stamp and so stay at the front of the rotation.
    expect(stamped.map((write) => write.id)).toEqual(["UC1", "UC2", "UC3"]);
    expect(warn.mock.calls).toEqual([
      [
        "Feed poll failed for [UC1] after 3 attempts:",
        "Request failed with status code 404",
      ],
      [
        "Feed poll failed for [UC2] after 3 attempts:",
        "Request failed with status code 500",
      ],
      [
        "Feed poll failed for [UC3] after 3 attempts:",
        "Request failed with status code 404",
      ],
      [
        "Feed poll: stopping round after 3 consecutive HTTP failures, 2 channels deferred",
      ],
    ]);
  });

  it("does not wait for the spacing once the round is stopped", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4"]);
    scripted({ UC1: refused, UC2: refused, UC3: refused, UC4: refused });

    await pollChannelFeeds();

    // UC1 and UC2: two retry gaps and one gap before the next channel each.
    // UC3: its two retry gaps, then the round stops with no further wait.
    expect(mockSleep.mock.calls).toEqual(
      Array.from({ length: 8 }, () => [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS])
    );
  });

  it("hands the deferred channels to the next round first", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    scripted({
      UC1: refused,
      UC2: refused,
      UC3: refused,
      UC4: [served("UC4")],
      UC5: [served("UC5")],
    });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();
    await pollChannelFeeds();

    // The fake drops stamped channels, standing in for the real sort putting
    // them last, so the second round sees exactly the two left unstamped.
    expect(requestedChannels()).toEqual([
      ...times("UC1", 3),
      ...times("UC2", 3),
      ...times("UC3", 3),
      "UC4",
      "UC5",
    ]);
  });

  it("neither counts nor clears the run on a timeout", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    scripted({
      UC1: refused,
      UC2: [timeoutError()],
      UC3: refused,
      UC4: refused,
      UC5: [served("UC5")],
    });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    // The timeout left the count at one, so the next two failed channels make
    // three and the round stops before UC5.
    expect(requestedChannels()).toEqual([
      ...times("UC1", 3),
      "UC2",
      ...times("UC3", 3),
      ...times("UC4", 3),
    ]);
  });

  it("does not count timeouts toward the stop", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const stamped = fakeChannels(["UC1", "UC2", "UC3", "UC4"]);
    scripted({
      UC1: [timeoutError()],
      UC2: [timeoutError()],
      UC3: [timeoutError()],
      UC4: [served("UC4")],
    });
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
    scripted({
      UC1: refused,
      UC2: refused,
      UC3: [served("UC3")],
      UC4: refused,
      UC5: refused,
    });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    expect(requestedChannels()).toEqual([
      ...times("UC1", 3),
      ...times("UC2", 3),
      "UC3",
      ...times("UC4", 3),
      ...times("UC5", 3),
    ]);
    expect(stamped.map((write) => write.id)).toEqual([
      "UC1",
      "UC2",
      "UC3",
      "UC4",
      "UC5",
    ]);
  });

  it("clears the run when a channel is served on its last attempt", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    scripted({
      UC1: refused,
      UC2: refused,
      UC3: [httpError(404), httpError(500), served("UC3")],
      UC4: refused,
      UC5: refused,
    });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

    await pollChannelFeeds();

    expect(requestedChannels()).toEqual([
      ...times("UC1", 3),
      ...times("UC2", 3),
      ...times("UC3", 3),
      ...times("UC4", 3),
      ...times("UC5", 3),
    ]);
  });

  it("clears the run on a 2xx body that is not a feed", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    scripted({
      UC1: refused,
      UC2: refused,
      UC3: [{ data: "<html>nope</html>" }],
      UC4: refused,
      UC5: refused,
    });

    await pollChannelFeeds();

    expect(requestedChannels()).toEqual([
      ...times("UC1", 3),
      ...times("UC2", 3),
      "UC3",
      ...times("UC4", 3),
      ...times("UC5", 3),
    ]);
  });

  it("clears the run on a 2xx even when writing its videos fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    scripted({
      UC1: refused,
      UC2: refused,
      UC3: [httpError(404), served("UC3", ["v1"])],
      UC4: refused,
      UC5: refused,
    });
    const writeError = new Error("write concern error");
    const notice = jest
      .spyOn(VideoModel, "noticeUnknownVideos")
      .mockRejectedValue(writeError);

    await pollChannelFeeds();

    // The write did run and fail; the origin had still served the feed.
    expect(notice.mock.calls.map((call) => call[0].length)).toEqual([1]);
    expect(requestedChannels()).toEqual([
      ...times("UC1", 3),
      ...times("UC2", 3),
      ...times("UC3", 2),
      ...times("UC4", 3),
      ...times("UC5", 3),
    ]);
    expect(warn.mock.calls[2]).toEqual([
      "Feed poll failed for [UC3] after 2 attempts:",
      writeError,
    ]);
  });

  it("still logs the stop when the last channel trips it", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3"]);
    scripted({ UC1: refused, UC2: refused, UC3: refused });

    await pollChannelFeeds();

    expect(warn.mock.calls).toEqual([
      [
        "Feed poll failed for [UC1] after 3 attempts:",
        "Request failed with status code 404",
      ],
      [
        "Feed poll failed for [UC2] after 3 attempts:",
        "Request failed with status code 404",
      ],
      [
        "Feed poll failed for [UC3] after 3 attempts:",
        "Request failed with status code 404",
      ],
      [
        "Feed poll: stopping round after 3 consecutive HTTP failures, 0 channels deferred",
      ],
    ]);
  });

  it("starts every round with a fresh count", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    scripted({
      UC1: refused,
      UC2: refused,
      UC3: refused,
      UC4: [served("UC4")],
      UC5: [served("UC5")],
    });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);
    // First round: two channels, both refused, so it ends with the count at two.
    jest.spyOn(ChannelModel, "findFeedPollCandidates").mockResolvedValueOnce([
      { id: "UC1", name: "Channel UC1" },
      { id: "UC2", name: "Channel UC2" },
    ] as never);

    await pollChannelFeeds();
    mockGet.mockClear();
    // Second round: one more refused channel, then feeds. A count carried over
    // from the first round would reach three here and stop after UC3.
    await pollChannelFeeds();

    expect(requestedChannels()).toEqual([...times("UC3", 3), "UC4", "UC5"]);
  });

  it("renews the agenda lock once a minute has passed between channels", async () => {
    fakeChannels(["UC1", "UC2", "UC3"]);
    scripted({
      UC1: [served("UC1")],
      UC2: [served("UC2")],
      UC3: [served("UC3")],
    });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);
    // Each request moves the clock 40 seconds on, so the minute is crossed
    // between the second and the third channel and nowhere else.
    let clock = 0;
    jest.spyOn(Date, "now").mockImplementation(() => clock);
    const answer = mockGet.getMockImplementation();
    mockGet.mockImplementation((url, config) => {
      clock += 40 * 1000;
      return answer!(url, config);
    });
    const touch = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await pollChannelFeeds({ touch } as never);

    expect(YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS).toBe(60 * 1000);
    const renewedAt = touch.mock.invocationCallOrder;
    expect(renewedAt).toHaveLength(1);
    // Renewed after UC2's request and before UC3's.
    expect(
      mockGet.mock.invocationCallOrder.map((order) => order < renewedAt[0])
    ).toEqual([true, true, false]);
  });

  it("ends the round when renewing the lock fails", async () => {
    const stamped = fakeChannels(["UC1", "UC2", "UC3"]);
    scripted({
      UC1: [served("UC1")],
      UC2: [served("UC2")],
      UC3: [served("UC3")],
    });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);
    let clock = 0;
    jest.spyOn(Date, "now").mockImplementation(() => clock);
    const answer = mockGet.getMockImplementation();
    mockGet.mockImplementation((url, config) => {
      clock += 40 * 1000;
      return answer!(url, config);
    });
    // What agenda's touch() does once it has cancelled the run.
    const cancelled = new Error("Job was canceled");
    const touch = jest.fn<() => Promise<void>>().mockRejectedValue(cancelled);

    await expect(pollChannelFeeds({ touch } as never)).rejects.toBe(cancelled);

    // UC3 was never fetched or stamped, so it leads the next round.
    expect(requestedChannels()).toEqual(["UC1", "UC2"]);
    expect(stamped.map((write) => write.id)).toEqual(["UC1", "UC2"]);
  });

  it("counts the candidate query toward the first renewal", async () => {
    fakeChannels(["UC1"]);
    scripted({ UC1: [served("UC1")] });
    jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);
    let clock = 0;
    jest.spyOn(Date, "now").mockImplementation(() => clock);
    // A query slow enough to use up more than a minute of the lock on its own.
    jest
      .spyOn(ChannelModel, "findFeedPollCandidates")
      .mockImplementation((() => {
        clock += 70 * 1000;
        return Promise.resolve([{ id: "UC1", name: "Channel UC1" }]);
      }) as never);
    const touch = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await pollChannelFeeds({ touch } as never);

    const renewedAt = touch.mock.invocationCallOrder;
    expect(renewedAt).toHaveLength(1);
    // Renewed before the first request, not a minute after it.
    expect(
      mockGet.mock.invocationCallOrder.map((order) => order < renewedAt[0])
    ).toEqual([false]);
  });
});
