# Webhook Pending Reschedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the lost-event race where MongoDB changeStream events arriving during active job processing are permanently dropped by adding a Redis pending flag that triggers a reschedule after the job completes.

**Architecture:** `scheduleAndEnqueue` SETs `webhook:pending:{jobId}` before the WATCH loop. The worker DELs it at job start (①). The bee-queue `succeeded` listener (③) checks EXISTS and reschedules when found. `WebhookQueueConsumerModule` gains `app` injection to access `RedisModule` and `WebhookQueueProducerModule`, plus a `pendingSucceededWork` Set and updated `close()` to drain async ③ work before the producer shuts down. Registration order in `webhook.ts` changes to ensure producer outlives consumer during shutdown (LIFO).

**Tech Stack:** bee-queue, node-redis v4, TypeScript, Jest (ts-jest ESM)

---

## File Map

| Action | Path                                |
| ------ | ----------------------------------- |
| Modify | `src/modules/webhook/queue.ts`      |
| Modify | `src/modules/webhook/queue.spec.ts` |
| Modify | `src/commands/webhook.ts`           |

---

### Task 1: Add `buildPendingKey` helper

**Files:**

- Modify: `src/modules/webhook/queue.ts`
- Test: `src/modules/webhook/queue.spec.ts`

- [ ] **Step 1: Update imports in test file**

In `src/modules/webhook/queue.spec.ts`, replace the existing import line:

```typescript
import { scheduleAndEnqueue } from "./queue.js";
```

with:

```typescript
import { scheduleAndEnqueue, buildJobId, buildPendingKey } from "./queue.js";
```

- [ ] **Step 2: Write the failing test**

In `src/modules/webhook/queue.spec.ts`, append a new `describe` block after the closing `});` of the existing `describe("scheduleAndEnqueue", ...)`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

```bash
NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/webhook/queue.spec.ts --testNamePattern="buildPendingKey"
```

Expected: FAIL — `buildPendingKey` is not exported from `./queue.js`

- [ ] **Step 4: Add `buildPendingKey` to `queue.ts`**

In `src/modules/webhook/queue.ts`, after the `buildNextKey` function:

```typescript
export function buildNextKey(jobId: string): string {
  return `webhook:next:${jobId}`;
}
```

add:

```typescript
export function buildPendingKey(jobId: string): string {
  return `webhook:pending:${jobId}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/webhook/queue.spec.ts --testNamePattern="buildPendingKey"
```

Expected: PASS

- [ ] **Step 6: Run all queue tests to verify no regressions**

```bash
NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/webhook/queue.spec.ts
```

Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add src/modules/webhook/queue.ts src/modules/webhook/queue.spec.ts
git commit -m "feat(webhook): add buildPendingKey helper"
```

---

### Task 2: Producer — SET pending key before WATCH loop

**Files:**

- Modify: `src/modules/webhook/queue.ts` (`scheduleAndEnqueue` function body)
- Test: `src/modules/webhook/queue.spec.ts`

- [ ] **Step 1: Write the failing test**

In `src/modules/webhook/queue.spec.ts`, add the following test inside the existing `describe("scheduleAndEnqueue", ...)` block (after the last existing `it(...)` but before the closing `});`):

```typescript
it("sets pending key before entering WATCH loop", async () => {
  const callOrder: string[] = [];
  const redis = createMockRedis(null);
  (redis.set as jest.Mock).mockImplementation((key: string) => {
    callOrder.push(`set:${key}`);
    return Promise.resolve("OK");
  });
  (redis.watch as jest.Mock).mockImplementation(() => {
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/webhook/queue.spec.ts --testNamePattern="sets pending key"
```

Expected: FAIL — `setPendingIdx` is -1 (SET not called before WATCH loop)

- [ ] **Step 3: Add pending key SET to `scheduleAndEnqueue`**

In `src/modules/webhook/queue.ts`, find the `scheduleAndEnqueue` function. After the lines:

```typescript
const jobId = buildJobId(job);
const nextKey = buildNextKey(jobId);
let lastNextAllowed = 0;
```

change to:

