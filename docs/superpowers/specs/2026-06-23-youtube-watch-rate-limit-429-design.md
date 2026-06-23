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

```text
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

對外只暴露兩個方法，內部封裝所有 Redis 互動與型別細節。閘門狀態存於單一 Redis
key `hb:yt:watch:gate`，其值為 `nextAllowedAtMs`（epoch 毫秒，字串）。

#### `acquire(maxWaitMs: number, signal?: AbortSignal): Promise<boolean>`

有界阻塞地嘗試取得一個全域請求額度。在 `maxWaitMs` 預算內排隊等待閘門開啟：等到
空檔即 claim 並回傳 `true`（可送請求）；預算耗盡（例如正處於冷卻）或 `signal` 被
abort（優雅關閉）→ 回傳 `false`（本輪跳過）。

底層用一段原子的 Lua **claim 腳本**（`EVAL`）配合 client 端等待迴圈：

claim 腳本（`KEYS[1]=gate key`，`ARGV=[now, INTERVAL_MS, GATE_KEY_TTL_MS]`）邏輯：

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

client 端 `acquire` 迴圈：

1. `deadline = Date.now() + maxWaitMs`。
2. 迴圈：若 `signal?.aborted` → 回 `false`。
3. 以 `now = Date.now()` 執行 claim 腳本。回傳 `-1` → 回 `true`（搶到）。
4. 否則 `nextAllowed = Number(回傳值)`，`delay = nextAllowed - Date.now()`；若
   `delay <= 0` 立即重試（競爭落空，極短）。
5. `remaining = deadline - Date.now()`；若 `remaining <= 0` → 回 `false`（預算耗盡）。
6. `await setTimeout(min(delay, remaining), undefined, { signal })`（`node:timers/promises`，
   可被 abort），喚醒後回到步驟 2。

多個 waiter 在閘門開啟時各自重試 claim，腳本原子性保證只有一個搶到、其餘讀到被推
進的 `nextAllowed` 後再排到下一個 `INTERVAL`——形成分散式版「排隊直到釋放」。`now`
一律取自 `Date.now()`。

#### `penalize(): Promise<void>`

偵測到 429 時呼叫，將同一個 key 原子地推進為
`max(current, now + YOUTUBE_WATCH_COOLDOWN_MS)`，使所有 pod 在冷卻視窗內的 `acquire`
都等不到空檔而退避。

penalize 腳本（`KEYS[1]=gate key`，`ARGV=[now, COOLDOWN_MS, GATE_KEY_TTL_MS]`）邏輯：

```lua
local current = tonumber(redis.call('GET', KEYS[1])) or 0
local now = tonumber(ARGV[1])
local target = now + tonumber(ARGV[2])
local wasActive = now < current        -- 冷卻是否已啟用
if target > current then
  redis.call('SET', KEYS[1], target, 'PX', tonumber(ARGV[3]))
