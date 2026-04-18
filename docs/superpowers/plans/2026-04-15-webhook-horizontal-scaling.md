# Webhook 水平擴展實現計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將 `src/commands/webhook.ts` 從單進程 changeStream 監聽改造為可水平擴展的多進程架構，支援 3–10 個實例同時運行。

**Architecture:** 混合架構。Redis 分區分配 collection 給各實例監聽（hash-based partition assignment + heartbeat），bee-queue 分發處理任務（跨實例均勻消費），MongoDB `WebhookResult` 作為冪等最終防線。每實例同時為 producer（自己分到的 collection changeStream）與 worker（queue 消費者）。

**Tech Stack:** TypeScript, Node.js ESM, MongoDB (mongoose + typegoose), Redis (node-redis v4), bee-queue v1.7.1, Jest for testing.

**Reference spec:** [`docs/superpowers/specs/2026-04-15-webhook-horizontal-scaling-design.md`](../specs/2026-04-15-webhook-horizontal-scaling-design.md)

---

## File Structure

**New files（全部集中於 `src/modules/webhook/` 目錄）：**

- `src/modules/webhook/partition.ts` — 分區分配模組（註冊/心跳/SCAN/hash 分配/rebalance 事件）
- `src/modules/webhook/partition.spec.ts` — 單元測試
- `src/modules/webhook/queue.ts` — bee-queue 封裝 + scheduleAndEnqueue + Consumer/Producer Application 模組
- `src/modules/webhook/queue.spec.ts` — 單元測試
- `src/modules/webhook/claim.ts` — WebhookResult 冪等 upsert / claim helper（抽出以便單元測試）
- `src/modules/webhook/claim.spec.ts` — 單元測試
- `src/modules/webhook/changestream.ts` — **Layer 2 獨立 Application 模組**：包含 meta-stream、per-collection changeStream lifecycle、resume token 持久化、rebalance 監聽、debounced reconcile loop；透過 `app.get` 取得 redis/partition/producer 依賴

**Modified files:**

- `src/constants.ts` — 新增 webhook 相關常數
- `src/interfaces.ts` — 新增 `WebhookJob` 型別
- `src/modules/queue.ts` — `QueueTypes` 加入 `webhook`
- `src/modules/redis.ts` — 新增 lazy `getSubscriber()` 方法，讓 pub/sub 消費者共用 RedisModule 管理的 subscriber 連線
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

- Create: `src/modules/webhook/partition.ts`
- Create: `src/modules/webhook/partition.spec.ts`

- [ ] **Step 1: 先寫失敗的測試**

建立 `src/modules/webhook/partition.spec.ts`：

```typescript
import { describe, expect, it } from "@jest/globals";
import { assignInstance, hashCollection } from "./partition.js";

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
npx jest src/modules/webhook/partition.spec.ts
```

Expected: FAIL — Cannot find module `./partition.js`.

- [ ] **Step 3: 建立 `src/modules/webhook/partition.ts` 的最小實作**

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
npx jest src/modules/webhook/partition.spec.ts
```

Expected: PASS（所有測試）。

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhook/partition.ts src/modules/webhook/partition.spec.ts
git commit -m "feat(webhook): add hash-based partition assignment pure functions"
```

---

### Task 5: WebhookPartitionModule - 實例註冊、心跳與 SCAN

**Files:**

- Modify: `src/modules/redis.ts`
- Modify: `src/modules/webhook/partition.ts`

**設計決策**：分區模組需要 Redis pub/sub 廣播 rebalance 事件。Redis subscribe mode 是連線專屬模式（一條連線進入 subscribe 狀態後就不能再執行其他指令），必須有獨立的 subscriber 連線。為避免分區模組自行管理 Redis 連線設定（REDIS_URI 解析、connect/disconnect 生命週期），擴充既有的 `RedisModule` 提供 `getSubscriber()` lazy method，由 `RedisModule` 集中管理 subscriber 連線生命週期；分區模組與其他需要 pub/sub 的模組都從這裡取得連線，不再自行 `createClient()`。

本任務分兩個 commit：先擴充 `RedisModule`，再加入使用它的 `WebhookPartitionModule`。

- [ ] **Step 1: 擴充 `src/modules/redis.ts` 新增 subscriber lazy method**

讀取 `src/modules/redis.ts` 目前內容（約 30 行）。整個檔案完整替換為：

```typescript
import assert from "assert";
import { createClient, RedisClientType } from "redis";
import { REDIS_URI } from "../constants.js";
import type { Module } from "./module.js";

export class RedisModule implements Module {
  name = "redis";
  redis: RedisClientType;
  private _subscriber?: RedisClientType;

  constructor() {
    assert(REDIS_URI, "REDIS_URI should be defined.");
    this.redis = createClient({
      url: REDIS_URI,
    });
  }

  async init(): Promise<void> {
    await this.redis.connect();
  }

  async close(): Promise<void> {
    if (this._subscriber?.isOpen) {
      try {
        await this._subscriber.disconnect();
      } catch {
        // ignore during shutdown
      }
    }
    await this.redis.disconnect();
  }

  async healthCheck(): Promise<boolean> {
    await this.redis.ping();
    return true;
  }

  /**
   * Returns a connected Redis subscriber connection. Redis subscribe mode is
   * exclusive — a connection in subscribe state cannot execute any other
   * command — so consumers that need pub/sub must use a dedicated connection
   * separate from the main command connection (this.redis).
   *
   * Lazy-initialized on first call and reused for all subsequent calls;
   * lifecycle (disconnect on RedisModule.close) is owned here, so consumers
   * MUST NOT call disconnect() on the returned client. Consumers SHOULD
   * unsubscribe() from their own channels in their close() to clean up
   * listeners — the underlying connection stays alive for any other consumer.
   */
  async getSubscriber(): Promise<RedisClientType> {
    if (!this._subscriber) {
      this._subscriber = this.redis.duplicate();
      await this._subscriber.connect();
    }
    return this._subscriber;
  }
}
```