```typescript
const jobId = buildJobId(job);
const nextKey = buildNextKey(jobId);
const pendingKey = buildPendingKey(jobId);
// SET before WATCH loop: one write regardless of WatchError retries, keeps pending race window minimal
await redis.set(pendingKey, "1", {
  PX: WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS,
});
let lastNextAllowed = 0;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/webhook/queue.spec.ts --testNamePattern="sets pending key"
```

Expected: PASS

- [ ] **Step 5: Run all queue tests to verify no regressions**

```bash
NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/webhook/queue.spec.ts
```

Expected: all PASS — existing tests assert `redis.set` with `toHaveBeenCalled()` (not arg-checked), so the new unconditional SET does not break them.

- [ ] **Step 6: Commit**

```bash
git add src/modules/webhook/queue.ts src/modules/webhook/queue.spec.ts
git commit -m "feat(webhook): SET pending flag before WATCH loop in scheduleAndEnqueue"
```

---

### Task 3: Consumer module — pending DEL, succeeded listener, graceful drain

**Files:**

- Modify: `src/modules/webhook/queue.ts` (`WebhookQueueConsumerModule` class)
- Test: `src/modules/webhook/queue.spec.ts`

- [ ] **Step 1: Add new imports to `queue.spec.ts`**

In `src/modules/webhook/queue.spec.ts`, update the import block at the top. Replace:

```typescript
import { describe, expect, it, jest } from "@jest/globals";
import type BeeQueue from "bee-queue";
import { WatchError, type RedisClientType } from "redis";
import { scheduleAndEnqueue, buildJobId, buildPendingKey } from "./queue.js";
import type { WebhookJob } from "../../interfaces.js";
```

with:

```typescript
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
```

- [ ] **Step 2: Add test infrastructure classes and factories**

In `src/modules/webhook/queue.spec.ts`, append the following after the `createMockQueue` factory function (after its closing `}`), before `const sampleJob`:

```typescript
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
```

- [ ] **Step 3: Write the consumer module tests**

In `src/modules/webhook/queue.spec.ts`, append a new `describe` block after the `describe("buildPendingKey", ...)` block:

```typescript
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
    // Stateful redis: the listener's DEL is what drives EXISTS→0 on the second emit
    const pendingKeys = new Set<string>([pendingKey]); // pending set during active processing
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

    await fakeQueue.triggerJob(jobData); // job-start DEL: no-op (key added back above for this test)

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

  it("reschedules regardless of job processing duration (processing >= cooldown path)", async () => {
    // Consumer always calls scheduleAndEnqueue({…, operationType:'update'}) with one
    // argument; immediate-vs-delayed branch selection lives inside the producer wrapper
    // (WebhookQueueProducerModule.scheduleAndEnqueue) and is not tested here.
    const fakeQueue = new FakeQueue();
    const redis = createConsumerRedis(1);
    const producer = createMockProducer();
    const mod = makeModule(redis, producer, fakeQueue);
    await mod.init();

    await fakeQueue.triggerJob(jobData);
    fakeQueue.emitSucceeded(jobData);
    await Promise.allSettled(Array.from(mod.pendingSucceededWork));

    expect(producer.scheduleAndEnqueue).toHaveBeenCalledTimes(1);
    expect(producer.scheduleAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ ...jobData, operationType: "update" })
    );
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
```

- [ ] **Step 4: Run the new tests to verify they fail**

```bash
NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/webhook/queue.spec.ts --testNamePattern="WebhookQueueConsumerModule"
```

Expected: FAIL — The new tests reference `WebhookQueueConsumerModule` APIs (constructor accepting `app` + `queueFactory`, `pendingSucceededWork` property, `close()` draining, `setHandler`/`init` flow) that do not yet exist or do not match the current implementation. Type errors or runtime errors are both acceptable failure signals.

- [ ] **Step 5: Add `documentLog` import to `queue.ts`**

In `src/modules/webhook/queue.ts`, add to the imports section (after the `import { RedisModule }` line):

```typescript
import { documentLog } from "../db.js";
```

- [ ] **Step 6: Replace `WebhookQueueConsumerModule` class in `queue.ts`**

In `src/modules/webhook/queue.ts`, replace the entire `WebhookQueueConsumerModule` class (from `export class WebhookQueueConsumerModule` through its closing `}`) with:

