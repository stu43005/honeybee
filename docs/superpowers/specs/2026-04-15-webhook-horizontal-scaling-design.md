# Webhook 水平擴展架構設計

## 背景與問題

`src/commands/webhook.ts` 的現行實作無法水平擴展。核心限制：

- 每個進程獨立對所有配置的 collection 開啟 MongoDB changeStream，多進程會造成同一事件被重複處理並重複發送 webhook
- `bufferChange` Map（follow-update 去重緩衝）與 `processWebhookQueue`（PQueue 任務佇列）皆為 in-memory 結構，無法跨進程共享
- 無任何跨進程協調機制，目前只能以單一進程部署

## 目標

- **同時具備水平擴展與高可用**：支援 3–10 個實例同時運行
- **分散負載**：changeStream 監聽負載與 webhook 發送負載皆需均勻分散至所有實例
- **Exactly-once best-effort 語義**：正常運行下不重複、不遺漏；在實例故障、rebalance、腦裂等罕見情境下允許極短暫的重播，由冪等層兜底
- **不引入新外部依賴**：僅使用專案既有的 Redis、MongoDB、bee-queue 基礎設施
- **保留現有的 follow-update 時序語義**：同一 follow-update 模式下的 `(webhookId, coll, docId)` 相鄰兩次推入 queue 的間隔必須 ≥ 5 秒

## 非目標

- 不追求嚴格 exactly-once（需要分散式交易）
- 不解決 webhook 目標端的可用性問題（下游仍可能失敗）
- 不提供 resume token 零遺漏保證（3 秒內的事件重播由冪等層處理）

## 整體架構

系統分為四層，每層職責獨立：

```
┌─────────────────────────────────────────────────┐
│              Partition Assignment               │
│  (Redis 心跳 + hash 分區分配 collection)         │
│  職責：決定「誰負責監聽哪些 collection」          │
└──────────────────────┬──────────────────────────┘
                       │ 本實例負責的 collection 列表
                       ▼
┌─────────────────────────────────────────────────┐
│              ChangeStream Listener              │
│  (只開啟分配給自己的 collection)                  │
│  職責：監聽 MongoDB 變更事件                      │
└──────────────────────┬──────────────────────────┘
                       │ WatcherResultDocument
                       ▼
┌─────────────────────────────────────────────────┐
│              Task Distribution                  │
│  (bee-queue + WATCH/MULTI/EXEC 冷卻與去重)        │
│  職責：跨實例均勻分發 webhook 處理任務             │
└──────────────────────┬──────────────────────────┘
                       │ Job
                       ▼
┌─────────────────────────────────────────────────┐
│              Webhook Execution                  │
│  (worker 消費 + MongoDB 冪等保障)                 │
│  職責：執行 webhook 發送，保證不重複               │
└─────────────────────────────────────────────────┘
```

每個實例同時扮演兩個角色：

- **Producer**：負責自己被分配的 collection 的 changeStream → 推入 queue
- **Worker**：從 queue 消費任務 → 執行 webhook 發送

**重要不變量**：任務 queue 與分區分配解耦。任何實例的 worker 都可以消費任何 job；分區只影響 producer 側的 changeStream 監聽，不影響 worker 側的任務消費。這保證了發送負載真正均勻分散，也使得 rebalance 只需調整 changeStream 所有權，不必遷移 queue 中的 pending/delayed jobs。

---

## 1. Partition Assignment（分區分配層）

### 1.1 實例註冊與心跳

每個實例啟動時生成唯一 `instanceId`（`hostname + pid + random suffix`），並在 Redis 中註冊：

```
SET webhook:instance:{instanceId} <metadataJson> EX WEBHOOK_PARTITION_TTL_SECONDS
```

`metadataJson` 為下列欄位的 JSON 序列化結果：

```typescript
{
  instanceId: string;
  hostname: string;
  pid: number;
  startedAt: number; // ms timestamp
  version: string; // from package.json
}
```

key 的「存在」本身已足以用於活躍實例判斷（§1.2 的 SCAN 只取 key 名），metadata 僅用於除錯與可觀測性。每 `WEBHOOK_PARTITION_HEARTBEAT_MS` 續租（刷新 TTL）。實例正常關閉時主動 `DEL webhook:instance:{instanceId}`。

### 1.2 分區計算（Hash-Based）

所有實例獨立執行相同計算，只要活躍實例列表一致，分配結果即一致：

```
1. SCAN webhook:instance:* → 取得所有活躍 instanceId
2. 將 instanceId 排序，得到穩定順序：[inst-A, inst-B, inst-C]
3. 對每個 collection：hash(collName) % len(instances) → 對應實例
4. 只開啟分配給自己的 collection 的 changeStream
```

**Hash 函數規格**：為確保所有實例在相同輸入下產生相同 hash 值，必須使用確定性的 hash。本設計指定使用 Node.js 內建 `crypto` 模組：

```typescript
import { createHash } from "node:crypto";

function hashCollection(collName: string): number {
  const digest = createHash("md5").update(collName).digest();
  return digest.readUInt32BE(0); // 取前 4 bytes 作為 uint32
}

function assignInstance(collName: string, sortedInstanceIds: string[]): string {
  return sortedInstanceIds[hashCollection(collName) % sortedInstanceIds.length];
}
```

MD5 並非用於密碼學安全，只用於確定性分散，任何 Node.js 版本都支援。

**不使用分散式鎖**：分區分配是純計算（hash），唯一需要的共識是「誰是活躍的」，由 Redis 心跳 TTL 保證。

**關於 hash 演算法的選擇**：本設計刻意使用最簡單的 `hash(collName) % N` 而非 consistent hashing 或 rendezvous hashing，因為：

- 本系統的 collection 數量預期為個位數到低雙位數，實例數也在 3–10 之間，rebalance 時 changeStream 的 tear-down / set-up 總數可接受
- 實例加入/離開為低頻事件（rolling deploy、故障恢復），不會頻繁觸發 rebalance
- Rebalance 期間的事件重播由 §5 的 resume token 持久化與 §4.3 的 MongoDB 冪等層兜底，重分配造成的短暫重播不影響正確性
- 若後續發現 rebalance 成本過高（例如 collection 數量大幅增加），可升級為 rendezvous hashing（hash(coll, instanceId) 取最大值），介面不變

