# Webhook Pending Reschedule 設計

## 背景與問題

`scheduleAndEnqueue`（`src/modules/webhook/queue.ts`）的現行 coalesce 語義存在一個遺漏場景：當某個 `(webhookId, coll, docId)` 的 job 正在被 worker **active 處理中**（worker 已開始讀取 document），此時若有新的 MongoDB changeStream 事件到來，該事件會被標記為 coalesced 而丟棄。由於 worker 已讀完舊狀態，這份變更最終無人處理。

### 時序說明（cooldown=5s，worker 處理需 2s）

| 時間     | 事件                | 現行行為                                     |
| -------- | ------------------- | -------------------------------------------- |
| t=0      | Event A             | 立即推入，worker 開始讀 t=0 文件狀態         |
| t=1      | Event B（文件變更） | `getJob(jobId) !== null` → coalesced（丟棄） |
| t=2      | Worker 完成         | 讀到 t=0 狀態，已無任何 job                  |
| **結果** | **t=1 的變更遺漏**  | 沒有任何 job 會處理它                        |

**Root cause**：coalesce 假設「已有 job 會以最新狀態處理」，但若 job 在 coalesce 發生前已完成讀取 document，coalesce 期間的變更就無從被補上。

---

## 解法：Pending Flag + Worker 自動重新排程

### 核心機制

```
Producer（coalesce 分支）:
  getJob(jobId) !== null  →  in-flight
    → SET webhook:pending:{jobId}   ← 新增：標記「有尚未處理的變更」
    → return "coalesced"

Worker（job 開始時）:
  DEL webhook:pending:{jobId}       ← 清除 job 啟動前累積的 pending

Worker（job 結束時，handler return 前）:
  const hasPending = await redis.exists(pendingKey)
  if (hasPending):
    await redis.del(pendingKey)
    await producer.scheduleAndEnqueue(job.data, Date.now(), cooldown)
```

### 為什麼「開始時 DEL」能自然區分 active 與非 active

- **Job 處於 waiting/delayed**：pending flag 在 DEL 之前就已設定。Worker 啟動時清除 pending，接著讀 document（此時文件已是最新）→ 結束時無 pending → 不觸發 reschedule。正確：waiting/delayed job 本就會在觸發時讀最新狀態。
- **Job 處於 active（正在讀文件中）**：pending flag 在 DEL 之後才設定 → 結束時有 pending → 觸發 reschedule，補上漏掉的變更。

不需要另設 `webhook:active:{jobId}` 標記，「開始時 DEL」本身即是正確的邊界。

---

## Redis Key 設計

### 新增 Key

| Key 格式                                     | 值    | TTL                                                                  |
| -------------------------------------------- | ----- | -------------------------------------------------------------------- |
| `webhook:pending:{webhookId}:{coll}:{docId}` | `"1"` | `WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS`（15000ms，沿用現有常數） |

`jobId` 由現有 `buildJobId(job)` 產生（`${webhookId}:${coll}:${docId}`），pending key 格式為 `webhook:pending:${jobId}`，新增 helper：

```typescript
export function buildPendingKey(jobId: string): string {
  return `webhook:pending:${jobId}`;
}
```

### TTL 選擇

沿用 `WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS`（15s）：

- Pending flag 的生命週期比 `webhook:next:{jobId}` 短（job 完成即被清除），15s 的 TTL 完全足夠。
- 不需要新常數，與現有 `webhook:next:*` key 的 TTL 策略保持一致。

---

## ScheduleResult 型別

**不新增** `"coalesced-pending"` 型別，維持現有 `"coalesced"`：

- Pending flag 是 producer 的內部機制，呼叫端（changeStream handler）不需要區分。
- 可觀測性需求可透過 log 層處理，不需型別反映。

---

## Producer 變更（scheduleAndEnqueue）

coalesce 分支增加一行 SET：

```typescript
// src/modules/webhook/queue.ts — scheduleAndEnqueue()

if (await isJobInFlight(queue, jobId)) {
  await redis.unwatch();
  // 標記「有尚未處理的變更」供 worker 結束時檢查
  await redis.set(buildPendingKey(jobId), "1", {
    PX: WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS,
  });
  return "coalesced";
}
```