```typescript
/**
 * Application module that manages the bee-queue worker lifecycle for this
 * instance, plus the pending-flag reschedule mechanism.
 *
 * Registration order: must be registered AFTER RedisModule and
 * WebhookQueueProducerModule. LIFO close means this module closes BEFORE the
 * producer, guaranteeing that all reschedule calls emitted during drain complete
 * while the producer's queue connection is still alive.
 *
 * Shutdown: close() first waits for bee-queue to drain in-flight handlers, then
 * yields via setImmediate so queued `succeeded` microtasks can register their
 * work, then marks the module closed (subsequent emits are ignored), then awaits
 * all registered post-job work via Promise.allSettled.
 */
export class WebhookQueueConsumerModule implements Module {
  public readonly name = "webhook-queue-consumer";
  public isInit = false;

  public readonly queue: BeeQueue<WebhookJob>;
  private handler: ((job: BeeQueue.Job<WebhookJob>) => Promise<void>) | null =
    null;
  private redis!: RedisClientType;
  private producer!: WebhookQueueProducerModule;
  readonly pendingSucceededWork = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly app: Application,
    queueFactory: () => BeeQueue<WebhookJob> = () =>
      createWebhookQueue({ isWorker: true })
  ) {
    this.queue = queueFactory();
  }

  setHandler(handler: (job: BeeQueue.Job<WebhookJob>) => Promise<void>): void {
    this.handler = handler;
  }

  async init(): Promise<void> {
    if (!this.handler) {
      throw new Error(
        "WebhookQueueConsumerModule.init called before setHandler"
      );
    }
    const redisModule = this.app.get<RedisModule>("redis");
    if (!redisModule) {
      throw new Error("WebhookQueueConsumerModule: RedisModule not found");
    }
    this.redis = redisModule.redis;

    const producer = this.app.get<WebhookQueueProducerModule>(
      "webhook-queue-producer"
    );
    if (!producer) {
      throw new Error(
        "WebhookQueueConsumerModule: WebhookQueueProducerModule not found"
      );
    }
    this.producer = producer;

    await this.queue.ready();

    this.queue.process(WEBHOOK_WORKER_CONCURRENCY, async (job) => {
      const jobId = buildJobId(job.data);
      const pendingKey = buildPendingKey(jobId);
      await this.redis.del(pendingKey);
      await this.handler!(job);
    });

    this.queue.on("succeeded", (job: BeeQueue.Job<WebhookJob>) => {
      if (this.closed) return;
      const work = (async () => {
        const jobId = buildJobId(job.data);
        const pendingKey = buildPendingKey(jobId);
        const hasPending = await this.redis.exists(pendingKey);
        if (hasPending > 0) {
          await this.redis.del(pendingKey);
          await this.producer.scheduleAndEnqueue({
            ...job.data,
            operationType: "update",
          });
        }
      })().catch((error) => {
        documentLog(
          buildJobId(job.data),
          "<!> [WARN] post-job pending check failed:",
          error
        );
      });
      this.pendingSucceededWork.add(work);
      void work.finally(() => this.pendingSucceededWork.delete(work));
    });
  }

  async close(): Promise<void> {
    await this.queue.close(SHUTDOWN_TIMEOUT);
    // Let queued microtasks (succeeded emits) register their work before we mark closed.
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.closed = true;
    await Promise.allSettled(Array.from(this.pendingSucceededWork));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.queue.checkHealth();
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 7: Run all queue tests to verify they pass**

```bash
NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/webhook/queue.spec.ts
```

Expected: all PASS

- [ ] **Step 8: Run TypeScript type check**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add src/modules/webhook/queue.ts src/modules/webhook/queue.spec.ts
git commit -m "feat(webhook): add pending reschedule + graceful drain to consumer module"
```

---

### Task 4: Update `webhook.ts` — constructor call and registration order

**Files:**

- Modify: `src/commands/webhook.ts`

- [ ] **Step 1: Update module construction and registration**

In `src/commands/webhook.ts`, inside `runWebhook()`, replace the block starting from the `// Webhook-domain modules` comment through `app.use(partitionModule)`:

**Current:**