**Collection 數量少於實例數的情況**：例如 3 個 collection、10 個實例，則只有 3 個實例負責 changeStream 監聽，其餘 7 個實例只作為 worker 消費 queue。這是可接受的，因為 worker 消費與分區無關（見整體架構章節的不變量）。

### 1.3 Rebalance 觸發時機

| 觸發事件             | 機制                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 新實例加入           | 註冊後透過 Redis Pub/Sub channel `webhook:rebalance` 廣播                                                            |
| 實例下線（正常關閉） | 主動 `DEL` + 廣播 rebalance                                                                                          |
| 實例崩潰             | 每次心跳 tick 由每個實例獨立 SCAN `webhook:instance:*`，與本地記錄的活躍實例列表比對；若差異存在則觸發本地 rebalance |
| Webhook 配置變更     | 與現有 `webhooksChangeStream` 邏輯整合                                                                               |

**崩潰偵測實作**：崩潰偵測不依賴 Redis keyspace notification（需要開啟額外配置），改用定期 SCAN 的方式。掃描動作與心跳續租共用同一個 `setInterval`（週期為 `WEBHOOK_PARTITION_HEARTBEAT_MS`），避免多個定時器且保證兩者頻率一致。

**Rebalance debouncing**：多個 rebalance 訊號可能在短時間內湧入（例如 rolling deploy 時多個實例同時加入/離開）。為避免 changeStream 的頻繁 tear-down / set-up，`rebalance` 事件處理器必須做 debounce：收到訊號後延遲 `WEBHOOK_REBALANCE_DEBOUNCE_MS`（預設 500ms），期間任何額外訊號併入同一次處理，時窗結束後執行一次分配計算。

### 1.4 Rebalance 流程

```
收到 rebalance 信號
  → 讀取最新的活躍實例列表 + 最新的 collection 列表
  → 重新計算分配
  → diff 與當前分配的差異
  → 關閉不再屬於自己的 collection 的 changeStream（寫入最終 resume token，見 §5）
  → 開啟新分配給自己的 collection 的 changeStream（讀取 resume token）
```

### 1.5 故障容錯

| 場景                                      | 處理                                                   |
| ----------------------------------------- | ------------------------------------------------------ |
| 實例正常關閉                              | 主動 DEL + 廣播 → 其他實例立即接管                     |
| 實例崩潰                                  | 心跳 TTL 過期 → 其他實例在下次 SCAN 時偵測 → rebalance |
| Redis 短暫不可用                          | 保持現有分配不變，恢復後重新同步                       |
| 腦裂（兩實例認為自己負責同一 collection） | 極短暫；由下游 bee-queue setId + MongoDB 冪等層兜底    |

---

## 2. ChangeStream Listener（監聽層）

### 2.1 與現有邏輯的差異

保留 `src/commands/webhook.ts` 中 `setupWebhook` / `startChangeStream` / `webhooksChangeStream` 的邏輯骨架，唯一差異：

- `setupWebhooks` 只對 `partition.getAssignedCollections()` 返回的 collection 啟動 changeStream
- changeStream 的 `change` event handler 不再直接呼叫 `processWebhookEvent`，改為呼叫 `webhookQueue.enqueue()`（見 §3）
- 移除 `bufferChange` Map 與 `global.setInterval` flush 邏輯（去重改至 §3 的 scheduleAndEnqueue）

### 2.2 webhooksChangeStream（meta-stream）的處理

`webhooksChangeStream` 是監聽 `WebhookModel` 集合本身變更的 meta-stream，用於偵測 webhook 配置變化。**此 meta-stream 在每個實例都獨立運行，不受分區分配影響**：

- 每個實例都需要知道配置變化以便重新計算分區與分配
- 配置變更只觸發輕量的 `setupWebhooks()` 呼叫，不會造成下游 webhook 重複發送
- 比起「將 meta-stream 也分區」或「只由單一實例監聽並廣播」，每實例獨立監聽的設計最簡單且無單點故障
- meta-stream 事件不經過 `webhookQueue`，純粹用於本地的分區與 changeStream 設置刷新

### 2.3 Resume Token 持久化

見 §5。

---

## 3. Task Distribution（任務分發層）

### 3.1 WebhookJob 型別

```typescript
interface WebhookJob {
  webhookId: string;
  coll: string;
  docId: string;
  operationType: "insert" | "update";
}
```

新增至 `src/interfaces.ts` 的 `QueueTypes`：

```typescript
type QueueTypes = {
  honeybee: HoneybeeJob;
  webhook: WebhookJob; // 新增
};
```

### 3.2 為什麼 Job 只傳 ID

- **避免 queue payload 過大**：Redis queue 不適合儲存大型 document
- **保證資料新鮮**：worker 消費時從 MongoDB 重新查詢最新狀態，對 follow-update 與延遲 job 尤其重要
- **延遲容忍**：job 在 queue 中積壓期間，文件可能已被更新，worker 處理時取到最新版本

### 3.3 Bee-Queue Queue 設定（創建時）

以下設定基於 bee-queue@1.7.1 的實際行為（見 `node_modules/bee-queue/lib/defaults.js` 與 `lib/lua/*.lua`）：

- `removeOnSuccess: true`：成功的 job 立即從 Redis `bq:webhook:jobs` hash 移除，釋放 jobId 供後續重用（coalesce 依賴這個行為，見 §3.4）
- `removeOnFailure: true`：**必要**。若為 false，永久失敗的 job 其 jobId 會永久佔用 hash，導致相同 `(webhookId, coll, docId)` 的後續事件被永遠 dedupe
- `activateDelayedJobs: true`：**必要**。bee-queue 預設為 false，若未設定則 `delayUntil` 的延遲 job 永遠不會被觸發。所有實例都需要開啟，以確保至少一個進程在運作
- `stallInterval: 30000`：與既有 `QueueModule` 一致
- `redis`：複用既有 `QueueModule` 的 Redis 連線
- **Redis key 前綴**：bee-queue 內建以 `bq:<queueName>:*` 為前綴，`queueName` 使用 `"webhook"`，故實際前綴為 `bq:webhook:*`，與既有 `bq:honeybee:*` 天然隔離，無碰撞風險
- `retries: 3`：失敗重試 3 次（job 層級設定，透過 `createJob().retries(3)` 指定）