- [ ] **Step 2: Type check (RedisModule 變更)**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 3: Commit (RedisModule)**

```bash
git add src/modules/redis.ts
git commit -m "feat(redis): add lazy getSubscriber() for pub/sub consumers"
```

- [ ] **Step 4: 在 partition.ts 新增 WebhookPartitionModule class**

在檔案尾端（保留既有的 pure 函數）加入：

```typescript
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { RedisClientType } from "redis";
import {
  WEBHOOK_PARTITION_HEARTBEAT_MS,
  WEBHOOK_PARTITION_TTL_SECONDS,
  WEBHOOK_REBALANCE_DEBOUNCE_MS,
} from "../../constants.js";
import type { Application } from "../application.js";
import type { Module } from "../module.js";
import { RedisModule } from "../redis.js";

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
 * Tracks the live set of webhook instances via per-instance Redis keys with
 * TTL (acts as a heartbeat) and broadcasts/listens for rebalance signals via
 * Redis pub/sub. Emits "rebalance" event whenever the active instance set
 * changes or a rebalance broadcast arrives. Consumers should recompute their
 * assigned collections via getAssignedCollections(allColls).
 *
 * Dependencies (obtained in init() via app.get):
 *   - RedisModule: provides both the main command connection (set/get/del/
 *     scan/publish) via redisModule.redis and the shared pub/sub subscriber
 *     connection via redisModule.getSubscriber(). RedisModule owns both
 *     connections' lifecycles, so this module does NOT call createClient or
 *     disconnect() — only subscribe()/unsubscribe() on its own channel.
 */
export class WebhookPartitionModule extends EventEmitter implements Module {
  public readonly name = "webhook-partition";
  public isInit = false;

  public readonly instanceId: string;
  private readonly metadata: InstanceMetadata;

  private redisModule!: RedisModule;
  private subscriber: RedisClientType | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private rebalanceDebounceTimer: NodeJS.Timeout | null = null;
  private activeInstanceIds: string[] = [];

  // Stored as a field (rather than an inline arrow at subscribe call site) so
  // we can pass the same reference to unsubscribe() during close, leaving any
  // other consumers of the shared subscriber connection unaffected.
  private readonly rebalanceListener = (): void => {
    this.scheduleRebalance();
  };

  constructor(
    private readonly app: Application,
    version = "unknown"
  ) {
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
    const redisModule = this.app.get<RedisModule>("redis");
    if (!redisModule) {
      throw new Error(
        "WebhookPartitionModule.init: RedisModule must be registered before this module"
      );
    }
    this.redisModule = redisModule;
    this.subscriber = await this.redisModule.getSubscriber();

    // Subscribe to rebalance broadcasts
    await this.subscriber.subscribe(REBALANCE_CHANNEL, this.rebalanceListener);

    // Initial registration + active set load
    await this.register();
    await this.refreshActiveInstances();

    // Broadcast so other instances know we joined
    await this.redisModule.redis.publish(REBALANCE_CHANNEL, this.instanceId);

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
    try {
      await this.redisModule.redis.del(
        `${INSTANCE_KEY_PREFIX}${this.instanceId}`
      );
      await this.redisModule.redis.publish(REBALANCE_CHANNEL, this.instanceId);
    } catch {
      // ignore during shutdown
    }
    if (this.subscriber) {
      try {
        // Pass the specific listener reference so we don't drop other
        // consumers' callbacks on the shared subscriber connection.
        await this.subscriber.unsubscribe(
          REBALANCE_CHANNEL,
          this.rebalanceListener
        );
      } catch {
        // ignore during shutdown
      }
      this.subscriber = null;
    }
    // NOTE: do NOT disconnect this.redisModule.redis or the subscriber —
    // both are owned by RedisModule and will be closed when it shuts down.
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
    await this.redisModule.redis.set(
      `${INSTANCE_KEY_PREFIX}${this.instanceId}`,
      JSON.stringify(this.metadata),
      { EX: WEBHOOK_PARTITION_TTL_SECONDS }
    );
  }

  private async refreshActiveInstances(): Promise<void> {
    const ids: string[] = [];
    for await (const key of this.redisModule.redis.scanIterator({
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

- [ ] **Step 5: 驗證 type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 6: Commit (WebhookPartitionModule)**

```bash
git add src/modules/webhook/partition.ts
git commit -m "feat(webhook): add WebhookPartitionModule with heartbeat and SCAN"
```

---

### Task 6: WebhookPartitionModule 測試補強（getAssignedCollections）

**Files:**

- Modify: `src/modules/webhook/partition.spec.ts`

- [ ] **Step 1: 在既有 import 中加入 WebhookPartitionModule 與 Application 型別**

在 `src/modules/webhook/partition.spec.ts` 檔案頂端既有的 import 中加入 `WebhookPartitionModule` 與 `Application`：

```typescript
import type { Application } from "../application.js";
import {
  WebhookPartitionModule,
  assignInstance,
  hashCollection,
} from "./partition.js";
```

- [ ] **Step 2: 在 spec 末尾加入 getAssignedCollections 測試**

測試策略：`activeInstanceIds` 為 private、`instanceId` 為 `readonly`。TypeScript 的 `private` 與 `readonly` 只在編譯期檢查，runtime 可透過雙重 cast (`as unknown as Mutable`) 繞過。此處刻意使用此技巧以避免為測試加開 public setter，並用 `type MutablePartition` 別名與註解顯式標示。

建構式接受 `app: Application`，但這些測試完全跳過 `init()`、直接突變私有欄位驗證 `getAssignedCollections` 的純運算邏輯，不會讀取 `this.app`，因此用 `{} as Application` cast 作為 stub 即可。

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

  // Stub Application — these tests never call init(), so the constructor's
  // stored `app` reference is never dereferenced.
  const stubApp = {} as Application;

  it("partitions collections evenly with no loss or duplication", () => {
    const module = new WebhookPartitionModule(stubApp);
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
    const module = new WebhookPartitionModule(stubApp);
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
    const module = new WebhookPartitionModule(stubApp);
    const mutable = module as unknown as MutablePartition;
    mutable.activeInstanceIds = [];
    expect(module.getAssignedCollections(["chats"])).toEqual([]);
  });
});
```

