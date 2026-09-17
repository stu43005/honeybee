/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { AxiosError } from "axios";
import crypto from "node:crypto";

// constants.ts reads the environment at module-eval time, so these must be set
// before anything imports it.
process.env.PUBLIC_BASE_URL = "https://honeybee.example.test/";
process.env.YOUTUBE_PUBSUB_SECRET = "test-secret";

type PostArgs = [
  url: string,
  body: string,
  config: { headers: Record<string, string>; timeout: number },
];

const mockPost = jest.fn<(...args: PostArgs) => Promise<unknown>>();

jest.unstable_mockModule("axios", () => {
  const isAxiosError = (error: unknown) =>
    !!error && (error as AxiosError).isAxiosError === true;
  return {
    default: { post: mockPost, isAxiosError },
    isAxiosError,
  };
});

const {
  channelIdFromTopic,
  getCallbackToken,
  getCallbackUrl,
  requestSubscription,
  topicForChannel,
} = await import("./hub-client.js");
const { PUBSUB_REQUEST_TIMEOUT_MS } = await import("../../constants.js");

function httpError(status: number): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    "ERR_BAD_REQUEST",
    undefined,
    {},
    { status } as never
  );
}

describe("callback url and topic helpers", () => {
  it("puts a stable 32-char token in the callback path", () => {
    const token = getCallbackToken();
    // Derived independently here, otherwise a wrong derivation would still pass
    // a shape-only check.
    const expected = crypto
      .createHmac("sha256", "test-secret")
      .update("pubsub-callback")
      .digest("hex")
      .slice(0, 32);

    expect(token).toBe(expected);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(getCallbackToken()).toBe(token);
    expect(getCallbackUrl()).toBe(
      `https://honeybee.example.test/notifications/youtube/${token}`
    );
  });

  it("round-trips a channel id through the topic url", () => {
    const topic = topicForChannel("UCabc");

    expect(topic).toBe(
      "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCabc"
    );
    expect(channelIdFromTopic(topic)).toBe("UCabc");
  });

  it("rejects a topic that is not a youtube feed topic", () => {
    expect(
      channelIdFromTopic("https://evil.example/?channel_id=UCabc")
    ).toBeNull();
    expect(
      channelIdFromTopic(
        "https://www.youtube.com/xml/feeds/videos.xml?channel_id="
      )
    ).toBeNull();
    expect(channelIdFromTopic(undefined)).toBeNull();
  });
});

describe("requestSubscription", () => {
  afterEach(() => {
    mockPost.mockReset();
    jest.useRealTimers();
  });

  it("posts the full subscribe form with an explicit timeout", async () => {
    mockPost.mockResolvedValue({ status: 202 });

    const result = await requestSubscription("UCabc");

    expect(result).toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe("https://pubsubhubbub.appspot.com/subscribe");
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      "hub.callback": getCallbackUrl(),
      "hub.mode": "subscribe",
      "hub.topic": topicForChannel("UCabc"),
      "hub.secret": "test-secret",
    });
    expect(config.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(config.timeout).toBe(PUBSUB_REQUEST_TIMEOUT_MS);
  });

  // Each case asserts the whole returned result and that the request really was
  // sent for that channel, so a classification that never reached the hub, or
  // one that reached it with the wrong topic, cannot pass.
  it.each([
    {
      label: "429, which is throttling",
      failure: () => httpError(429),
      expected: {
        ok: false,
        kind: "throttled",
        status: 429,
        message: "Request failed with status code 429",
      },
    },
    {
      label: "503, which is also throttling",
      failure: () => httpError(503),
      expected: {
        ok: false,
        kind: "throttled",
        status: 503,
        message: "Request failed with status code 503",
      },
    },
    {
      label: "400, which is not throttling",
      failure: () => httpError(400),
      expected: {
        ok: false,
        kind: "http",
        status: 400,
        message: "Request failed with status code 400",
      },
    },
    {
      label: "a timeout, distinctly from an http failure",
      failure: () =>
        new AxiosError("timeout of 10000ms exceeded", "ECONNABORTED"),
      expected: {
        ok: false,
        kind: "timeout",
        message: "timeout of 10000ms exceeded",
      },
    },
    {
      label: "a refused connection",
      failure: () => new AxiosError("connect ECONNREFUSED", "ECONNREFUSED"),
      expected: {
        ok: false,
        kind: "network",
        message: "connect ECONNREFUSED",
      },
    },
    {
      label: "a plain throw that is not an axios error",
      failure: () => new Error("boom"),
      expected: { ok: false, kind: "network", message: "boom" },
    },
  ])("classifies $label", async ({ failure, expected }) => {
    mockPost.mockRejectedValueOnce(failure());

    const result = await requestSubscription("UCabc");

    expect(result).toEqual(expected);
    expect(
      mockPost.mock.calls.map(
        (call) => Object.fromEntries(new URLSearchParams(call[1]))["hub.topic"]
      )
    ).toEqual([topicForChannel("UCabc")]);
  });

  it("applies the configured timeout to a transport that never answers", async () => {
    jest.useFakeTimers();
    // A transport that only fails once config.timeout has elapsed: this proves
    // the timeout is really handed down, and that expiry ends up classified as
    // a timeout instead of the call hanging forever.
    mockPost.mockImplementation(
      (_url, _body, config) =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                new AxiosError(
                  `timeout of ${config.timeout}ms exceeded`,
                  "ECONNABORTED"
                )
              ),
            config.timeout
          );
        })
    );

    const pending = requestSubscription("UCabc");
    await jest.advanceTimersByTimeAsync(PUBSUB_REQUEST_TIMEOUT_MS);

    expect(await pending).toEqual({
      ok: false,
      kind: "timeout",
      message: `timeout of ${PUBSUB_REQUEST_TIMEOUT_MS}ms exceeded`,
    });
  });
});