end
if wasActive then return 0 else return 1 end   -- 1 = 由未啟用→啟用
```

`max` 語意（`if target > current`）保證不縮短既有更長的冷卻。腳本回傳 `1`（由未
啟用轉啟用）時，client 端輸出單行 log，例如
`entering YouTube watch rate-limit cooldown for 60s`；回傳 `0`（冷卻已啟用）則不
輸出。log-once 的判斷在腳本內原子完成，並發 `penalize` 不會各自誤判而重複輸出
（除非剛好同時跨越啟用邊界，最壞數個 pod 各印一次）。

#### 為何用 Lua `EVAL` 而非 `WATCH`/`MULTI`

`WATCH` 是**連線層級**狀態。worker 在 `JOB_CONCURRENCY > 1` 時會有多個 job 並發在
**同一條共享 Redis 連線**（`RedisModule.redis`）上呼叫 `acquire`/`penalize`；並發的
`WATCH`/`MULTI`/`EXEC` 在單一連線上會互相干擾，且有界阻塞會拉長 `acquire` 的存活
時間、放大重疊。Lua `EVAL` 將「讀-比較-寫」收斂為單一原子指令，無連線狀態、無
`WatchError` 重試迴圈，在共享連線並發下安全，且讓上述等待迴圈的每次重試只是一個
`EVAL`。代價是引入 Lua 這一新慣例（取捨後選擇此方案）。

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
      await gate.penalize(); // 全域退避
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
- `YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS = 5000` — 單次 `acquire` 排隊等待空檔的時間
  上限。取 5 秒（= 5 個 `INTERVAL_MS`）足以吸收穩態下的併發排隊；遠小於
  `COOLDOWN_MS`（冷卻中等滿即跳過、不空耗 job），也遠小於 `SHUTDOWN_TIMEOUT`（45s）
  且等待可被 abort，確保不拖延優雅關閉。

數值為起始值；上線後可依實測調整。

## 錯誤處理與邊界情況

### Redis 執行期故障（acquire 故障即關閉、penalize 盡力而為）

`acquire()` 與 `penalize()` 內部的 `EVAL` 操作以 try/catch 包覆，吞掉非預期例外
（連線斷、`EVAL` 失敗）。兩者採不同策略：

- `acquire()` 例外 → 回傳 `false`（對 stats 更新而言是 **fail-closed**：本輪跳過
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
保證收斂到最遠的冷卻時間，不會互相縮短；log 去重靠「轉換時才印」，最壞情況數個
pod 各印一次，仍遠少於現狀的洪水。

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
7. **Redis 故障處理** — 令 fake `eval` 丟例外：`acquire` 回 `false`（fail-closed，跳
   過本輪更新）、`penalize` 不向外拋例外（best-effort）。
8. **log 去重** — 冷卻由未啟用→啟用只輸出一次（腳本回 `1`）；冷卻仍有效時重複
   `penalize`（腳本回 `0`）不再輸出（以 spy 觀察輸出次數）。

每個案例至少一項結構性斷言（key 實際值 / 回傳值 / 輸出次數），不以
`toHaveBeenCalled` 單獨充數；Redis 狀態變化以 stateful fake 觀察；涉及 timer 的案例
以 fake timers 明確推進並 await promise 結算，不以「等事件發生」草草帶過。

### worker.ts 429 偵測

`is429(err)` 判斷式（`isAxiosError && response.status === 429`，以及
`AccessDeniedError`）若可低成本獨立單元測試則加一例；否則於計畫階段依既有 worker
測試涵蓋方式處理。

## 第三方套件行為依據

- **node-redis v4**：以 `EVAL`（client `eval(script, { keys, arguments })`，arguments
  皆為字串）執行 Lua 腳本，於腳本內 `redis.call('GET'/'SET', ...)` 並以
  `SET key value PX ms` 設定毫秒 TTL；腳本回傳值經 client 轉為 JS number。`EVAL` 為
  單一原子指令，並發呼叫由 Redis 序列化，無 `WATCH` 連線狀態問題。專案既有
  `src/modules/webhook/queue.ts`、`partition.ts` 使用 `SET ... { PX }` 與 `multi`，
  本設計改用 `eval`，屬新增用法。
- **axios**：HTTP 429 時 `isAxiosError(err)` 為真且 `err.response?.status === 429`；
  `err.code` 為 `ERR_BAD_REQUEST` / `ERR_BAD_RESPONSE` 而非 `"429"`（此即 masterchat
  偵測失效的原因）。
- **@stu43005/masterchat**：`fetchMetadataFromWatch` 對偵測到的限速丟
  `AccessDeniedError`；其 `err.code === "429"` 判斷對 axios 錯誤不成立。
- **node:timers/promises**：`setTimeout(delay, value, { signal })` 在 `signal` abort
  時 reject（`AbortError`）；worker 既有程式已使用此模式（`src/commands/worker.ts`
  第 17、906、925 行）。

> 計畫階段須依專案規範以 research subagent 讀取 `node_modules/` 原始碼，確認上述
> node-redis `eval` 簽名／回傳型別、`setTimeout` abort 行為與 masterchat 行為與專案
> 實際版本一致後，才將具體呼叫寫入實作計畫。