- [ ] **Step 3: 執行測試**

```bash
npx jest src/modules/webhook/partition.spec.ts
```

Expected: PASS（所有測試，包含 Task 4 的純函數測試）。

- [ ] **Step 4: Commit**

```bash
git add src/modules/webhook/partition.spec.ts
git commit -m "test(webhook): add getAssignedCollections coverage for partition module"
```

---

## Phase 3: Webhook Queue Module

### Task 7: Queue 建立 + getJobIfInFlight helper

**Files:**

- Create: `src/modules/webhook/queue.ts`

- [ ] **Step 1: 建立 queue.ts 骨架**

```typescript
import BeeQueue from "bee-queue";
import { REDIS_URI } from "../../constants.js";
import type { WebhookJob } from "../../interfaces.js";

const QUEUE_NAME = "webhook";

/**
 * Creates the shared bee-queue instance used by producers (enqueue) and
 * consumers (startWorker). The Redis settings mirror the existing QueueModule
 * pattern but add `removeOnFailure` and `activateDelayedJobs`:
 *
 * - `removeOnFailure: true` — without it, a permanently failed job keeps its
 *   id in `bq:webhook:jobs` forever, making coalesce permanently dedupe any
 *   future event for the same (webhookId, coll, docId).
 * - `activateDelayedJobs: true` — defaults to false in bee-queue. Without it,
 *   delayed jobs are saved to the `delayed` sorted set but never promoted to
 *   the waiting queue, so they never fire.
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
 * precisely means the id is still in `bq:webhook:jobs` hash, i.e. the job is
 * in one of {waiting, delayed, active, stalling, retrying} states.
 *
 * Do NOT use `job.status` for this check. bee-queue stores the status string
 * inside the job's serialized data; it is written once at construction (as
 * "created") and not updated when the job is pushed to waiting, promoted to
 * active, or moved between internal sets. For any job that has not yet
 * completed, `getJob(id).status === "created"` regardless of queue position,
 * so using it to infer queue state is wrong. The only reliable signal is
 * whether `getJob(id)` returns a non-null Job or null.
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
git add src/modules/webhook/queue.ts
git commit -m "feat(webhook): add webhook-queue skeleton with createQueue helper"
```

---

### Task 8: scheduleAndEnqueue with WATCH/MULTI/EXEC（TDD）

**Files:**

- Modify: `src/modules/webhook/queue.ts`
- Create: `src/modules/webhook/queue.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

建立 `src/modules/webhook/queue.spec.ts`：

```typescript
import { describe, expect, it, jest } from "@jest/globals";
import type BeeQueue from "bee-queue";
import { WatchError, type RedisClientType } from "redis";
import { scheduleAndEnqueue } from "./queue.js";
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
npx jest src/modules/webhook/queue.spec.ts
```

Expected: FAIL — `scheduleAndEnqueue` is not exported.

- [ ] **Step 3: 在 `src/modules/webhook/queue.ts` 實作 scheduleAndEnqueue**

首先，在檔案頂端的 import 區塊加入 `WatchError`、`RedisClientType` 與 `WEBHOOK_NEXT_KEY_TTL_MS`：

```typescript
import BeeQueue from "bee-queue";
import { WatchError, type RedisClientType } from "redis";
import { REDIS_URI, WEBHOOK_NEXT_KEY_TTL_MS } from "../../constants.js";
import type { WebhookJob } from "../../interfaces.js";
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
npx jest src/modules/webhook/queue.spec.ts
```

Expected: PASS（5 個測試）。

若 mock 對 `multi().set(...)` 的 chain 結構不符，調整測試中 `createMockRedis` 的 `multiObj` 結構使 `set` 回傳 `this`（同一 multiObj），以符合 `multi.set(...).set(...)` chaining 的 type 推論。

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhook/queue.ts src/modules/webhook/queue.spec.ts
git commit -m "feat(webhook): add scheduleAndEnqueue with WATCH/MULTI/EXEC cooldown"
```

---

### Task 9: WebhookQueueConsumerModule（Application 模組化）

**Files:**

- Modify: `src/modules/webhook/queue.ts`

- [ ] **Step 1: 在 import 區塊加入 Module 介面、Application、RedisModule、cooldown 常數與 worker 常數**

在檔案頂端既有的 import 加入：

```typescript
import {
  REDIS_URI,
  SHUTDOWN_TIMEOUT,
  WEBHOOK_COOLDOWN_MS,
  WEBHOOK_NEXT_KEY_TTL_MS,
  WEBHOOK_WORKER_CONCURRENCY,
} from "../../constants.js";
import type { Application } from "../application.js";
import type { Module } from "../module.js";
import { RedisModule } from "../redis.js";
```

（保留既有的 `import BeeQueue from "bee-queue"` 與 `import { WatchError, type RedisClientType } from "redis"`，僅更新 `../../constants.js` 的完整 import 清單並新增 `../module.js` / `../application.js` / `../redis.js` import。）

- [ ] **Step 2: 在檔案末尾新增 consumer module**

