/// <reference types="jest" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

process.env.PUBLIC_BASE_URL = "https://honeybee.example.test/";
process.env.YOUTUBE_PUBSUB_SECRET = "test-secret";

type SubscribeResult = Awaited<
  ReturnType<typeof import("./hub-client.js").requestSubscription>
>;

const mockRequestSubscription =
  jest.fn<(channelId: string) => Promise<SubscribeResult>>();
const mockSleep = jest.fn<(ms: number) => Promise<void>>();

jest.unstable_mockModule("./hub-client.js", () => ({
  requestSubscription: mockRequestSubscription,
}));

// Sleeping for real would only slow the suite down, and the mock also lets the
// spacing be asserted.
jest.unstable_mockModule("node:timers/promises", () => ({
  setTimeout: mockSleep,
}));

const { default: ChannelModel } = await import("../../models/Channel.js");
const { renewPubsubSubscriptions } = await import("./renewal.js");
const { PUBSUB_RENEW_BATCH_SIZE, PUBSUB_REQUEST_SPACING_MS } =
  await import("../../constants.js");

// A stateful fake channel collection that records the order of writes.
function fakeChannels(ids: string[]) {
  const writes: string[] = [];
  const candidates = ids.map((id) => ({ id, name: `Channel ${id}` }));
  const findSpy = jest
    .spyOn(ChannelModel, "findPubsubRenewalCandidates")
    .mockResolvedValue(candidates as never);
  const updateSpy = jest
    .spyOn(ChannelModel, "updateOne")
    .mockImplementation(((filter: { id: string }) => {
      writes.push(filter.id);
      return Promise.resolve({ acknowledged: true }) as never;
    }) as never);
  return { writes, findSpy, updateSpy };
}

describe("renewPubsubSubscriptions", () => {
  beforeEach(() => {
    mockSleep.mockResolvedValue(undefined);
    mockRequestSubscription.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockRequestSubscription.mockReset();
    mockSleep.mockReset();
  });

  it("asks for at most one batch and handles exactly what it got", async () => {
    const { writes, findSpy } = fakeChannels(["UC1"]);

    await renewPubsubSubscriptions();

    // One query, capped at the batch size — no paging, no second round.
    expect(findSpy.mock.calls.map((call) => call[0])).toEqual([
      PUBSUB_RENEW_BATCH_SIZE,
    ]);
    expect(writes).toEqual(["UC1"]);
    expect(mockRequestSubscription.mock.calls.map((call) => call[0])).toEqual([
      "UC1",
    ]);
  });

  it("stamps the request time before sending the request", async () => {
    const order: string[] = [];
    const candidates = [{ id: "UC1", name: "One" }];
    jest
      .spyOn(ChannelModel, "findPubsubRenewalCandidates")
      .mockResolvedValue(candidates as never);
    jest.spyOn(ChannelModel, "updateOne").mockImplementation(((
      _filter: unknown,
      update: { $set: { pubsubRequestedAt: Date } }
    ) => {
      order.push("write");
      expect(update.$set.pubsubRequestedAt).toBeInstanceOf(Date);
      return Promise.resolve({ acknowledged: true }) as never;
    }) as never);
    // Not an async arrow: an async function with no await fails
    // @typescript-eslint/require-await, which lint treats as an error.
    mockRequestSubscription.mockImplementation(() => {
      order.push("request");
      return Promise.resolve({ ok: true });
    });

    await renewPubsubSubscriptions();

    expect(order).toEqual(["write", "request"]);
  });

  it("processes every candidate and spaces the requests", async () => {
    const { writes } = fakeChannels(["UC1", "UC2", "UC3"]);

    await renewPubsubSubscriptions();

    expect(writes).toEqual(["UC1", "UC2", "UC3"]);
    expect(mockRequestSubscription.mock.calls.map((call) => call[0])).toEqual([
      "UC1",
      "UC2",
      "UC3",
    ]);
    // No need to wait after the last one.
    expect(mockSleep.mock.calls).toEqual([
      [PUBSUB_REQUEST_SPACING_MS],
      [PUBSUB_REQUEST_SPACING_MS],
    ]);
  });

  it("waits for a hanging request, classifies it, and still runs the rest", async () => {
    const { writes } = fakeChannels(["UC1", "UC2", "UC3"]);
    // A request that only settles when released, standing in for a hub that
    // does not answer until the client times out.
    let releaseFirst: ((result: SubscribeResult) => void) | undefined;
    let firstRequestEntered: (() => void) | undefined;
    const enteredFirstRequest = new Promise<void>((resolve) => {
      firstRequestEntered = resolve;
    });
    mockRequestSubscription.mockImplementationOnce(
      () =>
        new Promise<SubscribeResult>((resolve) => {
          firstRequestEntered?.();
          releaseFirst = resolve;
        })
    );

    const round = renewPubsubSubscriptions();

    // Explicit drain point: wait until the loop is actually inside the first
    // request. Counting microtasks would be wrong, because the candidate query
    // and the timestamp write are awaited before the request goes out.
    await enteredFirstRequest;
    expect(writes).toEqual(["UC1"]);
    expect(mockRequestSubscription).toHaveBeenCalledTimes(1);

    releaseFirst?.({
      ok: false,
      kind: "timeout",
      message: "timeout of 10000ms exceeded",
    });
    await round;

    // A timeout is not throttling, so the round runs to completion.
    expect(writes).toEqual(["UC1", "UC2", "UC3"]);
    expect(mockRequestSubscription.mock.calls.map((call) => call[0])).toEqual([
      "UC1",
      "UC2",
      "UC3",
    ]);
  });

  // `as const` matters: without it the statuses widen to `number`, which the
  // throttled variant of the result type does not accept.
  it.each([429, 503] as const)(
    "stops the round as soon as the hub answers %i",
    async (status) => {
      const { writes } = fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
      mockRequestSubscription
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: false,
          kind: "throttled",
          status,
          message: `Request failed with status code ${status}`,
        });

      await renewPubsubSubscriptions();

      expect(mockRequestSubscription.mock.calls.map((call) => call[0])).toEqual(
        ["UC1", "UC2", "UC3"]
      );
      // The fourth and fifth never even get their pubsubRequestedAt written.
      expect(writes).toEqual(["UC1", "UC2", "UC3"]);
    }
  );

  it("keeps going after a non-rate-limit failure, including a timeout", async () => {
    const { writes } = fakeChannels(["UC1", "UC2", "UC3"]);
    mockRequestSubscription
      .mockResolvedValueOnce({
        ok: false,
        kind: "timeout",
        message: "timeout of 10000ms exceeded",
      })
      .mockResolvedValueOnce({
        ok: false,
        kind: "http",
        status: 400,
        message: "Request failed with status code 400",
      })
      .mockResolvedValueOnce({ ok: true });

    await renewPubsubSubscriptions();

    expect(mockRequestSubscription).toHaveBeenCalledTimes(3);
    expect(writes).toEqual(["UC1", "UC2", "UC3"]);
  });

  it("does nothing when there is no candidate", async () => {
    const { writes } = fakeChannels([]);

    await renewPubsubSubscriptions();

    expect(writes).toEqual([]);
    expect(mockRequestSubscription.mock.calls).toEqual([]);
    expect(mockSleep.mock.calls).toEqual([]);
  });
});
