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

```text
Producer（WATCH loop 之前）:
  SET webhook:pending:{jobId}       ← 在整個 WATCH loop 之前一次性 SET

Producer（WATCH loop 內，coalesce 分支）:
  getJob(jobId) !== null  →  in-flight
    → unwatch, return "coalesced"
  （not in-flight → 走正常 immediate/delayed/fallback 分支；新建 job 的 ① 會 DEL pending，無害）

Worker（queue.process() 內，job 開始時）:
  DEL webhook:pending:{jobId}       ← 清除 job 啟動前累積的 pending

Worker（queue.process() 內，執行 handler）:
  執行業務邏輯（handler）

Worker（queue.on("succeeded") 內，job 從 hash 移除後）:
  const hasPending = await redis.exists(pendingKey)
  if (hasPending > 0):
    await redis.del(pendingKey)
    await producer.scheduleAndEnqueue({ ...job.data, operationType: "update" })
    ← reschedule 一律以 "update" 發送，因為 pending 代表文件在處理中已變更
```

### 為什麼 SET pending 必須在 WATCH loop 之前

1. **避免 WATCH session 中混入非 MULTI 寫入**：`redis.watch(nextKey)` 後、`multi().exec()` 前執行 `redis.set(pendingKey, ...)` 雖然在 Redis server 層面不影響 WATCH 語義（只有 nextKey 的修改才會讓 EXEC 失敗），但語義上應分開：WATCH/MULTI/EXEC 用於 nextKey 的原子更新，pending flag 的 SET 是獨立的 best-effort 操作，放在迴圈外更清晰且無干擾風險。
2. **避免每次 WatchError retry 重複 SET**：SET pending 在迴圈外只執行一次，idempotent（同一 key，同一值）。

### 為什麼「先 SET 再判斷 in-flight」能消除殘餘 race

舊設計：`isJobInFlight → unwatch → SET pending` 的 race window 是「in-flight check 到 SET pending」這段時間。若 worker 在此期間完成 ③（check pending → false），pending 被孤立。

新設計（SET 在 WATCH loop 之前）：

- 若 in-flight：producer 返回 "coalesced"，pending 留存；worker 的 `succeeded` listener 觸發時 job 已從 hash 移除，EXISTS → "1" → 觸發 reschedule ✓
- 若 not in-flight（job 在 producer SET pending 之前已完成，且 `succeeded` listener 已執行完 ③）：isJobInFlight 返回 false → 走 immediate/delayed 分支建立新 job → 新 job 的 ① DEL pending，無害 ✓

**透過 `succeeded` 事件消除殘餘 race**：bee-queue 在原子性移除 job 的 jobs hash 後才 emit `succeeded`。`succeeded` 觸發時，任何並發 producer 呼叫 `isJobInFlight` 均返回 false，會走 immediate/delayed 分支建立新 job（非 coalesce）。換言之，`succeeded` listener 執行 ③ 時，「producer 已 SET pending 但仍判斷 in-flight → coalesced」的場景已不可能發生——job 不再在 hash 中，producer 無法再 coalesce。殘餘 race **已徹底消除**。

**並發 producer 在 `succeeded` 後建立新 job 的安全性**：若 `succeeded` listener 的 EXISTS 與一個 producer 的 `createJob().setId().save()` 並發，兩者可能同時嘗試建立相同 jobId 的 job，bee-queue `setId` 使用 `HSETNX` 保證只有一個 job 真正進入佇列。

### 為什麼「開始時 DEL」能自然區分 active 與非 active

- **Job 處於 waiting/delayed**：pending flag 在 DEL 之前就已設定。Worker 啟動時清除 pending，接著讀 document（此時文件已是最新）→ `succeeded` listener 執行時無 pending → 不觸發 reschedule。正確：waiting/delayed job 本就會在觸發時讀最新狀態。
- **Job 處於 active（正在讀文件中）**：pending flag 在 DEL 之後才設定 → `succeeded` listener 執行時有 pending → 觸發 reschedule，補上漏掉的變更。