```typescript
/**
 * Application module that manages the bee-queue worker lifecycle for this
 * instance. Producer-side concerns (queue connection + scheduleAndEnqueue
 * API) live in WebhookQueueProducerModule below.
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
 * Producer-side public API. Owns the non-worker bee-queue connection AND
 * exposes scheduleAndEnqueue() — the canonical way for upstream code (Layer 2
 * changeStream handler) to push webhook events into the queue with cooldown
 * semantics. Producer concerns (queue, redis client, cooldown defaults) live
 * here so callers don't have to thread them through.
 *
 * Dependencies:
 *   - RedisModule (looked up in init() via app.get): provides the redis client
 *     used by the underlying scheduleAndEnqueue() pure function for
 *     WATCH/MULTI/EXEC cooldown coordination.
 *
 * Registration order: must be registered AFTER RedisModule so that
 * `app.get("redis")` succeeds at init() time. The pure scheduleAndEnqueue()
 * function (above) remains exported for unit testing — production code should
 * call producerModule.scheduleAndEnqueue(job) instead.
 *
 * Shutdown ordering: LIFO close means changeStream module (registered later)
 * closes first and drains its setupQueue, so no new scheduleAndEnqueue calls
 * happen by the time this module's close() runs. The cached redis client
 * remains valid until RedisModule.close() runs (registered earlier, closes
 * later), eliminating any close-time use-after-disconnect risk.
 */
export class WebhookQueueProducerModule implements Module {
  public readonly name = "webhook-queue-producer";
  public isInit = false;

  public readonly queue: BeeQueue<WebhookJob>;
  private redis!: RedisClientType;

  constructor(private readonly app: Application) {
    this.queue = createWebhookQueue({ isWorker: false });
  }

  async init(): Promise<void> {
    const redisModule = this.app.get<RedisModule>("redis");
    if (!redisModule) {
      throw new Error(
        "WebhookQueueProducerModule.init: RedisModule must be registered before this module"
      );
    }
    this.redis = redisModule.redis;
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

  /**
   * Producer-side public API: atomically schedule a webhook job into the queue
   * with cooldown semantics. Thin wrapper around the pure scheduleAndEnqueue
   * function (above) — the underlying algorithm is unit-tested via that pure
   * entry, and this method exists to bind the queue + redis dependencies that
   * production callers shouldn't have to know about.
   *
   * `now` and `cooldown` default to `Date.now()` and `WEBHOOK_COOLDOWN_MS`
   * respectively for ergonomic production calls; tests of the underlying
   * algorithm exercise the pure function directly with explicit args.
   */
  scheduleAndEnqueue(
    job: WebhookJob,
    now: number = Date.now(),
    cooldown: number = WEBHOOK_COOLDOWN_MS
  ): Promise<ScheduleResult> {
    return scheduleAndEnqueue(this.queue, this.redis, job, now, cooldown);
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
git add src/modules/webhook/queue.ts
git commit -m "feat(webhook): add WebhookQueueConsumerModule and ProducerModule"
```

---

## Phase 4: webhook.ts 整合重寫

### Task 10: 冪等檢查 helper（TDD）

**Files:**

- Create: `src/modules/webhook/claim.ts`
- Create: `src/modules/webhook/claim.spec.ts`

為了讓 claim 邏輯可以單元測試，獨立成 module（而非內嵌於 `webhook.ts`）。此 module 只依賴 `WebhookResultModel` 與 lodash-es 的 `isEqual`，不觸及其他 webhook 邏輯。

- [ ] **Step 1: 寫失敗的測試**

建立 `src/modules/webhook/claim.spec.ts`：

```typescript
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { claimWebhookResult } from "./claim.js";
import WebhookResultModel from "../../models/WebhookResult.js";

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
npx jest src/modules/webhook/claim.spec.ts
```

Expected: FAIL — `Cannot find module './claim.js'`。

- [ ] **Step 3: 實作 `src/modules/webhook/claim.ts`**

```typescript
import type { DocumentType } from "@typegoose/typegoose";
import { isEqual } from "lodash-es";
import { WEBHOOK_RESULT_FOLLOW_TTL_SECONDS } from "../../constants.js";
import type { Webhook } from "../../models/Webhook.js";
import WebhookResultModel from "../../models/WebhookResult.js";

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
 * keyed by (webhookId, coll, docId) and decides whether the current event
 * should actually be sent, based on prior delivery state:
 *
 *   - If upsertedCount === 1 (fresh insert): action = "send"
 *   - If existing record has a non-null `response`:
 *       - For a non-followUpdate webhook: action = "skip"
 *         (the target has already been notified; further events are duplicates)
 *       - For a followUpdate webhook with identical body: action = "skip"
 *         (body unchanged since last successful send, no reason to re-send)
 *       - For a followUpdate webhook with different body: action = "send"
 *   - If existing record has no response yet (stall recovery or concurrent
 *     in-flight worker): action = "send"
 *
 * method/url/body are written in $setOnInsert to satisfy the WebhookResult
 * schema's required:true constraint on these fields. They are ALSO re-written
 * in the post-send $set performed by sendDiscordWebhook / sendWebhook so that
 * subsequent followUpdate comparisons use the LAST sent body, not the body
 * that happened to trigger the first insert. Without the post-send re-write,
 * every follow-update event would compare against the same original body and
 * deduplication would break after the second event.
 *
 * A conservative fallback `expireAt` is set on insert so that records created
 * by this upsert but never followed by a successful send (e.g. the HTTP call
 * fails and is never retried) are eventually reclaimed by the TTL index
 * rather than accumulating indefinitely.
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
npx jest src/modules/webhook/claim.spec.ts
```

Expected: PASS（5 個測試）。

