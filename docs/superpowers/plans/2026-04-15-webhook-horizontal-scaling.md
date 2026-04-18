# Webhook 水平擴展實現計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將 `src/commands/webhook.ts` 從單進程 changeStream 監聽改造為可水平擴展的多進程架構，支援 3–10 個實例同時運行。

**Architecture:** 混合架構。Redis 分區分配 collection 給各實例監聽（hash-based partition assignment + heartbeat），bee-queue 分發處理任務（跨實例均勻消費），MongoDB `WebhookResult` 作為冪等最終防線。每實例同時為 producer（自己分到的 collection changeStream）與 worker（queue 消費者）。

**Tech Stack:** TypeScript, Node.js ESM, MongoDB (mongoose + typegoose), Redis (node-redis v4), bee-queue v1.7.1, Jest for testing.

**Reference spec:** [`docs/superpowers/specs/2026-04-15-webhook-horizontal-scaling-design.md`](../specs/2026-04-15-webhook-horizontal-scaling-design.md)

---

## File Structure

**New files:**

- `src/modules/webhook-partition.ts` — 分區分配模組（註冊/心跳/SCAN/hash 分配/rebalance 事件）
- `src/modules/webhook-partition.spec.ts` — 單元測試
- `src/modules/webhook-queue.ts` — bee-queue 封裝 + scheduleAndEnqueue + worker startup
- `src/modules/webhook-queue.spec.ts` — 單元測試

**Modified files:**

- `src/constants.ts` — 新增 webhook 相關常數
- `src/interfaces.ts` — 新增 `WebhookJob` 型別
- `src/modules/queue.ts` — `QueueTypes` 加入 `webhook`
- `src/models/WebhookResult.ts` — 新增 `expireAt` TTL 欄位
- `src/commands/webhook.ts` — 主編排邏輯重寫（移除 in-memory buffer / PQueue，改用 partition + webhook-queue）

---

## Phase 1: Foundation（常數、型別、schema）

### Task 1: 新增常數

**Files:**

- Modify: `src/constants.ts`

- [ ] **Step 1: 在檔案末尾加入 webhook 相關常數**

找到 `src/constants.ts` 檔案尾端，加入：

```typescript
// Webhook horizontal scaling constants
export const WEBHOOK_COOLDOWN_MS = 5000;
// nextKey 必須在 delayed job 執行之前存活；3× cooldown 涵蓋系統時鐘抖動、
// Redis 複寫延遲與少量排隊時間
export const WEBHOOK_NEXT_KEY_TTL_MS = WEBHOOK_COOLDOWN_MS * 3;

// 分區分配：心跳週期與 TTL
// 單一 setInterval tick 同時執行「續租本實例 key」與「SCAN 偵測其他實例崩潰」
export const WEBHOOK_PARTITION_HEARTBEAT_MS = 5000;
export const WEBHOOK_PARTITION_TTL_SECONDS = 15;

// Rebalance debounce：避免 rolling deploy 期間 changeStream 頻繁抖動
export const WEBHOOK_REBALANCE_DEBOUNCE_MS = 500;

// Worker 並發
export const WEBHOOK_WORKER_CONCURRENCY = Number(
  process.env.WEBHOOK_WORKER_CONCURRENCY ?? 10
);

// Resume token 定時寫入週期（ms）
export const WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS = 3000;

// WebhookResult 的 TTL（秒）
export const WEBHOOK_RESULT_NON_FOLLOW_TTL_SECONDS = 3600; // 1 hour
export const WEBHOOK_RESULT_FOLLOW_TTL_SECONDS = 604800; // 7 days
```

- [ ] **Step 2: 執行 type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat(webhook): add horizontal scaling constants"
```

---

### Task 2: 新增 WebhookJob 型別

**Files:**

- Modify: `src/interfaces.ts`
- Modify: `src/modules/queue.ts`

- [ ] **Step 1: 在 `src/interfaces.ts` 末尾新增 WebhookJob interface**

在既有 `HoneybeeJob` 等定義之後加入：

```typescript
export interface WebhookJob {
  webhookId: string;
  coll: string;
  docId: string;
  operationType: "insert" | "update";
}
```

- [ ] **Step 2: 在 `src/modules/queue.ts` 的 QueueTypes 加入 webhook**

找到現有的 `QueueTypes` 型別定義（約 line 7-9），修改為：

```typescript
import type { HoneybeeJob, WebhookJob } from "../interfaces.js";

export type QueueTypes = {
  honeybee: HoneybeeJob;
  webhook: WebhookJob;
};
```

若檔案已經匯入 `HoneybeeJob`，只需在 import 語句加入 `WebhookJob`，並在 `QueueTypes` 型別加入新的 key。

- [ ] **Step 3: 執行 type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 4: Commit**

```bash
git add src/interfaces.ts src/modules/queue.ts
git commit -m "feat(webhook): add WebhookJob type and QueueTypes entry"
```

---

### Task 3: WebhookResult schema 新增 expireAt TTL 欄位

**Files:**

- Modify: `src/models/WebhookResult.ts`

- [ ] **Step 1: 加入 expireAt 欄位與 TTL index**

讀取 `src/models/WebhookResult.ts` 目前內容（約 45 行）。在 `error?: string` 欄位之後（line 42-43 附近）加入：

```typescript
  @prop({ type: Date, expires: 0, index: true })
  public expireAt?: Date;
```

說明：`expires: 0` 配合 `expireAt` 為 Date，MongoDB 會在 `expireAt` 時間到達時刪除文件。實際保留時間由寫入時的 `expireAt` 值決定。

- [ ] **Step 2: 執行 type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 3: Commit**

```bash
git add src/models/WebhookResult.ts
git commit -m "feat(webhook): add expireAt TTL field to WebhookResult"
```

---

## Phase 2: Partition Assignment Module

### Task 4: 純函數 hash 分配邏輯（TDD）

**Files:**

- Create: `src/modules/webhook-partition.ts`
- Create: `src/modules/webhook-partition.spec.ts`

- [ ] **Step 1: 先寫失敗的測試**

建立 `src/modules/webhook-partition.spec.ts`：

```typescript
import { describe, expect, it } from "@jest/globals";
import { assignInstance, hashCollection } from "./webhook-partition.js";

describe("hashCollection", () => {
  it("returns a deterministic uint32 for a given collection name", () => {
    const h1 = hashCollection("chats");
    const h2 = hashCollection("chats");
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThanOrEqual(0xffffffff);
  });

  it("produces different hashes for different collection names", () => {
    expect(hashCollection("chats")).not.toBe(hashCollection("superchats"));
  });
});