**改動範圍**：僅 `scheduleAndEnqueue` 純函數本體。`WebhookQueueProducerModule.scheduleAndEnqueue` wrapper 不需改動。

**Non-follow-update webhook**（§3.8）不受影響：non-follow-update 走快速路徑（直接 `createJob().setId().save()`），不進 WATCH/MULTI/EXEC 迴圈，也不進 coalesce 分支。

---

## Consumer 變更（WebhookQueueConsumerModule）

Pending flag 的 DEL/check/reschedule 屬於 **Task Distribution（Layer 3）** 的職責，封裝在 `WebhookQueueConsumerModule` 內部，上層 handler（Layer 4 Webhook Execution）不感知 pending 機制。

### 新增依賴

`WebhookQueueConsumerModule` 透過 `app` 取得（與 `WebhookQueueProducerModule` 的模式平行）：

- `RedisModule`：用於 pending flag 的 DEL / EXISTS
- `WebhookQueueProducerModule`：用於 reschedule

```typescript
// WebhookQueueConsumerModule — 新增 constructor 參數
constructor(private readonly app: Application) {
  this.queue = createWebhookQueue({ isWorker: true });
}

// init() 新增
private redis!: RedisClientType;
private producer!: WebhookQueueProducerModule;

async init(): Promise<void> {
  const redisModule = this.app.get<RedisModule>("redis");
  if (!redisModule) throw new Error("WebhookQueueConsumerModule: RedisModule not found");
  this.redis = redisModule.redis;

  const producer = this.app.get<WebhookQueueProducerModule>("webhook-queue-producer");
  if (!producer) throw new Error("WebhookQueueConsumerModule: WebhookQueueProducerModule not found");
  this.producer = producer;

  // ...
}
```

### queue.process() 包裝 handler

```typescript
async init(): Promise<void> {
  // ...（依賴取得）

  await this.queue.ready();
  this.queue.process(WEBHOOK_WORKER_CONCURRENCY, async (job) => {
    const jobId = buildJobId(job.data);
    const pendingKey = buildPendingKey(jobId);

    // ① 清除 job 啟動前累積的 pending flag
    await this.redis.del(pendingKey);

    // ② 業務邏輯（Layer 4，不感知 pending）
    await this.handler!(job);

    // ③ 結束時檢查是否有新變更需要補排
    const hasPending = await this.redis.exists(pendingKey);
    if (hasPending) {
      await this.redis.del(pendingKey);
      await this.producer.scheduleAndEnqueue(job.data);
      // 預設 now=Date.now()、cooldown=WEBHOOK_FOLLOW_UPDATE_COOLDOWN_MS
    }
  });
}
```

### 錯誤處理規範

- **① `DEL pending`（handler 前）失敗**：例外向上傳，bee-queue 重試整個 job；重試時再次執行 ① → 正確。
- **② `handler` 本身的例外**：依現有行為向上傳，bee-queue 重試。此行為不受本 patch 影響。
- **③ `EXISTS` / `DEL` / `scheduleAndEnqueue`（handler 後）失敗**：例外向上傳，bee-queue 重試整個 job（handler 重跑一次）。前提：webhook handler（② 的業務邏輯）必須是冪等的（與現有 bee-queue 重試語義一致）。重跑後若 ③ 成功，reschedule 一次；若再次失敗則繼續重試直至超過 retries 上限。

### Registration 順序

完整順序：`RedisModule` → `WebhookQueueProducerModule` → `WebhookQueueConsumerModule`。Consumer 的 `init()` 同時依賴 `app.get("redis")` 和 `app.get("webhook-queue-producer")`，兩者都必須先於 consumer 完成初始化。

LIFO 關閉：consumer 先關閉（停止接收新 job），producer 與 redis 後關閉，確保 ③ 的 reschedule 在 shutdown 期間仍能正常執行。

---

## 修正後時序驗證

**參數**：cooldown=5s，worker 處理需 2s

