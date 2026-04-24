import { describe, expect, it, jest } from "@jest/globals";
import type BeeQueue from "bee-queue";
import { WatchError, type RedisClientType } from "redis";
import { scheduleAndEnqueue, buildJobId, buildPendingKey } from "./queue.js";
import type { WebhookJob } from "../../interfaces.js";

// Each exec step is either "ok" (resolves) or "watch-abort" (throws WatchError).
type ExecOutcome = "ok" | "watch-abort";

type MockRedis = {
  watch: jest.Mock;
  get: jest.Mock;
  unwatch: jest.Mock;
  multi: jest.Mock;
  set: jest.Mock;
};

type MockQueue = {
  getJob: jest.Mock;
  createJob: jest.Mock;
};

function createMockRedis(
  initialNextKey: string | null = null,
  execSequence: ExecOutcome[] = ["ok"]
): MockRedis {
  const seq = [...execSequence];
  const execFn = jest.fn<() => Promise<string[]>>(() => {
    const next = seq.shift() ?? "ok";
    if (next === "watch-abort") {
      return Promise.reject(new WatchError());
    }
    return Promise.resolve(["OK"]);
  });
  const multiObj: { set: jest.Mock; exec: jest.Mock } = {
    set: jest.fn<() => typeof multiObj>(),
    exec: execFn,
  };
  // set must return multiObj for chaining: multi.set(...).exec()
  multiObj.set.mockReturnValue(multiObj);
  return {
    watch: jest.fn<() => Promise<string>>().mockResolvedValue("OK"),
    get: jest
      .fn<() => Promise<string | null>>()
      .mockResolvedValue(initialNextKey),
    unwatch: jest.fn<() => Promise<string>>().mockResolvedValue("OK"),
    multi: jest.fn<() => typeof multiObj>().mockReturnValue(multiObj),
    set: jest.fn<() => Promise<string>>().mockResolvedValue("OK"),
  };
}

function createMockQueue(inFlight = false): MockQueue {
  type SaveResult = { id: string };
  type DelayUntilResult = { save: jest.Mock<() => Promise<SaveResult>> };
  type SetIdResult = {
    save: jest.Mock<() => Promise<SaveResult>>;
    delayUntil: jest.Mock<() => DelayUntilResult>;
  };
  type CreateJobResult = { setId: jest.Mock<() => SetIdResult> };

  const saveFn = jest
    .fn<() => Promise<SaveResult>>()
    .mockResolvedValue({ id: "some-id" });
  const delayUntilFn = jest
    .fn<() => DelayUntilResult>()
    .mockReturnValue({ save: saveFn });
  const setIdFn = jest
    .fn<() => SetIdResult>()
    .mockReturnValue({ save: saveFn, delayUntil: delayUntilFn });
  const createJobFn = jest
    .fn<() => CreateJobResult>()
    .mockReturnValue({ setId: setIdFn });
  return {
    getJob: jest
      .fn<() => Promise<{ id: string } | null>>()
      .mockResolvedValue(inFlight ? { id: "exists" } : null),
    createJob: createJobFn,
  };
}

const sampleJob: WebhookJob = {
  webhookId: "wh1",
  coll: "chats",
  docId: "doc1",
  operationType: "update",
};

