/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import fastify from "fastify";

process.env.PUBLIC_BASE_URL = "https://honeybee.example.test/";
process.env.YOUTUBE_PUBSUB_SECRET = "test-secret";

// Declaring the argument types, rather than `() => Promise<unknown>`, is what
// lets assertions read `mock.calls[n][0]`: a zero-argument signature records
// its calls as an empty tuple, so indexing one is a type error.
type NoticeInput = {
  video: { id: string; title: string };
  channel: { id: string };
};
type NoticeResult = { upsertedCount: number; modifiedCount: number };

const mockNoticeFromNotification =
  jest.fn<(input: NoticeInput) => Promise<NoticeResult>>();
const mockUpdateVideoFromYoutube =
  jest.fn<(videoIds: string[]) => Promise<unknown>>();

jest.unstable_mockModule("../../models/Video.js", () => ({
  default: { noticeFromNotification: mockNoticeFromNotification },
}));

jest.unstable_mockModule("../youtube.js", () => ({
  updateVideoFromYoutube: mockUpdateVideoFromYoutube,
}));

const { default: ChannelModel } = await import("../../models/Channel.js");
const { pubsubRoutes } = await import("./routes.js");
const { getCallbackToken, topicForChannel } = await import("./hub-client.js");
const { PUBSUB_DEFAULT_LEASE_MS, PUBSUB_MAX_LEASE_MS } =
  await import("../../constants.js");

async function buildServer() {
  const app = fastify();
  await app.register(pubsubRoutes);
  return app;
}

const token = getCallbackToken();

function verificationUrl(params: Record<string, string>, path = token): string {
  return `/notifications/youtube/${path}?${new URLSearchParams(params)}`;
}

/**
 * A stateful channel store whose findOne actually evaluates the filter, so a
 * missing cooldown condition in the implementation makes these tests fail
 * instead of passing by accident.
 */
function fakeChannelStore(
  channels: { id: string; pubsubRequestedAt?: Date }[],
  options?: { failWriteFor?: string }
): {
  /** Expiries that actually landed, keyed by channel id. */
  expiries: Map<string, Date>;
  /** Every write that was attempted, in order, whether or not it succeeded. */
  attempted: { id: string; expiresAt: Date }[];
} {
  jest.spyOn(ChannelModel, "findOne").mockImplementation(((filter: {
    id: string;
    pubsubRequestedAt?: { $gte: Date };
  }) => {
    const found = channels.find((channel) => {
      if (channel.id !== filter.id) return false;
      const cutoff = filter.pubsubRequestedAt?.$gte;
      if (!cutoff) return true;
      return !!channel.pubsubRequestedAt && channel.pubsubRequestedAt >= cutoff;
    });
    return Promise.resolve(found ?? null) as never;
  }) as never);

  // A write that succeeds lands in `expiries`, one that fails does not, so
  // "nothing was stored" is a meaningful assertion rather than a vacuous one.
  const expiries = new Map<string, Date>();
  const attempted: { id: string; expiresAt: Date }[] = [];
  jest.spyOn(ChannelModel, "updateOne").mockImplementation(((
    filter: { id: string },
    update: { $set: { pubsubExpiresAt: Date } }
  ) => {
    attempted.push({ id: filter.id, expiresAt: update.$set.pubsubExpiresAt });
    if (filter.id === options?.failWriteFor) {
      return Promise.reject(new Error("mongo down")) as never;
    }
    expiries.set(filter.id, update.$set.pubsubExpiresAt);
    return Promise.resolve({ acknowledged: true }) as never;
  }) as never);

  return { expiries, attempted };
}

