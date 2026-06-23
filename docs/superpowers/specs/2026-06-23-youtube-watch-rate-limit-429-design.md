# YouTube watch-page 429 跨 pod 限速設計

## 問題陳述

worker 服務持續出現大量重複的錯誤 log：

```
<!> [STATS UPDATE ERROR] AxiosError: Request failed with status code 429
```

### 根本原因

錯誤路徑：`updateVideoStats()`（`src/commands/worker.ts`）→
`VideoModel.updateFromMasterchat(mc)`（`src/models/Video.ts`）→ masterchat
`fetchMetadataFromWatch()`，後者會抓取 YouTube 的 `/watch?v=` 網頁。當對外 IP 對
watch page 的請求過於頻繁時，YouTube 回應 HTTP 429。

兩個相互疊加的因素：

1. **限速無法跨 pod 協調。** 現有的 `src/modules/rate-limiter.ts` 匯出一個
   per-process 單例 `youtubeRateLimiter = new RateLimiter(1, 1000)`（單一 process
   內每秒 1 次請求）。生產環境 worker 部署 3 個 replica（`k8s/overlays/production/kustomization.yaml`），
   且 3 個 pod 共用同一個對外 IP。YouTube 的限速是針對該 IP，因此實際對 YouTube
   的請求速率約為 per-pod 上限的 3 倍，且彼此不協調，沒有任何機制在 IP 被限速時
   讓全體一起退避。

2. **錯誤被連鎖放大成 log 洪水。** 一旦該 IP 被 YouTube 限速，所有並行 job 後續的
   stats 更新（job 啟動時、每分鐘週期、job 結束的 finally）全部拿到 429，於是同一
   行錯誤被大量重複輸出。

### masterchat 的 429 偵測為何失效

masterchat 的 `fetchMetadataFromWatch` 以 `err.code === "429"` 判斷限速並改丟
`AccessDeniedError`。但 axios 對 HTTP 429 丟出的 `AxiosError.code` 是
`ERR_BAD_REQUEST` / `ERR_BAD_RESPONSE`，並非字串 `"429"`，因此該判斷永不成立，
原始 `AxiosError`（其 `response.status === 429`）會直接往上傳遞，最終落在
`updateVideoStats` catch 中的 `isAxiosError(err)` 分支被輸出。本設計因此在自身這層
偵測 429，不依賴 masterchat 的包裝。

## 目標與非目標

### 目標

- 真正降低 429 的發生率：讓對 YouTube watch page 的請求速率跨所有 worker pod
  協調在一個全域上限內。
- 在偵測到 429 時，讓所有 pod 一起退避一段冷卻時間，使 YouTube 的限速窗口得以冷卻。
- 作為上述機制的自然結果，消除重複 429 log 洪水（冷卻期間請求被跳過、不再嘗試）。

### 非目標

- 不導入自適應 AIMD 動態速率控制（成功則加速、429 則減速）。此為更複雜的替代方案，
  待本設計上線後若仍不足再評估。
- 不改動 chat 收集主流程（`mc.iterate`）、不改動 masterchat 套件本身。
- 不處理 `resolveRaidName` → `updateChannelByHandle` 這條另一個呼叫 YouTube 的路徑；
  本次 429 來自 stats 更新的 watch-page 抓取。

## 設計總覽

新增一個跨 pod 的分散式速率閘門模組 `YoutubeWatchGate`，取代現有的 per-process
`youtubeRateLimiter` 單例。閘門狀態存放於 worker 共用的 Redis，沿用既有
`src/modules/webhook/queue.ts` 中以單一 Redis key（存「下一次可請求的絕對時間戳」）
配合 `WATCH`/`MULTI`/`WatchError` 重試的分散式節流模式。

```
runWorker (Application)
  ├─ MongodbModule
  ├─ RedisModule            ← 新增（提供 redis client）
  ├─ YoutubeWatchGate       ← 新增（建構時注入 redisModule.redis）
  └─ QueueModule(honeybee)
         └─ queue.process(N, job => handleJob(job, signal, gate))  ← 將 gate 傳入
```

## 元件

### `YoutubeWatchGate`（新模組 `src/modules/youtube-watch-gate.ts`）

唯一職責：跨所有 worker pod 協調對 YouTube watch page 的請求節奏。實作 `Module`
介面（`name`，無 `init`/`close` 需求，因為它不擁有 Redis 連線生命週期——連線由
`RedisModule` 擁有）。建構子接受一個已連線的 node-redis client。