**注意**：consumer 並發數 (`concurrency`) 屬於 worker 啟動選項（`queue.process(concurrency, handler)`），不在 queue 建立時設定，見 §6.2。

### 3.4 Job ID 與 bee-queue 的去重行為

使用 `setId()` 以 `${webhookId}:${coll}:${docId}` 作為 job ID。基於對 bee-queue@1.7.1 原始碼的研究（`lib/lua/addJob.lua:13` 與 `lib/lua/addDelayedJob.lua:15`），其去重行為有以下特性：

**First-writer-wins dedupe（不是 merge）**：

- bee-queue 的 Lua 腳本在 insert 前會檢查 `HEXISTS bq:webhook:jobs <jobId>`
- 若 jobId 已存在（無論其 job 處於 waiting / delayed / active / stalling / retrying 任一狀態），新的 `save()` 會**靜默丟棄**，不會建立新 job，不會 merge 資料，不會修改既存 job 的 `delayUntil`
- 唯一的 JS 端觀察：`save()` resolve 後 `job.id === null`，表示實際上未寫入
- jobId 只有在 job 從 hash 被移除後才能再次使用；這需要 `removeOnSuccess: true` + `removeOnFailure: true`（見 §3.3）

**對本設計的影響**：

- 「新 event 的 delayUntil 無法延後既存 delayed job 的觸發時間」— 這**正是本設計想要的語義**。延遲 job 本來就應該在第一次排程的時間觸發；coalesce 期間到達的 event 只需要「不產生新 job」即可，具體資料由 worker 從 MongoDB 重新讀取時取得最新狀態（§4.2）
- 因此 bee-queue 的 dedupe 行為與本設計的需求天然契合，不需要額外的合併邏輯
- `save()` 回傳 `job.id === null` **不是錯誤**，代表「另一個 instance 已搶先寫入相同 jobId 的 job」，本實例無需做任何補救

**In-flight 判定方式**：

由於 bee-queue 的 `Job.status` 只有 `'created' / 'succeeded' / 'failed' / 'retrying'` 四種值，且對 waiting/delayed/active 狀態的 job 都回傳 `'created'`（因為狀態只在 `_finishJob` 中被更新），`status` 欄位**不能**用來判斷 in-flight。正確做法是直接用 `getJob(id)` 的返回值：

```typescript
// in-flight 判定：id 是否仍在 bq:webhook:jobs hash 中
async function getJobIfInFlight(queue, jobId): Promise<boolean> {
  const job = await queue.getJob(jobId);
  return job !== null; // null 表示已被 removeOnSuccess/removeOnFailure 清除
}
```

在 `removeOnSuccess: true + removeOnFailure: true` 設定下，`getJob(id) !== null` 精確對應「id 仍在 hash，亦即 job 處於 waiting/delayed/active/stalling/retrying 之一」，這是 coalesce 判斷需要的語義。

### 3.5 Follow-Update 冷卻與延遲語義

**不變量**（僅限 `followUpdate=true` 的 webhook）：**任意兩次 webhook 實際被 worker 觸發處理的時間點（即 delayed job 的 delayUntil 時間戳，或 immediate job 的 save 時間）相差 ≥ cooldown（5 秒）**。非 follow-update webhook 不受此限制（見 §3.8）。

**nextAllowed 的精確語義**：`nextAllowed` 儲存於 Redis `webhook:next:{jobId}`，代表「下一次觸發被允許的最早時間戳」，而非「下一次 save 的時間」。每次成功 save 後：

- **immediate 分支**（`now >= nextAllowed`）：觸發時間 = `now` → 新 `nextAllowed = now + cooldown`
- **delayed 分支**（`now < nextAllowed`）：觸發時間 = `nextAllowed`（delayUntil 設為此值）→ 新 `nextAllowed = nextAllowed + cooldown`
- **coalesce 分支**：不改變 `nextAllowed`（前次 save 已經推進過）
- **fallback-delayed 分支**：見 §3.6 的說明

**時序範例**（cooldown=5000ms，worker 快速消費，延遲 job 觸發後立即從 hash 移除；時間單位為秒，但 `nextAllowed` 欄位以秒顯示以對應其他欄位）：

| 時間 | 事件 | nextAllowed | 動作                                | delayUntil |
| ---- | ---- | ----------- | ----------------------------------- | ---------- |
| t=0  | A    | 0 → 5       | 立即推入                            | 0          |
| t=2  | B    | 5 → 10      | 延遲，delayUntil=5                  | 5          |
| t=3  | C    | 10          | 合併跳過                            | —          |
| t=4  | D    | 10          | 合併跳過                            | —          |
| t=5  | —    | —           | bee-queue 觸發 B                    | —          |
| t=7  | E    | 10 → 15     | 延遲，delayUntil=10                 | 10         |
| t=10 | —    | —           | bee-queue 觸發 E                    | —          |
| t=12 | F    | 15 → 20     | 延遲，delayUntil=15                 | 15         |
| t=15 | —    | —           | bee-queue 觸發 F                    | —          |
| t=16 | G    | 20 → 25     | 延遲 4s，delayUntil=20              | 20         |
| t=20 | —    | —           | bee-queue 觸發 G                    | —          |
| t=25 | H    | 25 → 30     | 立即推入（now=25 ≥ nextAllowed=25） | 25         |

**驗證**：觸發時間序列為 `[0, 5, 10, 15, 20, 25]`，相鄰間隔恆為 5 秒，符合不變量。即便事件密集到來（例如 G 於 t=16，僅比 F 觸發時間 t=15 晚 1 秒），因 `nextAllowed=20 > 16`，G 仍走 delayed 分支延遲到 t=20 觸發。

**Worker 仍 active 的 coalesce 情境**：若 worker 處理 B 的 delayed job 耗時較長，在 t=7 時 B 仍在 `bq:webhook:jobs` hash 中（狀態為 active）。此時 Event E：

