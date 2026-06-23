# YouTube watch-page 429 跨 pod 限速設計

## 問題陳述

worker 服務持續出現大量重複的錯誤 log：

```text
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
`youtubeRateLimiter` 單例。閘門狀態存放於 worker 共用的 Redis，以單一 Redis key
（存「下一次可請求的絕對時間戳」`nextAllowedAtMs`）表達全域節奏。沿襲既有
`src/modules/webhook/queue.ts` 的「next-allowed timestamp」語意，但原子操作改以 Lua
`EVAL` 腳本實作，而非 `WATCH`/`MULTI`（理由見下方「為何用 Lua `EVAL`」）。

`acquire` 採**有界阻塞**語意：等同現有 `youtubeRateLimiter.acquire()` 的「排隊直到
釋放」，但加上時間上限與可中斷性，避免在冷卻期間無限期阻塞 job。

連線管理走專案既有的模組化慣例：worker 註冊 `RedisModule`，`YoutubeWatchGate` 注入
`redisModule.redis` 使用（與 webhook 服務同時用 `RedisModule` + `QueueModule` 的組成
方式一致）。為避免「gate 這個 best-effort 設施的 Redis 連不上就拖垮整個 worker」，
`RedisModule` 增加一個**可選的 `nonBlockingConnect` 選項**，僅 worker 啟用；啟動時不
以 `await connect()` 阻塞、改背景連線並降級，其他使用 `RedisModule` 的服務（如
webhook）行為不變（詳見「啟動期 Redis 不可用」一節）。

```text
runWorker (Application)
  ├─ MongodbModule
  ├─ RedisModule            ← 新增（啟用 nonBlockingConnect；啟動不被 Redis 阻塞）
  ├─ YoutubeWatchGate       ← 新增（注入 redisModule.redis 使用）
  └─ QueueModule(honeybee)
         └─ queue.process(N, job => handleJob(job, signal, gate))  ← 將 gate 傳入
```

## 元件

### `YoutubeWatchGate`（新模組 `src/modules/youtube-watch-gate.ts`）

唯一職責：跨所有 worker pod 協調對 YouTube watch page 的請求節奏。實作 `Module`
介面，**不自管 Redis 連線**——建構子注入 `RedisModule` 的共享 client
（`redisModule.redis`），連線生命週期由 `RedisModule` / `Application` 擁有。gate 的
`init`/`close` 無連線責任（最多 `close` 時清掉自身的 in-flight 等待，不 `disconnect`
共享連線）。

- **正常狀態**（共享 client `redis.isReady === true`）：`acquire`/`penalize` 走全域
  Redis 協調（跨所有 pod）。
- **降級狀態**（共享 client 未就緒：Redis 啟動連不上仍在背景重連、或執行期斷線）：
  `acquire` **退回 process 本地限速**（per-process 1 req/s，等同變更前的
  `rate-limiter.ts` 行為），使 stats 更新持續進行、**不會靜默陳舊**；同時發 rate-limited
  的降級告警 log（見「降級可觀測性與操作」）。`penalize` 仍設本地後備冷卻並回
  `false`（Redis 未記錄）。兩者皆不向呼叫端拋例外。降級模式≈變更前的生產基準（stats
  新鮮、3 pod 各自 1/s + 本地 429 退避，對 YouTube 風險不高於現況）。

對外只暴露兩個方法，內部封裝所有 Redis 互動與型別細節。閘門狀態存於兩個 Redis
key：`hb:yt:watch:gate`（值為 `nextAllowedAtMs`，epoch 毫秒字串）與
`hb:yt:watch:cooldown-log`（log-once 旗標，見 `penalize`）。模組另持有三個 process
本地欄位：`localNextAllowedMs`（降級時 per-process 限速的 next-allowed 時間戳）、
`localCooldownUntilMs`（429 後備退避）、`lastDegradedLogAtMs`（降級告警 rate-limit）。

#### `acquire(maxWaitMs: number, signal?: AbortSignal): Promise<boolean>`

有界阻塞地嘗試取得一個請求額度。在 `maxWaitMs` 預算內排隊等待空檔：等到即 claim 並
回傳 `true`（可送請求）；預算耗盡（例如正處於冷卻）或 `signal` 被 abort（優雅關閉）
→ 回傳 `false`（本輪跳過）。

`acquire` 用**單一有界等待迴圈**，依共享 client 是否就緒切換 claim 後端：

- **全域後端（`redis.isReady === true`）**：以原子 Lua **claim 腳本**（`EVAL`）對
  `hb:yt:watch:gate` 做「讀-比較-寫」，跨所有 pod 協調。
- **降級後端（`redis.isReady === false`）**：對 process 本地欄位 `localNextAllowedMs`
  做同一套「讀-比較-寫」（純記憶體、per-process），達成等同變更前 `rate-limiter.ts`
  的 1 req/s；並呼叫 rate-limited 的降級告警（見「降級可觀測性與操作」）。

claim 腳本（全域後端，`KEYS[1]=gate key`，`ARGV=[now, INTERVAL_MS, GATE_KEY_TTL_MS]`）：

```lua
local nextAllowed = tonumber(redis.call('GET', KEYS[1])) or 0
local now = tonumber(ARGV[1])
if now >= nextAllowed then
  redis.call('SET', KEYS[1], now + tonumber(ARGV[2]), 'PX', tonumber(ARGV[3]))
  return -1            -- 已 claim
