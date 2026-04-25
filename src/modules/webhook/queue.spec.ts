import { describe, expect, it, jest } from "@jest/globals";
import type BeeQueue from "bee-queue";
import { WatchError, type RedisClientType } from "redis";
import {
  scheduleAndEnqueue,
  buildJobId,
  buildPendingKey,
  WebhookQueueConsumerModule,
} from "./queue.js";
import type { WebhookJob } from "../../interfaces.js";
import type { Application } from "../application.js";

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

// ---------------------------------------------------------------------------
// Consumer module test infrastructure
// ---------------------------------------------------------------------------

class FakeQueue {
  private processHandler:
    | ((job: BeeQueue.Job<WebhookJob>) => Promise<void>)
    | null = null;
  private readonly succeededHandlers: Array<
    (job: BeeQueue.Job<WebhookJob>) => void
  > = [];

  readonly ready = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  readonly close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  readonly checkHealth = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);

  process(
    _concurrency: number,
    handler: (job: BeeQueue.Job<WebhookJob>) => Promise<void>
  ): void {
    this.processHandler = handler;
  }

  on(event: string, handler: (job: BeeQueue.Job<WebhookJob>) => void): this {
    if (event === "succeeded") this.succeededHandlers.push(handler);
    return this;
  }

  async triggerJob(jobData: WebhookJob): Promise<void> {
    if (!this.processHandler)
      throw new Error("FakeQueue: no process handler registered");
    await this.processHandler({
      data: jobData,
    } as unknown as BeeQueue.Job<WebhookJob>);
  }

  emitSucceeded(jobData: WebhookJob): void {
    for (const h of this.succeededHandlers)
      h({ data: jobData } as unknown as BeeQueue.Job<WebhookJob>);
  }
}

type ConsumerRedis = {
  del: jest.Mock<(key: string) => Promise<number>>;
  exists: jest.Mock<(key: string) => Promise<number>>;
};

function createConsumerRedis(existsReturn = 0): ConsumerRedis {
  return {
    del: jest.fn<(key: string) => Promise<number>>().mockResolvedValue(1),
    exists: jest
      .fn<(key: string) => Promise<number>>()
      .mockResolvedValue(existsReturn),
  };
}

type MockProducer = {
  scheduleAndEnqueue: jest.Mock<(job: WebhookJob) => Promise<string>>;
};

function createMockProducer(): MockProducer {
  return {
    scheduleAndEnqueue: jest
      .fn<(job: WebhookJob) => Promise<string>>()
      .mockResolvedValue("immediate"),
  };
}