- `getJobIfInFlight(jobId)` 返回 true → 返回 `"coalesced"`，`nextAllowed` 維持 10
- E 不產生新 job，但其資料變化不會遺漏：worker 在 t=5 觸發 B 時已從 MongoDB 讀取當時最新的 fullDocument
- 後續若 worker 在 t=9 完成 B 並從 hash 移除，Event H 於 t=9.5 到來時 `9500 < 10000` → delayed 分支，`delayUntil=10`，`nextAllowed=15`
- 觸發時間序列仍維持 ≥5 間隔

**資料新鮮度保證**：所有在 coalesce 期間發生的 MongoDB 變更，會在下一個被 worker 處理的 job 中透過 `loadJobContext`（§4.2）重新查詢 MongoDB 而被捕捉。即便多個事件合併為單一 job，最終發送的 webhook payload 仍反映最新狀態。

**nextAllowed 的前進時機**：`nextAllowed` 只在 `scheduleAndEnqueue` 成功執行 MULTI/EXEC 時前進，**不會**因為 delayed job 被 bee-queue 觸發、worker 完成或 job 從 hash 移除而改變。

### 3.6 scheduleAndEnqueue 實作（WATCH/MULTI/EXEC）

使用 Redis 原生樂觀鎖確保 `nextAllowed` 計算的原子性，不使用 Lua 腳本。

```typescript
async function scheduleAndEnqueue(
  job: WebhookJob,
  now: number,
  cooldown: number
): Promise<"immediate" | "delayed" | "coalesced" | "fallback-delayed"> {
  const jobId = `${job.webhookId}:${job.coll}:${job.docId}`;
  const nextKey = `webhook:next:${jobId}`;
  let lastNextAllowed = 0; // 供迴圈結束後的 fallback 使用

  for (let attempt = 0; attempt < 5; attempt++) {
    await redis.watch(nextKey);
    const nextAllowed = parseInt((await redis.get(nextKey)) ?? "0", 10);
    lastNextAllowed = nextAllowed;

    // In-flight 判定：`queue.getJob(jobId)` 返回非 null 即表示 jobId 仍在
    // `bq:webhook:jobs` hash（對應 waiting/delayed/active/stalling/retrying 任一狀態）。
    // 在 `removeOnSuccess:true + removeOnFailure:true` 設定下（§3.3），完成的 job
    // 會立即從 hash 移除，因此 `getJob(jobId) !== null` 精確對應 coalesce 語義。
    // 不可使用 `job.status` 判斷，因為 bee-queue 的 status 欄位對 waiting/delayed/active
    // 的 job 都會回傳 'created'，並非實際佇列狀態（見 §3.4 的研究結果）。
    const existing = await webhookQueue.getJob(jobId);
    if (existing !== null) {
      await redis.unwatch();
      return "coalesced";
    }

    if (now >= nextAllowed) {
      // 已過冷卻期 → 立即推入
      const multi = redis.multi();
      multi.set(nextKey, String(now + cooldown), "PX", WEBHOOK_NEXT_KEY_TTL_MS);
      const result = await multi.exec();
      if (result === null) continue; // WATCH 被觸發，重試

      await webhookQueue.createJob(job).setId(jobId).save();
      return "immediate";
    }

    // 冷卻期內且無待發 job → 排程延遲推入
    const delay = nextAllowed - now;
    const multi = redis.multi();
    multi.set(
      nextKey,
      String(nextAllowed + cooldown),
      "PX",
      WEBHOOK_NEXT_KEY_TTL_MS
    );
    const result = await multi.exec();
    if (result === null) continue;

    await webhookQueue
      .createJob(job)
      .setId(jobId)
      .delayUntil(now + delay)
      .save();
    return "delayed";
  }

  // 超過 5 次重試仍無法完成：採用確定性 fallback。
  // 關鍵：必須先用非交易（unconditional）SET 推進 nextKey，
  // 否則 fallback job 完成後下一次事件會讀到 stale nextAllowed，
  // 走 "immediate" 分支造成 ≥ 5 秒間隔不變量被破壞。
  // 此處不用 WATCH/MULTI/EXEC，因為 5 次競爭失敗已表明樂觀鎖難以成功；
  // 用 best-effort SET 推進 nextKey 比放任 stale 更安全。
  // 取 max(當前讀取值 + cooldown, now + 2*cooldown) 確保至少比當下 fallback
  // 觸發時間再多 cooldown，保證下一次推入至少要等到 fallback job 被消費後 cooldown 時間。
  const fallbackNextAllowed = Math.max(
    lastNextAllowed + cooldown,
    now + cooldown * 2
  );
  await redis.set(
    nextKey,
    String(fallbackNextAllowed),
    "PX",
    WEBHOOK_NEXT_KEY_TTL_MS
  );
  await webhookQueue
    .createJob(job)
    .setId(jobId)
    .delayUntil(now + cooldown)
    .save();
  return "fallback-delayed";
}
```

**錯誤處理責任**：`scheduleAndEnqueue` 不在內部 swallow 任何例外。若 `multi.exec()` 或 `save()` 拋出，例外會直接向上傳遞到呼叫端（changeStream event handler）。Handler 必須 catch 並以 `documentLog(webhook, "<!> [ERROR]", error)` 記錄後繼續運行，**絕不可讓例外終止 changeStream 監聽器**，否則單次 Redis 抖動會導致整個監聽失效。

**`save()` 的 ID 碰撞**：根據 bee-queue 研究（§3.4），當 `createJob(...).setId(jobId).save()` 遇到相同 jobId 已在 hash 時，`save()` 不會丟例外，而是 resolve 為 `job.id === null`。這**不是錯誤**，代表另一個 instance 在極小的時間窗內搶先寫入了同樣 jobId 的 job（getJobIfInFlight 與我們的 save 之間的競態窗）。此時本實例不需要做任何補救：搶先寫入的 job 會被它的 worker 正常處理，目標 webhook 仍會被送出。scheduleAndEnqueue 可忽略 `job.id === null`，返回一致的 `"immediate"` / `"delayed"` 狀態。

**關於 `save()` 失敗的處理**：