| 時間 | 事件                          | nextAllowed | 動作                                                           | pending flag |
| ---- | ----------------------------- | ----------- | -------------------------------------------------------------- | ------------ |
| t=0  | A                             | 0→5         | 立即推入，worker 啟動：DEL pending（no-op），讀 doc            | —            |
| t=1  | B                             | —           | in-flight → coalesced，SET pending                             | "1"          |
| t=2  | worker 完成                   | —           | check pending="1" → DEL → scheduleAndEnqueue(now=2)            | cleared      |
| t=2  | reschedule                    | 5→10        | now=2 < nextAllowed=5 → delayed, delayUntil=5                  | —            |
| t=5  | bee-queue 觸發 reschedule job | —           | worker 啟動：DEL pending（no-op），讀最新 doc（捕捉 t=1 變更） | —            |
| t=7  | worker 完成                   | —           | check pending → 不存在 → 結束                                  | —            |

**t=1 的變更不再遺漏** ✓，相鄰觸發間隔仍 ≥5s（t=0 → t=5）✓

**t=2 reschedule 的計算說明**：Delayed 分支以 `nextAllowed + cooldown`（= 5+5 = 10）更新 nextKey（非 `now + cooldown`），確保下一次觸發距本次觸發仍 ≥ cooldown。`delayUntil = now + (nextAllowed - now) = nextAllowed = 5`，因此 reschedule job 在 t=5 觸發，與 primary job 觸發時間（t=0）間隔恰好 5s ≥ cooldown。

---

## 邊界情況

| 情況                                           | 行為                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker crash，pending flag 已設                | bee-queue stall 後重試；重試時 ① DEL pending，重新執行完整流程，reschedule 邏輯在重試完成後正常觸發                                                                                                                                                                                    |
| ① DEL 失敗（Redis 瞬斷）                       | 例外向上傳，bee-queue 重試整個 job；重試時再次 DEL → 正確                                                                                                                                                                                                                              |
| ③ scheduleAndEnqueue 失敗                      | 例外向上傳，bee-queue 重試 job（handler 重跑一次，依賴 handler 冪等性）；重試時 ① DEL pending，重試完成後再次到達 ③；若成功則 reschedule 一次                                                                                                                                          |
| Producer SET pending 失敗（Redis 瞬斷）        | 例外向上傳至 `scheduleAndEnqueue` 呼叫端（changeStream handler）。changeStream handler 必須 catch 並 log error，不可靜默丟棄（同現有設計：任何 scheduleAndEnqueue 例外都需 log 後繼續）。若 job 仍 in-flight，下一個 changeStream 事件到來時會再次進入 coalesce 分支並重試 SET pending |
| ③ scheduleAndEnqueue 返回 "coalesced"          | 此期間又有新 event 搶先建立了 job，pending 已由新 job 接手，無需補救                                                                                                                                                                                                                   |
| Reschedule 時 nextAllowed 已過期（key TTL 到） | `now >= 0` → immediate 分支，正常推入                                                                                                                                                                                                                                                  |
| Non-follow-update webhook                      | pending key 不存在，DEL 與 EXISTS 均為 O(1) no-op，無副作用                                                                                                                                                                                                                            |

---

## 測試需求

1. **Active 期間有變更**：primary job active 時 SET pending → worker 完成後觸發 reschedule
2. **Delayed job 清除 pending**：delayed job 啟動時 DEL pending → 不觸發 reschedule（變更已被 worker 讀取）
3. **兩次 coalesce**：primary active 期間兩次 SET pending（同一 key，冪等）→ worker 只 reschedule 一次
4. **reschedule 後無新變更**：reschedule job 完成後 pending 不存在 → 不再 reschedule
5. **buildPendingKey**：對任意 `WebhookJob`，`buildPendingKey(buildJobId(job))` 回傳 `webhook:pending:${webhookId}:${coll}:${docId}`，與 `buildNextKey` 共用相同 `buildJobId` 串接規則

---

## 影響範圍

| 元件                                        | 變更                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/modules/webhook/queue.ts`              | `scheduleAndEnqueue` coalesce 分支新增 SET pending；新增 `buildPendingKey` helper                                  |
| `src/modules/webhook/queue.ts`              | `WebhookQueueConsumerModule`：constructor 接收 `app`；`init()` 取得 redis/producer；`queue.process()` 包裝 handler |
| `src/modules/webhook/queue.spec.ts`         | 新增上述測試案例                                                                                                   |
| `src/commands/webhook.ts`（或 wiring 位置） | `WebhookQueueConsumerModule` 建構時傳入 `app`；確保 registration 順序正確                                          |