- [ ] **Step 5: Type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/modules/webhook/claim.ts src/modules/webhook/claim.spec.ts
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
    // body must be re-written here (not only in $setOnInsert) so that subsequent
    // follow-update events compare against the LAST sent body via
    // isEqual(existing.body, newBody). If body were only written on insert, the
    // comparison would always be against the first-ever body and subsequent
    // updates would never deduplicate correctly.
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
import { claimWebhookResult } from "../modules/webhook/claim.js";
```

注意：`WebhookResultIdentifier` 型別既有定義在 `webhook.ts` 本地（約 line 164-168），Task 10 新增的 `src/modules/webhook/claim.ts` 也定義了同名型別。為避免重複，改為從 `webhook/claim` 匯入並刪除本地定義：

```typescript
import {
  claimWebhookResult,
  type WebhookResultIdentifier,
} from "../modules/webhook/claim.js";
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

**保留**既有 `processWebhookEvent` 中的 `if (parameters.previousBody && isEqual(parameters.previousBody, body)) return;` 檢查（line 315-318）作為 **Redis-cached fast-path**。這與 `claimWebhookResult` 內的 `isEqual(existing.body, body)` 語義相同，但分層意圖不同：

- **fast-path（previousBody）**：透過 `getWebhookResult` 讀取 Redis cache（見 line 184-218 與 `cache = getCacheInstance({ ttl: 300_000 })`），body 未變的情況下直接 return，**零 MongoDB 查詢**，延遲在毫秒以下
- **authoritative check（claimWebhookResult）**：upsert + findOne 共兩次 MongoDB round-trip，是跨實例、跨時段的最終防線

兩層並存是為了「常見路徑快、極端情況安全」。若 previousBody 檢查命中（body 未變），省下 claim 的兩次 MongoDB 查詢；若未命中（cache miss / body 不同 / 首次事件），再走 claim 做權威判定。

**參數物件保留**：`parameters.previousBody` 與 `parameters.previousResponse` 除了用於此 fast-path，也是 json-templates 模板的公開 API（使用者可在 webhook template 引用 `{{previousBody}}` 或 `{{previousResponse.id}}`），不要移除。

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

### Task 13: loadJobContext（Worker 端重建事件 context）

**Files:**

- Modify: `src/commands/webhook.ts`

**背景**：worker 消費 `WebhookJob` 時，payload 只有 `{ webhookId, coll, docId, operationType }`。需要 helper 從 MongoDB 重新載入 webhook config 與 fullDocument，組成 `processWebhookEvent` 所需的 `WatcherResultDocument`。此 helper 不涉及 Redis，單純是 Layer 4 worker 側的 shared helper，留在 `webhook.ts`。

Resume token 相關 helper（load / save）則改為 Task 14 ChangeStreamModule 的 private method（Layer 2 內部實作細節），不放在 `webhook.ts`。

- [ ] **Step 1: 在 webhook.ts 頂端 import 區塊加入 WebhookJob 型別**

```typescript
import type { WebhookJob } from "../interfaces.js";
```

- [ ] **Step 2: 在 `processWebhookEvent` 之前新增 `loadJobContext` helper**

```typescript
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
```

注意：在 import 區塊中確認已加入 `getModelByCollectionName`（應已存在）、`mongo`（從 mongoose 已匯入）、`WebhookModel`（應已存在）。若 TypeScript 對 `WatcherResultDocument` 的 typing 較嚴格，使用 `as WatcherResultDocument` cast 即可。

- [ ] **Step 3: 在檔案末尾加入暫時引用以避免 `noUnusedLocals` 錯誤**

此 helper 要到 Task 15 才被 worker handler 呼叫，先加 placeholder（Task 15 完成後刪除）：

```typescript
void loadJobContext;
```

- [ ] **Step 4: Type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。

- [ ] **Step 5: Commit**

```bash
git add src/commands/webhook.ts
git commit -m "feat(webhook): add loadJobContext helper for worker side"
```

---

### Task 14: WebhookChangeStreamModule（Layer 2 抽離為獨立 Application 模組）

**Files:**

- Create: `src/modules/webhook/changestream.ts`

**Scope**：把原本散在 `runWebhook` 裡的「changeStream 生命週期 + meta-stream + resume token + rebalance 監聽」全部收進一個 Application 模組。對應 design spec Layer 2。

**主要設計決策**：

- **單一類別封裝**：`WebhookChangeStreamModule` implements `Module`。所有 state（collections Map / setup queue / meta-stream）與邏輯（reconcile / open / close）都是 class 的 private member。
- **透過 `app.get` 取依賴**：在 `init()` 開頭取得 `RedisModule` / `WebhookPartitionModule` / `WebhookQueueProducerModule`。建構時只接受 `app` 參考，不做實際工作。
- **簡化 setup 流程**：移除原本的 `setupWebhooks → setupWebhook → startChangeStream` 三層。改為**單層 reconcile**：`setupCollections()` 一次計算完「本實例該監聽哪些 coll」，直接 diff 當前狀態並執行 open/close。內部 helper 只有 `openCollection` 與 `closeCollection`（後者同時負責寫入 final resume token，取代既有 `removeWebhook` 與 `closeChangeStream` 的微妙區分）。
- **debounce via PQueue(concurrency=1)**：`setupQueue.size < 2` 的 cap-at-2 模式保留，純粹作為 debounce（避免 meta-stream 爆量事件觸發多次 reconcile）。
- **Resume token helpers 變 private method**：`loadResumeToken` / `saveResumeToken` 只被這個模組使用，封裝進 class，不再暴露為 file-level 函數。
- **命名調整**：`CollectionSetting` → `CollectionState`（存的是 runtime state，不是設定）；`setupWebhooks` → `setupCollections`；`startChangeStream` → `openCollection`；`closeChangeStream` + `removeWebhook` → `closeCollection`。