- `multi.exec()` 成功但 `save()` 丟出（Redis 瞬時故障、序列化失敗等）時，nextKey 已前進但 queue 中無對應 job
- 本設計**不回滾 nextKey**，因為回滾本身也可能與其他 instance 的 WATCH/EXEC 競爭，反而造成更複雜的不一致
- 該事件會由以下機制之一補上：(a) 下一次同一 doc 的 changeStream 事件（follow-update 場景常發生），(b) 實例重啟時從 resume token 重播
- 由 §4.3 的冪等層兜底避免重複
- `save()` 失敗屬於極罕見的 Redis 故障場景，此略有遺漏的可能性視為可接受的代價

**`WEBHOOK_NEXT_KEY_TTL_MS` 常數**：定義於 §6.3，值為 `WEBHOOK_COOLDOWN_MS * 3`（15000ms）。此 TTL 必須 ≥ 最長可能的 delayUntil 延遲（`cooldown`）加上時鐘誤差容忍，以確保 nextKey 在延遲 job 執行前不會過期。選擇 3× 而非剛好 2× 是為了涵蓋系統時鐘抖動、Redis 複寫延遲、以及少量 job 在 queue 中的排隊時間。

### 3.7 設計要點

- **讀取在 MULTI 外**：Redis 事務內不能讀後分支，WATCH 保證讀取到 EXEC 之間值未被修改
- **UNWATCH 時機**：合併分支不寫入，必須顯式 UNWATCH
- **重試上限 5 次**：極端 contention 下避免無限迴圈；超過上限走確定性 fallback（`delayUntil(now + cooldown)`），仍維持「下次推入距離 now ≥ cooldown」的不變量
- **併發正確性**：兩實例同時對同一 doc 收到事件時，先完成的 EXEC 成功，另一方 EXEC 返回 null 重試，重試時看到新狀態走合併或延遲分支

### 3.8 Non-Follow-Update Webhook

跳過 WATCH/MULTI/EXEC 冷卻期邏輯，直接 `createJob(job).setId(jobId).save()`。setId 本身仍防止併發重複。5 秒最小間隔限制**不適用**於非 follow-update webhook（保留現有行為）。

---

## 4. Webhook Execution（執行層）

### 4.1 Worker 消費流程

```
Worker 收到 WebhookJob { webhookId, coll, docId, operationType }
  → loadJobContext(): 從 MongoDB 查詢最新 webhook config + fullDocument
  → 重建 WatcherResultDocument 結構
  → 執行冪等檢查（§4.3）
  → 呼叫 processWebhookEvent（沿用現有邏輯）
  → 成功 → ack；失敗 → bee-queue 依 retry 策略處理
```

### 4.2 loadJobContext

`getModelByCollectionName` 為 `src/modules/db.ts` 既有函數（由 `src/commands/webhook.ts` line 33 匯入使用），直接複用，無需新增。

```typescript
async function loadJobContext(job: WebhookJob) {
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
    } satisfies WatcherResultDocument,
  };
}
```

處理時重新查詢，因此延遲 job 觸發時拿到最新狀態（而非事件發生當下的狀態）。

### 4.3 冪等保障（MongoDB 作為最終防線）

利用 `WebhookResultModel` 的 unique index `(webhookId, coll, docId)`。為避免「插入後 HTTP 發送永久失敗」造成的孤兒記錄無限累積，insert 時同時設置一個保守的 `expireAt` 作為 fallback TTL；發送成功後 §4.4 會以新的 `expireAt` 覆蓋。

**欄位寫入策略**：`method` / `url` / `body` 在 schema 為 `required: true`（見 `src/models/WebhookResult.ts`），因此必須在 `$setOnInsert` 寫入以滿足首次插入的 validation。同時 §4.4 的發送成功路徑也會以 `$set` 再次寫入這三個欄位，使後續 follow-update 的 isEqual 比較對象永遠是「上一次成功送出的 body」而非首次插入的 body：

- 首次事件：`$setOnInsert` 寫入 body=v1 → HTTP 送出 → §4.4 `$set` 寫入 body=v1（同值覆蓋）
- 第二次事件（body=v2）：`$setOnInsert` 為 no-op（記錄已存在），existing.body=v1 → isEqual(v1, v2)=false 繼續處理 → HTTP 送出 → `$set` 寫入 body=v2
- 第三次事件（body=v3）：existing.body=v2 → isEqual(v2, v3)=false 繼續處理 ✓

```typescript
const FOLLOW_TTL_MS = WEBHOOK_RESULT_FOLLOW_TTL_SECONDS * 1000;

const updateResult = await WebhookResultModel.updateOne(
  resultIdentifier,
  {
    $setOnInsert: {
      ...resultIdentifier,
      // method / url / body 為 schema required，必須在 $setOnInsert 寫入
      // 以滿足 upsert 的首次插入 validation
      method,
      url,
      body,
      // Fallback expireAt：若後續 HTTP 發送永久失敗，此記錄仍會被 TTL 回收。
      // 使用 follow TTL 作為較長的上限，足以讓 bee-queue 完成所有重試。
      expireAt: new Date(Date.now() + FOLLOW_TTL_MS),
    },
  },
  { upsert: true }
);

if (updateResult.upsertedCount === 0) {
  const existing = await WebhookResultModel.findOne(resultIdentifier);

  if (existing?.response) {
    if (!webhook.followUpdate) {
      // 非 follow-update：已發送即為重複，跳過
      return;
    }
    if (webhook.followUpdate && isEqual(existing.body, body)) {
      // follow-update 且內容相同，跳過
      return;
    }
    // follow-update 且內容不同，繼續處理（發送 update）
  }
  // 尚未發送（例如 stall 後被接管），繼續處理
}
```

**關於併發情境的 best-effort 保證**：

- 正常流程下 bee-queue 保證每個 job 只被一個 worker 處理，這層檢查不會觸發
- 在 worker stall + 重派、分區腦裂等極罕見情境下，同一 doc 可能被兩個 worker 同時處理；雙方都看到「existing 存在但 response 未寫入」而繼續發送，因此**本設計在極罕見情境下最多允許 2 次發送（brain-split 時的兩實例同步執行）**
- 這是「exactly-once best-effort」的顯式權衡：在 TTL 視窗（§4.4，1 小時）內，相同 `(webhookId, coll, docId)` 的發送次數上限為 `min(腦裂併發實例數, 2)`
- 這符合使用者對「exactly-once best-effort」的要求：正常情況下不重複、不遺漏，在故障/切換期允許極短暫的少量重複