else
  return nextAllowed   -- 未 claim；回傳未來時間戳供 client 計算 sleep
end
```

降級後端的本地 claim 等價邏輯（同語意，無 Redis）：`if now >= localNextAllowedMs then
localNextAllowedMs = now + INTERVAL_MS; claimed else 回傳 localNextAllowedMs`。

client 端 `acquire` 迴圈：

1. 若 `Date.now() < localCooldownUntilMs`（本地後備冷卻中，**兩種後端皆適用**）→ 立即
   回 `false`。
2. `deadline = Date.now() + maxWaitMs`。
3. 迴圈：若 `signal?.aborted` → 回 `false`。
4. 以 `now = Date.now()` 依當下 `redis.isReady` 選後端執行一次 claim：
   - 全域後端 `EVAL` 例外 → fail-closed 回 `false`。
   - 降級後端：先 `maybeLogDegraded()`，再做本地 claim（不會丟例外）。
   - claim 成功（全域回 `-1` / 本地命中）→ 回 `true`。
5. 否則取得未命中時的 `nextAllowed`（全域為腳本回傳值、降級為 `localNextAllowedMs`），
   `delay = nextAllowed - Date.now()`；若 `delay <= 0` 立即重試（競爭落空，極短）。
6. `remaining = deadline - Date.now()`；若 `remaining <= 0` → 回 `false`（預算耗盡）。
7. `await setTimeout(min(delay, remaining), undefined, { signal })`（`node:timers/promises`，
   可被 abort），喚醒後回到步驟 3。

> 後端在「每次迴圈迭代」依當下 `redis.isReady` 決定，故連線在等待中恢復/斷線時，下一
> 次迭代會自動切換到對應後端，不會卡在錯誤後端。

多個 waiter 在閘門開啟時各自重試 claim，腳本原子性保證只有一個搶到、其餘讀到被推
進的 `nextAllowed` 後再排到下一個 `INTERVAL`——形成分散式版「排隊直到釋放」。`now`
一律取自 `Date.now()`。

#### `penalize(): Promise<boolean>`

偵測到 429 時呼叫。**回傳值語意：`recorded`——「這次 429 是否成功寫入全域 Redis 冷
卻」**（`true` = `EVAL` 成功執行；`false` = client 未就緒或 `EVAL` 例外）。回傳值**不**
代表 log-once（log 是 gate 內部副作用，見下），呼叫端只用 `recorded === false` 決定是
否印一次「全域冷卻未記錄」告警。

行為：

1. **無條件**設定 process 本地後備冷卻
   `localCooldownUntilMs = Date.now() + YOUTUBE_WATCH_COOLDOWN_MS`（即使 Redis 失效，
   本 pod 也會本地退避，不會 1 秒後立刻又打 YouTube）。
2. 若 `redis.isReady === false` → 直接回 `false`（`recorded = false`，不嘗試 `EVAL`）。
3. 否則執行 penalize 腳本；`EVAL` 例外 → catch 後回 `false`。
4. 腳本回傳 `1`（本 cooldown episode 首次）時，**gate 內部**印單行
   `entering YouTube watch rate-limit cooldown for 60s`；回 `0` 不印。此 log-once 副作
   用與 `recorded` 回傳值無關。
5. 步驟 2–4 正常完成（`EVAL` 有跑）→ 回 `true`。

penalize 腳本（`KEYS[1]=gate key`、`KEYS[2]=cooldown-log 旗標 key`，
`ARGV=[now, COOLDOWN_MS, GATE_KEY_TTL_MS]`）邏輯：

```lua
local current = tonumber(redis.call('GET', KEYS[1])) or 0
local now = tonumber(ARGV[1])
local cooldown = tonumber(ARGV[2])
local target = now + cooldown
if target > current then
  redis.call('SET', KEYS[1], target, 'PX', tonumber(ARGV[3]))