describe("scheduleAndEnqueue", () => {
  it("returns 'immediate' when nextAllowed is absent and queue is empty", async () => {
    const redis = createMockRedis(null);
    const queue = createMockQueue(false);
    const result = await scheduleAndEnqueue(
      queue as unknown as BeeQueue<WebhookJob>,
      redis as unknown as RedisClientType,
      sampleJob,
      1_000_000,
      5000
    );
    expect(result).toBe("immediate");
    expect(redis.watch).toHaveBeenCalled();
    expect(queue.createJob).toHaveBeenCalledWith(sampleJob);
  });

  it("returns 'coalesced' when an in-flight job exists", async () => {
    const redis = createMockRedis("1000500");
    const queue = createMockQueue(true);
    const result = await scheduleAndEnqueue(
      queue as unknown as BeeQueue<WebhookJob>,
      redis as unknown as RedisClientType,
      sampleJob,
      1_000_000,
      5000
    );
    expect(result).toBe("coalesced");
    expect(redis.unwatch).toHaveBeenCalled();
    expect(queue.createJob).not.toHaveBeenCalled();
  });

  it("returns 'delayed' when now < nextAllowed", async () => {
    // nextAllowed = 1_002_000, now = 1_000_000 → delay 2000ms
    const redis = createMockRedis("1002000");
    const queue = createMockQueue(false);
    const result = await scheduleAndEnqueue(
      queue as unknown as BeeQueue<WebhookJob>,
      redis as unknown as RedisClientType,
      sampleJob,
      1_000_000,
      5000
    );
    expect(result).toBe("delayed");
    expect(queue.createJob).toHaveBeenCalled();
  });

  it("retries when exec throws WatchError and eventually succeeds", async () => {
    const redis = createMockRedis(null, ["watch-abort", "ok"]);
    const queue = createMockQueue(false);
    const result = await scheduleAndEnqueue(
      queue as unknown as BeeQueue<WebhookJob>,
      redis as unknown as RedisClientType,
      sampleJob,
      1_000_000,
      5000
    );
    expect(result).toBe("immediate");
    // watch called twice (once per attempt)
    expect(redis.watch).toHaveBeenCalledTimes(2);
  });

  it("falls back to delayed push after 5 WatchError retries and advances nextKey", async () => {
    const redis = createMockRedis(null, [
      "watch-abort",
      "watch-abort",
      "watch-abort",
      "watch-abort",
      "watch-abort",
    ]);
    const queue = createMockQueue(false);
    const result = await scheduleAndEnqueue(
      queue as unknown as BeeQueue<WebhookJob>,
      redis as unknown as RedisClientType,
      sampleJob,
      1_000_000,
      5000
    );
    expect(result).toBe("fallback-delayed");
    // non-transactional SET invoked to advance nextKey
    expect(redis.set).toHaveBeenCalled();
    expect(queue.createJob).toHaveBeenCalled();
  });

  it("rethrows non-WatchError exec failures without retry", async () => {
    const redis = createMockRedis(null);
    // Override exec to throw a generic error
    redis.multi.mockReturnValue({
      set: jest.fn<() => unknown>().mockReturnThis(),
      exec: jest
        .fn<() => Promise<never>>()
        .mockRejectedValue(new Error("connection lost")),
    });
    const queue = createMockQueue(false);
    await expect(
      scheduleAndEnqueue(
        queue as unknown as BeeQueue<WebhookJob>,
        redis as unknown as RedisClientType,
        sampleJob,
        1_000_000,
        5000
      )
    ).rejects.toThrow("connection lost");
  });

  it("sets pending key before entering WATCH loop", async () => {
    const callOrder: string[] = [];
    const redis = createMockRedis(null);
    (
      redis.set as jest.Mock<(key: string) => Promise<string>>
    ).mockImplementation((key: string) => {
      callOrder.push(`set:${key}`);
      return Promise.resolve("OK");
    });
    (redis.watch as jest.Mock<() => Promise<string>>).mockImplementation(() => {
      callOrder.push("watch");
      return Promise.resolve("OK");
    });

    const queue = createMockQueue(false);
    await scheduleAndEnqueue(
      queue as unknown as BeeQueue<WebhookJob>,
      redis as unknown as RedisClientType,
      sampleJob,
      1_000_000,
      5000
    );

    const pendingKey = buildPendingKey(buildJobId(sampleJob));
    const setPendingIdx = callOrder.indexOf(`set:${pendingKey}`);
    const watchIdx = callOrder.indexOf("watch");
    expect(setPendingIdx).toBeGreaterThanOrEqual(0);
    expect(setPendingIdx).toBeLessThan(watchIdx);
  });
});

describe("buildPendingKey", () => {
  it("returns webhook:pending: prefixed jobId", () => {
    const job: WebhookJob = {
      webhookId: "wh1",
      coll: "chats",
      docId: "doc1",
      operationType: "update",
    };
    const jobId = buildJobId(job);
    expect(buildPendingKey(jobId)).toBe("webhook:pending:wh1:chats:doc1");
  });
});