對外只暴露兩個方法，內部封裝所有 Redis 互動與型別細節：

#### `tryAcquire(): Promise<boolean>`

非阻塞地嘗試取得一個全域請求額度（claim-or-skip 語意，非 blocking）。

底層使用單一 Redis key `hb:yt:watch:gate`，其值為 `nextAllowedAtMs`（epoch 毫秒，
字串）。流程（沿用 `src/modules/webhook/queue.ts` 第 113–159 行的有界 `WATCH`/`MULTI`
重試模式）：

1. `WATCH key` → `GET key` → `nextAllowed = raw === null ? 0 : parseInt(raw, 10)`。
2. 若 `now >= nextAllowed`：`MULTI` 中 `SET key String(now + YOUTUBE_WATCH_INTERVAL_MS)`
   帶 `PX: YOUTUBE_WATCH_GATE_KEY_TTL_MS`，`EXEC`。`EXEC` 因 `WatchError` 失敗則重試；
   成功則回傳 `true`。
3. 若 `now < nextAllowed`：`UNWATCH`，回傳 `false`（此刻不送請求）。
4. 有界重試（最多 5 次，比照既有模式）用盡仍未成功 claim → 回傳 `false`。

`now` 取自 `Date.now()`。

#### `penalize(): Promise<void>`

偵測到 429 時呼叫，將同一個 key 原子地推進為 `max(current, now + YOUTUBE_WATCH_COOLDOWN_MS)`，
使所有 pod 在冷卻視窗內的 `tryAcquire` 全部回傳 `false`，一起退避。

流程（同樣 `WATCH`/`MULTI` 有界重試）：

1. `WATCH key` → `GET key` → `current = raw === null ? 0 : parseInt(raw, 10)`。
2. `target = now + YOUTUBE_WATCH_COOLDOWN_MS`。
3. 若 `target > current`：`MULTI` 中 `SET key String(target)` 帶
   `PX: YOUTUBE_WATCH_GATE_KEY_TTL_MS`，`EXEC`；`WatchError` 則重試。
4. `max` 語意（步驟 3 的條件）保證不縮短既有更長的冷卻。
5. 冷卻由「未啟用」轉「啟用」時（即步驟 1 讀到 `now >= current`，代表先前無有效冷卻）
   輸出單行 log，例如：`entering YouTube watch rate-limit cooldown for 60s`。
   後續 `penalize` 在冷卻仍有效時（`now < current`）不再輸出。

### `updateVideoStats` 的改動（`src/commands/worker.ts`）

`handleJob` 透過 `queue.process` callback 接收一個 `gate: YoutubeWatchGate` 參數
（於 `runWorker` 閉包中建立並傳入），`updateVideoStats` 使用該 gate。

正常路徑：

```
async function updateVideoStats() {
  try {
    if (isReplay) return;
    if (replica > 1) return;
    if (!(await gate.tryAcquire())) return;   // 閘門關閉就跳過這次更新
    await VideoModel.updateFromMasterchat(mc);
  } catch (err) {
    if (err instanceof AbortError || axios.isCancel(err)) {
      // ignore
    } else if (is429(err)) {
      await gate.penalize();                   // 全域退避
    } else if (isAxiosError(err)) {
      videoLog(`<!> [STATS UPDATE ERROR] ${err}`);
    } else {
      videoLog("<!> [STATS UPDATE ERROR]", err);
    }
  }
}
```

`is429(err)` 的判斷：`(isAxiosError(err) && err.response?.status === 429)` 為主要
偵測；另防禦性地將 masterchat 的 `AccessDeniedError` 一併視為 429（涵蓋未來上游修
正、或 embed 路徑改丟該錯誤的情況）。

### 移除既有 per-process limiter

`src/modules/rate-limiter.ts` 僅被 `src/commands/worker.ts` 匯入使用。替換完成後，
刪除整個 `src/modules/rate-limiter.ts` 並移除 worker.ts 中對應的 import，清除
dead code。

### Application 接線與關閉順序

於 `runWorker` 中註冊順序：`MongodbModule` → `RedisModule` →
`YoutubeWatchGate`（建構子傳入 `redisModule.redis`）→ `QueueModule`。

- `RedisModule` 在 `YoutubeWatchGate` 之前註冊，確保 init 時 Redis 已連線、close
  時（LIFO）gate 先於 Redis 關閉。`YoutubeWatchGate` 不擁有 Redis 連線，故其
  `close()` 無需 disconnect。
- `QueueModule` 在最後，確保 job 消費者先於其依賴（Redis/Mongo）停止。