不需要另設 `webhook:active:{jobId}` 標記，「開始時 DEL」本身即是正確的邊界。

### 關鍵不變式

本機制依賴以下執行順序：

1. ① `DEL pending`（`queue.process()` 內）必須**先於** ② handler 讀取 document
2. ③ `EXISTS pending`（`queue.on("succeeded")` 內）必須**後於** ② handler 完成所有可觀察變更，且**後於** job 從 hash 移除

滿足此不變式時：

- 任何在 ① 之後、③ 之前 SET 的 pending flag 都會被 ③ 看到 → 觸發 reschedule
- 任何在 ① 之前 SET 的 pending flag，對應的變更已被 ② 讀入 → DEL 後不 reschedule 正確
- ③ 執行時 job 已不在 hash 中 → producer 無法 coalesce → 無殘餘 race

bee-queue 保證 `queue.process()` handler resolve 後才 emit `succeeded`，且 `succeeded` 在原子性移除 job 後才 emit，故不變式成立。

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

SET pending 在 WATCH loop **之前**執行（一次性，不受 WatchError retry 影響）：

```typescript
// src/modules/webhook/queue.ts — scheduleAndEnqueue()

const jobId = buildJobId(job);
const nextKey = buildNextKey(jobId);
const pendingKey = buildPendingKey(jobId);

// SET pending 在 WATCH loop 之前：
// 1. 避免在 WATCH session 中混入非 MULTI 寫入（語義更清晰）
// 2. 只 SET 一次，不因 WatchError retry 重複執行
// 3. 大幅縮小「isJobInFlight 判斷時 job 已完成但 pending 未 SET」的 race window
await redis.set(pendingKey, "1", {
  PX: WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS,
});

let lastNextAllowed = 0;
for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  await redis.watch(nextKey);
  // ...（現有 GET nextKey + isJobInFlight + immediate/delayed 邏輯不變）

  if (await isJobInFlight(queue, jobId)) {
    await redis.unwatch();
    return "coalesced";
    // pending 保留，worker ③ 會清除並觸發 reschedule
  }
  // not in-flight：走 immediate/delayed 分支，新建 job 的 ① 會 DEL pending，無害
}

// fallback-delayed：新建 job 的 ① 同樣會 DEL pending，無害
```

**改動範圍**：僅 `scheduleAndEnqueue` 純函數本體（`SET pending` 一行提至 `for` loop 前）。`WebhookQueueProducerModule.scheduleAndEnqueue` wrapper 不需改動。

**Non-follow-update webhook**（`followUpdate: false`）不受影響：non-follow-update 走快速路徑（直接 `createJob().setId().save()`），不進 WATCH/MULTI/EXEC 迴圈，也不進 coalesce 分支。

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

### queue.process() 與 succeeded 監聽器

`queue.process()` 只負責 ① 與 ②；③ 移至 `queue.on("succeeded")` 中執行（此時 job 已從 hash 移除）：