- [ ] **Step 1: 新增 `src/modules/webhook/changestream.ts`**

```typescript
import type { DocumentType } from "@typegoose/typegoose";
import { isEqual, groupBy } from "lodash-es";
import { mongo } from "mongoose";
import PQueue from "p-queue";
import { WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS } from "../../constants.js";
import type { WebhookJob } from "../../interfaces.js";
import WebhookModel, { type Webhook } from "../../models/Webhook.js";
import { flatObjectKey, setIfDefine } from "../../util.js";
import type { Application } from "../application.js";
import { documentLog, getModelByCollectionName } from "../db.js";
import { isMatching } from "../matching.js";
import type { Module } from "../module.js";
import { RedisModule } from "../redis.js";
import { WebhookPartitionModule } from "./partition.js";
import { WebhookQueueProducerModule } from "./queue.js";

interface CollectionState {
  changeStream: mongo.ChangeStream;
  tokenSaveInterval: NodeJS.Timeout;
  changeStreamMatch: any;
  webhooks: DocumentType<Webhook>[];
}

function requireModule<T extends Module>(app: Application, name: string): T {
  const mod = app.get<T>(name);
  if (!mod) {
    throw new Error(
      `WebhookChangeStreamModule: required module '${name}' not found`
    );
  }
  return mod;
}

/**
 * Listens to MongoDB changeStreams for the collections this instance owns and
 * forwards each relevant insert/update event into the bee-queue worker pool
 * for actual webhook delivery. Centralises all changeStream lifecycle in one
 * place so that webhook config changes (meta-stream) and ownership changes
 * (partition rebalance) trigger a single reconcile path.
 *
 * Owns:
 *   - meta-stream: a single changeStream on WebhookModel that watches insert /
 *     update / replace / delete on webhook config documents and triggers a
 *     reconcile so newly enabled collections are picked up and disabled ones
 *     are dropped.
 *   - per-collection changeStreams: opens one ChangeStream per collection that
 *     this instance currently owns, with a $match filter assembled from all
 *     enabled webhooks targeting that collection.
 *   - resume token persistence: writes the latest resume token to Redis on a
 *     periodic interval and again at close, so a restarted instance (or a new
 *     owner after rebalance) resumes from where the previous owner stopped.
 *   - reconcile loop: idempotent setupCollections() that diffs the desired
 *     ownership set (from partition.getAssignedCollections + enabled webhook
 *     list) against the currently-open streams and opens / closes / updates as
 *     needed. Triggered by meta-stream events and by partition rebalance.
 *
 * Dependencies (obtained in init() via app.get):
 *   - RedisModule: stores resume tokens under "webhook:resumetoken:<coll>"
 *     keys. Resume tokens are this module's internal state — no other module
 *     reads them.
 *   - WebhookPartitionModule: provides getAssignedCollections() to compute
 *     ownership and emits "rebalance" when the active instance set changes.
 *   - WebhookQueueProducerModule: receives change events via
 *     producerModule.scheduleAndEnqueue(job). The cooldown window, in-flight
 *     coalesce check, and Redis WATCH/MULTI/EXEC coordination all live inside
 *     the producer; this module just hands over a WebhookJob describing the
 *     event.
 */
export class WebhookChangeStreamModule implements Module {
  public readonly name = "webhook-changestream";
  public isInit = false;

  private redisModule!: RedisModule;
  private partition!: WebhookPartitionModule;
  private producerModule!: WebhookQueueProducerModule;

  private readonly collections = new Map<string, CollectionState>();
  // PQueue(concurrency=1) + size<2 cap: serialize reconcile runs and
  // coalesce burst events (meta-stream + rebalance) into at most 2 pending runs
  private readonly setupQueue = new PQueue({ concurrency: 1 });
  private metaStream?: mongo.ChangeStream;

  constructor(private readonly app: Application) {}

  async init(): Promise<void> {
    this.redisModule = requireModule(this.app, "redis");
    this.partition = requireModule(this.app, "webhook-partition");
    this.producerModule = requireModule(this.app, "webhook-queue-producer");

    // Meta-stream: watch Webhook config inserts/updates/replaces/deletes
    this.metaStream = WebhookModel.watch([
      {
        $match: {
          operationType: { $in: ["insert", "update", "replace", "delete"] },
        },
      },
    ]).on("change", (data: mongo.ChangeStreamDocument<Webhook>) => {
      documentLog(data, data.operationType.toUpperCase());
      this.scheduleSetup();
    });

    // React to partition reassignments. This also provides our INITIAL
    // reconcile: runWebhook registers changestream BEFORE partition so that
    // partition closes first under LIFO shutdown — partition's close()
    // promptly DELs its instance key from Redis and broadcasts a rebalance,
    // letting peers begin reassignment while our own changeStreams are still
    // alive to flush in-flight events. As a consequence, this init() runs
    // while partition is still uninitialized. partition.init() will later
    // publish to its rebalance channel as its last step, and its own
    // subscriber loops it back to emit "rebalance" on the EventEmitter —
    // triggering our first setupCollections() call with a fully-populated
    // activeInstanceIds. No manual initial reconcile is needed.
    this.partition.on("rebalance", () => this.scheduleSetup());
  }

  async close(): Promise<void> {
    // Stop accepting new meta-stream events
    if (this.metaStream) {
      await this.metaStream.close();
    }
    // Drain any in-flight reconcile runs
    await this.setupQueue.onIdle();
    // Close all owned collection streams (writes final resume tokens)
    for (const coll of Array.from(this.collections.keys())) {
      await this.closeCollection(coll);
    }
  }

  /** Enqueue a reconcile run. Drops if ≥2 already queued (debounce). */
  private scheduleSetup(): void {
    if (this.setupQueue.size < 2) {
      void this.setupQueue.add(() => this.setupCollections());
    }
  }

  /**
   * Reconcile loop: fetch enabled webhooks, compute which colls this instance
   * should listen to via partition.getAssignedCollections, then diff against
   * current `collections` Map to open/close/keep each one.
   */
  private async setupCollections(): Promise<void> {
    try {
      const allWebhooks = await WebhookModel.findEnabled();
      const valid = allWebhooks.filter((wh) => this.validateWebhook(wh));
      const byColl = groupBy(
        valid.flatMap((webhook) =>
          webhook.colls.map((coll) => ({ webhook, coll }))
        ),
        ({ coll }) => coll
      );
      const allColls = Object.keys(byColl);
      const assigned = new Set(this.partition.getAssignedCollections(allColls));

      // 1) Close collections no longer owned or no longer configured
      for (const coll of Array.from(this.collections.keys())) {
        if (!assigned.has(coll) || !byColl[coll]) {
          await this.closeCollection(coll);
        }
      }

      // 2) Open or reconfigure assigned collections
      for (const coll of assigned) {
        const webhooks = byColl[coll].map(({ webhook }) => webhook);
        const match = this.buildMatch(webhooks);
        const existing = this.collections.get(coll);
        if (
          existing &&
          existing.changeStream.closed === false &&
          isEqual(match, existing.changeStreamMatch)
        ) {
          // same match + still open: just refresh webhooks reference
          existing.webhooks = webhooks;
          continue;
        }
        // new coll or match changed: close (if any) and reopen
        if (existing) await this.closeCollection(coll);
        await this.openCollection(coll, webhooks, match);
      }
    } catch (error) {
      documentLog("global", "<!> [FATAL] Unable to setup webhooks.", error);
      process.exit(1);
    }
  }

  private buildMatch(webhooks: DocumentType<Webhook>[]): any {
    return {
      $or: webhooks.map((webhook) =>
        flatObjectKey({
          operationType: webhook.followUpdate
            ? { $in: ["insert", "update"] }
            : "insert",
          ...setIfDefine("fullDocument", webhook.match),
        })
      ),
    };
  }

  private validateWebhook(webhook: DocumentType<Webhook>): boolean {
    const error = webhook.validateSync();
    if (error) {
      documentLog(
        webhook,
        "<!> [ERROR] The format of the webhook is incorrect.",
        error
      );
      return false;
    }
    return true;
  }

  private async openCollection(
    coll: string,
    webhooks: DocumentType<Webhook>[],
    match: any
  ): Promise<void> {
    const model = getModelByCollectionName(coll);
    if (!model) {
      documentLog(
        coll,
        `<!> [ERROR] Unable to get model (unknown collection "${coll}")`
      );
      return;
    }
    const resumeAfter = await this.loadResumeToken(coll);
    const changeStream = model.watch([{ $match: match }], {
      resumeAfter: resumeAfter as any,
      fullDocument: "updateLookup",
      readPreference: "secondaryPreferred",
    });

    const tokenSaveInterval = global.setInterval(() => {
      const token = (changeStream as any).resumeToken;
      if (!token) return;
      void this.saveResumeToken(coll, token).catch((err) =>
        documentLog(coll, "<!> [WARN] resume token save failed:", err)
      );
    }, WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS);

    changeStream.on("change", (data: mongo.ChangeStreamDocument) => {
      this.handleChangeEvent(coll, data);
    });

    this.collections.set(coll, {
      changeStream,
      tokenSaveInterval,
      changeStreamMatch: match,
      webhooks,
    });
    documentLog(coll, `start listening (match length: ${match.$or.length})`);
  }

  private async closeCollection(coll: string): Promise<void> {
    const state = this.collections.get(coll);
    if (!state) return;
    this.collections.delete(coll);
    global.clearInterval(state.tokenSaveInterval);
    // Read resumeToken BEFORE close() — driver may clear it afterwards
    const finalToken = (state.changeStream as any).resumeToken;
    try {
      await state.changeStream.close();
      state.changeStream.removeAllListeners();
    } catch (error) {
      documentLog(coll, "<!> [ERROR] Unable to close change stream.", error);
    }
    if (finalToken) {
      await this.saveResumeToken(coll, finalToken).catch(() => {});
    }
    documentLog(coll, "stop listening");
  }

  private handleChangeEvent(
    coll: string,
    data: mongo.ChangeStreamDocument
  ): void {
    if (data.operationType !== "insert" && data.operationType !== "update")
      return;
    if (!("documentKey" in data)) return;
    if (!("fullDocument" in data) || !data.fullDocument) {
      documentLog(coll, "<!> [ERROR] missing fullDocument", data.documentKey);
      return;
    }
    const state = this.collections.get(coll);
    if (!state) return;

    const docId = (data.documentKey._id as mongo.BSON.ObjectId).toHexString();
    for (const webhook of state.webhooks) {
      if (!webhook.followUpdate && data.operationType === "update") continue;
      if (webhook.match && !isMatching(data.fullDocument, webhook.match))
        continue;
      const job: WebhookJob = {
        webhookId: webhook._id.toHexString(),
        coll,
        docId,
        operationType: data.operationType,
      };
      void this.producerModule
        .scheduleAndEnqueue(job)
        .catch((err) =>
          documentLog(coll, "<!> [ERROR] scheduleAndEnqueue failed:", err)
        );
    }
  }

  private async loadResumeToken(coll: string): Promise<unknown | undefined> {
    const raw = await this.redisModule.redis.get(`webhook:resumetoken:${coll}`);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw).token;
    } catch {
      return undefined;
    }
  }

  private async saveResumeToken(coll: string, token: unknown): Promise<void> {
    await this.redisModule.redis.set(
      `webhook:resumetoken:${coll}`,
      JSON.stringify({
        token,
        updatedAt: Date.now(),
        owner: this.partition.instanceId,
      }),
      { EX: 3600 }
    );
  }
}
```

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。若 `import { isEqual, groupBy } from "lodash-es";` 報錯，確認 lodash-es 已安裝（既有專案依賴）。若 `WebhookQueueProducerModule` import 出錯，確認 Task 9 已完成。