## 常數（`src/constants.ts`）

依專案 `_MS` 慣例命名並各帶一行說明：

- `YOUTUBE_WATCH_INTERVAL_MS = 1000` — 全域（跨所有 worker pod）兩次 watch-page
  請求的最小間隔。現況 per-pod 1 秒、3 pod 共用 IP 等於對 YouTube 約 3 req/s；改為
  全域 1 req/s 直接消除此 3 倍放大。
- `YOUTUBE_WATCH_COOLDOWN_MS = 60_000` — 偵測到 429 後所有 pod 暫停 watch-page 請求
  的時間，讓 YouTube 限速窗口冷卻；取 1 分鐘對齊 stats 更新本身的最小週期，跳過一
  輪更新即可恢復。
- `YOUTUBE_WATCH_GATE_KEY_TTL_MS = YOUTUBE_WATCH_COOLDOWN_MS * 3` — gate key 的
  Redis TTL，明顯大於冷卻時間以免冷卻中途因 key 過期而失效；比照
  `WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS` 的 `* 3` 慣例。

數值為起始值；上線後可依實測調整。

## 錯誤處理與邊界情況

### Redis 執行期故障（tryAcquire 故障即關閉、penalize 盡力而為）

`tryAcquire()` 與 `penalize()` 內部的 Redis 操作以 try/catch 包覆，吞掉非預期例外
（連線斷、`WATCH`/`GET`/`EXEC` 失敗且非 `WatchError`）。兩者採不同策略：

- `tryAcquire()` 例外 → 回傳 `false`（對 stats 更新而言是 **fail-closed**：本輪跳過
  更新）。保守選擇：在失去協調能力時寧可本輪不更新，也不放任 3 pod 無節制打
  YouTube。
- `penalize()` 例外 → 直接 return（**best-effort**：退避失敗不影響 chat 收集，下次
  429 仍會再次嘗試）。

注意：此處的 fail-closed 只作用在「stats 更新這一次是否進行」，**不**影響 chat 收集
主流程——整段 stats 更新本就包在 best-effort try/catch 內，Redis 故障不得使 job 失敗
或中斷 chat 收集。上述策略針對的是執行期暫時抖動；啟動期行為見下節。

### 啟動期 Redis 不可用：不引入新的硬性依賴

新增 `RedisModule` **不會**讓 worker 變得「比現在更依賴 Redis」。worker 既有的
`QueueModule`（Bee-Queue）已使用與 `RedisModule` 完全相同的 `REDIS_URI`
（`src/modules/queue.ts` 第 18–21 行 `redis: { url: REDIS_URI }`），因此 Redis 在本
設計之前就已是 worker 的硬性前置依賴：

- 沒有 Redis，worker 根本收不到任何 `honeybee` job，chat 收集本就無從開始。
- Redis 故障時，既有的 `queue.on("error")`（`src/commands/worker.ts` 第 1064–1068
  行）會 `process.exit(1)`，worker 直接結束。

因此啟動期行為定義為：`RedisModule.init()` 的 `connect()` 連不上時，`app.init()`
拋例外、process 結束——這與「Redis 故障時 Bee-Queue 讓 worker exit」是**同一個**失敗
封套，不是本設計新增的失敗模式。`RedisModule` 與 Bee-Queue 指向同一 Redis 實例，兩
者要嘛同時可用、要嘛同時不可用；不存在「Bee-Queue 連得上但 watch gate 連不上」而
獨自卡死 worker 的情境。

> 操作面：first-run / 部署時的 Redis 失敗本就由既有的 queue-error → `process.exit(1)`
> 行為涵蓋（k8s 會重啟並在 Redis 恢復後成功啟動），本設計不改變此行為，故不需新增
> 啟動期 Redis 失敗的測試或檢查。

### WatchError 重試上限

`tryAcquire`／`penalize` 沿用既有有界重試（最多 5 次）。`tryAcquire` 用盡回傳
`false`；`penalize` 用盡則放棄本次退避（best-effort）。高競爭時退化為「跳過這次更
新」，不會 busy-loop。

### claim-or-skip 對既有呼叫點的影響

`updateVideoStats` 在三處被呼叫，跳過皆可接受：

- job 啟動時 `void updateVideoStats()` — 被跳過僅少一次初始 stats，下一輪補上。
- 每分鐘週期迴圈 — 跳過後該次 200-action 視窗的 stats 延後一輪，可接受。
- job 結束 finally `await updateVideoStats()` — 跳過僅少最後一次 stats（best-effort），
  且好處是 job 退場不被閘門阻塞。