```typescript
// Webhook-domain modules — registered in init order (first registered
// inits first). Application.close() runs LIFO, so partition closes FIRST
// (registered last). LIFO close order becomes:
//   partition → changestream → producer → consumer → redis → discord → mongo
//
// partition closing first DELs its instance key from Redis and publishes
// rebalance; peers notice us leaving and start reassigning collections.
// changestream then closes our local streams and writes the final resume
// tokens. The brief overlap — this instance's streams still alive while
// peers are starting to take over — is tolerated by bee-queue setId dedup
// plus the WebhookResult idempotency layer.
const consumerModule = new WebhookQueueConsumerModule();
// Producer needs `app` to resolve RedisModule via app.get at init() time;
// scheduleAndEnqueue is exposed as a method on this module (queue + redis
// dependencies are bound here, not threaded through callsites).
const producerModule = new WebhookQueueProducerModule(app);
const changeStreamModule = new WebhookChangeStreamModule(app);
// Partition needs `app` to resolve RedisModule for the main command
// connection AND its shared subscriber (RedisModule.getSubscriber()).
const partitionModule = new WebhookPartitionModule(app);

// Worker handler (Layer 4 concern; wired here because it depends on
// webhook.ts's processWebhookEvent which stays in this file)
consumerModule.setHandler(async (job) => {
  try {
    const ctx = await loadJobContext(job.data);
    if (!ctx) return; // webhook or document gone
    await processWebhookEvent(ctx.webhook, ctx.data);
  } catch (error) {
    documentLog(job.data.coll, "<!> [ERROR] worker handler failed:", error);
    throw error; // let bee-queue retry
  }
});

app.use(consumerModule);
app.use(producerModule);
app.use(changeStreamModule);
app.use(partitionModule);
```

**Replace with:**

```typescript
// Webhook-domain modules — registered in init order (first registered
// inits first). Application.close() runs LIFO, so partition closes FIRST
// (registered last). LIFO close order becomes:
//   partition → changestream → consumer → producer → redis → discord → mongo
//
// partition closing first DELs its instance key from Redis and publishes
// rebalance; peers notice us leaving and start reassigning collections.
// changestream then closes our local streams and writes the final resume
// tokens. consumer drains in-flight jobs and pending reschedules before
// closing. producer closes after consumer, so scheduleAndEnqueue calls
// issued during consumer.close() remain safe. The brief overlap — this
// instance's streams still alive while peers are starting to take over —
// is tolerated by bee-queue setId dedup plus the WebhookResult idempotency
// layer.
//
// Producer needs `app` to resolve RedisModule via app.get at init() time;
// scheduleAndEnqueue is exposed as a method on this module (queue + redis
// dependencies are bound here, not threaded through callsites).
const producerModule = new WebhookQueueProducerModule(app);
// Consumer needs `app` to resolve RedisModule and producer at init() time.
const consumerModule = new WebhookQueueConsumerModule(app);
const changeStreamModule = new WebhookChangeStreamModule(app);
// Partition needs `app` to resolve RedisModule for the main command
// connection AND its shared subscriber (RedisModule.getSubscriber()).
const partitionModule = new WebhookPartitionModule(app);

// Worker handler (Layer 4 concern; wired here because it depends on
// webhook.ts's processWebhookEvent which stays in this file)
consumerModule.setHandler(async (job) => {
  try {
    const ctx = await loadJobContext(job.data);
    if (!ctx) return; // webhook or document gone
    await processWebhookEvent(ctx.webhook, ctx.data);
  } catch (error) {
    documentLog(job.data.coll, "<!> [ERROR] worker handler failed:", error);
    throw error; // let bee-queue retry
  }
});

app.use(producerModule);
app.use(consumerModule);
app.use(changeStreamModule);
app.use(partitionModule);
```

- [ ] **Step 2: Run TypeScript type check**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Run all webhook-related tests**

```bash
NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/webhook/
```

Expected: all PASS

- [ ] **Step 4: Run ESLint**

```bash
npx eslint src/modules/webhook/queue.ts src/modules/webhook/queue.spec.ts src/commands/webhook.ts
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/commands/webhook.ts
git commit -m "feat(webhook): update registration order and consumer constructor in runWebhook"
```
