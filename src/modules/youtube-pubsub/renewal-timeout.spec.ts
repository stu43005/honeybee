/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { AxiosError } from "axios";

process.env.PUBLIC_BASE_URL = "https://honeybee.example.test/";
process.env.YOUTUBE_PUBSUB_SECRET = "test-secret";

type PostArgs = [
  url: string,
  body: string,
  config: { headers: Record<string, string>; timeout: number },
];

const mockPost = jest.fn<(...args: PostArgs) => Promise<unknown>>();
const mockSleep = jest.fn<(ms: number) => Promise<void>>();

// Only the transport is mocked here, so hub-client's real timeout handling and
// failure classification are part of what this test covers.
jest.unstable_mockModule("axios", () => {
  const isAxiosError = (error: unknown) =>
    !!error && (error as AxiosError).isAxiosError === true;
  return { default: { post: mockPost, isAxiosError }, isAxiosError };
});

jest.unstable_mockModule("node:timers/promises", () => ({
  setTimeout: mockSleep,
}));

const { default: ChannelModel } = await import("../../models/Channel.js");
const { renewPubsubSubscriptions } = await import("./renewal.js");
const {
  PUBSUB_RENEW_BATCH_SIZE,
  PUBSUB_REQUEST_SPACING_MS,
  PUBSUB_REQUEST_TIMEOUT_MS,
} = await import("../../constants.js");

describe("renewPubsubSubscriptions against a hub that stops answering", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    mockPost.mockReset();
    mockSleep.mockReset();
  });

  it("times the first request out, keeps going, and finishes within the bound", async () => {
    jest.useFakeTimers();
    mockSleep.mockResolvedValue(undefined);
    // The only externally visible evidence of how a failure was classified is
    // the warning, so it is captured rather than silenced.
    const warnings: string[] = [];
    jest.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    const writes: string[] = [];
    jest.spyOn(ChannelModel, "findPubsubRenewalCandidates").mockResolvedValue([
      { id: "UC1", name: "One" },
      { id: "UC2", name: "Two" },
      { id: "UC3", name: "Three" },
    ] as never);
    jest.spyOn(ChannelModel, "updateOne").mockImplementation(((filter: {
      id: string;
    }) => {
      writes.push(filter.id);
      return Promise.resolve({ acknowledged: true }) as never;
    }) as never);

    // The first channel's request never gets an answer until its own timeout
    // elapses; the rest answer immediately.
    let call = 0;
    mockPost.mockImplementation((_url, _body, config) => {
      call += 1;
      if (call > 1) return Promise.resolve({ status: 202 });
      return new Promise((_resolve, reject) => {
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
      });
    });

    const startedAt = Date.now();
    const round = renewPubsubSubscriptions();
    await jest.advanceTimersByTimeAsync(PUBSUB_REQUEST_TIMEOUT_MS);
    await round;
    const elapsedMs = Date.now() - startedAt;

    // The hung request really was classified as a timeout — not swallowed as a
    // success, and not mistaken for a network failure or for throttling.
    expect(warnings).toEqual([
      expect.stringContaining("Pubsub subscribe failed for [UC1] (timeout)"),
    ]);
    // And it did not abort the round.
    expect(writes).toEqual(["UC1", "UC2", "UC3"]);
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(mockPost.mock.calls.map((callArgs) => callArgs[2].timeout)).toEqual([
      PUBSUB_REQUEST_TIMEOUT_MS,
      PUBSUB_REQUEST_TIMEOUT_MS,
      PUBSUB_REQUEST_TIMEOUT_MS,
    ]);
    // And the whole round stayed inside the bound the batch size and the
    // per-request timeout imply, which is what makes job.touch() unnecessary.
    expect(elapsedMs).toBeLessThanOrEqual(
      PUBSUB_RENEW_BATCH_SIZE *
        (PUBSUB_REQUEST_TIMEOUT_MS + PUBSUB_REQUEST_SPACING_MS)
    );
  });
});