end
-- log-once 旗標：每個冷卻 episode 僅首次 SET 成功（NX），TTL = 冷卻長度
local fresh = redis.call('SET', KEYS[2], '1', 'NX', 'PX', cooldown)
if fresh then return 1 else return 0 end   -- 1 = 本 episode 首次，gate 內部 log 一次
```

`max` 語意（`if target > current`）保證不縮短既有更長的冷卻。**log-once 改用獨立旗標
key `KEYS[2]`（`SET NX PX cooldown`）判斷，而非比較 `nextAllowedAtMs`**：因為剛成功
claim 會把 `nextAllowedAtMs` 留在 `now + INTERVAL`（未來 1 秒），若用時間戳比較會把
「首次進入冷卻」誤判成「冷卻已啟用」而吞掉首條 log。旗標 NX 語意則精準對應「每個冷
卻 episode 一條 log」。持續 429 超過一個冷卻長度後旗標到期，下次 penalize 的腳本會再
回 `1`、再印一次（每分鐘至多一條，仍遠少於現狀洪水，且有助於辨識「仍在限速中」）。

> 為何把 cooldown-entry log 放進 gate 內部、而非由呼叫端依回傳值印：避免把「Redis 記
> 錄成功與否（`recorded`）」與「本 episode 是否首次（log-once）」兩個正交概念混在同一
> 個回傳值——否則 `recorded=true` 但 `0`（已記錄過）會被誤讀成「未記錄」而印錯告警。

#### 為何用 Lua `EVAL` 而非 `WATCH`/`MULTI`

`WATCH` 是**連線層級**狀態。worker 在 `JOB_CONCURRENCY > 1` 時會有多個 job 並發在
**`RedisModule.redis` 這條共享連線**上呼叫 `acquire`/`penalize`；並發的 `WATCH`/
`MULTI`/`EXEC` 在單一連線上會互相干擾，且有界阻塞會拉長 `acquire` 的存活時間、放大
重疊。
Lua `EVAL` 將「讀-比較-寫」收斂為單一原子指令，無連線狀態、無 `WatchError` 重試迴
圈，在共享連線並發下安全，且讓上述等待迴圈的每次重試只是一個 `EVAL`。代價是引入
Lua 這一新慣例（取捨後選擇此方案）。

### `updateVideoStats` 的改動（`src/commands/worker.ts`）

`handleJob` 透過 `queue.process` callback 接收一個 `gate: YoutubeWatchGate` 參數
（於 `runWorker` 閉包中建立並傳入），`updateVideoStats` 使用該 gate。

正常路徑：

```ts
async function updateVideoStats() {
  try {
    if (isReplay) return;
    if (replica > 1) return;
    // 有界阻塞排隊；傳入 cancelController.signal 讓優雅關閉能立即解除等待
    if (
      !(await gate.acquire(
        YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS,
        cancelController.signal
      ))
    )
      return; // 預算耗盡（冷卻中）或已 abort → 跳過
    await VideoModel.updateFromMasterchat(mc);
  } catch (err) {
    if (err instanceof AbortError || axios.isCancel(err)) {
      // ignore
    } else if (is429(err)) {
      // 全域退避；penalize 已先設好本地後備冷卻。Redis 記錄失敗時印一次告警，
      // 讓「偵測到 429 但全域冷卻未記錄」的降級狀態可見（非靜默）
      const recorded = await gate.penalize();
      if (!recorded) {
        videoLog(
          "<!> [STATS UPDATE ERROR] 429 detected; global cooldown not recorded (local backoff active)"
        );
      }
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

注意：penalize 失敗時印的告警**不會**像原始 429 洪水那樣氾濫——因為 penalize 已設好
本地後備冷卻（`localCooldownUntilMs`），該 pod 在冷卻期間的 `acquire` 會直接回
`false` 跳過，不再觸發新的 watch-page 請求，自然不會反覆進到這個分支。

### 移除既有 per-process limiter

`src/modules/rate-limiter.ts` 僅被 `src/commands/worker.ts` 匯入使用。其「per-process
1 req/s」行為已被 `YoutubeWatchGate` 的**降級後端**（`localNextAllowedMs` 的本地
claim）以等價語意吸收，故替換完成後刪除整個 `src/modules/rate-limiter.ts` 並移除
worker.ts 中對應的 import，避免留下功能重複的孤兒類別。

### `RedisModule` 的可選 init 容錯（`src/modules/redis.ts`）

為 `RedisModule` 建構子增加一個可選選項（例如 `new RedisModule({ nonBlockingConnect:
true })`，預設 `false`）。語意依 node-redis v4 實際行為（見「第三方套件行為依據」，已
讀原始碼確認）設計：

- `false`（預設，現狀）：`init()` **`await connect()`**。node-redis 預設策略
  `Math.min(retries*50, 500)` 會無限重試初次連線，故 Redis 不可達時 `await` 會阻塞至
  連上為止——維持既有服務（webhook 等）行為不變。
- `true`（僅 worker 啟用）：`init()` **不 await `connect()`**，改以 fire-and-forget
  發起連線（`this.redis.connect().catch(...)`）並立即返回，使 worker 啟動不被 Redis
  阻塞；初次連線由 node-redis 預設無限重試策略在背景重連，連上後 `isReady` 轉真。
  **必須**先掛 `this.redis.on('error', ...)`（node-redis 每次連線失敗會 `emit('error')`，
  無 listener 會讓 process 崩潰）。`close()` 比照既有 `disconnect()`，並確保未連上時
  呼叫不致拋出未處理錯誤。

此選項是本設計對 `src/modules/redis.ts` 的唯一改動，且向後相容（既有呼叫 `new
RedisModule()` 不傳參數即維持 `await connect()` 行為）。

### Application 接線與關閉順序

於 `runWorker` 中註冊順序：`MongodbModule` → `RedisModule`（啟用 `nonBlockingConnect`）→
`YoutubeWatchGate`（建構子注入 `redisModule.redis`）→ `QueueModule`。

- `RedisModule` 在 `YoutubeWatchGate` 之前註冊，gate 才能取得共享 client；close 為
  LIFO，故 QueueModule 先關、gate 次之、`RedisModule` 再關（gate 不擁有連線、不
  `disconnect`）、Mongo 最後。
- `QueueModule` 在最後，確保 job 消費者先於其依賴（Redis/Mongo）停止。
- worker 的 `RedisModule` 以容錯選項註冊，使「gate 的 Redis 連不上」不致命（理由見
  「啟動期 Redis 不可用」）。

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
- `YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS = 5000` — 單次 `acquire` 排隊等待空檔的時間
  上限。取 5 秒（= 5 個 `INTERVAL_MS`）足以吸收穩態下的併發排隊；遠小於
  `COOLDOWN_MS`（冷卻中等滿即跳過、不空耗 job），也遠小於 `SHUTDOWN_TIMEOUT`（45s）
  且等待可被 abort，確保不拖延優雅關閉。
- `YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS = 60_000` — gate 處於降級（共享 client 未就
  緒）時，降級告警 log 的最小間隔。取 1 分鐘讓「持續連不上」可被觀測/告警，又不致洗
  版（相對於每次 `acquire` 都印）。

數值為起始值；上線後可依實測調整。

## 錯誤處理與邊界情況

### Redis 執行期故障（acquire 故障即關閉、penalize 盡力而為）

`acquire()` 與 `penalize()` 內部的 `EVAL` 操作以 try/catch 包覆，吞掉非預期例外
（連線斷、`EVAL` 失敗）：

- `acquire()` 全域後端的單次 `EVAL` 例外（`isReady` 仍 true 時的瞬時抖動）→ 該次回
  `false`（**fail-closed**，本輪跳過）。若是**持續**不就緒（`isReady === false`），
  則由降級後端（per-process 本地限速）接手，stats 更新照常進行、不會無限跳過（見
  「降級可觀測性與操作」）。
- `penalize()` 例外或 `isReady === false` → 回 `false`（`recorded = false`，
  **best-effort**：已先設好本地後備冷卻，呼叫端印一次告警；不影響 chat 收集）。

注意：上述「跳過」只作用在「stats 更新這一次是否進行」，**不**影響 chat 收集主流程——
整段 stats 更新本就包在 best-effort try/catch 內，Redis 故障不得使 job 失敗或中斷
chat 收集。本節針對執行期抖動；啟動期行為見下節。

### 啟動期 Redis 不可用：RedisModule 可選 init 容錯，worker 不死

gate 是 best-effort 的 stats 限速設施，**不得**因它依賴的 Redis 連不上而讓整個
worker 無法消費 job / 收集 chat。問題在於：若直接把標準 `RedisModule` 加進 worker，
其 `init()` 的 `await connect()` 在 Redis 啟動不可達時會**阻塞**——node-redis 預設無限
重試策略下 `connect()` 不會 reject，而是持續重試直到連上（已讀 `@redis/client`
1.5.14 原始碼確認，見「第三方套件行為依據」）。也就是說 worker 會卡在 `app.init()`
等 Redis，遲遲無法啟動 `QueueModule`、無法收集 chat——即使 Bee-Queue 可能仍連得上
（相同 `REDIS_URI` **不等於**相同可用性：第二條連線有獨立的握手、認證/TLS，以及
Redis `maxclients` 壓力，存在「Bee-Queue 仍可處理 job，但新連線因 `maxclients` 或瞬時
握手失敗而連不上」的情境）。為一個 stats-only 功能阻塞 chat 收集得不償失。

解法：**為 `RedisModule` 增加可選的 `nonBlockingConnect` 選項（預設關閉），僅 worker
啟用。** 啟用時 `init()` **不 await `connect()`**，改以 fire-and-forget 發起連線並先掛
`'error'` handler，立即返回——worker 照常啟動 `QueueModule`、收集 chat；初次連線由
node-redis 預設無限重試策略在背景完成，連上後 `isReady` 轉真，gate 自動回到全域限速。
預設關閉，故 webhook 等既有使用 `RedisModule` 的服務維持 `await connect()` 行為完全
不變。

降級狀態下（`redis.isReady === false`，啟動仍在背景連線、或執行期斷線）gate 的
`acquire` 退回 **per-process 本地限速**（見「降級可觀測性與操作」），stats 更新照常以
1 req/s 進行、**不會無限跳過**；Redis 連上後 gate 自動回到全域限速。

### 降級可觀測性與操作

降級（共享 client 持續未就緒）必須**可被觀測**，不可變成全 worker 的靜默資料陳舊：

- **行為（非靜默陳舊）：** 降級時 `acquire` 用 per-process 本地限速（≈變更前基準），
  stats 仍持續更新，只是退回單 pod 1 req/s、失去跨 pod 協調；本地 429 後備冷卻仍生
  效。對 YouTube 的風險不高於變更前現況。
- **可觀測（rate-limited log）：** `maybeLogDegraded()` 在降級且距上次降級 log
  ≥ `YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS`（60s）時印一行告警（如
  `<!> [YT GATE DEGRADED] redis not ready; using per-process rate limit`），更新
  `lastDegradedLogAtMs`；持續中斷時每分鐘至多一條，足以告警又不洗版。
- **恢復訊號：** 由降級轉回就緒（上次處於降級、本次 `isReady === true`）時印一行
  `[YT GATE] recovered; resumed global coordination` 並清掉降級 log 節流狀態。
- **操作恢復路徑：** 看到 `[YT GATE DEGRADED]` 表示該 worker 的 Redis 連線長時間建不
  起來——處置為提高 Redis `maxclients` / 修復網路；或回滾本次部署（變更為附加式，回
  滾即恢復原 per-process limiter，且降級模式本就≈該基準，回滾無資料風險）。

> 連線數與部署前置：每個 worker pod 因 `RedisModule` 多一條 Redis 連線（3 pod = +3）。
> 部署前應確認 Redis `maxclients` 有對應餘裕（webhook 服務早已同時持有 QueueModule +
> RedisModule 兩條連線於生產運行，量級可參照）。即便餘裕不足導致 gate 連不上，worker
> 也只會降級（per-process 限速 + 上述告警），不會中斷 chat 收集。

### 等待迴圈終止與原子性

`acquire` 的等待迴圈以 `deadline = now + maxWaitMs` 為硬上限：每次重試前重新計算
`remaining`，`remaining <= 0` 即回 `false`，保證迴圈在 `maxWaitMs` 內必定結束、不
busy-loop（每次未命中都 `setTimeout` 至少到下一個 `nextAllowed`）。`signal` 被 abort
時等待立即解除並回 `false`。claim/penalize 的「讀-比較-寫」由 Lua `EVAL` 原子完成，
無 `WATCH`/`WatchError` 重試需求；並發 `acquire` 只是各自重跑 `EVAL`，由 Redis 序列
化保證互斥。

### 有界阻塞對既有呼叫點的影響

`updateVideoStats` 在三處被呼叫，皆傳入 `cancelController.signal`：

- job 啟動時 `void updateVideoStats()` — 穩態下短暫排隊後成功；冷卻中等滿
  `MAX_WAIT_MS` 後跳過（下一輪補上）。
- 每分鐘週期迴圈 — 同上；跳過時該次 200-action 視窗的 stats 延後一輪，可接受。
- job 結束 finally `await updateVideoStats()`（`src/commands/worker.ts` 第 1033 行）
  — 見下方終端更新語意。

**為何改用有界阻塞（取代原 non-blocking claim-or-skip）：** 純 non-blocking 會在
穩態下「兩個 job 剛好同一秒更新」時直接丟棄其中一次更新。有界阻塞讓後者排隊等到下
個 `INTERVAL` 空檔再成功，把常見的穩態併發競爭從「丟棄」改善為「短暫延後後完成」，
同時保留上限以免冷卻期間無限阻塞。

**終端更新語意（明文定義）：**

- **正常 stream 結束（非關閉）：** 此時 `cancelController` 尚未 abort（它在
  `updateVideoStats` 之後、finally 末段才 abort，見 `src/commands/worker.ts` 第
  1034–1036 行），故終端更新會正常有界排隊；穩態下成功，冷卻中等滿 `MAX_WAIT_MS`
  後跳過。
- **優雅關閉：** `cancelController.signal` 已由 `globalSignal` 連動 abort，`acquire`
  立即回 `false`、終端更新跳過，不拖延關閉。

**終端更新在冷卻中被跳過——可接受性論證（已與需求方確認接受並明文標註）：**
此情況僅發生在「stream 恰在 429 冷卻視窗內結束」。其資料影響有界且多被既有寫入語意
吸收：

- `maxViewers`（峰值觀眾）與 Channel `subscriberCount` 皆為 `$max` 寫入，由先前的
  週期更新保留，**不受終端跳過影響**。
- 真正可能略為過時的只有「最後 1～2 分鐘的 `likes` 與當下 `viewers`」。
- 冷卻意味 YouTube 正在限速，watch page 本就拒絕服務；即使此刻嘗試也取不到資料。
  唯一理論上可恢復的窄窗是「YouTube 已恢復、但固定冷卻尚未到期」，其代價（為終端更
  新引入持久化待補機制 / 讓 job 長時間阻塞等滿冷卻）與所換得的少量 `likes`/`viewers`
  精度不成比例，故本設計不納入（YAGNI）。
- 與現況比較：現有 blocking limiter 在 429 風暴下的終端更新同樣會拿到 429 而失敗
  （只是吵雜地 log），本設計在「YouTube 正限速」期間並未使資料更差，只是更安靜。

### Cooldown key TTL

gate key 帶 `PX: YOUTUBE_WATCH_GATE_KEY_TTL_MS`（= 冷卻時間 × 3），確保冷卻期間 key
不會中途過期。冷卻結束後 key 仍可能殘留（TTL 比冷卻長），但其值 `nextAllowedAtMs`
已成過去，claim 腳本 `now >= nextAllowed` 成立 → 可立即 claim，行為與穩態相同；key
最終於 TTL 到期被清除。換言之：限速恢復靠「值落在過去」，而非靠 key 被刪除。

### 時鐘偏移

key 存的是絕對 epoch 毫秒，跨 pod 比較依賴各 pod 時鐘大致一致。k8s 節點走 NTP，
毫秒級偏移對「秒級 INTERVAL／分鐘級 COOLDOWN」無實質影響——與 `webhook/queue.ts`
gate 既有假設相同，不額外處理。

### 並發 penalize

多個 pod 幾乎同時撞 429 各自呼叫 `penalize()`，`max(current, now + COOLDOWN)` 語意
保證收斂到最遠的冷卻時間，不會互相縮短；log 去重靠獨立旗標 key 的 `SET NX`（每個冷
卻 episode 只有一個 penalize 搶到旗標而印一次），最壞情況跨 pod 競態下數個各印一
次，仍遠少於現狀的洪水。

### penalize 失敗的可見性與本地後備

防止「偵測到 429，但全域冷卻沒被記錄而靜默失效」：

- **可見性：** `penalize()` 回傳 Redis 是否成功記錄；`updateVideoStats` 在失敗時印一
  次告警（見上方程式碼），讓限速機制降級不再是隱形的。此告警本身不會氾濫，因為下一
  點的本地後備會立即讓該 pod 停止再打 watch page。
- **本地後備冷卻：** `penalize()` 一進入就**無條件**設定 process 本地
  `localCooldownUntilMs = now + COOLDOWN_MS`，且 `acquire` 會先檢查它。因此即使 Redis
  協調完全失效（`EVAL` 例外、降級），撞到 429 的該 pod 仍會本地退避一個 `COOLDOWN`，
  **不會**在 1 秒 INTERVAL 後立刻又恢復 watch-page 流量、重燃 429。其他 pod 若 Redis
  正常則照常吃到全域冷卻；若連 Redis 都壞了，各 pod 也會在各自撞到 429 後本地退避，
  收斂到「大家都安靜」。本地後備是全域協調的下位保險，不取代它。

## 測試

### `src/modules/youtube-watch-gate.spec.ts`

以 stateful 的 Redis fake（`eval` 對共享 key 做真實的讀-比較-寫、可觀察 key 值變化，
非裸 `jest.fn()`）搭配可控時間（注入或 mock `Date.now()`）與可控 `setTimeout`（fake
timers）：

1. **穩態 claim** — 首次 `acquire(MAX_WAIT, signal)` 回 `true` 且 key 被設為
   `now + YOUTUBE_WATCH_INTERVAL_MS`（結構性斷言 key 實際值）。
2. **有界阻塞排隊後成功** — key 已被推進到 `now + INTERVAL` 內的未來；呼叫
   `acquire`，推進 fake timer 過該 `INTERVAL` 後 promise resolve 為 `true`，且最終
   key 再被推進一個 `INTERVAL`（驗證確實 claim，非提早放棄）。
3. **預算耗盡跳過** — 先 `penalize` 進入冷卻（`nextAllowed = now + COOLDOWN`，遠大於
   `MAX_WAIT`）；`acquire(MAX_WAIT)` 在推進 timer 至 `deadline` 後 resolve 為
   `false`，且未對 key 再寫入（未 claim）。
4. **abort 立即解除** — `acquire` 等待中將 `signal` abort，promise 立即 resolve 為
   `false`（以 fake timer 確認未等到 `deadline`）。
5. **penalize 後全體退避** — `penalize()` 後 key = `now + YOUTUBE_WATCH_COOLDOWN_MS`；
   冷卻內 `acquire` 預算耗盡回 `false`；時間前進過冷卻後再 `acquire` 回 `true`。
6. **penalize 的 max 語意** — 先 `penalize` 設較長冷卻，再以較早時間 `penalize`
   不縮短既有 key 值（由 stateful fake 觀察 key 未被改小）。
7. **全域後端瞬時 EVAL 例外** — `isReady === true` 但單次 `eval` 丟例外：該次
   `acquire` 回 `false`（fail-closed）、`penalize` 回 `false` 不拋（best-effort）。
8. **log-once 旗標** — 同一冷卻 episode 內重複 `penalize`：首次旗標 `SET NX` 成功、
   腳本回 `1`（gate 內部 log 一次）；其後旗標已存在、回 `0`（不 log）。並驗證「剛
   claim 後 `nextAllowedAtMs = now + INTERVAL`」的情況下首次 `penalize` 的腳本仍回
   `1`（旗標機制不受時間戳干擾，避免吞掉首條 log）；此測試同時確認 `penalize` 的回傳
   值（`recorded`）為 `true`（`eval` 有成功跑），與 log-once 解耦。
9. **降級後端：本地限速接手** — 注入 `redis.isReady === false` 的 fake client：
   `acquire` **不呼叫 `eval`**、改走本地 claim：首次回 `true` 且 `localNextAllowedMs`
   被設為 `now + INTERVAL`；同一視窗第二次有界等待，推進 timer 過 `INTERVAL` 後回
   `true`（驗證 stats 仍以 1 req/s 持續，而非無限跳過）。
10. **降級告警節流 + 恢復 log** — 降級下連續多次 `acquire`：降級告警 log 僅在距上次
    ≥ `YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS` 時印（以 spy 計次，推進 timer 驗證節
    流）；隨後將 fake `isReady` 切回 `true` 再 `acquire`，印一次「recovered」log（轉
    換偵測），且後端切回全域 `eval`（結構性斷言 gate key 被寫入）。
11. **penalize 本地後備** — `penalize` 後（不論 Redis 成功與否）`localCooldownUntilMs`
    被設為 `now + COOLDOWN`；在該本地冷卻內呼叫 `acquire` 立即回 `false`（即使全域 gate
    key 或本地 `localNextAllowedMs` 顯示可 claim，也因本地後備而跳過）；時間前進過本地
    冷卻後 `acquire` 恢復。
12. **penalize 回傳 recorded** — `isReady===true` 且 `eval` 成功 → `penalize` 回
    `true`（含腳本回 `0` 的「已記錄過」情況也回 `true`，不被誤判為未記錄）；`eval` 丟
    例外或 `isReady===false` → 回 `false`，且本地後備仍被設定（`localCooldownUntilMs`
    已更新）。

每個案例至少一項結構性斷言（key 實際值 / 回傳值 / 輸出次數 / 本地欄位值），不以
`toHaveBeenCalled` 單獨充數；Redis 狀態變化以 stateful fake 觀察；涉及 timer 的案例
以 fake timers 明確推進並 await promise 結算，不以「等事件發生」草草帶過。

### `src/modules/redis.spec.ts`（RedisModule `nonBlockingConnect` 選項）

1. **預設 await 連線** — 不傳選項時，`init()` 會 `await this.redis.connect()`：以 spy
   驗證 `init()` 等待 connect 結算（既有行為，確保 webhook 等服務不受影響）。
2. **non-blocking 啟用** — `nonBlockingConnect: true` 時，即使 fake `connect()` 尚未
   resolve（pending），`init()` 仍立即 resolve（以 fake timers / 未結算的 connect
   promise 驗證 init 不等待）；且 `init()` 前已掛上 `'error'` listener（避免 connect
   背景失敗的 `error` 事件讓 process 崩潰）；`close()` 不因未連線而拋例外。

### worker.ts 429 偵測

`is429(err)` 判斷式（`isAxiosError && response.status === 429`，以及
`AccessDeniedError`）若可低成本獨立單元測試則加一例；否則於計畫階段依既有 worker
測試涵蓋方式處理。

## 第三方套件行為依據

- **node-redis v4**：gate 使用 `RedisModule.redis` 注入的共享 client（不自建連線）；
  以 `redis.isReady` 判斷連線就緒、以 `EVAL`（client `eval(script, { keys, arguments
})`，arguments 皆為字串）執行 Lua 腳本，腳本內 `redis.call('GET'/'SET', ...)`，
  `SET key value PX ms` 設定毫秒 TTL、`SET ... NX` 在 key 已存在時回 `nil`（Lua 內
  `false`）、否則回 `OK`；腳本回傳值經 client 轉為 JS number。`EVAL` 為單一原子指令，
  並發呼叫由 Redis 序列化，無 `WATCH` 連線狀態問題。專案既有
  `src/modules/webhook/queue.ts`、`partition.ts` 使用 `SET ... { PX }` 與 `multi`，
  本設計改用 `eval`，屬新增用法。
- **node-redis v4 連線/重連**（已讀 `node_modules/@redis/client@1.5.14`
  `dist/lib/client/socket.js` 確認）：預設 `reconnectStrategy` 為
  `Math.min(retries*50, 500)`（L129），**永遠回傳數字 → 無限重試**。初次 `connect()`
  自身的 `do...while (isOpen && !isReady)` 迴圈（L143–170）即依此策略重試初次連線；
  因此 `await connect()` 在 Redis 不可達時**阻塞重試直到連上**（每次嘗試受
  `connectTimeout=5000ms` 限制），**不會 reject**——只有當 `reconnectStrategy` 回傳
  `false`/`Error` 時才會 reject 並把 `isOpen` 設為 `false`（L132–141）。每次失敗會
  `emit('error')`（L166），故背景連線模式**必須**先掛 `client.on('error')`，否則
  Node 對無 listener 的 `'error'` 事件會丟出。據此，worker 的 `nonBlockingConnect`
  以「不 await `connect()` + 掛 `'error'` handler」即可達成「啟動不阻塞、背景自動連
  上」，不需自訂 `reconnectStrategy` 或顯式重試迴圈。
- **axios**：HTTP 429 時 `isAxiosError(err)` 為真且 `err.response?.status === 429`；
  `err.code` 為 `ERR_BAD_REQUEST` / `ERR_BAD_RESPONSE` 而非 `"429"`（此即 masterchat
  偵測失效的原因）。
- **@stu43005/masterchat**：`fetchMetadataFromWatch` 對偵測到的限速丟
  `AccessDeniedError`；其 `err.code === "429"` 判斷對 axios 錯誤不成立。
- **node:timers/promises**：`setTimeout(delay, value, { signal })` 在 `signal` abort
  時 reject（`AbortError`）；worker 既有程式已使用此模式（`src/commands/worker.ts`
  第 17、906、925 行）。

> node-redis 連線/重連行為已於本設計階段讀 `@redis/client@1.5.14` 原始碼確認（見上
> 條，含行號）。計畫階段仍須依專案規範以 research subagent 確認 `eval` 簽名／回傳型
> 別、`SET ... NX` 回傳值、`setTimeout` abort 行為與 masterchat 行為與專案實際版本一
> 致後，才將具體呼叫寫入實作計畫。