- [ ] **Step 3: Lint check**

```bash
npx eslint src/modules/webhook/changestream.ts
```

Expected: 無錯誤。

- [ ] **Step 4: Commit**

```bash
git add src/modules/webhook/changestream.ts
git commit -m "feat(webhook): add WebhookChangeStreamModule (Layer 2) as Application module"
```

---

### Task 15: runWebhook() 主函數重寫（組裝層）

**Files:**

- Modify: `src/commands/webhook.ts`

在 Layer 2 抽出成 `WebhookChangeStreamModule` 後，`runWebhook` 僅剩「組裝 Application + 註冊模組 + 設定 worker handler + 初始化」。既有 `startChangeStream` / `closeChangeStream` / `setupWebhook` / `setupWebhooks` / `removeWebhook` / `bufferChange` / `processWebhookQueue` / `prepareWebhookEvent` / `webhooksChangeStream` / 相關 `app.use` 全部**刪除**。

- [ ] **Step 1: 新增必要的 imports**

在檔案頂部 import 區塊加入：

```typescript
import { RedisModule } from "../modules/redis.js";
import { WebhookChangeStreamModule } from "../modules/webhook/changestream.js";
import { WebhookPartitionModule } from "../modules/webhook/partition.js";
import {
  WebhookQueueConsumerModule,
  WebhookQueueProducerModule,
} from "../modules/webhook/queue.js";
```