### 4.4 WebhookResult 保留策略與 TTL 清理

**原問題**：現行程式碼在非 follow-update 成功發送後立即 `deleteOne`，導致 §4.3 的冪等檢查對非 follow-update webhook 幾乎無效。

**解法**：改為以 TTL index 延後清理。

Schema 新增欄位：

```typescript
@prop({ type: Date, expires: 0, index: true })
expireAt?: Date;
```

（`expires: 0` 表示 MongoDB 會在 `expireAt` 所指定的時間到達時刪除文件；實際保留時間由寫入時設定的 `expireAt` 決定。）

發送成功後：

```typescript
const NON_FOLLOW_TTL_MS = WEBHOOK_RESULT_NON_FOLLOW_TTL_SECONDS * 1000; // 3600
const FOLLOW_TTL_MS = WEBHOOK_RESULT_FOLLOW_TTL_SECONDS * 1000; // 604800

// 關鍵：body / method / url 在此寫入（非 $setOnInsert），
// 使下次 follow-update 的 isEqual 比較對象為「本次成功送出的 body」，
// 而非第一次 upsert 時的 body。
// statusCode 由呼叫端（sendDiscordWebhook / sendWebhook）依據實際 HTTP
// 回應提取後傳入：HTTPError.status / response.status 等（沿用現有邏輯）。
const commonFields = { method, url, body, response, statusCode };

if (webhook.followUpdate) {
  await WebhookResultModel.updateOne(resultIdentifier, {
    $set: {
      ...commonFields,
      // follow-update：長 TTL 作為上限，防止無限累積
      expireAt: new Date(Date.now() + FOLLOW_TTL_MS),
    },
  });
} else {
  await WebhookResultModel.updateOne(resultIdentifier, {
    $set: {
      ...commonFields,
      // 非 follow-update：短 TTL，足夠兜底 stall recovery
      expireAt: new Date(Date.now() + NON_FOLLOW_TTL_MS),
    },
  });
}
```

**兩種 TTL 的設計理由**：

- **非 follow-update（預設 1 小時）**：足以覆蓋 bee-queue `stallInterval` (30s) 的多倍容錯窗口；不會無限累積
- **follow-update（預設 7 天）**：視為「活躍追蹤期」上限；每次收到 follow-update 事件且內容變化時會刷新 `expireAt`，因此活躍中的記錄不會被 TTL 刪除；若一個 doc 連續 7 天沒有新 update，則視為追蹤結束，記錄被清理；這同時解決了 follow-update 記錄無限累積的問題
- 兩個 TTL 都透過同一個 `expireAt` 欄位與單一 TTL index 管理，無需多個 index

### 4.5 發送階段與現有函數的改動範圍

`sendDiscordWebhook` 與 `sendWebhook` 的 HTTP 發送核心邏輯（request 構建、超時、錯誤分類）不變，但外層需要調整：

- **新增**：在實際發送 HTTP request 之前，插入 §4.3 的冪等檢查（upsert + existing 檢查 + 內容比較），決定是否 skip
- **修改**：成功後的 WebhookResult 更新邏輯由 `deleteOne`（非 follow-update 路徑）改為 `updateOne` + `$set: { response, statusCode, expireAt }`
- **保留**：Discord webhook 的 HTTPError 分類與 AxiosError 的 statusCode 擷取邏輯

具體重構方式：將 §4.3 的冪等檢查抽為 `checkAndClaimWebhookResult(resultIdentifier, ...)` helper，在 `sendDiscordWebhook` / `sendWebhook` 的 request 構建之後、實際發送之前呼叫。若 helper 返回 `skip`，則直接 return。

### 4.6 Worker 失敗與重試

由 bee-queue 內建機制處理：

- HTTP 失敗（4xx/5xx）：job 標記失敗 → 重試 3 次
- Worker 崩潰：stall detection 30 秒 → job 重新分配
- 超過最大重試：job 進入 failed 狀態，記錄在 Redis

### 4.7 優雅關閉

整合進 Application 模組生命週期。由於 Application 的 `close()` 以 **LIFO** 順序執行（後註冊的先關閉，見 `src/modules/application.ts`），因此模組必須按下列順序註冊以確保關閉時的正確順序：

**模組註冊順序（init 順序）**：

1. `webhook-queue.ts` 匯出的 **Webhook Queue Consumer 模組**（封裝 bee-queue 的 worker 啟動與關閉；producer API 以普通函數匯出，不註冊為 Application 模組）— 先註冊，最後關閉
2. ChangeStream Listener 模組（封裝 changeStream 開關）
3. Partition Assignment 模組（`webhook-partition.ts`）— 後註冊，最先關閉

> 說明：`webhook-queue.ts` 檔案同時包含 producer 函數與 consumer 模組定義，但只有 consumer 部分需要作為 Application 模組註冊來管理生命週期；producer 是純函數呼叫，無狀態需要 init/close。

**實際關閉順序（LIFO）**：

1. **Partition Assignment 模組 close**：從 Redis 移除 instanceId + 廣播 rebalance（通知其他實例準備接管）
2. **ChangeStream Listener 模組 close**：停止本實例所有 changeStream，寫入最終 resume token。此時本實例不再產生新的 changeStream 事件
3. **Bee-Queue Consumer 模組 close**：停止接受新 job，等待當前 job 完成（受 `SHUTDOWN_TIMEOUT` 上限）

**為何此順序正確**：

- Partition Assignment 先下線讓其他實例立即得知本實例離開，開始接管本實例的 collection；雖然本實例的 changeStream 尚未關閉，但接管實例會從 resume token 開始重播，兩者短暫重疊期間產生的事件由 §3.4 的 setId 去重 + §4.3 的冪等層去重
- ChangeStream 關閉確保本實例不再產生新事件進入 queue
- Worker 最後關閉以處理 queue 中既有的任務（包含本實例 changeStream 關閉前產生的任務）
- 此順序刻意讓「接管重疊窗口」存在，但窗口內的重複由冪等層吸收；替代方案（先關 changeStream 再下線）會造成本實例 changeStream 關閉後到其他實例接管前的「無人監聽」真空期，反而風險更大