```typescript
// 新增私有成員（shutdown drain 用）
private pendingSucceededWork = new Set<Promise<void>>();

async init(): Promise<void> {
  // ...（依賴取得）

  await this.queue.ready();

  // ①② 在 job 執行中
  this.queue.process(WEBHOOK_WORKER_CONCURRENCY, async (job) => {
    const jobId = buildJobId(job.data);
    const pendingKey = buildPendingKey(jobId);

    // ① 清除 job 啟動前累積的 pending flag
    await this.redis.del(pendingKey);

    // ② 業務邏輯（Layer 4，不感知 pending）
    await this.handler!(job);
  });

  // ③ 在 job 成功完成並從 hash 移除後
  // bee-queue 在原子性移除 job 後才 emit succeeded，故 isJobInFlight 已返回 false
  this.queue.on("succeeded", (job: BeeQueue.Job<WebhookJob>) => {
    const work = (async () => {
      const jobId = buildJobId(job.data);
      const pendingKey = buildPendingKey(jobId);
      const hasPending = await this.redis.exists(pendingKey); // node-redis returns number
      if (hasPending > 0) {
        await this.redis.del(pendingKey);
        // reschedule 一律以 "update"：pending 代表文件在處理中已變更
        await this.producer.scheduleAndEnqueue({
          ...job.data,
          operationType: "update",
        });
        // 預設 now=Date.now()、cooldown=WEBHOOK_FOLLOW_UPDATE_COOLDOWN_MS
      }
    })().catch((error) => {
      documentLog(job.data.coll, "<!> [WARN] post-job pending check failed:", error);
      // pending flag 將於 15s TTL 後過期，或由下次 changeStream 事件清除
    });
    this.pendingSucceededWork.add(work);
    void work.finally(() => this.pendingSucceededWork.delete(work));
  });
}

async close(): Promise<void> {
  await this.queue.close(SHUTDOWN_TIMEOUT);
  // bee-queue.close() 等待 activeJobs（①② handler），但 succeeded listener 的 async work
  // 是在 activeJobs 解除後才觸發的 .then() 鏈，不在 close() 追蹤範圍內。
  // setImmediate 讓已排隊的 microtask（succeeded emit）有機會執行並登記 work，
  // 再統一等待全部完成後才讓 producer 關閉。
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.allSettled(Array.from(this.pendingSucceededWork));
}
```

### 錯誤處理規範

- **① `DEL pending`（handler 前）失敗**：例外向上傳，bee-queue 重試整個 job；重試時再次執行 ① → 正確。
- **② `handler` 本身的例外**：依現有行為向上傳，bee-queue 重試。此行為不受本 patch 影響。
- **③ `EXISTS` / `DEL` / `scheduleAndEnqueue`（`succeeded` listener 內）失敗**：catch 後 log warning，job 已成功完成，不觸發 bee-queue retry。pending flag 於 15s TTL 後過期，或由下次 changeStream 事件（producer SET pending 後 isJobInFlight=false → 新 job）清除。**不依賴冪等重試**：③ 移至 `succeeded` listener 後，③ 失敗不會導致 webhook 重送，消除了對 `claimWebhookResult` 保護的依賴（`claimWebhookResult` 仍保障 ② 的冪等性，但不再是 ③ 失敗的補救機制）。

### Registration 順序

**破壞性變更**：當前 `src/commands/webhook.ts` 的建構順序為：
`consumer → producer → changeStream → partition`
（LIFO close：`partition → changeStream → producer → consumer → redis`，consumer 最後關閉）

本 patch 之後必須改為：
`producer → consumer → changeStream → partition`
（LIFO close：`partition → changeStream → consumer → producer → redis`，consumer 先於 producer 關閉）

```text
app.register(producerModule)      // 1st — init first
app.register(consumerModule)      // 2nd — init after producer (depends on app.get("webhook-queue-producer"))
app.register(changeStreamModule)  // 3rd — changeStream calls producer.scheduleAndEnqueue; close before consumer
app.register(partitionModule)     // 4th — init last, close first
```

**LIFO close 正確性驗證**：

- `partition` 先關閉：DEL instance key + 廣播 rebalance，peers 開始接管 changeStream
- `changeStream` 關閉：drain setupQueue，close 所有 collection changeStream，**不再**呼叫 `scheduleAndEnqueue`
- `consumer` 關閉：`queue.close(SHUTDOWN_TIMEOUT)` 等待 in-flight handler（①②），隨後 `setImmediate` 讓剩餘 succeeded emit 觸發，最後 `Promise.allSettled(pendingSucceededWork)` 等待所有 ③ async work 完成
- `producer` 關閉：此時 consumer 已關，所有 ③ `scheduleAndEnqueue` 已完成，不會 use-after-close

此順序確保：consumer 的整個 `close()` 返回前，所有 ③ reschedule 均已向 producer 提交。