describe("assignInstance", () => {
  it("returns the only instance when there is one", () => {
    expect(assignInstance("chats", ["inst-a"])).toBe("inst-a");
  });

  it("returns the same instance for the same collection regardless of call order", () => {
    const instances = ["inst-a", "inst-b", "inst-c"];
    const r1 = assignInstance("chats", instances);
    const r2 = assignInstance("chats", [...instances].reverse());
    expect(r1).toBe(r2);
  });

  it("distributes different collections across instances", () => {
    const instances = ["inst-a", "inst-b", "inst-c"];
    const assignments = new Set(
      ["chats", "superchats", "videos", "channels", "messages"].map((coll) =>
        assignInstance(coll, instances)
      )
    );
    // at least two distinct instances should get assignments from this sample
    expect(assignments.size).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: 執行測試，確認失敗**

```bash
npx jest src/modules/webhook-partition.spec.ts
```

Expected: FAIL — Cannot find module `./webhook-partition.js`.

- [ ] **Step 3: 建立 `src/modules/webhook-partition.ts` 的最小實作**

```typescript
import { createHash } from "node:crypto";

/**
 * Deterministic uint32 hash of a collection name.
 * Used by assignInstance() to map collections to instances.
 * MD5 is used for distribution only, not security.
 */
export function hashCollection(collName: string): number {
  const digest = createHash("md5").update(collName).digest();
  return digest.readUInt32BE(0);
}

/**
 * Pure function: given a collection name and a list of active instance IDs,
 * deterministically returns the instance responsible for that collection.
 * Instance list is sorted internally for stability.
 */
export function assignInstance(
  collName: string,
  instanceIds: readonly string[]
): string {
  if (instanceIds.length === 0) {
    throw new Error("assignInstance: no active instances");
  }
  const sorted = [...instanceIds].sort();
  return sorted[hashCollection(collName) % sorted.length];
}
```

- [ ] **Step 4: 再次執行測試，確認通過**

```bash
npx jest src/modules/webhook-partition.spec.ts
```

Expected: PASS（所有測試）。

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhook-partition.ts src/modules/webhook-partition.spec.ts
git commit -m "feat(webhook): add hash-based partition assignment pure functions"
```

---

### Task 5: WebhookPartitionModule - 實例註冊、心跳與 SCAN

**Files:**

- Modify: `src/modules/webhook-partition.ts`

- [ ] **Step 1: 在 webhook-partition.ts 新增 WebhookPartitionModule class**

在檔案尾端（保留既有的 pure 函數）加入：

```typescript
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import {
  REDIS_URI,
  WEBHOOK_PARTITION_HEARTBEAT_MS,
  WEBHOOK_PARTITION_TTL_SECONDS,
  WEBHOOK_REBALANCE_DEBOUNCE_MS,
} from "../constants.js";
import type { Module } from "./module.js";

const INSTANCE_KEY_PREFIX = "webhook:instance:";
const REBALANCE_CHANNEL = "webhook:rebalance";

function generateInstanceId(): string {
  return `${hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

interface InstanceMetadata {
  instanceId: string;
  hostname: string;
  pid: number;
  startedAt: number;
  version: string;
}

/**
 * Emits "rebalance" event when the active instance set changes or when a
 * rebalance broadcast is received. Consumers should recompute their assigned
 * collections via getAssignedCollections(allColls).
 */
export class WebhookPartitionModule extends EventEmitter implements Module {
  public readonly name = "webhook-partition";
  public isInit = false;

  public readonly instanceId: string;
  private readonly metadata: InstanceMetadata;

  private client: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private rebalanceDebounceTimer: NodeJS.Timeout | null = null;
  private activeInstanceIds: string[] = [];

  constructor(version = "unknown") {
    super();
    this.instanceId = generateInstanceId();
    this.metadata = {
      instanceId: this.instanceId,
      hostname: hostname(),
      pid: process.pid,
      startedAt: Date.now(),
      version,
    };
  }

  async init(): Promise<void> {
    if (!REDIS_URI) {
      throw new Error("WebhookPartitionModule requires REDIS_URI");
    }
    this.client = createClient({ url: REDIS_URI });
    this.subscriber = this.client.duplicate();
    await this.client.connect();
    await this.subscriber.connect();

    // Subscribe to rebalance broadcasts
    await this.subscriber.subscribe(REBALANCE_CHANNEL, () => {
      this.scheduleRebalance();
    });

    // Initial registration + active set load
    await this.register();
    await this.refreshActiveInstances();

    // Broadcast so other instances know we joined
    await this.client.publish(REBALANCE_CHANNEL, this.instanceId);

    // Start periodic heartbeat + SCAN
    this.heartbeatTimer = setInterval(() => {
      void this.tick();
    }, WEBHOOK_PARTITION_HEARTBEAT_MS);
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.rebalanceDebounceTimer) {
      clearTimeout(this.rebalanceDebounceTimer);
      this.rebalanceDebounceTimer = null;
    }
    if (this.client) {
      try {
        await this.client.del(`${INSTANCE_KEY_PREFIX}${this.instanceId}`);
        await this.client.publish(REBALANCE_CHANNEL, this.instanceId);
      } catch {
        // ignore during shutdown
      }
    }
    await this.subscriber?.unsubscribe();
    await this.subscriber?.disconnect();
    await this.client?.disconnect();
    this.client = null;
    this.subscriber = null;
  }

  /**
   * Given the full list of collections configured by enabled webhooks,
   * returns those assigned to this instance.
   */
  getAssignedCollections(allColls: readonly string[]): string[] {
    if (this.activeInstanceIds.length === 0) {
      return [];
    }
    return allColls.filter(
      (coll) => assignInstance(coll, this.activeInstanceIds) === this.instanceId
    );
  }

  /**
   * For tests and diagnostics.
   */
  getActiveInstanceIds(): readonly string[] {
    return this.activeInstanceIds;
  }

  private async register(): Promise<void> {
    if (!this.client) return;
    await this.client.set(
      `${INSTANCE_KEY_PREFIX}${this.instanceId}`,
      JSON.stringify(this.metadata),
      { EX: WEBHOOK_PARTITION_TTL_SECONDS }
    );
  }

  private async refreshActiveInstances(): Promise<void> {
    if (!this.client) return;
    const ids: string[] = [];
    for await (const key of this.client.scanIterator({
      MATCH: `${INSTANCE_KEY_PREFIX}*`,
      COUNT: 100,
    })) {
      const id = key.slice(INSTANCE_KEY_PREFIX.length);
      ids.push(id);
    }
    ids.sort();
    const previous = this.activeInstanceIds;
    this.activeInstanceIds = ids;
    const changed =
      previous.length !== ids.length || previous.some((id, i) => id !== ids[i]);
    if (changed) {
      this.scheduleRebalance();
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.register(); // renew TTL
      await this.refreshActiveInstances();
    } catch (error) {
      console.error("[webhook-partition] tick failed:", error);
    }
  }

  private scheduleRebalance(): void {
    if (this.rebalanceDebounceTimer) return;
    this.rebalanceDebounceTimer = setTimeout(() => {
      this.rebalanceDebounceTimer = null;
      this.emit("rebalance");
    }, WEBHOOK_REBALANCE_DEBOUNCE_MS);
  }
}
```

- [ ] **Step 2: 驗證 type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 3: Commit**

```bash
git add src/modules/webhook-partition.ts
git commit -m "feat(webhook): add WebhookPartitionModule with heartbeat and SCAN"
```

---

### Task 6: WebhookPartitionModule 測試補強（getAssignedCollections）

**Files:**

- Modify: `src/modules/webhook-partition.spec.ts`

- [ ] **Step 1: 在既有 import 中加入 WebhookPartitionModule**

在 `src/modules/webhook-partition.spec.ts` 檔案頂端既有的 import 中加入 `WebhookPartitionModule`：

```typescript
import {
  WebhookPartitionModule,
  assignInstance,
  hashCollection,
} from "./webhook-partition.js";
```

- [ ] **Step 2: 在 spec 末尾加入 getAssignedCollections 測試**

測試策略：`activeInstanceIds` 為 private、`instanceId` 為 `readonly`。TypeScript 的 `private` 與 `readonly` 只在編譯期檢查，runtime 可透過雙重 cast (`as unknown as Mutable`) 繞過。此處刻意使用此技巧以避免為測試加開 public setter，並用 `type MutablePartition` 別名與註解顯式標示。

```typescript
describe("WebhookPartitionModule.getAssignedCollections", () => {
  // Test helper: bypass readonly/private for isolated unit testing.
  // TypeScript's readonly and private are compile-time only, so the double
  // cast works at runtime. Preferred over leaking test-only setters into
  // the production class.
  type MutablePartition = {
    instanceId: string;
    activeInstanceIds: string[];
  };

  it("partitions collections evenly with no loss or duplication", () => {
    const module = new WebhookPartitionModule();
    const mutable = module as unknown as MutablePartition;
    mutable.activeInstanceIds = ["inst-a", "inst-b", "inst-c"];

    const allColls = ["chats", "superchats", "videos", "channels", "messages"];

    // Collect each instance's assignments by temporarily rewriting instanceId.
    const allAssignments = mutable.activeInstanceIds.flatMap((id) => {
      mutable.instanceId = id;
      return module.getAssignedCollections(allColls);
    });

    // Union equals allColls (no loss) and no duplication (lengths match).
    expect(new Set(allAssignments)).toEqual(new Set(allColls));
    expect(allAssignments.length).toBe(allColls.length);
  });

  it("matches the standalone assignInstance() result for a fixed instance", () => {
    const module = new WebhookPartitionModule();
    const mutable = module as unknown as MutablePartition;
    const instanceIds = ["inst-a", "inst-b", "inst-c"];
    mutable.activeInstanceIds = instanceIds;
    mutable.instanceId = "inst-b";

    const allColls = ["chats", "superchats", "videos", "channels", "messages"];
    const assigned = module.getAssignedCollections(allColls);
    const expected = allColls.filter(
      (coll) => assignInstance(coll, instanceIds) === "inst-b"
    );
    expect(assigned).toEqual(expected);
  });

  it("returns empty when no active instances", () => {
    const module = new WebhookPartitionModule();
    const mutable = module as unknown as MutablePartition;
    mutable.activeInstanceIds = [];
    expect(module.getAssignedCollections(["chats"])).toEqual([]);
  });
});
```

- [ ] **Step 3: 執行測試**

```bash
npx jest src/modules/webhook-partition.spec.ts
```

Expected: PASS（所有測試，包含 Task 4 的純函數測試）。

- [ ] **Step 4: Commit**

```bash
git add src/modules/webhook-partition.spec.ts
git commit -m "test(webhook): add getAssignedCollections coverage for partition module"
```

---

## Phase 3: Webhook Queue Module

### Task 7: Queue 建立 + getJobIfInFlight helper

**Files:**

- Create: `src/modules/webhook-queue.ts`

- [ ] **Step 1: 建立 webhook-queue.ts 骨架**

```typescript
import BeeQueue from "bee-queue";
import { REDIS_URI } from "../constants.js";
import type { WebhookJob } from "../interfaces.js";

const QUEUE_NAME = "webhook";

/**
 * Creates the shared bee-queue instance used by producers (enqueue) and
 * consumers (startWorker). The Redis settings mirror the existing QueueModule
 * pattern but add `removeOnFailure` and `activateDelayedJobs`, both of which
 * are required for the spec's coalesce semantics (see spec §3.3).
 */
export function createWebhookQueue(
  opts: { isWorker: boolean } = { isWorker: false }
): BeeQueue<WebhookJob> {
  return new BeeQueue<WebhookJob>(QUEUE_NAME, {
    redis: { url: REDIS_URI },
    removeOnSuccess: true,
    removeOnFailure: true, // 必要：否則失敗 job 的 ID 會永久佔用 jobs hash
    activateDelayedJobs: true, // 必要：否則 delayed job 永遠不會被觸發
    stallInterval: 30_000,
    isWorker: opts.isWorker,
  });
}

/**
 * In-flight detection for scheduleAndEnqueue's coalesce decision.
 * In `removeOnSuccess:true + removeOnFailure:true` mode, `getJob(id) !== null`
 * precisely means the id is still in `bq:webhook:jobs` hash, i.e. job is in
 * one of {waiting, delayed, active, stalling, retrying} states.
 *
 * Do NOT use `job.status` for this check — see spec §3.4; bee-queue's status
 * field is "created" for all unexecuted jobs regardless of queue position.
 */
export async function isJobInFlight(
  queue: BeeQueue<WebhookJob>,
  jobId: string
): Promise<boolean> {
  const job = await queue.getJob(jobId);
  return job !== null;
}

export function buildJobId(job: WebhookJob): string {
  return `${job.webhookId}:${job.coll}:${job.docId}`;
}

export function buildNextKey(jobId: string): string {
  return `webhook:next:${jobId}`;
}
```

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。若出現 `BeeQueue` 型別問題，檢查是否需要 `import BeeQueue = require("bee-queue")` 或 default export 寫法；參考既有 `src/modules/queue.ts` 的 import 方式修正。

- [ ] **Step 3: Commit**

```bash
git add src/modules/webhook-queue.ts
git commit -m "feat(webhook): add webhook-queue skeleton with createQueue helper"
```

---

### Task 8: scheduleAndEnqueue with WATCH/MULTI/EXEC（TDD）

**Files:**

- Modify: `src/modules/webhook-queue.ts`
- Create: `src/modules/webhook-queue.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

建立 `src/modules/webhook-queue.spec.ts`：

```typescript
import { describe, expect, it, jest } from "@jest/globals";
import type BeeQueue from "bee-queue";
import { WatchError, type RedisClientType } from "redis";
import { scheduleAndEnqueue } from "./webhook-queue.js";
import type { WebhookJob } from "../interfaces.js";

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
  const execFn = jest.fn(() => {
    const next = seq.shift() ?? "ok";
    if (next === "watch-abort") {
      return Promise.reject(new WatchError());
    }
    return Promise.resolve(["OK"]);
  });
  const setFn = jest.fn(function (this: unknown) {
    return this;
  });
  const multiObj: { set: jest.Mock; exec: jest.Mock } = {
    set: setFn,
    exec: execFn,
  };
  // Bind `this` for chaining so `multi.set(...).set(...).exec()` resolves to multiObj
  setFn.mockImplementation(() => multiObj);
  return {
    watch: jest.fn().mockResolvedValue("OK"),
    get: jest.fn().mockResolvedValue(initialNextKey),
    unwatch: jest.fn().mockResolvedValue("OK"),
    multi: jest.fn().mockReturnValue(multiObj),
    set: jest.fn().mockResolvedValue("OK"),
  };
}

function createMockQueue(inFlight = false): MockQueue {
  const saveFn = jest.fn().mockResolvedValue({ id: "some-id" });
  const delayUntilFn = jest.fn().mockReturnValue({ save: saveFn });
  const setIdFn = jest
    .fn()
    .mockReturnValue({ save: saveFn, delayUntil: delayUntilFn });
  const createJobFn = jest.fn().mockReturnValue({ setId: setIdFn });
  return {
    getJob: jest.fn().mockResolvedValue(inFlight ? { id: "exists" } : null),
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
    const multiObj = (redis.multi as jest.Mock).mock.results;
    (redis.multi as jest.Mock).mockReturnValue({
      set: jest.fn().mockReturnThis(),
      exec: jest.fn().mockRejectedValue(new Error("connection lost")),
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
});
```

- [ ] **Step 2: 執行測試，確認失敗**

```bash
npx jest src/modules/webhook-queue.spec.ts
```

Expected: FAIL — `scheduleAndEnqueue` is not exported.

- [ ] **Step 3: 在 `src/modules/webhook-queue.ts` 實作 scheduleAndEnqueue**

首先，在檔案頂端的 import 區塊加入 `WatchError`、`RedisClientType` 與 `WEBHOOK_NEXT_KEY_TTL_MS`：

```typescript
import BeeQueue from "bee-queue";
import { WatchError, type RedisClientType } from "redis";
import { REDIS_URI, WEBHOOK_NEXT_KEY_TTL_MS } from "../constants.js";
import type { WebhookJob } from "../interfaces.js";
```

然後在檔案中（既有 helper 之後）加入：

```typescript
export type ScheduleResult =
  | "immediate"
  | "delayed"
  | "coalesced"
  | "fallback-delayed";

/**
 * Atomically decide whether to enqueue immediately, delay, coalesce, or fall
 * back, and perform the corresponding bee-queue save(). Uses Redis
 * WATCH/MULTI/EXEC for optimistic concurrency on the per-job nextKey.
 *
 * Invariant: any two successive worker trigger times (delayUntil for delayed
 * branch, save time for immediate branch) for the same (webhookId, coll,
 * docId) differ by ≥ cooldown.
 *
 * node-redis v4 behaviour: when a WATCHed key changes before EXEC, `multi.exec()`
 * rejects with `WatchError` — it does NOT return null like ioredis. We catch
 * WatchError to retry and rethrow other errors.
 */
export async function scheduleAndEnqueue(
  queue: BeeQueue<WebhookJob>,
  redis: RedisClientType,
  job: WebhookJob,
  now: number,
  cooldown: number
): Promise<ScheduleResult> {
  const jobId = buildJobId(job);
  const nextKey = buildNextKey(jobId);
  let lastNextAllowed = 0;
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await redis.watch(nextKey);
    const raw = await redis.get(nextKey);
    const nextAllowed = raw === null ? 0 : parseInt(raw, 10);
    lastNextAllowed = nextAllowed;

    // In-flight check: getJob(id) !== null means id is still in bq:webhook:jobs
    if (await isJobInFlight(queue, jobId)) {
      await redis.unwatch();
      return "coalesced";
    }

    if (now >= nextAllowed) {
      const multi = redis.multi();
      multi.set(nextKey, String(now + cooldown), {
        PX: WEBHOOK_NEXT_KEY_TTL_MS,
      });
      try {
        await multi.exec();
      } catch (err) {
        if (err instanceof WatchError) continue; // WATCH triggered, retry
        throw err;
      }

      await queue.createJob(job).setId(jobId).save();
      return "immediate";
    }

    const delay = nextAllowed - now;
    const multi = redis.multi();
    multi.set(nextKey, String(nextAllowed + cooldown), {
      PX: WEBHOOK_NEXT_KEY_TTL_MS,
    });
    try {
      await multi.exec();
    } catch (err) {
      if (err instanceof WatchError) continue;
      throw err;
    }

    await queue
      .createJob(job)
      .setId(jobId)
      .delayUntil(now + delay)
      .save();
    return "delayed";
  }

  // Fallback: 5 retries exhausted. Use best-effort unconditional SET to advance
  // nextKey (avoids stale value breaking the ≥cooldown invariant after the
  // fallback job completes) then push a delayed job. setId-dedup handles the
  // race with other instances' winning saves.
  const fallbackNextAllowed = Math.max(
    lastNextAllowed + cooldown,
    now + cooldown * 2
  );
  await redis.set(nextKey, String(fallbackNextAllowed), {
    PX: WEBHOOK_NEXT_KEY_TTL_MS,
  });
  await queue
    .createJob(job)
    .setId(jobId)
    .delayUntil(now + cooldown)
    .save();
  return "fallback-delayed";
}
```

**注意**：

- node-redis v4 的 `multi.exec()` 在 WATCH 衝突時**丟出 `WatchError`**（非回傳 `null`），所以必須用 try/catch 而非 null check。
- `set(key, value, options)` 的第三參數是物件形式 `{ PX: ms }`，與 ioredis 的位置參數不同。

- [ ] **Step 4: 執行測試，確認全部通過**

```bash
npx jest src/modules/webhook-queue.spec.ts
```

Expected: PASS（5 個測試）。

若 mock 對 `multi().set(...)` 的 chain 結構不符，調整測試中 `createMockRedis` 的 `multiObj` 結構使 `set` 回傳 `this`（同一 multiObj），以符合 `multi.set(...).set(...)` chaining 的 type 推論。

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhook-queue.ts src/modules/webhook-queue.spec.ts
git commit -m "feat(webhook): add scheduleAndEnqueue with WATCH/MULTI/EXEC cooldown"
```

---

### Task 9: WebhookQueueConsumerModule（Application 模組化）

**Files:**

- Modify: `src/modules/webhook-queue.ts`

- [ ] **Step 1: 在 import 區塊加入 Module 介面與 SHUTDOWN_TIMEOUT / WEBHOOK_WORKER_CONCURRENCY**

在檔案頂端既有的 import 加入：

```typescript
import {
  REDIS_URI,
  SHUTDOWN_TIMEOUT,
  WEBHOOK_NEXT_KEY_TTL_MS,
  WEBHOOK_WORKER_CONCURRENCY,
} from "../constants.js";
import type { Module } from "./module.js";
```

（保留既有的 `import BeeQueue from "bee-queue"` 與 `import type { RedisClientType } from "redis"`，僅更新 `../constants.js` 與新增 `./module.js` import。）

- [ ] **Step 2: 在檔案末尾新增 consumer module**

```typescript
/**
 * Application module that manages the bee-queue worker lifecycle for this
 * instance. The high-level producer API (scheduleAndEnqueue) is a plain
 * function, but the underlying bee-queue producer connection still needs a
 * lifecycle owner — see WebhookQueueProducerModule below.
 */
export class WebhookQueueConsumerModule implements Module {
  public readonly name = "webhook-queue-consumer";
  public isInit = false;

  public readonly queue: BeeQueue<WebhookJob>;
  private handler: ((job: BeeQueue.Job<WebhookJob>) => Promise<void>) | null =
    null;

  constructor() {
    this.queue = createWebhookQueue({ isWorker: true });
  }

  /**
   * Register the handler that worker runs for each incoming job. Must be
   * called before init().
   */
  setHandler(handler: (job: BeeQueue.Job<WebhookJob>) => Promise<void>): void {
    this.handler = handler;
  }

  async init(): Promise<void> {
    if (!this.handler) {
      throw new Error(
        "WebhookQueueConsumerModule.init called before setHandler"
      );
    }
    await this.queue.ready();
    this.queue.process(WEBHOOK_WORKER_CONCURRENCY, (job) => this.handler!(job));
  }

  async close(): Promise<void> {
    // bee-queue.close() stops accepting new jobs and waits up to timeout
    // for in-flight jobs to finish
    await this.queue.close(SHUTDOWN_TIMEOUT);
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

/**
 * Producer-only bee-queue connection. Owns the non-worker bee-queue instance
 * used by the changeStream event handler to push jobs via scheduleAndEnqueue.
 * Exists as an Application module so that the underlying Redis connection
 * has a managed lifecycle (init → ready, close → disconnect).
 *
 * Registration order note: both this module and WebhookQueueConsumerModule
 * are registered in runWebhook (see Task 14). Spec §4.7 documents only the
 * consumer; the producer is an implementation detail and shuts down alongside
 * the consumer before the partition module is removed.
 */
export class WebhookQueueProducerModule implements Module {
  public readonly name = "webhook-queue-producer";
  public isInit = false;

  public readonly queue: BeeQueue<WebhookJob>;

  constructor() {
    this.queue = createWebhookQueue({ isWorker: false });
  }

  async init(): Promise<void> {
    await this.queue.ready();
  }

  async close(): Promise<void> {
    await this.queue.close(SHUTDOWN_TIMEOUT);
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

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。若 bee-queue 的 `BeeQueue.Job` namespace 型別無法解析，改用 `import type { Job } from "bee-queue"` 並以 `Job<WebhookJob>` 代替。

- [ ] **Step 4: Commit**

```bash
git add src/modules/webhook-queue.ts
git commit -m "feat(webhook): add WebhookQueueConsumerModule and ProducerModule"
```

---

## Phase 4: webhook.ts 整合重寫

### Task 10: 冪等檢查 helper（TDD）

**Files:**

- Create: `src/modules/webhook-claim.ts`
- Create: `src/modules/webhook-claim.spec.ts`

為了讓 claim 邏輯可以單元測試，獨立成 module（而非內嵌於 `webhook.ts`）。此 module 只依賴 `WebhookResultModel` 與 lodash-es 的 `isEqual`，不觸及其他 webhook 邏輯。

- [ ] **Step 1: 寫失敗的測試**

建立 `src/modules/webhook-claim.spec.ts`：

```typescript
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { claimWebhookResult } from "./webhook-claim.js";
import WebhookResultModel from "../models/WebhookResult.js";

type FakeExisting = {
  response?: unknown;
  body?: unknown;
};

const identifier = { webhookId: "w1", coll: "chats", docId: "d1" };

function mockUpsert(upsertedCount: number): jest.SpyInstance {
  return jest.spyOn(WebhookResultModel, "updateOne").mockResolvedValue({
    acknowledged: true,
    upsertedCount,
    upsertedId: upsertedCount === 1 ? ("fake-id" as never) : null,
    matchedCount: upsertedCount === 0 ? 1 : 0,
    modifiedCount: 0,
  } as never);
}

function mockFindOne(existing: FakeExisting | null): jest.SpyInstance {
  return jest.spyOn(WebhookResultModel, "findOne").mockReturnValue({
    lean: () => ({
      exec: () => Promise.resolve(existing),
    }),
  } as never);
}

describe("claimWebhookResult", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 'send' on fresh upsert (upsertedCount=1)", async () => {
    mockUpsert(1);
    const decision = await claimWebhookResult(
      { followUpdate: false } as never,
      identifier,
      "POST",
      "https://example.com",
      { content: "v1" }
    );
    expect(decision).toEqual({ action: "send" });
  });

  it("returns 'skip' when non-follow and response already present", async () => {
    mockUpsert(0);
    mockFindOne({ response: { ok: true }, body: { content: "anything" } });
    const decision = await claimWebhookResult(
      { followUpdate: false } as never,
      identifier,
      "POST",
      "https://example.com",
      { content: "v2" }
    );
    expect(decision).toEqual({
      action: "skip",
      reason: "already-sent-non-follow",
    });
  });

  it("returns 'skip' when follow-update and body unchanged", async () => {
    mockUpsert(0);
    mockFindOne({ response: { ok: true }, body: { content: "v1" } });
    const decision = await claimWebhookResult(
      { followUpdate: true } as never,
      identifier,
      "POST",
      "https://example.com",
      { content: "v1" }
    );
    expect(decision).toEqual({
      action: "skip",
      reason: "follow-update-body-unchanged",
    });
  });

  it("returns 'send' when follow-update and body differs from last sent", async () => {
    mockUpsert(0);
    mockFindOne({ response: { ok: true }, body: { content: "v1" } });
    const decision = await claimWebhookResult(
      { followUpdate: true } as never,
      identifier,
      "POST",
      "https://example.com",
      { content: "v2" }
    );
    expect(decision).toEqual({ action: "send" });
  });

  it("returns 'send' when record exists but response is not yet written (stall recovery)", async () => {
    mockUpsert(0);
    mockFindOne({ body: { content: "v1" } }); // no response field
    const decision = await claimWebhookResult(
      { followUpdate: false } as never,
      identifier,
      "POST",
      "https://example.com",
      { content: "v1" }
    );
    expect(decision).toEqual({ action: "send" });
  });
});
```

- [ ] **Step 2: 執行測試，確認失敗**

```bash
npx jest src/modules/webhook-claim.spec.ts
```

Expected: FAIL — `Cannot find module './webhook-claim.js'`。

- [ ] **Step 3: 實作 `src/modules/webhook-claim.ts`**

```typescript
import type { DocumentType } from "@typegoose/typegoose";
import { isEqual } from "lodash-es";
import { WEBHOOK_RESULT_FOLLOW_TTL_SECONDS } from "../constants.js";
import type { Webhook } from "../models/Webhook.js";
import WebhookResultModel from "../models/WebhookResult.js";

export type WebhookResultIdentifier = {
  webhookId: string;
  coll: string;
  docId: string;
};

export type ClaimDecision =
  | { action: "send" }
  | { action: "skip"; reason: string };

/**
 * Idempotent claim for a webhook delivery. Upserts a WebhookResult record
 * keyed by (webhookId, coll, docId). Returns "skip" if the record already
 * shows a successful delivery of the same body.
 *
 * Design spec §4.3: method/url/body are written in $setOnInsert to satisfy
 * the schema's required:true constraint. They are ALSO written in the
 * post-send $set (see sendDiscordWebhook / sendWebhook in Task 11) so that
 * subsequent follow-update comparisons use "last sent body" not
 * "first inserted body".
 *
 * A conservative fallback `expireAt` is set so that records for permanently
 * failing sends are eventually reclaimed by the TTL index.
 */
export async function claimWebhookResult(
  webhook: DocumentType<Webhook>,
  resultIdentifier: WebhookResultIdentifier,
  method: string,
  url: string,
  body: unknown
): Promise<ClaimDecision> {
  const fallbackExpireAt = new Date(
    Date.now() + WEBHOOK_RESULT_FOLLOW_TTL_SECONDS * 1000
  );

  const updateResult = await WebhookResultModel.updateOne(
    resultIdentifier,
    {
      $setOnInsert: {
        ...resultIdentifier,
        method,
        url,
        body,
        expireAt: fallbackExpireAt,
      },
    },
    { upsert: true }
  );

  if (updateResult.upsertedCount === 1) {
    // Fresh insert, never seen — go ahead and send
    return { action: "send" };
  }

  const existing = await WebhookResultModel.findOne(resultIdentifier)
    .lean()
    .exec();

  if (existing?.response) {
    if (!webhook.followUpdate) {
      return { action: "skip", reason: "already-sent-non-follow" };
    }
    if (isEqual(existing.body, body)) {
      return { action: "skip", reason: "follow-update-body-unchanged" };
    }
    // follow-update, body changed → proceed
  }
  // no response yet (stall recovery) → proceed
  return { action: "send" };
}
```

- [ ] **Step 4: 執行測試，確認全部通過**

```bash
npx jest src/modules/webhook-claim.spec.ts
```

Expected: PASS（5 個測試）。

- [ ] **Step 5: Type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/modules/webhook-claim.ts src/modules/webhook-claim.spec.ts
git commit -m "feat(webhook): add claimWebhookResult idempotency helper with tests"
```

---

### Task 11: 改寫 sendDiscordWebhook / sendWebhook 整合 claim 與 TTL expireAt

**Files:**

- Modify: `src/commands/webhook.ts`

- [ ] **Step 1: 在 webhook.ts 的 import 區塊加入 TTL 常數**

在既有 import 區塊中加入：

```typescript
import {
  WEBHOOK_RESULT_FOLLOW_TTL_SECONDS,
  WEBHOOK_RESULT_NON_FOLLOW_TTL_SECONDS,
} from "../constants.js";
```

- [ ] **Step 2: 重寫 sendDiscordWebhook**

找到 `sendDiscordWebhook` 函數（約 line 53–90）。完整替換為：

```typescript
async function sendDiscordWebhook(
  method: string,
  url: string,
  body: any,
  webhook: Webhook,
  resultIdentifier: WebhookResultIdentifier
) {
  const uri = new URL(url);
  uri.searchParams.set("wait", "true");

  const ttlMs = webhook.followUpdate
    ? WEBHOOK_RESULT_FOLLOW_TTL_SECONDS * 1000
    : WEBHOOK_RESULT_NON_FOLLOW_TTL_SECONDS * 1000;

  try {
    const response = await discordRest.request({
      fullRoute: uri.pathname.replace(/^\/api/, "") as RouteLike,
      method: method.toUpperCase() as RequestMethod,
      body: body,
      query: uri.searchParams,
      auth: false,
    });

    // On success, overwrite method/url/body along with response/statusCode.
    // body must be re-written here (not only in $setOnInsert) so subsequent
    // follow-update comparisons use "last sent body" — see spec §4.3.
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: {
        method,
        url,
        body,
        response,
        statusCode: 200,
        expireAt: new Date(Date.now() + ttlMs),
      },
      $unset: { error: "" },
    });
  } catch (error) {
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: {
        statusCode: error instanceof HTTPError ? error.status : -1,
        error: `${error}`,
      },
    });
  } finally {
    void cache.del(createWebhookResultCacheKey(resultIdentifier));
  }
}
```

- [ ] **Step 3: 重寫 sendWebhook**

找到 `sendWebhook` 函數（約 line 92–128）。完整替換為：

```typescript
async function sendWebhook(
  method: string,
  url: string,
  body: any,
  webhook: Webhook,
  resultIdentifier: WebhookResultIdentifier
) {
  const ttlMs = webhook.followUpdate
    ? WEBHOOK_RESULT_FOLLOW_TTL_SECONDS * 1000
    : WEBHOOK_RESULT_NON_FOLLOW_TTL_SECONDS * 1000;

  try {
    const timeout = AbortSignal.timeout(10000);
    const res = await axiosInstance.request({
      method,
      url,
      data: body,
      signal: timeout,
    });

    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: {
        method,
        url,
        body,
        response: res.data,
        statusCode: res.status,
        expireAt: new Date(Date.now() + ttlMs),
      },
      $unset: { error: "" },
    });
  } catch (error) {
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: {
        statusCode: error instanceof AxiosError ? error.response?.status : -1,
        error: `${error}`,
      },
    });
  } finally {
    void cache.del(createWebhookResultCacheKey(resultIdentifier));
  }
}
```

- [ ] **Step 4: Type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 5: Commit**

```bash
git add src/commands/webhook.ts
git commit -m "refactor(webhook): send functions now write body/method/url on success and use expireAt TTL"
```

---

### Task 12: processWebhookEvent 整合 claimWebhookResult

**Files:**

- Modify: `src/commands/webhook.ts`

- [ ] **Step 1: 在 webhook.ts 的 import 區塊加入 claimWebhookResult**

在檔案頂端的 import 區塊加入：

```typescript
import { claimWebhookResult } from "../modules/webhook-claim.js";
```

注意：`WebhookResultIdentifier` 型別既有定義在 `webhook.ts` 本地（約 line 164-168），Task 10 新增的 `src/modules/webhook-claim.ts` 也定義了同名型別。為避免重複，改為從 webhook-claim 匯入並刪除本地定義：

```typescript
import {
  claimWebhookResult,
  type WebhookResultIdentifier,
} from "../modules/webhook-claim.js";
```

然後刪除 `webhook.ts` 中既有的 `type WebhookResultIdentifier = { ... }` 宣告（約 line 164-168）。

- [ ] **Step 2: 修改 processWebhookEvent 以使用 claim**

找到 `processWebhookEvent`（約 line 221–339）。在函數中組裝 `method` / `url` / `body` 之後、實際呼叫 `sendDiscordWebhook` / `sendWebhook` 之前，插入 claim 檢查。

目前既有程式碼流程（精簡版）：

```typescript
// ... build parameters, method, url, body ...
await WebhookResultModel.updateOne(
  resultIdentifier,
  { $setOnInsert: resultIdentifier, $set: { method, url, body } },
  { upsert: true }
);
void cache.del(...);
if (checkIsDiscordWebhookUrl(url)) {
  await sendDiscordWebhook(...);
} else {
  await sendWebhook(...);
}
```

將既有 `updateOne` + `sendDiscordWebhook/sendWebhook` 區塊替換為：

```typescript
const decision = await claimWebhookResult(
  webhook,
  resultIdentifier,
  method,
  url,
  body
);
if (decision.action === "skip") {
  documentLog(
    webhook,
    `[idempotent-skip] ${decision.reason} for ${resultIdentifier.coll}:${resultIdentifier.docId}`
  );
  return;
}
void cache.del(createWebhookResultCacheKey(resultIdentifier));

if (checkIsDiscordWebhookUrl(url)) {
  await sendDiscordWebhook(method, url, body, webhook, resultIdentifier);
} else {
  await sendWebhook(method, url, body, webhook, resultIdentifier);
}
```

注意：保留既有的「若 previousBody 與新 body 相同則 return」檢查（line 315–318），它是 coalesce 期內的額外提前退出。claim 檢查是對 **已發送的 response** 的比對，不重疊。

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 4: Commit**

```bash
git add src/commands/webhook.ts
git commit -m "refactor(webhook): integrate claimWebhookResult into processWebhookEvent"
```

---

### Task 13: loadJobContext + resume token 持久化

**Files:**

- Modify: `src/commands/webhook.ts`

- [ ] **Step 1: 新增 loadJobContext**

在 `processWebhookEvent` 之前新增：

首先，在 `webhook.ts` 頂端的 import 區塊加入以下匯入（`createClient` / `RedisClientType` / `REDIS_URI` / `WebhookJob`）：

```typescript
import { createClient, type RedisClientType } from "redis";
import { REDIS_URI } from "../constants.js";
import type { WebhookJob } from "../interfaces.js";
```

然後在 `processWebhookEvent` 之前、在檔案頂層 scope（與其他既有模組層宣告同列）新增 `sharedRedisClient` 變數與三個 helper 函數。**為避免 `noUnusedLocals` 警告（這些符號要到 Task 14 才被消費）**，宣告變數時加上 `// eslint-disable-next-line @typescript-eslint/no-unused-vars` 註記，或在檔案末尾加 `void [sharedRedisClient, loadJobContext, loadResumeToken, saveResumeToken];` 一行 placeholder 引用，Task 14 完成後刪除該行。

```typescript
// Shared redis client for resume token + scheduleAndEnqueue on the producer
// side. Initialised in runWebhook() (see Task 14).
let sharedRedisClient: RedisClientType | null = null;

async function loadJobContext(job: WebhookJob): Promise<{
  webhook: DocumentType<Webhook>;
  data: WatcherResultDocument;
} | null> {
  const webhook = await WebhookModel.findById(job.webhookId).exec();
  if (!webhook || !webhook.enabled) return null;

  const model = getModelByCollectionName(job.coll);
  if (!model) return null;

  const fullDocument = await model.findById(job.docId).exec();
  if (!fullDocument) return null;

  return {
    webhook,
    data: {
      documentKey: { _id: new mongo.BSON.ObjectId(job.docId) },
      fullDocument,
      operationType: job.operationType,
      ns: { db: model.db.name, coll: job.coll },
    } as WatcherResultDocument,
  };
}

async function loadResumeToken(
  redis: RedisClientType,
  coll: string
): Promise<unknown | undefined> {
  const raw = await redis.get(`webhook:resumetoken:${coll}`);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed.token;
  } catch {
    return undefined;
  }
}

async function saveResumeToken(
  redis: RedisClientType,
  coll: string,
  token: unknown,
  instanceId: string
): Promise<void> {
  await redis.set(
    `webhook:resumetoken:${coll}`,
    JSON.stringify({ token, updatedAt: Date.now(), owner: instanceId }),
    { EX: 3600 }
  );
}
```

注意：在 import 區塊中確認已加入 `getModelByCollectionName`（應已存在）、`mongo`（從 mongoose 已匯入）、`WebhookModel`（應已存在）。若 TypeScript 對 `WatcherResultDocument` 的 typing 較嚴格，使用 `as WatcherResultDocument` cast 即可，因為下游 `processWebhookEvent` 並未依賴 `new model(...)` 的 Document 包裝語法之外的特性。

- [ ] **Step 2: 在檔案末尾加入暫時引用以避免 unused 錯誤**

在 `webhook.ts` 末尾加入一行（Task 14 完成後刪除）：

```typescript
void [sharedRedisClient, loadJobContext, loadResumeToken, saveResumeToken];
```

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 4: Commit**

```bash
git add src/commands/webhook.ts
git commit -m "feat(webhook): add loadJobContext and resume token helpers"
```

---

### Task 14: runWebhook() 主函數重寫

**Files:**

- Modify: `src/commands/webhook.ts`

這是整個 refactor 最核心的一步。目前的 `runWebhook` 約 line 361–659。

- [ ] **Step 1: 新增必要的 imports**

在檔案頂部 import 區塊加入：

```typescript
import {
  WEBHOOK_COOLDOWN_MS,
  WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS,
} from "../constants.js";
import { WebhookPartitionModule } from "../modules/webhook-partition.js";
import {
  WebhookQueueConsumerModule,
  WebhookQueueProducerModule,
} from "../modules/webhook-queue.js";
```

（若既有 import 區塊已經部分匯入 `../constants.js`，合併匯入即可。不要引入 `src/version.ts`；直接在 runWebhook 函數內用 `const packageVersion = "unknown";` 或從 `process.env.npm_package_version ?? "unknown"` 讀取。）

- [ ] **Step 2: 將 startChangeStream 改為使用 resume token 持久化**

找到 `startChangeStream` 函數（約 line 482–548）。改寫為：

```typescript
async function startChangeStream(
  coll: string,
  collectionSetting: CollectionSetting
): Promise<
  | {
      stream: mongo.ChangeStream;
      tokenSaveInterval: NodeJS.Timeout;
    }
  | undefined
> {
  // close previous change stream if exists
  const resumeAfter = collectionSetting.changeStream
    ? await closeChangeStream(
        coll,
        collectionSetting.changeStream,
        collectionSetting.tokenSaveInterval
      )
    : sharedRedisClient
      ? await loadResumeToken(sharedRedisClient, coll)
      : undefined;

  const model = getModelByCollectionName(coll);
  if (!model) {
    documentLog(
      coll,
      `<!> [ERROR] Unable to get model (unknown collection "${coll}")`
    );
    return;
  }
  const changeStream = model.watch(
    [{ $match: collectionSetting.changeStreamMatch }],
    {
      resumeAfter: resumeAfter as any,
      fullDocument: "updateLookup",
      readPreference: "secondaryPreferred",
    }
  );

  // Periodic resume token save
  const tokenSaveInterval = global.setInterval(() => {
    const token = (changeStream as any).resumeToken;
    if (!token || !sharedRedisClient) return;
    void saveResumeToken(
      sharedRedisClient,
      coll,
      token,
      partition.instanceId
    ).catch((err) =>
      documentLog(coll, "<!> [WARN] resume token save failed:", err)
    );
  }, WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS);

  changeStream.on("change", (changeStreamData: mongo.ChangeStreamDocument) => {
    if (
      changeStreamData.operationType !== "insert" &&
      changeStreamData.operationType !== "update"
    ) {
      return;
    }
    if (!("documentKey" in changeStreamData)) return;
    if (
      !("fullDocument" in changeStreamData) ||
      !changeStreamData.fullDocument
    ) {
      documentLog(
        coll,
        "<!> [ERROR] missing fullDocument",
        changeStreamData.documentKey
      );
      return;
    }

    // Push to queue via scheduleAndEnqueue instead of processing inline
    const webhookJob: WebhookJob[] = collectionSetting.webhooks
      .filter((wh) => {
        if (!wh.followUpdate && changeStreamData.operationType === "update")
          return false;
        if (wh.match && !isMatching(changeStreamData.fullDocument, wh.match))
          return false;
        return true;
      })
      .map((wh) => ({
        webhookId: wh._id.toHexString(),
        coll,
        docId: (
          changeStreamData.documentKey._id as mongo.BSON.ObjectId
        ).toHexString(),
        operationType: changeStreamData.operationType as "insert" | "update",
      }));

    for (const job of webhookJob) {
      if (!sharedRedisClient || !producerQueue) continue;
      scheduleAndEnqueue(
        producerQueue,
        sharedRedisClient,
        job,
        Date.now(),
        WEBHOOK_COOLDOWN_MS
      ).catch((err) =>
        documentLog(coll, "<!> [ERROR] scheduleAndEnqueue failed:", err)
      );
    }
  });
  return { stream: changeStream, tokenSaveInterval };
}
```

- [ ] **Step 3: 更新 CollectionSetting 結構**

找到 `interface CollectionSetting`（約 line 355–359），改為：

```typescript
interface CollectionSetting {
  changeStream?: mongo.ChangeStream;
  tokenSaveInterval?: NodeJS.Timeout;
  changeStreamMatch?: any;
  webhooks: DocumentType<Webhook>[];
}
```

- [ ] **Step 4: 更新 closeChangeStream 簽名**

找到 `closeChangeStream`（約 line 452–468），改為：

```typescript
async function closeChangeStream(
  coll: string,
  changeStream: mongo.ChangeStream,
  tokenSaveInterval?: NodeJS.Timeout
) {
  if (tokenSaveInterval) {
    global.clearInterval(tokenSaveInterval);
  }
  // Read resumeToken BEFORE close() because the driver may clear it afterwards
  const finalToken = (changeStream as any).resumeToken;
  try {
    await changeStream.close();
    changeStream.removeAllListeners();
    if (finalToken && sharedRedisClient) {
      await saveResumeToken(
        sharedRedisClient,
        coll,
        finalToken,
        partition.instanceId
      ).catch(() => {});
    }
    return finalToken;
  } catch (error) {
    documentLog(
      coll,
      "<!> [FATAL] Unable to close the previous change stream.",
      error
    );
    process.exit(1);
  }
}
```

- [ ] **Step 5: 更新 setupWebhook 以使用 partition filter 與新結構**

找到 `setupWebhook`（約 line 554–598）。改寫為：

```typescript
async function setupWebhook(coll: string, webhooks: DocumentType<Webhook>[]) {
  try {
    // Only act on collections assigned to this instance
    const myColls = new Set(
      partition.getAssignedCollections(
        Array.from(collectionSettings.keys()).concat(coll)
      )
    );
    if (!myColls.has(coll)) {
      // If we previously owned this coll, close it
      if (collectionSettings.has(coll)) {
        await removeWebhook(coll);
      }
      return;
    }

    const collectionSetting: CollectionSetting = collectionSettings.get(
      coll
    ) ?? { webhooks: [] };

    const changeStreamMatch = {
      $or: webhooks.map((webhook) =>
        flatObjectKey({
          operationType: webhook.followUpdate
            ? { $in: ["insert", "update"] }
            : "insert",
          ...setIfDefine("fullDocument", webhook.match),
        })
      ),
    };

    if (
      changeStreamIsValid(collectionSetting.changeStream) &&
      collectionSetting.changeStreamMatch &&
      isEqual(changeStreamMatch, collectionSetting.changeStreamMatch)
    ) {
      collectionSetting.webhooks = webhooks;
      return;
    }

    collectionSetting.webhooks = webhooks;
    collectionSetting.changeStreamMatch = changeStreamMatch;
    const started = await startChangeStream(coll, collectionSetting);
    if (started) {
      collectionSetting.changeStream = started.stream;
      collectionSetting.tokenSaveInterval = started.tokenSaveInterval;
      collectionSettings.set(coll, collectionSetting);
      documentLog(
        coll,
        `start listening (match length: ${changeStreamMatch.$or.length})`
      );
    }
  } catch (error) {
    documentLog(coll, "<!> [FATAL] Unable to create change stream.", error);
    process.exit(1);
  }
}
```

- [ ] **Step 6: 重寫 runWebhook 主體**

找到 `export async function runWebhook`（約 line 361）。本步驟做以下變動：

1. **將 Step 2/4/5 重寫的 `startChangeStream` / `closeChangeStream` / `setupWebhook` 函數移入 `runWebhook` 內部**，使其能 close over `sharedRedisClient`、`producerQueue`、`partition`、`collectionSettings` 等 runWebhook 內的 local state。同樣把既有的 `removeWebhook`、`changeStreamIsValid`、`setupWebhooks` 也移入 runWebhook 內。
2. **建立 shared Redis client 早於 partition module**，並 assign 給模組層的 `sharedRedisClient`（Task 13 宣告）。
3. **依 §4.7 順序註冊 modules**：先註冊「先 init、後 close」的，再註冊「後 init、先 close」的。LIFO 關閉順序為：webhook-change-stream → setup-webhooks-queue → partition → remove-webhook-changestreams → producer → consumer → discord-rest-client → MongoDB。**partition 必須在 remove-webhook-changestreams 之前註冊**，才能讓關閉順序變成「partition 先離開（讓其他實例接管）→ 本實例 changeStream 關閉」。
4. **所有 `app.use(...)` 必須在 `await app.init()` 之前**：Application 不支援 init 後再註冊 module（後註冊者的 `init()` 不會被呼叫）。
5. **partition 的 rebalance 事件觸發 setupWebhooks**：將 `setupWebhooksQueue = new PQueue(...)` 宣告**移到** `partition.on("rebalance", ...)` 之前，避免 forward reference 帶來的脆弱性。

整個 `runWebhook` 重寫為：

```typescript
export async function runWebhook() {
  await importAllModels();
  const app = new Application();
  app.use(new MongodbModule());

  // Shared Redis client for resume token save/load and scheduleAndEnqueue.
  // Assign to the module-level `sharedRedisClient` declared in Task 13 so
  // that loadJobContext / loadResumeToken / saveResumeToken can use it.
  sharedRedisClient = createClient({ url: REDIS_URI });
  await sharedRedisClient.connect();

  const collectionSettings = new Map<string, CollectionSetting>();

  // Setup queue is created early because partition.on("rebalance") references it
  const setupWebhooksQueue = new PQueue({ concurrency: 1 });

  // Consumer first registered (closes last, drains queue last)
  const consumerModule = new WebhookQueueConsumerModule();

  // Producer queue
  const producerModule = new WebhookQueueProducerModule();
  const producerQueue = producerModule.queue;

  // Partition module (closes earlier than changeStream cleanup, so other
  // instances are notified before this instance stops emitting events)
  const partition = new WebhookPartitionModule();

  // Consumer handler
  consumerModule.setHandler(async (job) => {
    try {
      const ctx = await loadJobContext(job.data);
      if (!ctx) {
        return; // webhook or document gone
      }
      await processWebhookEvent(ctx.webhook, ctx.data);
    } catch (error) {
      documentLog(job.data.coll, "<!> [ERROR] worker handler failed:", error);
      throw error; // let bee-queue retry
    }
  });

  // Module INIT order below (first `app.use` call runs init first).
  // LIFO close order is the reverse:
  //   webhook-change-stream → setup-webhooks-queue → partition →
  //   remove-webhook-changestreams → producer → consumer →
  //   discord-rest-client → MongoDB
  // Spec §4.7 requires partition to close BEFORE remove-webhook-changestreams
  // so other instances are notified before this instance stops emitting events.
  // MongoDB and discord-rest are registered FIRST (init first, close last) so
  // they outlive every other lifecycle during shutdown.
  app.use({
    name: "discord-rest-client",
    async close() {
      for (const [, handler] of discordRest.handlers) {
        while (!handler.inactive) {
          await setTimeout(100);
        }
      }
    },
  });
  app.use(consumerModule);
  app.use(producerModule);
  app.use({
    name: "remove-webhook-changestreams",
    async close() {
      for (const coll of Array.from(collectionSettings.keys())) {
        await removeWebhook(coll);
      }
    },
  });
  app.use(partition);
  app.use({
    name: "setup-webhooks-queue",
    async close() {
      await setupWebhooksQueue.onIdle();
    },
  });

  // Meta-stream that watches Webhook config changes; runs on every instance (§2.2)
  const webhooksChangeStream = WebhookModel.watch([
    {
      $match: {
        operationType: { $in: ["insert", "update", "replace", "delete"] },
      },
    },
  ]).on("change", (data: mongo.ChangeStreamDocument<Webhook>) => {
    documentLog(data, data.operationType.toUpperCase());
    if (setupWebhooksQueue.size < 2)
      void setupWebhooksQueue.add(() => setupWebhooks());
  });
  app.use({
    name: "webhook-change-stream",
    async close() {
      await webhooksChangeStream.close();
    },
  });

  // Trigger recompute when partition assignments change
  partition.on("rebalance", () => {
    if (setupWebhooksQueue.size < 2)
      void setupWebhooksQueue.add(() => setupWebhooks());
  });

  // Initialize all modules now that registration is complete
  await app.init();

  // ---- function definitions that close over runWebhook's locals ----
  // The functions below (closeChangeStream, removeWebhook, startChangeStream,
  // setupWebhook, setupWebhooks) MUST be defined inside runWebhook because
  // they reference `sharedRedisClient`, `producerQueue`, `partition`,
  // `collectionSettings`, and `setupWebhooksQueue`.

  function changeStreamIsValid(changeStream?: mongo.ChangeStream) {
    return changeStream && changeStream.closed === false;
  }

  // ... the closeChangeStream / removeWebhook / startChangeStream / setupWebhook
  // / setupWebhooks function bodies from Steps 2, 4, 5 go here, lexically
  // enclosed by runWebhook so they have access to the locals above.

  // (To save space, the bodies are not repeated here. When implementing,
  // place the function definitions from Steps 2/4/5 immediately below this
  // marker.)

  // Initial bootstrap
  await setupWebhooksQueue.add(() => setupWebhooks());
  console.log("webhook is ready");
}
```

**重要實作備註**：

- Step 2 (`startChangeStream`)、Step 4 (`closeChangeStream`)、Step 5 (`setupWebhook`) 的函數定義在 Step 6 寫入時必須**放在 `runWebhook` 函數內部**，否則它們無法存取 `sharedRedisClient`/`producerQueue`/`partition`/`collectionSettings` 這些 closure 變數，會出現 ReferenceError。
- 既有的 `removeWebhook` 函數也要一併移入 `runWebhook` 內部（它依賴 `collectionSettings`）。
- LIFO 關閉順序由註冊順序決定。請逐條對照註冊順序註解，確認 partition 在 remove-webhook-changestreams 之後註冊（即會更早關閉）。

- [ ] **Step 7: 移除舊的 bufferChange 與 PQueue 邏輯**

在 `runWebhook` 內部找到並刪除以下區塊（對照既有 `src/commands/webhook.ts` line 387–419、366–373、421–450）：

- `const processWebhookQueue = new PQueue();`（line 387）
- 對應的 `app.use({ name: "process-webhook-queue", async close() { await processWebhookQueue.onIdle(); } });` 註冊（line 388–394）
- `global.setInterval(() => { for (const [key, { webhook, data }] of bufferChange) ... }, 5000);` 區塊（line 408–419）
- `const bufferChange = new Map<...>();` 宣告（line 367–373）
- `function prepareWebhookEvent(...)` 整個函數（line 421–450，已被 scheduleAndEnqueue 取代）
- 既有 changeStream `change` event handler 中對 `prepareWebhookEvent` 與 `processWebhookQueue.add` 的呼叫（line 536–544）— 已由 Step 2 的新 startChangeStream 取代

- [ ] **Step 8: 也移除既有 `remove-webhook` cleanup 模組（line 396–404）**

既有的 `app.use({ name: "remove-webhook", async close() { for (const coll of collectionSettings.keys()) { await removeWebhook(coll); } } });` 被 Step 6 的 `remove-webhook-changestreams` 取代，**刪除舊的**避免重複註冊。

- [ ] **Step 9: Type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。若有型別錯誤，多半來自 `as any` cast 未對齊；逐個修正。

- [ ] **Step 9: Lint check**

```bash
npx eslint src/commands/webhook.ts src/modules/webhook-partition.ts src/modules/webhook-queue.ts
```

Expected: 無錯誤。

- [ ] **Step 10: 執行所有新增的單元測試**

```bash
npx jest src/modules/webhook-partition.spec.ts src/modules/webhook-queue.spec.ts
```

Expected: PASS。

- [ ] **Step 11: Commit**

```bash
git add src/commands/webhook.ts
git commit -m "refactor(webhook): integrate partition + queue modules into runWebhook"
```

---

### Task 15: 人工煙霧測試（smoke test）

**Files:** 無（純驗證步驟）

**前提**：在執行此步驟前，確認：

- Task 1–14 所有 commit 已完成
- `npm run build` 已成功（TypeScript 編譯通過）
- 本地 `.env` 有 `REDIS_URI`（例 `redis://localhost:6379`）與 `MONGODB_URI`
- Redis 與 MongoDB 已運行（例 `docker compose up redis mongo`，依既有專案 compose 定義）
- MongoDB 至少有一個 `enabled=true` 的 Webhook 設定，其 `colls` 包含 `chats` 或其他活躍集合

- [ ] **Step 1: 以 httpbin 作為 mock webhook 目標（可選）**

為了驗證送達與內容正確性，在本地啟動 httpbin（收到的 request 會回 echo）：

```bash
docker run -d --rm -p 8090:80 --name webhook-smoke-httpbin kennethreitz/httpbin
```

臨時建立一筆 webhook 指向 `http://localhost:8090/post`。**測試結束後記得刪除 webhook 與停止容器**（`docker stop webhook-smoke-httpbin`）。

- [ ] **Step 2: 啟動第一個 webhook 實例**

```bash
INSTANCE_LABEL=A npm run build && node dist/index.js webhook 2>&1 | tee /tmp/webhook-A.log
```

Expected log（約 5 秒內出現）：

- `webhook is ready`
- 每個 enabled webhook 的每個 collection 都有一行 `<coll> - start listening (match length: N)`
- log 內可見本實例的 partition instanceId（於 WebhookPartitionModule 的 init 後可加 `documentLog` 協助觀察，若無則透過 Redis `SCAN webhook:instance:*` 確認）

驗證 Redis 狀態：

```bash
redis-cli --scan --pattern 'webhook:instance:*'
# 應看到 1 筆
```

- [ ] **Step 3: 觸發一筆 insert 事件並驗證端到端送達**

在 MongoDB 直接 insert 一筆符合 webhook `match` 條件的文件。例：

```bash
mongosh "$MONGODB_URI" --eval '
  db.chats.insertOne({
    originVideoId: "smoke-test-1",
    authorChannelId: "UCsmoke",
    message: "hello",
    timestamp: new Date(),
    createdAt: new Date()
  })
'
```

Expected（≤ 10 秒內）：

- 實例 A 的 log 顯示該 doc 的 insert 事件被接收並推入 queue
- httpbin 收到一筆 POST（在 `docker logs webhook-smoke-httpbin` 中可看到）
- WebhookResult 集合新增一筆記錄，且 `response` 欄位非空、`expireAt` 為 1 小時後時間戳：

```bash
mongosh "$MONGODB_URI" --eval '
  db.webhookresults.findOne({ "body.originVideoId": "smoke-test-1" }, { response: 1, expireAt: 1, body: 1 })
'
```

- [ ] **Step 4: 驗證 follow-update 冷卻去重**

若步驟 3 使用的 webhook 設定 `followUpdate: true`，快速對同一 doc 做 3 次 update（間隔 < 1 秒）：

```bash
mongosh "$MONGODB_URI" --eval '
  for (let i = 2; i <= 4; i++) {
    db.chats.updateOne(
      { originVideoId: "smoke-test-1" },
      { $set: { message: "update-" + i, updatedAt: new Date() } }
    );
  }
'
```

Expected：

- 實例 A log：3 次 update 事件接收，但只有 1 次實際推入 queue（其餘 `coalesced`）；且下一次 delayed 觸發時 httpbin 只收到 1 筆額外 POST
- httpbin 的 POST 數從步驟 3 的 1 次變為 2 次，**不是 4 次**

- [ ] **Step 5: 啟動第二個實例驗證 partition 分配**

在另一個 terminal：

```bash
INSTANCE_LABEL=B node dist/index.js webhook 2>&1 | tee /tmp/webhook-B.log
```

Expected：

- 兩個 terminal 都會在數百毫秒內印出新的 `start listening` 行與 `start removing`（部分 collection 轉移）
- Redis 中 `webhook:instance:*` 為 2 筆
- 對任一 collection，只有 A 或 B 其中一個印出對應的 `start listening`（不重複）

驗證：

```bash
# 確認沒有重複監聽同一 collection
grep -c "start listening (match length" /tmp/webhook-A.log /tmp/webhook-B.log
# 加總應等於 enabled webhook 的 collection 總數，無論第二個實例啟動前後
```

- [ ] **Step 6: 驗證故障接管（partition rebalance）**

在第一個 terminal 按 Ctrl+C 終止實例 A。

Expected（實例 B 的 log）：

- ≤ 15 秒內顯示新的 `start listening` 行，接管原本 A 負責的 collection
- Redis `webhook:instance:*` 減為 1 筆

驗證沒有事件遺漏：在 B 接管後重新執行步驟 3，確認 httpbin 仍正常收到事件。

- [ ] **Step 7: 清理**

```bash
# 終止實例 B
# 刪除測試用 webhook 設定
mongosh "$MONGODB_URI" --eval 'db.webhooks.deleteOne({ insertUrl: "http://localhost:8090/post" })'
# 停止 httpbin
docker stop webhook-smoke-httpbin
# 刪除 smoke test 插入的 chat 文件
mongosh "$MONGODB_URI" --eval 'db.chats.deleteOne({ originVideoId: "smoke-test-1" })'
# 清理 WebhookResult
mongosh "$MONGODB_URI" --eval 'db.webhookresults.deleteMany({ "body.originVideoId": "smoke-test-1" })'
```

- [ ] **Step 8: 無 code 修改則不需 commit**

若過程中發現 bug，開啟新的 debug + fix commit。

---

## Self-Review

**本 plan 的 self-review 依使用者 CLAUDE.md 規則，由獨立 subagent 進行，不在此處 inline 執行。**

Plan 撰寫者完成 Task 1–15 後，會為每個 Task 啟動獨立的 review subagent 進行審查，並迴圈直到所有 Task 都回報 OKAY。