選擇 non-blocking（claim-or-skip）而非 blocking acquire 的理由：stats 更新本為
best-effort 週期性工作，閘門關閉時直接跳過、下輪再試，避免在冷卻期間讓 job 卡住等
待數十秒而拖延 chat 收集與 job 清理；同時讓冷卻期間請求自然停止、log 安靜下來。

### Cooldown key TTL

gate key 帶 `PX: YOUTUBE_WATCH_GATE_KEY_TTL_MS`（= 冷卻時間 × 3），確保冷卻期間 key
不會中途過期；冷卻結束後 key 自然到期清除，回到穩態（下一次 `tryAcquire` 讀到
`null` → `nextAllowed = 0` → 可立即 claim）。

### 時鐘偏移

key 存的是絕對 epoch 毫秒，跨 pod 比較依賴各 pod 時鐘大致一致。k8s 節點走 NTP，
毫秒級偏移對「秒級 INTERVAL／分鐘級 COOLDOWN」無實質影響——與 `webhook/queue.ts`
gate 既有假設相同，不額外處理。

### 並發 penalize

多個 pod 幾乎同時撞 429 各自呼叫 `penalize()`，`max(current, now + COOLDOWN)` 語意
保證收斂到最遠的冷卻時間，不會互相縮短；log 去重靠「轉換時才印」，最壞情況數個
pod 各印一次，仍遠少於現狀的洪水。

## 測試

### `src/modules/youtube-watch-gate.spec.ts`

以 stateful 的 Redis fake（可觀察 key 值變化，非裸 `jest.fn()`）搭配可控時間
（注入或 mock `Date.now()`）：

1. **穩態節流** — 第一次 `tryAcquire` 回 `true` 且 key 被 `SET` 為
   `now + YOUTUBE_WATCH_INTERVAL_MS`（結構性斷言 key 實際值）；同一時間視窗內第二次
   回 `false`；時間前進過 `INTERVAL_MS` 後再回 `true`。
2. **penalize 後全體退避** — `penalize()` 後 key = `now + YOUTUBE_WATCH_COOLDOWN_MS`；
   冷卻內 `tryAcquire` 持續回 `false`；時間前進過冷卻後恢復回 `true`。
3. **penalize 的 max 語意** — 先 `penalize` 設較長冷卻，再以較早時間 `penalize`
   不縮短既有 key 值（由 stateful fake 觀察 key 未被改小）。
4. **Redis 故障處理** — 令 fake Redis 指令丟例外：`tryAcquire` 回 `false`
   （fail-closed，跳過本輪更新）、`penalize` 不向外拋例外（best-effort）。
5. **log 去重** — 冷卻由未啟用→啟用只輸出一次；冷卻仍有效時重複 `penalize` 不再
   輸出（以 spy 觀察輸出次數）。

每個案例至少一項結構性斷言（key 實際值 / 回傳值 / 輸出次數），不以
`toHaveBeenCalled` 單獨充數；Redis 狀態變化以 stateful fake 觀察。

### worker.ts 429 偵測

`is429(err)` 判斷式（`isAxiosError && response.status === 429`，以及
`AccessDeniedError`）若可低成本獨立單元測試則加一例；否則於計畫階段依既有 worker
測試涵蓋方式處理。

## 第三方套件行為依據

- **node-redis v4**：`WATCH`/`MULTI`/`exec()`，`exec()` 在 `WATCH` 的 key 被改動時
  丟 `WatchError`；`SET key value { PX: ms }` 設定毫秒 TTL。以上用法與專案既有
  `src/modules/webhook/queue.ts`、`src/modules/webhook/partition.ts` 完全一致，沿用
  既有已驗證的呼叫模式。
- **axios**：HTTP 429 時 `isAxiosError(err)` 為真且 `err.response?.status === 429`；
  `err.code` 為 `ERR_BAD_REQUEST` / `ERR_BAD_RESPONSE` 而非 `"429"`（此即 masterchat
  偵測失效的原因）。
- **@stu43005/masterchat**：`fetchMetadataFromWatch` 對偵測到的限速丟
  `AccessDeniedError`；其 `err.code === "429"` 判斷對 axios 錯誤不成立。

> 計畫階段須依專案規範以 research subagent 讀取 `node_modules/` 原始碼，確認上述
> node-redis 與 masterchat 行為與專案實際版本一致後，才將具體呼叫寫入實作計畫。