**注意**：bee-queue 的 `queue.close(timeout)` 只等待 `activeJobs`（handler 執行），不等待 `succeeded` listener 的 async work（`succeeded` emit 在 `_finishJob().then()` 鏈中觸發，晚於 `activeJobs` 清除）。`pendingSucceededWork` Set 追蹤這些 async work，使 `consumer.close()` 能完整 drain。

**破壞性 API 變更**：`WebhookQueueConsumerModule` constructor signature 由 `()` 變為 `(app: Application)`。`src/commands/webhook.ts` 中的 `new WebhookQueueConsumerModule()` 必須更新為 `new WebhookQueueConsumerModule(app)`。

---

## 修正後時序驗證

**參數**：cooldown=5s，worker 處理需 2s

| 時間 | 事件                          | nextAllowed | 動作                                                                              | pending flag |
| ---- | ----------------------------- | ----------- | --------------------------------------------------------------------------------- | ------------ |
| t=0  | A                             | 0→5         | 立即推入，worker 啟動：① DEL pending（no-op），② 讀 doc                           | —            |
| t=1  | B                             | —           | in-flight → coalesced，SET pending                                                | "1"          |
| t=2  | worker handler 完成（②結束）  | —           | \_finishJob multi.exec：HDEL jobs hash + PUBLISH；job 從 hash 移除                | "1"          |
| t=2  | succeeded 事件觸發（③）       | —           | EXISTS pending="1" → DEL → scheduleAndEnqueue({…, operationType:"update"}, now=2) | cleared      |
| t=2  | reschedule                    | 5→10        | now=2 < nextAllowed=5 → delayed, delayUntil=5                                     | —            |
| t=5  | bee-queue 觸發 reschedule job | —           | ① DEL pending（no-op），② 讀最新 doc（operationType:"update"，捕捉 t=1 變更）     | —            |
| t=7  | worker 完成                   | —           | succeeded listener：EXISTS pending=0 → 結束                                       | —            |

**t=1 的變更不再遺漏** ✓，相鄰觸發間隔仍 ≥5s（t=0 → t=5）✓

**t=2 reschedule 的計算說明**：Delayed 分支以 `nextAllowed + cooldown`（= 5+5 = 10）更新 nextKey（非 `now + cooldown`），確保下一次觸發距本次觸發仍 ≥ cooldown。`delayUntil = now + (nextAllowed - now) = nextAllowed = 5`，因此 reschedule job 在 t=5 觸發，與 primary job 觸發時間（t=0）間隔恰好 5s ≥ cooldown。

---

## 邊界情況

| 情況                                                 | 行為                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker crash / stall（pending 存在）                 | bee-queue stall（stallInterval=30s）後將 job 從 active 移回 waiting 並重試；重試時 ① DEL pending，② 讀最新 doc（包含 stall 期間的所有變更），③ EXISTS → 0 → 不 reschedule（已讀入最新狀態）。**Stall 期間 pending 仍可被 SET（job 仍在 hash 中）**，但只要 ② 讀到最新狀態即正確；TTL(15s) < stallInterval(30s) 時若無新事件 SET pending，stall 後 pending 已過期，但 ② 依然讀到最新 doc ✓ |
| ① DEL 失敗（Redis 瞬斷）                             | 例外向上傳，bee-queue 重試整個 job；重試時再次 DEL → 正確                                                                                                                                                                                                                                                                                                                                 |
| ③ scheduleAndEnqueue 失敗（`succeeded` listener 內） | catch 後 log warning；job 已完成，不觸發 bee-queue retry。pending flag 於 15s TTL 後過期，或由下次 changeStream 事件重新觸發（producer isJobInFlight=false → 建立新 job）補上                                                                                                                                                                                                             |
| Handler retries 耗盡（job 永久失敗）                 | `removeOnFailure:true` 清除 job；若最後一次 retry 的 ① DEL 後有 changeStream 事件 SET pending，pending 會於 15s TTL 後孤立過期，該次變更遺漏。**已知限制**：與現有設計「Redis 故障時 save() 失敗事件可能遺漏」的可接受失敗模式一致；下次文件再次變更時會觸發新 job 補上                                                                                                                   |
| Producer SET pending 失敗（Redis 瞬斷）              | 例外向上傳至 `scheduleAndEnqueue` 呼叫端（changeStream handler）。changeStream handler 必須 catch 並 log error，不可靜默丟棄（同現有設計：任何 scheduleAndEnqueue 例外都需 log 後繼續）。若 job 仍 in-flight，下一個 changeStream 事件到來時會再次進入 coalesce 分支並重試 SET pending                                                                                                    |
| ③ scheduleAndEnqueue 返回 "coalesced"                | 此期間又有新 event 搶先建立了 job，pending 已由新 job 接手，無需補救                                                                                                                                                                                                                                                                                                                      |
| Worker 處理時間 ≥ cooldown                           | 完成時 `now >= nextAllowed` → ③ 的 scheduleAndEnqueue 走 immediate 分支，立即推入；相鄰觸發間隔 = worker 處理時間 ≥ cooldown，不變量維持                                                                                                                                                                                                                                                  |
| Reschedule 時 nextAllowed 已過期（key TTL 到）       | `now >= 0` → immediate 分支，正常推入                                                                                                                                                                                                                                                                                                                                                     |
| Non-follow-update webhook                            | pending key 不存在，DEL 與 EXISTS 均為 O(1) no-op，無副作用                                                                                                                                                                                                                                                                                                                               |