---

## 5. Resume Token 持久化

### 5.1 策略：定時寫入 + 關閉時補寫

採用定時寫入為主、關閉時補寫為輔的混合策略，避免接管時的時序協調問題。

### 5.2 Redis Key 結構

```
Key: webhook:resumetoken:{coll}
Value: JSON {
  token: <BSON resumeToken>,
  updatedAt: <ms timestamp>,
  owner: <instanceId>
}
TTL: 3600s (1 hour)
```

### 5.3 寫入時機

**定時寫入（主要機制）**

每個 changeStream 啟動時同步啟動 `setInterval`，每 `WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS`（預設 3000）寫入一次：

```typescript
const tokenSaveInterval = global.setInterval(async () => {
  const token = changeStream.resumeToken;
  if (!token) return;
  await redis.set(
    `webhook:resumetoken:${coll}`,
    JSON.stringify({ token, updatedAt: Date.now(), owner: instanceId }),
    "EX",
    3600
  );
}, 3000);
```

**關閉時補寫（best-effort 優化）**

`closeChangeStream` 在呼叫 `close()` 之前**先讀取並快取** `changeStream.resumeToken`，因為 MongoDB Node 驅動不保證 `resumeToken` 在 `close()` 後仍然可讀。快取後再關閉 stream，最後用快取值寫入 Redis：

```typescript
async function closeChangeStream(coll, changeStream, tokenSaveInterval) {
  global.clearInterval(tokenSaveInterval);
  // 先讀取 resumeToken（必須在 close() 之前，否則驅動可能已清空）
  const finalToken = changeStream.resumeToken;
  try {
    await changeStream.close();
  } catch {}
  if (finalToken) {
    await redis.set(
      `webhook:resumetoken:${coll}`,
      JSON.stringify({
        token: finalToken,
        updatedAt: Date.now(),
        owner: instanceId,
      }),
      "EX",
      3600
    );
  }
}
```

即使此寫入失敗也不影響正確性，僅是提升 graceful rebalance 的精度。

### 5.4 讀取時機（接管實例，無等待）

```typescript
async function loadResumeToken(coll: string): Promise<ResumeToken | undefined> {
  const raw = await redis.get(`webhook:resumetoken:${coll}`);
  if (!raw) return undefined;
  try {
    const { token } = JSON.parse(raw);
    return token;
  } catch {
    return undefined;
  }
}
```

`startChangeStream` 在新接管時立即呼叫：有值即用，無值即從當前時間開始。**不阻塞 rebalance**。

**TTL 管理由 Redis 負責**：key 的 `EX 3600` 已確保過期 token 自動從 GET 結果中消失，不需要在應用層再做時間比對。如果未來需要更短的「新鮮度」視窗（例如只接受 10 分鐘內的 token），改為調整 Redis TTL 而非應用層檢查。

### 5.5 故障場景分析

| 場景                    | 資料流                                                | 結果                                                 |
| ----------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Graceful rebalance      | 前任關閉時補寫 → 新實例立即讀到最新 token             | 幾乎零遺漏                                           |
| 前任崩潰                | 最後一次定時寫入（≤ 3 秒前）→ 新實例讀到 3 秒前 token | 最多 3 秒事件重播，由冪等層去重                      |
| 前任崩潰 + Redis 不可用 | 讀不到 token                                          | 從當前時間開始；follow-update 場景由下次 update 補救 |
| 長期無監聽後恢復        | TTL 過期 → 視為無 token                               | 從當前時間開始，遺漏恢復窗口事件                     |
| 兩實例短暫腦裂都在監聽  | 兩者定時寫入互相覆蓋                                  | 皆正常處理，下游由 setId + 冪等層去重                |

### 5.6 權衡

| 定時週期 | Redis 寫入頻率 | 崩潰時最大重播窗口 |
| -------- | -------------- | ------------------ |
| 1s       | 高             | ≤ 1s               |
| **3s**   | **中**         | **≤ 3s**（預設）   |
| 5s       | 低             | ≤ 5s               |

重播的事件由 setId + MongoDB 冪等層（1 小時 TTL）去重，不會造成重複發送。

---

## 6. 模組結構

### 6.1 檔案變更

```
src/
├── commands/
│   └── webhook.ts                    [修改] 主編排邏輯簡化
├── modules/
│   ├── webhook-partition.ts          [新增] 分區分配模組
│   ├── webhook-queue.ts              [新增] bee-queue producer/consumer 封裝
│   └── queue.ts                      [修改] 註冊 webhook queue 實例
├── models/
│   └── WebhookResult.ts              [修改] 新增 expireAt TTL 欄位
├── interfaces.ts                     [修改] 新增 WebhookJob 型別 / QueueTypes
└── constants.ts                      [修改] 新增冷卻、心跳、掃描、TTL、worker 並發常數
```

**`modules/queue.ts` 的具體修改**：既有的 `QueueModule` 以 `queueName` 參數建立 bee-queue 實例。新增工廠函數或新增 `webhook` queue 的顯式建立，例如：

```typescript
// 在 QueueModule 或 webhook-queue.ts 中
const webhookQueue = new Queue<WebhookJob>("webhook", {
  redis: sharedRedisClient,
  removeOnSuccess: true,
  removeOnFailure: true, // 必要：見 §3.3，否則失敗 job 的 ID 永久佔用 hash
  activateDelayedJobs: true, // 必要：見 §3.3，否則延遲 job 永遠不會被觸發
  stallInterval: 30_000,
  isWorker: true, // 所有實例同時為 producer + worker
});
```

具體實作細節（是否新增專用模組或複用 `QueueModule`）可於 plan 階段決定；spec 層只要求：(a) 複用既有 Redis 連線，(b) 與既有 `honeybee` queue 命名隔離，(c) 成為 Application 的一部分並具有 graceful shutdown 能力。

### 6.2 模組職責

**`webhook-partition.ts`**

- 實例註冊/心跳（Redis `SET` + `EX` 續租）
- 活躍實例列表維護（Redis SCAN + Pub/Sub 通知）
- 崩潰偵測（定期 SCAN）
- Hash-based 分區計算
- 對外 API：`getAssignedCollections(allColls: string[]): string[]`
- 對外事件：`on('rebalance', () => ...)` 通知主邏輯重建 changeStream