**不要**匯入 `createClient` / `REDIS_URI` / `WEBHOOK_COOLDOWN_MS` / `WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS` — 這些都已移入 ChangeStreamModule 內部。

- [ ] **Step 2: 重寫 runWebhook**

找到 `export async function runWebhook`（約 line 361）。整個函數完整替換為：

```typescript
export async function runWebhook() {
  await importAllModels();
  const app = new Application();

  // Infrastructure modules — init first, close last
  app.use(new MongodbModule());
  app.use({
    name: "discord-rest-client",
    async close() {
      // wait for all pending Discord REST handlers to flush
      for (const [, handler] of discordRest.handlers) {
        while (!handler.inactive) {
          await setTimeout(100);
        }
      }
    },
  });
  app.use(new RedisModule());

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

  await app.init();
  console.log("webhook is ready");
}
```

- [ ] **Step 3: 刪除舊程式碼**

在 `runWebhook` 之外（檔案中其他地方）與之內，刪除所有下列既有定義。每一條都要移除以免死碼：

- `interface CollectionSetting` 及其使用點（已被 `CollectionState` 取代於 ChangeStreamModule 內）
- `function changeStreamIsValid` 獨立定義（已內聯為 ChangeStreamModule 內的條件判斷）
- `function closeChangeStream` 獨立定義（已合併為 `closeCollection`）
- `function removeWebhook` 獨立定義（已合併為 `closeCollection`）
- `function startChangeStream` 獨立定義（已改為 `openCollection`）
- `function setupWebhook` 獨立定義（已內聯為 `setupCollections` 的迴圈）
- `function setupWebhooks` 獨立定義（已改為 `setupCollections`）
- `function prepareWebhookEvent` 獨立定義（被 `scheduleAndEnqueue` 取代）
- `const bufferChange = new Map<...>();`
- `const processWebhookQueue = new PQueue();`
- `global.setInterval(() => { for (const [key, { webhook, data }] of bufferChange) ... }, 5000);`
- `const setupWebhooksQueue = new PQueue(...);`
- `const webhooksChangeStream = WebhookModel.watch(...)...`
- 對應的 `app.use({ name: "process-webhook-queue", ... })`、`app.use({ name: "remove-webhook", ... })`、`app.use({ name: "setup-webhooks-queue", ... })`、`app.use({ name: "webhook-change-stream", ... })` 註冊
- Task 13 加入的 `void loadJobContext;` placeholder（現在被 worker handler 使用，不再需要）

保留：

- `processWebhookEvent` 函數（Layer 4 核心邏輯）
- `sendDiscordWebhook` / `sendWebhook`（Task 11 改寫過的版本）
- `loadJobContext`（Task 13 的 worker helper）
- `claimWebhookResult` 匯入（Task 10/12）
- `axiosInstance` / `discordRest` / `cache` 等既有設施
- 所有 helper：`createWebhookResultIdentifier` / `createWebhookResultCacheKey` / `getWebhookTemplateCache` / `getVideo` / `getChannel` 等

- [ ] **Step 4: Type check**

```bash
npx tsc --noEmit
```

Expected: 無錯誤。若有 `CollectionSetting` 等已刪除型別的殘留引用，逐個移除。

- [ ] **Step 5: Lint check**

```bash
npx eslint src/commands/webhook.ts src/modules/webhook/
```

Expected: 無錯誤。

- [ ] **Step 6: 執行所有單元測試**

```bash
npx jest src/modules/webhook/partition.spec.ts src/modules/webhook/queue.spec.ts src/modules/webhook/claim.spec.ts
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/commands/webhook.ts
git commit -m "refactor(webhook): simplify runWebhook to pure module wiring"
```

### Task 16: 人工煙霧測試（smoke test）

**Files:** 無（純驗證步驟）

**前提**：在執行此步驟前，確認：

- Task 1–15 所有 commit 已完成
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