---

## 測試需求

1. **Active 期間有變更（處理時間 < cooldown）**：handler 暫停中（t < cooldown），producer 呼叫
   `scheduleAndEnqueue` → 返回 `"coalesced"`，pending 存在；resolve handler → 等待 `succeeded`
   觸發 → spy on `producer.scheduleAndEnqueue` 驗證：第一個引數
   `{ ...job.data, operationType: "update" }`，`now` ≥ handler resolve 時間點，`cooldown` 為
   預設 `WEBHOOK_FOLLOW_UPDATE_COOLDOWN_MS`；被呼叫恰好一次。

2. **Active 期間有變更（處理時間 ≥ cooldown）**：handler 執行時間 ≥ cooldown，reschedule 走
   immediate 分支（`now >= nextAllowed`）；同上驗證第一引數 `operationType` 為 `"update"`。

3. **Delayed job 清除 pending**：delayed job 啟動時 ① DEL pending → succeeded listener EXISTS → 0
   → 不觸發 reschedule（變更在 waiting/delayed 階段，已由 ② 讀取最新狀態）。

4. **兩次 coalesce**：primary active 期間兩次 SET pending（同一 key，冪等）→ worker 只 reschedule 一次。

5. **reschedule 後無新變更**：reschedule job 完成後 succeeded listener EXISTS → 0 → 不再 reschedule。

6. **buildPendingKey**：對任意 `WebhookJob`，`buildPendingKey(buildJobId(job))` 回傳
   `webhook:pending:${webhookId}:${coll}:${docId}`，與 `buildNextKey` 共用相同 `buildJobId` 串接規則。

---

## 影響範圍

| 元件                                | 變更                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/webhook/queue.ts`      | `scheduleAndEnqueue`：SET pending 移至 WATCH loop 之前；新增 `buildPendingKey` helper                                                                                                                                                                                                                     |
| `src/modules/webhook/queue.ts`      | `WebhookQueueConsumerModule`：constructor `()` → `(app: Application)`（破壞性 API 變更）；`init()` 取得 redis/producer；`queue.process()` 加入 ①② 邏輯；新增 `queue.on("succeeded")` 監聽器執行 ③；新增 `pendingSucceededWork` Set 追蹤 async work；覆寫 `close()` 以 drain succeeded async work 後再返回 |
| `src/modules/webhook/queue.spec.ts` | 新增上述測試案例                                                                                                                                                                                                                                                                                          |
| `src/commands/webhook.ts`           | `new WebhookQueueConsumerModule()` → `new WebhookQueueConsumerModule(app)`；調整 register 順序為 `producer → consumer → changeStream → partition`                                                                                                                                                         |