**`webhook-queue.ts`**

- 封裝 bee-queue webhook queue
- Producer API：`enqueue(job: WebhookJob, options: { followUpdate: boolean })`
- Producer 內部：處理 WATCH/MULTI/EXEC 冷卻邏輯、setId 去重、`delayUntil` 排程、fallback 路徑
- Consumer API：`startWorker(handler: (job: WebhookJob) => Promise<void>, options: { concurrency: number })`；`concurrency` 預設為 `WEBHOOK_WORKER_CONCURRENCY`
- 優雅關閉整合（參見 §4.7 的順序）

**`commands/webhook.ts`（簡化後）**

- 保留：`setupWebhook` / `startChangeStream` / `webhooksChangeStream` / `processWebhookEvent` 邏輯骨架
- 修改：`setupWebhooks` 只對 `partition.getAssignedCollections()` 內的 collection 啟動 changeStream
- 修改：changeStream 事件呼叫 `webhookQueue.enqueue()` 而非直接 `processWebhookEvent`
- 修改：`webhooksChangeStream`（meta-stream）在所有實例獨立運行（見 §2.2），觸發 `setupWebhooks()`
- 新增：註冊 worker handler，內部呼叫 `loadJobContext` → `processWebhookEvent`
- 移除：`bufferChange` Map、`processWebhookQueue` (PQueue)、global flush interval

### 6.3 新增常數

```typescript
// src/constants.ts
export const WEBHOOK_COOLDOWN_MS = 5000;
// nextKey 必須在延遲 job 執行之前存活；3× cooldown 涵蓋
// 系統時鐘抖動、Redis 複寫延遲與少量排隊時間
export const WEBHOOK_NEXT_KEY_TTL_MS = WEBHOOK_COOLDOWN_MS * 3;
// Heartbeat 同一 tick 同時執行：續租本實例 key + SCAN 偵測其他實例崩潰
// 因此不需要額外的 scan interval 常數
export const WEBHOOK_PARTITION_HEARTBEAT_MS = 5000;
export const WEBHOOK_PARTITION_TTL_SECONDS = 15;
// Rebalance 訊號 debounce，避免 rolling deploy 時 changeStream 頻繁抖動
export const WEBHOOK_REBALANCE_DEBOUNCE_MS = 500;
export const WEBHOOK_WORKER_CONCURRENCY = 10;
export const WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS = 3000;
export const WEBHOOK_RESULT_NON_FOLLOW_TTL_SECONDS = 3600; // 1 hour
export const WEBHOOK_RESULT_FOLLOW_TTL_SECONDS = 604800; // 7 days
```

---

## 7. 遷移策略

### 7.1 單階段切換

由於新舊實例混用會造成重複處理，採用單階段 rolling restart 而非漸進式：

1. 部署前於 staging 完整測試
2. 生產環境 rolling restart 所有實例
3. 舊實例關閉期間 changeStream 短暫停止；新實例啟動後透過 resume token 接續
4. 部署期間可能有極短遺漏或延遲，由 at-least-once + MongoDB 冪等保障兜底

### 7.2 WebhookResult Schema 變更

- 新增 `expireAt` 欄位（optional）與 TTL index
- 既有記錄不受影響：依現行程式碼行為，非 follow-update 成功發送後已被 `deleteOne` 刪除，資料庫中不應累積；follow-update 記錄中無 `expireAt` 欄位者永不過期（與現行行為一致），直到下一次發送時被新邏輯設定 `expireAt`
- TTL index 由 MongoDB 在背景建立，建立期間 insert/update 不受影響
- 無需資料回填（backfill）

---

## 8. 測試策略

### 8.1 單元測試

**`webhook-partition.ts`**

- Hash 分配的確定性與均勻性
- 實例列表變化後的 diff 計算
- 心跳續租與過期偵測
- SCAN-based 崩潰偵測在心跳 TTL 過期後觸發 rebalance

**`webhook-queue.ts`**

- `scheduleAndEnqueue` 的時序語義（fake timer + mock Redis）
- `coalesced` / `immediate` / `delayed` / `fallback-delayed` 四種路徑
- `getJobIfInFlight` 正確偵測 waiting / delayed / active 三種狀態（這是 coalesce 的唯一依據，§3.4）
- WATCH 競爭下的重試行為（透過 mock Redis 注入 EXEC null 返回）
- 5 次重試耗盡後走 fallback 仍保持 ≥ cooldown 間隔的不變量
- `save()` 丟出例外時 handler 能 catch 並繼續運行（不讓 changeStream listener 死亡）

### 8.2 整合測試

啟動 2–3 個實例 + 真實 Redis + 真實 MongoDB，驗證：

- 單一 collection 只被一個實例監聽
- 殺掉一個實例後，它負責的 collection 被其他實例接管
- 同一 doc 的快速連續更新在 5 秒冷卻期內只觸發一次發送
- 多實例併發推入同一 jobId 只產生一個 job
- Worker stall（模擬 SIGSTOP）後 job 被重新分配且不重複發送
- Rolling restart 期間的事件不遺漏（透過監控收到的 webhook 請求數）

### 8.3 冪等驗證

- Mock webhook 端點記錄所有收到的請求
- 注入故障（網路中斷、worker 崩潰、Redis 短暫不可用）
- 驗證每個事件最終只產生 1 個 webhook 請求（brain-split 下最多 2 個，見 §4.3）

---

## 9. 開放議題

- **Resume token 定時寫入週期**：預設 3 秒，上線後依實際事件量調整
- **Worker concurrency**：預設 10，依 webhook 目標端的吞吐調整
- **Partition heartbeat TTL**：預設 15 秒，在「崩潰偵測延遲」與「網路抖動誤判」之間取得平衡
- **Follow-update TTL（7 天）**：若後續發現活躍記錄頻繁被 TTL 刪除（代表追蹤週期超過 7 天），需提高此值
- **bee-queue setId 行為**：已由 bee-queue@1.7.1 原始碼驗證（見 §3.4）。pinned 依賴版本不得在未重新驗證的情況下升級，避免 upstream 行為變更破壞本設計的假設