/** Lets the handler finish the work it does after answering the request. */
function drainPostResponseWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("verification GET", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("echoes the challenge and stores the expiry for a channel we just asked about", async () => {
    const { expiries, attempted } = fakeChannelStore([
      { id: "UCabc", pubsubRequestedAt: new Date() },
    ]);
    const app = await buildServer();
    const before = Date.now();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "challenge-value",
        "hub.lease_seconds": "432000",
      }),
    });
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    // A body that is not exactly the challenge makes the hub treat the
    // verification as failed.
    expect(response.body).toBe("challenge-value");
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(attempted.map((write) => write.id)).toEqual(["UCabc"]);
    expect([...expiries.keys()]).toEqual(["UCabc"]);
    const leaseMs = expiries.get("UCabc")!.getTime() - before;
    // The stored expiry reflects the lease the hub reported, within the drift
    // of reading the clock twice.
    expect(leaseMs).toBeGreaterThanOrEqual(432_000 * 1000 - 5_000);
    expect(leaseMs).toBeLessThanOrEqual(432_000 * 1000 + 5_000);
    await app.close();
  });

  it("rejects a wrong token without touching the database", async () => {
    const { expiries } = fakeChannelStore([
      { id: "UCabc", pubsubRequestedAt: new Date() },
    ]);
    const findSpy = jest.spyOn(ChannelModel, "findOne");
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl(
        {
          "hub.mode": "subscribe",
          "hub.topic": topicForChannel("UCabc"),
          "hub.challenge": "challenge-value",
        },
        "0".repeat(32)
      ),
    });

    expect(response.statusCode).toBe(404);
    expect(findSpy).not.toHaveBeenCalled();
    expect([...expiries.keys()]).toEqual([]);
    await app.close();
  });

  it("rejects a channel whose request is older than the cooldown", async () => {
    const { expiries } = fakeChannelStore([
      {
        id: "UCabc",
        // Stamped long before the accepted window.
        pubsubRequestedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    ]);
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "challenge-value",
      }),
    });

    expect(response.statusCode).toBe(404);
    expect([...expiries.keys()]).toEqual([]);
    await app.close();
  });

  it("rejects a channel that was never requested", async () => {
    const { expiries } = fakeChannelStore([{ id: "UCabc" }]);
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "challenge-value",
      }),
    });

    expect(response.statusCode).toBe(404);
    expect([...expiries.keys()]).toEqual([]);
    await app.close();
  });

  it("rejects a channel we do not have at all", async () => {
    const { expiries } = fakeChannelStore([]);
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCother"),
        "hub.challenge": "challenge-value",
      }),
    });

    expect(response.statusCode).toBe(404);
    expect([...expiries.keys()]).toEqual([]);
    await app.close();
  });

  it("answers the challenge before the expiry is written", async () => {
    jest.spyOn(ChannelModel, "findOne").mockResolvedValue({
      id: "UCabc",
      pubsubRequestedAt: new Date(),
    } as never);
    let releaseWrite: (() => void) | undefined;
    let writeStarted = false;
    let writeFinished = false;
    jest.spyOn(ChannelModel, "updateOne").mockImplementation((() => {
      writeStarted = true;
      return new Promise((resolve) => {
        releaseWrite = () => {
          writeFinished = true;
          resolve({ acknowledged: true });
        };
      }) as never;
    }) as never);
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "challenge-value",
      }),
    });

    // The response is complete while the write is still in flight: that
    // ordering is the point. The reverse order would leave an expiry stored for
    // a subscription the hub never established.
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("challenge-value");
    expect(writeStarted).toBe(true);
    expect(writeFinished).toBe(false);

    releaseWrite?.();
    await drainPostResponseWork();
    expect(writeFinished).toBe(true);
    await app.close();
  });

  it("still answers the challenge when the expiry write fails", async () => {
    // The same store the passing cases use, told to fail this channel's write.
    // Because that store does record successful writes, "nothing was stored"
    // below is a real assertion — and an absent expiry is exactly what leaves
    // the channel eligible for another renewal.
    const { expiries, attempted } = fakeChannelStore(
      [{ id: "UCabc", pubsubRequestedAt: new Date() }],
      { failWriteFor: "UCabc" }
    );
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "challenge-value",
      }),
    });
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("challenge-value");
    // The write was attempted for the right channel and left nothing behind.
    expect(attempted.map((write) => write.id)).toEqual(["UCabc"]);
    expect([...expiries.keys()]).toEqual([]);
    await app.close();
  });

  it.each([
    ["missing", {}, PUBSUB_DEFAULT_LEASE_MS],
    ["not a number", { "hub.lease_seconds": "soon" }, PUBSUB_DEFAULT_LEASE_MS],
    ["zero", { "hub.lease_seconds": "0" }, PUBSUB_DEFAULT_LEASE_MS],
    ["fractional", { "hub.lease_seconds": "1.5" }, PUBSUB_DEFAULT_LEASE_MS],
    ["over the cap", { "hub.lease_seconds": "99999999" }, PUBSUB_MAX_LEASE_MS],
  ])("handles a lease that is %s", async (_label, extra, expectedMs) => {
    const { expiries } = fakeChannelStore([
      { id: "UCabc", pubsubRequestedAt: new Date() },
    ]);
    const app = await buildServer();
    const before = Date.now();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "c",
        ...(extra as Record<string, string>),
      }),
    });
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    const leaseMs = expiries.get("UCabc")!.getTime() - before;
    expect(leaseMs).toBeGreaterThanOrEqual(expectedMs - 5_000);
    expect(leaseMs).toBeLessThanOrEqual(expectedMs + 5_000);
    await app.close();
  });

  it("rejects an unsubscribe verification and ignores a denial", async () => {
    const { expiries } = fakeChannelStore([
      { id: "UCabc", pubsubRequestedAt: new Date() },
    ]);
    const app = await buildServer();

    const unsubscribed = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "unsubscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "c",
      }),
    });
    const denied = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "denied",
        "hub.topic": topicForChannel("UCabc"),
      }),
    });

    expect(unsubscribed.statusCode).toBe(404);
    expect(denied.statusCode).toBe(200);
    expect([...expiries.keys()]).toEqual([]);
    await app.close();
  });

  it("rejects a topic that is not a youtube feed topic", async () => {
    fakeChannelStore([{ id: "UCabc", pubsubRequestedAt: new Date() }]);
    const findSpy = jest.spyOn(ChannelModel, "findOne");
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": "https://evil.example/?channel_id=UCabc",
        "hub.challenge": "c",
      }),
    });

    expect(response.statusCode).toBe(404);
    expect(findSpy).not.toHaveBeenCalled();
    await app.close();
  });
});