function createConsumerApp(redis: ConsumerRedis, producer: MockProducer) {
  return {
    get: jest
      .fn<(name: string) => unknown>()
      .mockImplementation((name: string) => {
        if (name === "redis") return { redis };
        if (name === "webhook-queue-producer") return producer;
        return undefined;
      }),
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

describe("WebhookQueueConsumerModule", () => {
  const jobData: WebhookJob = {
    webhookId: "wh1",
    coll: "chats",
    docId: "doc1",
    operationType: "insert",
  };
  const pendingKey = buildPendingKey(buildJobId(jobData));

  function makeModule(
    redis: ConsumerRedis,
    producer: MockProducer,
    fakeQueue: FakeQueue
  ) {
    const mockApp = createConsumerApp(redis, producer);
    const mod = new WebhookQueueConsumerModule(
      mockApp as unknown as Application,
      () => fakeQueue as unknown as BeeQueue<WebhookJob>
    );
    mod.setHandler(
      jest
        .fn<(job: BeeQueue.Job<WebhookJob>) => Promise<void>>()
        .mockResolvedValue(undefined)
    );
    return mod;
  }

  it("DELs pending key before invoking handler", async () => {
    const fakeQueue = new FakeQueue();
    const redis = createConsumerRedis(0);
    const producer = createMockProducer();
    const callOrder: string[] = [];
    redis.del.mockImplementation((key) => {
      callOrder.push(`del:${key}`);
      return Promise.resolve(1);
    });

    const mod = makeModule(redis, producer, fakeQueue);
    // Override handler to record its invocation order
    mod.setHandler(
      jest
        .fn<(job: BeeQueue.Job<WebhookJob>) => Promise<void>>()
        .mockImplementation(() => {
          callOrder.push("handler");
          return Promise.resolve();
        })
    );
    await mod.init();

    await fakeQueue.triggerJob(jobData);

    expect(callOrder).toEqual([`del:${pendingKey}`, "handler"]);
  });

  it("reschedules with operationType='update' when pending flag exists at job completion", async () => {
    const fakeQueue = new FakeQueue();
    const redis = createConsumerRedis(1); // exists returns 1 — pending was set during processing
    const producer = createMockProducer();
    const mod = makeModule(redis, producer, fakeQueue);
    await mod.init();

    await fakeQueue.triggerJob(jobData);
    fakeQueue.emitSucceeded(jobData);

    const snapshot = Array.from(mod.pendingSucceededWork);
    await Promise.allSettled(snapshot);

    expect(producer.scheduleAndEnqueue).toHaveBeenCalledTimes(1);
    expect(producer.scheduleAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ ...jobData, operationType: "update" })
    );
    // Verify consumer relies on producer defaults for now/cooldown (single-arg call)
    expect(producer.scheduleAndEnqueue.mock.calls[0]).toHaveLength(1);
  });

  it("does not reschedule when no pending flag at job completion", async () => {
    const fakeQueue = new FakeQueue();
    const redis = createConsumerRedis(0); // no pending
    const producer = createMockProducer();
    const mod = makeModule(redis, producer, fakeQueue);
    await mod.init();

    await fakeQueue.triggerJob(jobData);
    fakeQueue.emitSucceeded(jobData);

    const snapshot = Array.from(mod.pendingSucceededWork);
    await Promise.allSettled(snapshot);

    expect(producer.scheduleAndEnqueue).not.toHaveBeenCalled();
  });

  it("pending DEL in succeeded listener prevents double-reschedule (multiple coalesced SETs → one reschedule)", async () => {
    // Multiple changeStream events during active processing each SET the same pending
    // key (idempotent in Redis). The succeeded listener DELs the flag before
    // rescheduling, so a second EXISTS returns 0 (the DEL already ran) — no double-reschedule.
    const fakeQueue = new FakeQueue();
    // Stateful redis: starts empty; handler simulates two coalesced SETs; listener DEL drives EXISTS→0
    const pendingKeys = new Set<string>();
    const redis: ConsumerRedis = {
      del: jest
        .fn<(key: string) => Promise<number>>()
        .mockImplementation((k) => {
          const had = pendingKeys.delete(k);
          return Promise.resolve(had ? 1 : 0);
        }),
      exists: jest
        .fn<(key: string) => Promise<number>>()
        .mockImplementation((k) => Promise.resolve(pendingKeys.has(k) ? 1 : 0)),
    };
    const producer = createMockProducer();
    const mockApp = createConsumerApp(redis, producer);
    const mod = new WebhookQueueConsumerModule(
      mockApp as unknown as Application,
      () => fakeQueue as unknown as BeeQueue<WebhookJob>
    );
    // Handler simulates two coalesced changeStream events SETting the same pending key
    // while the job is active (two SETs of the same key are idempotent in Redis).
    mod.setHandler(
      jest
        .fn<(job: BeeQueue.Job<WebhookJob>) => Promise<void>>()
        .mockImplementation(() => {
          pendingKeys.add(pendingKey);
          pendingKeys.add(pendingKey); // idempotent second SET
          return Promise.resolve();
        })
    );
    await mod.init();

    await fakeQueue.triggerJob(jobData); // job-start DEL: no-op (empty set); handler adds key twice

    fakeQueue.emitSucceeded(jobData); // listener: EXISTS=1 → DEL + reschedule
    const snap1 = Array.from(mod.pendingSucceededWork);
    await Promise.allSettled(snap1);

    fakeQueue.emitSucceeded(jobData); // listener: EXISTS=0 (DELed by first reschedule) → no reschedule
    const snap2 = Array.from(mod.pendingSucceededWork);
    await Promise.allSettled(snap2);

    expect(producer.scheduleAndEnqueue).toHaveBeenCalledTimes(1);
  });

  it("job-start DEL clears a pre-existing pending flag (delayed job reads fresh state, no reschedule)", async () => {
    // Scenario: pending was SET before the job started (e.g., while the job was
    // waiting/delayed). The job-start DEL clears it before the handler reads the doc
    // (which already has the latest state). The post-job EXISTS check returns 0 — no reschedule.
    const fakeQueue = new FakeQueue();
    // Stateful redis: del removes the key, exists reports its presence
    const pendingKeys = new Set<string>([pendingKey]); // pre-existing pending
    const redis: ConsumerRedis = {
      del: jest
        .fn<(key: string) => Promise<number>>()
        .mockImplementation((k) => {
          const had = pendingKeys.delete(k);
          return Promise.resolve(had ? 1 : 0);
        }),
      exists: jest
        .fn<(key: string) => Promise<number>>()
        .mockImplementation((k) => Promise.resolve(pendingKeys.has(k) ? 1 : 0)),
    };
    const producer = createMockProducer();
    const mod = makeModule(redis, producer, fakeQueue);
    await mod.init();

    // Job-start DEL clears the pre-existing pending flag before handler runs
    await fakeQueue.triggerJob(jobData);
    // Post-job EXISTS=0 (cleared by job-start DEL) → no reschedule
    fakeQueue.emitSucceeded(jobData);
    await Promise.allSettled(Array.from(mod.pendingSucceededWork));

    expect(redis.del).toHaveBeenCalledWith(pendingKey);
    expect(producer.scheduleAndEnqueue).not.toHaveBeenCalled();
  });

  it("close() drains succeeded work registered during microtask flush (setImmediate gap)", async () => {
    // close() must yield via setImmediate so succeeded emits queued as microtasks
    // during queue.close() can register their work before closed=true is set.
    const fakeQueue = new FakeQueue();
    const redis = createConsumerRedis(1); // pending exists
    const producer = createMockProducer();
    const mod = makeModule(redis, producer, fakeQueue);
    await mod.init();

    await fakeQueue.triggerJob(jobData);
    // Schedule the emit as a microtask racing with close() — exercises the setImmediate gap
    queueMicrotask(() => fakeQueue.emitSucceeded(jobData));

    await mod.close();

    // Producer must have been called before close() returned
    expect(producer.scheduleAndEnqueue).toHaveBeenCalledTimes(1);
  });

  it("ignores succeeded events fired after close() completes", async () => {
    const fakeQueue = new FakeQueue();
    const redis = createConsumerRedis(1); // pending exists
    const producer = createMockProducer();
    const mod = makeModule(redis, producer, fakeQueue);
    await mod.init();

    await mod.close();

    fakeQueue.emitSucceeded(jobData);
    expect(mod.pendingSucceededWork.size).toBe(0);
    await new Promise<void>((r) => setImmediate(r));
    expect(producer.scheduleAndEnqueue).not.toHaveBeenCalled();
  });
});
