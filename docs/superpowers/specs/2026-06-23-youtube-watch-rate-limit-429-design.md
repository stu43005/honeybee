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
`youtubeRateLimiter` 單例。閘門狀態存放於 worker 共用的 Redis，核心是一個存「下一次
可請求的絕對時間戳」`nextAllowedAtMs` 的 key（另有一個 log-once 旗標 key，見
`penalize`）來表達全域節奏。沿襲既有
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
  `acquire` 一律回 `false`（**fail-closed：跳過 stats 更新、不呼叫 watch page**），並發
  rate-limited 降級告警 log（見「降級可觀測性與操作」）。**不**退回 per-process 限速——
  失去跨 pod 協調時若各 pod 自行探測，3 pod 共用 IP 會重燃原本要消滅的 429 風暴；寧可
  暫時跳過 stats（chat 收集不受影響、且有告警可被處置）也不冒風暴風險。`penalize` 仍
  設本地後備冷卻並回 `false`（Redis 未記錄）。兩者皆不向呼叫端拋例外。

對外只暴露兩個方法，內部封裝所有 Redis 互動與型別細節。閘門狀態存於兩個 Redis
key：`hb:yt:watch:gate`（值為 `nextAllowedAtMs`，epoch 毫秒字串）與
`hb:yt:watch:cooldown-log`（log-once 旗標，見 `penalize`）。模組另持有以下 process
本地欄位：`localCooldownUntilMs`（429 後備退避，正常模式下 `penalize` 的 Redis 寫入瞬
時失敗時讓本 pod 仍退避）、`lastDegradedLogAtMs`（降級告警 rate-limit）、`wasDegraded`
（上次是否處於降級，用於印一次恢復 log）、`lastEvalErrorLogAtMs`（**EVAL 錯誤**告警
rate-limit，用於把「client 已連上但 `EVAL` 被拒/失敗」與「連線降級」區隔開來，避免
ACL/scripting 被擋時靜默全停）、`lastSaturatedLogAtMs`（**飽和**告警 rate-limit，用於
讓「健康但全域速率不足、`maxWaitMs` 預算耗盡而跳過」在持續發生時可觀測，不靜默陳舊）。
（以上告警節流見「降級可觀測性與操作」。）

#### `acquire(maxWaitMs: number, signal?: AbortSignal): Promise<boolean>`

有界阻塞地嘗試取得一個請求額度。在 `maxWaitMs` 預算內排隊等待空檔：等到即 claim 並
回傳 `true`（可送請求）；預算耗盡（例如正處於冷卻）或 `signal` 被 abort（優雅關閉）
→ 回傳 `false`（本輪跳過）。

`acquire` 用一段原子的 Lua **claim 腳本**（`EVAL`）配合 client 端有界等待迴圈，對
`hb:yt:watch:gate` 做跨 pod 的「讀-比較-寫」。**Redis 未就緒（降級）時一律回 `false`、
不打 watch page**（不退回 per-process 限速，理由見上）。

claim 腳本（`KEYS[1]=gate key`，`ARGV=[now, INTERVAL_MS, GATE_KEY_TTL_MS]`）：

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

1. 若 `Date.now() < localCooldownUntilMs`（本地後備冷卻中）→ 立即回 `false`。
2. 若 `redis.isReady === false`（降級）→ `maybeLogDegraded()` 後立即回 `false`
   （不打 watch page）。
3. `deadline = Date.now() + maxWaitMs`。
4. 迴圈：若 `signal?.aborted` → 回 `false`。
5. 以 `now = Date.now()` 執行 claim 腳本（`EVAL`）：
   - `EVAL` 例外 → fail-closed 回 `false`。**若此刻 `redis.isReady === true`**（即非連
     線降級，而是 `EVAL` 本身被拒/失敗，如 Redis ACL 未授權 scripting、`EVAL` 被
     managed policy 停用、或腳本錯誤）→ 先 `maybeLogEvalError(err)`（rate-limited 的
     **區隔**告警，與 `[YT GATE DEGRADED]` 不同），確保此類「連得上但 EVAL 不通」的失
     敗**不會靜默**全停。等待中斷線使 `isReady` 已轉 false 的情況則歸入降級、不誤報。
   - 回 `-1`（claim 成功）→ 回 `true`。
   - 否則 `nextAllowed = Number(回傳值)`，`delay = nextAllowed - Date.now()`；若
     `delay <= 0` 立即重試（競爭落空，極短）。
6. `remaining = deadline - Date.now()`；若 `remaining <= 0` → `maybeLogSaturated()`
   後回 `false`（**預算耗盡**：健康但全域速率不足、排不到空檔；rate-limited 告警見
   「降級可觀測性與操作」，使持續飽和不靜默）。
7. 在 try/catch 內
   `await setTimeout(min(delay, remaining), undefined, { signal })`（`node:timers/promises`，
   可被 abort）；**捕捉到 `AbortError` → 回 `false`**（不讓 reject 外溢，守住
   `Promise<boolean>` 契約）；正常喚醒則回到步驟 4。

> `acquire` 的所有路徑（降級、abort、`EVAL` 例外、預算耗盡）一律 **resolve `false`，
> 從不 reject**。若連線在等待**中**斷線，下一次 `EVAL` 會 reject → 步驟 5 fail-closed
> 回 `false`（該次跳過），與「呼叫進入時就降級」效果一致。

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
   `localCooldownUntilMs = Date.now() + YOUTUBE_WATCH_COOLDOWN_MS`（即使 Redis 寫入瞬時
   失效，本 pod 也會本地退避，不會 1 秒後立刻又打 YouTube）。
2. 若 `redis.isReady === false` → 回 `false`（`recorded = false`，不嘗試 `EVAL`）。
3. 否則執行 penalize 腳本；`EVAL` 例外 → `maybeLogEvalError(err)`（同上區隔告警，因
   `isReady` 為真代表 EVAL 本身被拒/失敗）後回 `false`。
4. 腳本回傳 `1`（本 cooldown episode 首次）時，**gate 內部**印單行
   `entering YouTube watch rate-limit cooldown for 60s`；回 `0` 不印。此 log-once 副作
   用與 `recorded` 回傳值無關。
5. 步驟 2–4 正常完成（`EVAL` 有跑）→ 回 `true`（`recorded = true`）。

> 註：正常運作時 `penalize` 必由「`acquire` 成功（`isReady` 為真）→ 打 watch page → 收
> 到 429」這條路觸發，故進到步驟 3 的全域寫入是常態；步驟 2（`isReady === false`）僅為
> 防禦——降級時 `acquire` 本就不打 watch page、不會收到 429，正常不會走到。

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

`is429(err)` 的判斷：**僅** `isAxiosError(err) && err.response?.status === 429`。

**為何不把 masterchat 的 `AccessDeniedError` 視為 429（避免污染全域冷卻）：**
`AccessDeniedError` 的 `code` 是泛用的 `"denied"`，語意比 HTTP 429 寬——雖然此版
masterchat 在 `fetchMetadataFromWatch/Embed` 對限速丟它，但「denied」本質可涵蓋
private / region-blocked / login-required 等非限速的存取拒絕。若把它一律當 429，一支
壞片就會讓**共用** Redis 全域冷卻被觸發、壓抑所有 worker 的 stats 更新，且掩蓋真正原
因。此外（已讀 `@stu43005/masterchat` 原始碼確認）masterchat 目前判斷限速用
`err.code === "429"`，但 axios 對 429 的 `err.code` 是 `ERR_BAD_REQUEST`，該判斷永不
成立 → 它**不會**丟 `AccessDeniedError`、而是原始 `AxiosError`（`status === 429`）上
來；因此偵測 `AxiosError 429` 對現況已完全正確且充分。若未來 masterchat 修正其偵測，
再以「限速專屬訊號」（明確的 message/code）擴充 `is429`，屬另一次需驗證的變更，不在本
設計臆測。

注意：penalize 失敗時印的告警**不會**像原始 429 洪水那樣氾濫——因為 penalize 已設好
本地後備冷卻（`localCooldownUntilMs`），該 pod 在冷卻期間的 `acquire` 會直接回
`false` 跳過，不再觸發新的 watch-page 請求，自然不會反覆進到這個分支。

### 移除既有 per-process limiter

`src/modules/rate-limiter.ts` 僅被 `src/commands/worker.ts` 匯入使用，其角色由
`YoutubeWatchGate` 的全域 Redis 限速完全取代（降級時為跳過、不退回 per-process）。替換
完成後刪除整個 `src/modules/rate-limiter.ts` 並移除 worker.ts 中對應的 import，清除
dead code。

### `RedisModule` 的可選 `nonBlockingConnect`（非阻塞 + 非關鍵健康，`src/modules/redis.ts`）

為 `RedisModule` 建構子增加一個可選選項（`new RedisModule({ nonBlockingConnect:
true })`，預設 `false`）。此選項把該 `RedisModule` 標記為**非關鍵 best-effort 模組**，
涵蓋兩件事——啟動非阻塞、且**不參與 `/healthz` liveness**：

- `false`（預設，現狀）：`init()` **`await connect()`**、`healthCheck()` 維持 `ping()`。
  node-redis 預設策略 `Math.min(retries*50, 500)` 會無限重試初次連線，故 Redis 不可達
  時 `await` 會阻塞至連上為止——維持既有服務（webhook 等）行為不變。
- `true`（僅 worker 啟用）：
  - **healthCheck 不影響 liveness（關鍵修正）**：`healthCheck()` 一律回 `true`、**不**
    `ping`。否則：`Application` 的 `/healthz`（`src/modules/application.ts` 第 16–32 行）
    會對每個 `isInit` 模組跑 `healthCheck`，任一失敗即 `/healthz` 500；而 worker.yaml
    用 `/healthz` 作 **startup + liveness probe**。若 gate 的 Redis 連不上（正是降級情
    境）而 `healthCheck` 仍 `ping`，k8s 會**重啟整個 worker**、中斷 chat 收集——把
    best-effort 的 stats 限速器變成 chat 收集的可用性依賴。gate 的 Redis 健康改由
    `[YT GATE DEGRADED]` log 呈現（alert-only），不綁 liveness。
  - **`init()` 不 await `connect()`**：改以 fire-and-forget 發起連線並立即返回，使
    worker 啟動不被 Redis 阻塞；初次連線由 node-redis 預設無限重試策略在背景重連，連
    上後 `isReady` 轉真。要點：
  - **先掛 `'error' listener`**：`this.redis.on('error', ...)` 必須在 `connect()` 之前
    註冊（node-redis 每次連線失敗會 `emit('error')`，無 listener 會讓 process 崩潰）。
  - **持有 pending connect promise**：`this.connectPromise = this.redis.connect()` 並
    對它掛 terminal `.catch(...)`（吞掉「最終放棄」或被 `close()` 中斷時的 reject，避免
    shutdown 後才冒出 unhandled rejection）。
  - **`close()` 在所有狀態都明確收尾、停止背景重連**：依 `@redis/client` socket.js，
    `connect()` 一進入就把 `isOpen = true`（L50），且初次連線的重試迴圈條件為
    `isOpen && !isReady`（L170）——故「連線中/反覆重試中」時 `isOpen` 仍為真。`close()`
    因此：`isOpen` 為真（已連上或仍在重試）→ `disconnect()`，這會把 `isOpen` 設為
    `false`、令重試迴圈於下次醒來即退出、並關閉 socket；`isOpen` 為假（從未啟動，或
    `reconnectStrategy` 已回 `false`/`Error` 放棄）→ 視為已關閉、no-op（不可呼叫
    `disconnect()`，否則丟 `ClientClosedError`，見 socket.js L61–64）。最後
    `await this.connectPromise`（已掛 terminal catch、不會 reject）確保該 async 工作在
    `close()` 返回前確實終止，不殘留於 Application 生命週期之外。

此選項是本設計對 `src/modules/redis.ts` 的唯一改動，且向後相容（既有呼叫 `new
RedisModule()` 不傳參數即維持 `await connect()` 行為）。

### Application 接線與關閉順序

於 `runWorker` 中註冊順序：`MongodbModule` → `RedisModule`（啟用 `nonBlockingConnect`）→
`YoutubeWatchGate`（建構子注入 `redisModule.redis`）→ `QueueModule`。

- `RedisModule` 在 `YoutubeWatchGate` 之前註冊，gate 才能取得共享 client；close 為
  LIFO，故 QueueModule 先關、gate 次之、`RedisModule` 再關（gate 不擁有連線、不
  `disconnect`）、Mongo 最後。
- `QueueModule` 在最後，確保 job 消費者先於其依賴（Redis/Mongo）停止。
- worker 的 `RedisModule` 以 `nonBlockingConnect` 註冊，使「gate 的 Redis 連不上」既不
  阻塞啟動、也**不**讓 `/healthz` liveness 失敗而被 k8s 重啟（理由見「啟動期 Redis 不
  可用」與 `RedisModule` 選項一節）。

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
- `YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS = 60_000` — 降級／EVAL 錯誤／飽和三類告警
  log 共用的最小間隔。取 1 分鐘讓「持續異常」可被觀測/告警，又不致洗版（相對於每次
  `acquire` 都印）。

數值為起始值；上線後可依實測調整。

### 全域速率 vs 併發的調校關係（避免高負載靜默陳舊）

全域可承載的 watch-page throughput = `1000 / YOUTUBE_WATCH_INTERVAL_MS` req/s，**跨所有
worker pod 共享**。stats 更新需求主要來自 first-replica（`replica === 1`）job 的「啟動
＋每分鐘週期＋finally」三類呼叫；其量級隨**同時直播數**與 `JOB_CONCURRENCY × replica`
成長。當需求**持續**超過全域 throughput，`acquire` 會以 `MAX_WAIT_MS` 為界排隊、超界即
跳過——這是限速**按設計運作**（全域上限就是要擋住超量），但本設計用 `[YT GATE SATURATED]`
告警讓它**可觀測**，不致變成靜默陳舊。

調校準則：`INTERVAL_MS = 1000`（全域 1 req/s）刻意比變更前的「3 pod 各 1/s ≈ 3 req/s」
更保守以根除 429；若 `[YT GATE SATURATED]` 持續出現且 429 已穩定消失，可**逐步**調降
`INTERVAL_MS`（提高全域 throughput，但每次調整後觀察 429 是否回升），或調高
`MAX_WAIT_MS`（容忍更深排隊、減少跳過，代價是單次 `acquire` 佔用更久——仍須遠小於
`SHUTDOWN_TIMEOUT` 且可被 abort）。`MAX_WAIT_MS` 不必精準等於最壞併發；它是「願意為一
次 stats 更新排多久」的上限，超界跳過由下一輪週期補上、並由告警可見。

`YOUTUBE_WATCH_INTERVAL_MS` 與 `YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS` 可由同名環境變數覆
寫，沿用 `src/constants.ts` 既有慣例（如 `JOB_CONCURRENCY`）：
`Number(process.env.YOUTUBE_WATCH_INTERVAL_MS ?? 1000)`、
`Number(process.env.YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS ?? 5000)`——未設時退回上述預設；
便於不重編譯即依實測（含負載測試，見測試一節）調整。`COOLDOWN_MS`、`GATE_KEY_TTL_MS`、
`DEGRADED_LOG_INTERVAL_MS` 維持常數即可，無調校需求。

## 錯誤處理與邊界情況

### Redis 執行期故障（acquire 故障即關閉、penalize 盡力而為）

`acquire()` 與 `penalize()` 內部的 `EVAL` 操作以 try/catch 包覆，吞掉非預期例外
（連線斷、`EVAL` 失敗）：

- `acquire()`：`isReady === false`（降級）或單次 `EVAL` 例外 → 回 `false`
  （**fail-closed**，本輪跳過、不打 watch page）。降級期間持續跳過（不退回 per-process
  限速，避免重燃跨 pod 風暴），但發 rate-limited 告警使其可觀測（見「降級可觀測性與操
  作」）。
- `penalize()` 例外或 `isReady === false` → 回 `false`（`recorded = false`,
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
`acquire` 一律回 `false`（跳過 stats 更新、不打 watch page），並發 rate-limited 降級告
警（見「降級可觀測性與操作」）；Redis 連上後 gate 自動回到全域限速。chat 收集全程不
受影響。

### 降級可觀測性與操作

降級（共享 client 持續未就緒）下 `acquire` 一律跳過。這必須**可被觀測**，不可變成全
worker 的靜默 stats 陳舊：

- **行為（fail-closed 跳過）：** 降級時 `acquire` 回 `false`、不打 watch page，故失去
  全域協調期間 stats 暫不更新。刻意**不**退回 per-process 限速——3 pod 共用 IP，各自探
  測會重燃原本要消滅的跨 pod 429 風暴；寧可暫停 stats（chat 不受影響、且可告警處置）
  也不冒風暴風險。stats 陳舊只發生在 Redis 對該 pod 持續不可用期間，恢復即回補。
- **可觀測（rate-limited log）：** `maybeLogDegraded()` 在降級且距上次降級 log
  ≥ `YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS`（60s）時印一行告警（如
  `<!> [YT GATE DEGRADED] redis not ready; skipping stats updates`），更新
  `lastDegradedLogAtMs` 並設 `wasDegraded = true`；持續中斷時每分鐘至多一條，足以告警
  又不洗版。
- **EVAL 錯誤的區隔告警（避免「連得上但 EVAL 不通」靜默全停）：** 當 `isReady === true`
  但 `EVAL` 拋例外（Redis ACL 未授權 scripting、`EVAL` 被 managed policy 停用、腳本
  錯誤等），`maybeLogEvalError(err)` 以同樣 `YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS`
  節流印一行**不同**告警（如 `<!> [YT GATE EVAL ERROR] eval failed while connected: <err>`），
  更新 `lastEvalErrorLogAtMs`。此告警與 `[YT GATE DEGRADED]` 區隔，使「Bee-Queue 連得
  上、但 scripting 被擋」這種**連線正常卻全 stats 跳過**的情況有專屬訊號、不被誤判成
  普通限速 miss。
- **飽和的區隔告警（避免高負載下靜默陳舊）：** 當 Redis、YouTube 皆健康，但全域請求
  需求超過全域速率上限、`acquire` 因 `maxWaitMs` 預算耗盡而跳過時，`maybeLogSaturated()`
  以同樣間隔節流印一行 `<!> [YT GATE SATURATED] global rate budget exhausted; stats updates delayed`，
  更新 `lastSaturatedLogAtMs`。**單次偶發**的預算耗盡屬正常限速、被節流吸收不洗版；但
  **持續**飽和（每分鐘一條）即為訊號，代表全域速率對當前直播數而言過低、stats 開始延
  遲——可據此調 `YOUTUBE_WATCH_INTERVAL_MS`／`YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS`（見常
  數一節的調校說明），而非靜默陳舊。
- **恢復訊號：** 由降級轉回就緒（`wasDegraded === true` 且本次 `isReady === true`）時印
  一行 `[YT GATE] recovered; resumed global coordination`，清 `wasDegraded` 與降級 log
  節流狀態。
- **操作恢復路徑：** 看到 `[YT GATE DEGRADED]` 表示該 worker 的 Redis 連線長時間建不
  起來——處置為提高 Redis `maxclients` / 修復網路；或回滾本次部署（變更為附加式，回
  滾即恢復原 per-process limiter，且回滾無資料風險）。

> 連線數與部署前置：每個 worker pod 因 `RedisModule` 多一條 Redis 連線（3 pod = +3）。
> 部署前應確認 Redis `maxclients` 有對應餘裕（webhook 服務早已同時持有 QueueModule +
> RedisModule 兩條連線於生產運行，量級可參照）。即便餘裕不足導致 gate 連不上，worker
> 也只會降級（跳過 stats + 上述告警），不會中斷 chat 收集。

### 等待迴圈終止與原子性

`acquire` 的等待迴圈以 `deadline = now + maxWaitMs` 為硬上限：每次重試前重新計算
`remaining`，`remaining <= 0` 即回 `false`，保證迴圈在 `maxWaitMs` 內必定結束、不
busy-loop（每次未命中都 `setTimeout` 至少到下一個 `nextAllowed`）。`signal` 在等待前
已 aborted → 步驟 3 回 `false`；等待**中**才 abort → `setTimeout` reject `AbortError`，
由步驟 7 的 try/catch 捕捉並回 `false`。兩條 abort 路徑都 resolve `false`、不 reject，
故呼叫端無需自行 catch `AbortError`（契約自洽）。claim/penalize 的「讀-比較-寫」由 Lua
`EVAL` 原子完成，無 `WATCH`/`WatchError` 重試需求；並發 `acquire` 只是各自重跑
`EVAL`，由 Redis 序列化保證互斥。

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
  `localCooldownUntilMs = now + COOLDOWN_MS`，且 `acquire` 會先檢查它。針對的情境是
  「`isReady` 為真、`acquire` 成功打了 watch page、收到 429，但 `penalize` 的全域
  `EVAL` 寫入**瞬時失敗**（`recorded = false`）」——此時全域冷卻沒寫成，本地後備仍讓
  該 pod 退避一個 `COOLDOWN`，**不會**在 1 秒 INTERVAL 後立刻又重打、重燃 429。其他
  pod 的全域 `EVAL` 通常成功、照常吃到全域冷卻。本地後備是全域協調的下位保險，不取代
  它。（注意：完全降級時 `acquire` 本就不打 watch page、不會收到 429，故此後備只在
  「正常模式 + 寫入瞬時失敗」這條窄路生效。）

## 上線安全：遷移、回滾與監控

降級採 fail-closed（Redis 不可用時跳過所有 stats 更新），故「gate 的 Redis 連線是否
與既有 worker 路徑一樣可靠」必須在上線前說清楚。本節即為該遷移/相容性計畫。本設計
**不**引入 runtime feature flag/kill switch——理由見末段「殘餘風險與接受理由」。

### gate 連線可靠性 = 既有 worker 路徑（除 +1 連線、EVAL 能力外無新變數）

gate 透過 `RedisModule` 連線，其 `REDIS_URI` 與 worker 既有的 `QueueModule`
（Bee-Queue）**完全相同**（同 host、認證、TLS、Redis 版本、網路政策）。因此 auth /
TLS / 版本 / 網路政策這些**連線層**可靠性因素**不可能與既有路徑不同**：若其中任一有
問題，Bee-Queue 連線會先失敗、worker 根本無法消費 job。gate 真正**新增**的失敗變數只
有兩項，皆可在部署前明確檢查：

1. **+1 連線 vs `maxclients`**：每個 worker pod 多一條 Redis 連線。
2. **`EVAL`（scripting）命令權限**：Bee-Queue 用的是 `SET`/`GET`/list 等命令，其連線
   正常**不保證** Redis ACL / managed-Redis policy 允許 `EVAL`。本設計新增 `EVAL` 命令
   面，故 scripting 權限是一個獨立於連線層的新變數。若 `EVAL` 被拒，client 仍 `isReady`
   為真、但每次 claim/penalize 的 `EVAL` 會失敗——已由 acquire/penalize 的
   `maybeLogEvalError`（`[YT GATE EVAL ERROR]` 區隔告警）使其**不靜默**，但仍應在部署
   前檢查以免上線即全 stats 跳過。

### 部署前檢查清單（migration checklist）

- **maxclients 餘裕**：確認 Redis `maxclients` ≥（現有每 pod 連線數 + 1）× 各服務
  replica 總和，含 worker 的 `+3`（3 pod 各 +1）。webhook 服務早已每 pod 持有
  QueueModule + RedisModule 兩條連線於生產運行，可作為餘裕量級的參照。
- **可達性**：`REDIS_URI` 對 worker 可達——此點 Bee-Queue 既有運行已證實，無需額外
  驗證；不需任何新的 auth/TLS 設定（沿用既有）。
- **`EVAL`（scripting）權限**：在部署環境的 Redis 上驗證允許 `EVAL`——例如以 worker 用
  的同一連線設定執行 `redis-cli ... EVAL "return 1" 0` 應回 `1`（managed Redis 須確認
  其 ACL/policy 未停用 scripting）。上線後若仍被擋，`[YT GATE EVAL ERROR]` 會在首次
  stats 更新時即告警（非靜默）。
- **首次上線無既有 gate 狀態**：gate key (`hb:yt:watch:gate`) 與 log 旗標
  (`hb:yt:watch:cooldown-log`) 不存在時，claim 腳本讀到 `nextAllowed = 0` → 立即可
  claim、penalize 旗標 `SET NX` 即首次成功，皆為正常初始行為，**無 migration 資料或
  預建 key 需求**。

### 回滾路徑（附加式變更，安全）

本設計為**附加式**：新增 `YoutubeWatchGate` 模組、worker 註冊 `RedisModule`、為
`RedisModule` 加一個預設關閉的選項，並以 gate 取代 worker 內部對 `rate-limiter.ts` 的
呼叫——不改動 chat 收集（`mc.iterate`）與 queue 流程。若上線後觀察到 gate 導致 stats
被跳過（`[YT GATE DEGRADED]` log），回滾 = **重新部署前一版**，即恢復原 per-process
`rate-limiter.ts` 行為、stats 恢復。回滾期間與降級期間 chat 收集皆不受影響；stats
為 best-effort，且 `maxViewers` 等 `$max` 欄位保留既有峰值，無資料破壞風險。

#### 回滾遇上「全域冷卻仍生效」的狀態相容性

需明確一個狀態不連續：舊版 per-process limiter **不認識** gate key
`hb:yt:watch:gate`，故若在「gate 已因 429 寫入全域冷卻、且冷卻尚未到期」時回滾，舊版
各 pod 不會遵守該全域冷卻，而是各自以 per-process 速率恢復 watch-page 流量。要點與
runbook（reviewer 建議的「以 runbook 管理回滾期間 gate 狀態與 replica 速率」路徑，無
需 runtime flag）：

- **不連續的上界是「回到變更前基準」，非新增風暴**：舊版 per-process（3 pod × 1/s ＝
  共用 IP 上約 3/s）正是本變更前的**生產既有行為**。回滾 = 卸下本次改善 = 回到既有基
  準速率，並非製造一個比歷史更糟的新狀態。
- **冷卻自動失效、對舊版無害**：要分清兩個時間尺度——gate key 的 **Redis TTL** 是
  `GATE_KEY_TTL_MS`（= COOLDOWN × 3 = 180s），但**冷卻本身**在 `nextAllowedAtMs` 落到
  過去、即 ≤ `YOUTUBE_WATCH_COOLDOWN_MS`（60s）後就**失效**（新版屆時即視為可 claim）。
  關鍵時間是「冷卻失效」的 60s，**不是** key 過期的 180s。舊版本就讀不到此 key、不受
  影響，**無需手動刪除**；key 之後自然過期。
- **回滾安全不依賴 rollout 順序（明確 pre-rollback gate）**：本設計**不**倚賴 k8s 滾動
  替換「同時只有 1 個舊 pod」這類未由本 spec 強制、且受 `maxSurge`/`maxUnavailable`/
  readiness/手動 `kubectl rollout undo`/緊急重啟影響的隱性行為來保證安全。改以一個**明
  確的操作步驟**使安全與 rollout 形狀無關：

  **若回滾時可能有 active 全域冷卻（即正逢 YouTube 限速事件）**，runbook 規定以
  **drain（scale-to-zero）+ 狀態驗證**回滾，而**非**固定 sleep：
  1. **Drain**：先把 worker Deployment `scale --replicas=0`。這是關鍵——沒有任何 worker
     在跑，就**沒有人能再呼叫 `penalize` 把 `nextAllowedAtMs` 往後推**。（單純 sleep 而
     不 drain 不可靠：等待期間仍在跑的 new pod 一旦再撞 429 就把冷卻再延 60s，sleep 無
     法保證冷卻已排空。）
  2. **狀態驗證**：drain 後讀 `hb:yt:watch:gate`，確認 `nextAllowedAtMs <= now`（冷卻
     已失效；key 不存在亦同義）。因已 drain，此值不會再被推遲，是穩定可驗證的條件，取
     代「等夠久」的時間猜測。
  3. **Rollback**：條件滿足後再部署舊版並 ramp replicas 回原值。舊版上線時冷卻已失效，
     不會「無視 active 冷卻而立即恢復」。

  非限速事件（無 active 冷卻）的常規回滾無此顧慮，直接滾動回滾即可。

#### 前進部署（混版窗口）

同理，正常 k8s 滾動更新會短暫讓**舊 pod（per-process 限速、不讀 gate）與新 pod（全域
gate）並存**：此窗口的對外速率 ≈ 仍在跑的舊 pod 的 per-process 量 + 新 pod 的全域
≤1/s。要點：

- **上界是「≈ 變更前基準」、且為過渡**：混版窗口最壞約等於變更前舊基準（3 pod × 1/s
  ≈ 3/s）再加新 pod 的 ≤1/s，**非**製造比歷史更糟的新穩態；滾動更新完成（全部新版）後
  即降到安全的全域 1/s。窗口長度 = 一次滾動更新時間（數分鐘級）。
- **新 pod 仍遵守全域 backoff**：混版期間若撞 429，新 pod 會寫全域冷卻、彼此退避；僅舊
  pod 不認 gate。
- **若部署恰逢已知 YouTube 限速事件**：採與回滾相同的保守作法——先 drain（scale-to-zero）
  再 ramp 新版，避免新舊疊加；平時（無 active 限速）的常規滾動部署接受該過渡上界即可。

> 上述 deploy/rollback 的狀態不連續，本質是「以跨 pod 協調（需 Redis）取代 per-process
> 限速」在**版本切換瞬間**無法跨版本協調的固有結果：其速率上界被「變更前既有基準」
> （≈3/s）所夾、且僅為過渡（穩態收斂為安全的全域 1/s）。據此本設計維持「不引入 runtime
> flag / 不保留雙限速路徑」的取捨，改以 **drain（scale-to-zero）+ 狀態驗證的 ops
> runbook** 覆蓋「限速事件期間的 deploy/rollback」這個低頻情境（見「殘餘風險與接受理
> 由」）。此為已與需求方確認的刻意取捨。

### 監控與告警

- **降級告警**：以 `<!> [YT GATE DEGRADED]` log 設 log-based alert（出現即代表該 pod
  的 gate Redis 持續連不上）。建議閾值：單一 pod 持續出現超過數分鐘即升級為人為處置
  （提高 `maxclients` / 修網路 / 回滾）。
- **EVAL 錯誤告警**：以 `<!> [YT GATE EVAL ERROR]` log 設**另一條** alert（代表連得上
  但 scripting 被拒/失敗——通常是 ACL/policy 設定問題，需修 Redis 權限或回滾）。出現
  即表示全 stats 在跳過但連線正常，與「降級」處置不同。
- **飽和告警**：以 `<!> [YT GATE SATURATED]` log 設 alert（持續出現代表全域速率對當前
  直播數過低、stats 延遲）。處置為調校 `YOUTUBE_WATCH_INTERVAL_MS`（在 429 容忍範圍內
  加快全域速率）或 `YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS`（容忍更深排隊），見常數調校說明。
- **成因可區分**：`acquire` 回 `false` 的成因可由 log 唯一辨識並只對需介入者告警——
  「連線降級」→ `[YT GATE DEGRADED]`；「EVAL 被拒/失敗」→ `[YT GATE EVAL ERROR]`；
  「持續飽和」→ `[YT GATE SATURATED]`；「本地/全域冷卻中」與**偶發**預算耗盡屬正常限
  速、被節流吸收、不誤觸告警。
- **恢復可見**：`[YT GATE] recovered` log 標示 gate 由降級轉回全域協調，供確認處置生
  效。

### 殘餘風險與接受理由

經上述後，殘餘風險為「`maxclients` 餘裕不足」或「`EVAL`/scripting 權限被擋」且未在部
署前檢查發現 → 全 worker 的 stats 暫停更新。兩者皆**非破壞**、且**可觀測**（分別由
`[YT GATE DEGRADED]` 與 `[YT GATE EVAL ERROR]` 告警）、**可由重新部署回滾**，且因
`healthCheck` 非關鍵而**不會**誤觸 k8s 重啟 worker（chat 收集不中斷）。本設計選擇以
「部署前 `maxclients` + `EVAL` 權限檢查 + 兩條區隔的可觀測告警 + 附加式回滾」覆蓋此風
險，**不**引入 runtime feature flag：一個有意義的 kill switch 必須保留「停用 gate 時的
限速路徑」（即保留將被淘汰的 `rate-limiter.ts` 與一條 flag 分支），徒增長期維護面與兩
條限速程式路徑；而殘餘風險本身已是 best-effort、可觀測、可回滾，與 flag 帶來的複雜度
不成比例。此為刻意的取捨決定。

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
4. **abort 立即解除（resolve，不 reject）** — `acquire` 等待**中**將 `signal` abort：
   以 `await expect(p).resolves.toBe(false)` 驗證 promise **resolve `false`、不 reject**
   （確認 `setTimeout` 丟的 `AbortError` 被 `acquire` 內部 try/catch 吞掉），且以 fake
   timer 確認未等到 `deadline`。另測「呼叫前 `signal` 已 aborted」也 resolve `false`。
5. **penalize 後全體退避** — `penalize()` 後 key = `now + YOUTUBE_WATCH_COOLDOWN_MS`；
   冷卻內 `acquire` 預算耗盡回 `false`；時間前進過冷卻後再 `acquire` 回 `true`。
6. **penalize 的 max 語意** — 先 `penalize` 設較長冷卻，再以較早時間 `penalize`
   不縮短既有 key 值（由 stateful fake 觀察 key 未被改小）。
7. **全域後端瞬時 EVAL 例外 → 區隔告警** — `isReady === true` 但單次 `eval` 丟例外：
   該次 `acquire` 回 `false`（fail-closed）、`penalize` 回 `false` 不拋（best-effort）；
   且印 `[YT GATE EVAL ERROR]`（**非** `[YT GATE DEGRADED]`，以 spy 驗證是這條、且受
   `lastEvalErrorLogAtMs` 節流——連續多次 `eval` 失敗在間隔內只印一次）。對照測：
   `isReady === false` 時不印 `[YT GATE EVAL ERROR]`（歸降級、不誤報）。
8. **log-once 旗標** — 同一冷卻 episode 內重複 `penalize`：首次旗標 `SET NX` 成功、
   腳本回 `1`（gate 內部 log 一次）；其後旗標已存在、回 `0`（不 log）。並驗證「剛
   claim 後 `nextAllowedAtMs = now + INTERVAL`」的情況下首次 `penalize` 的腳本仍回
   `1`（旗標機制不受時間戳干擾，避免吞掉首條 log）；此測試同時確認 `penalize` 的回傳
   值（`recorded`）為 `true`（`eval` 有成功跑），與 log-once 解耦。
9. **降級即跳過** — 注入 `redis.isReady === false` 的 fake client：`acquire`
   **不呼叫 `eval`**、立即回 `false`（驗證未對任何 key 寫入、未打 watch page）。
10. **降級告警節流 + 恢復 log** — 降級下連續多次 `acquire`：降級告警 log 僅在距上次
    ≥ `YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS` 時印（以 spy 計次，推進 timer 驗證節
    流）、且 `wasDegraded` 被設真；隨後將 fake `isReady` 切回 `true` 再 `acquire`，印
    一次「recovered」log（`wasDegraded` 轉換偵測後清除），且該次走全域 `eval`（結構性
    斷言 gate key 被寫入、回 `true`）。
11. **penalize 本地後備** — `isReady===true` 下 `penalize`（即使 `eval` 成功）後
    `localCooldownUntilMs` 被設為 `now + COOLDOWN`；在該本地冷卻內呼叫 `acquire` 立即回
    `false`（即使全域 gate key 顯示可 claim，也因本地後備而跳過）；時間前進過本地冷卻
    後 `acquire` 恢復。此後備保險針對「正常模式撞 429 但 `eval` 寫入瞬時失敗」。
12. **penalize 回傳 recorded** — `isReady===true` 且 `eval` 成功 → `penalize` 回
    `true`（含腳本回 `0` 的「已記錄過」情況也回 `true`，不被誤判為未記錄）；`eval` 丟
    例外或 `isReady===false` → 回 `false`，且本地後備仍被設定（`localCooldownUntilMs`
    已更新）。
13. **飽和告警** — `isReady===true`、gate key 一直被推到未來（模擬全域已飽和），
    `acquire(MAX_WAIT)` 推進 timer 至 `deadline` 後回 `false`，並印一次
    `[YT GATE SATURATED]`；連續多次飽和的 `acquire` 在
    `YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS` 內只印一次（以 spy 計次驗證節流），確認
    「偶發跳過不洗版、持續飽和可觀測」。

每個案例至少一項結構性斷言（key 實際值 / 回傳值 / 輸出次數 / 本地欄位值），不以
`toHaveBeenCalled` 單獨充數；Redis 狀態變化以 stateful fake 觀察；涉及 timer 的案例
以 fake timers 明確推進並 await promise 結算，不以「等事件發生」草草帶過。

> 負載面向（計畫階段）：以 stateful fake 模擬「`JOB_CONCURRENCY × replica` 對全域
> 1 req/s」的併發 `acquire`，驗證超過 `MAX_WAIT/INTERVAL` 的併發會有部分跳過並觸發
> `[YT GATE SATURATED]`（而非靜默），作為調校 `INTERVAL_MS`/`MAX_WAIT_MS` 的依據。

### `src/modules/redis.spec.ts`（RedisModule `nonBlockingConnect` 選項）

1. **預設 await 連線** — 不傳選項時，`init()` 會 `await this.redis.connect()`：以 spy
   驗證 `init()` 等待 connect 結算（既有行為，確保 webhook 等服務不受影響）。
2. **non-blocking 啟用** — `nonBlockingConnect: true` 時，即使 fake `connect()` 尚未
   resolve（pending），`init()` 仍立即 resolve（以 fake timers / 未結算的 connect
   promise 驗證 init 不等待）；且 `init()` 前已掛上 `'error'` listener（避免 connect
   背景失敗的 `error` 事件讓 process 崩潰）。
   2b. **healthCheck 非關鍵（liveness 保護）** — `nonBlockingConnect: true` 且 fake client
   未連上（`isReady === false`、`ping` 會丟例外）時，`healthCheck()` 仍回 `true` 且
   **不呼叫 `ping`**（以 spy 驗證），確保 `/healthz` 不因 gate Redis 連不上而失敗、
   worker 不被 k8s 重啟。對照：預設（不傳選項）時 `healthCheck()` 仍走 `ping`（既有
   行為不變）。
3. **close 於 connect pending 時** — `nonBlockingConnect`、`connect()` 仍 pending
   （fake client `isOpen===true`）時呼叫 `close()`：`close()` resolve 不拋；以 spy 驗證
   走 `disconnect()`（`isOpen` 為真路徑）並 await 已存的 connectPromise（不留未結算
   async）。
4. **close 於反覆連線失敗時** — fake `connect()` 持續 reject/emit `'error'`（背景重試
   中，`isOpen===true`）：`close()` 仍能 resolve、停止重試、且不產生 shutdown 後的
   unhandled rejection（connectPromise 已掛 terminal catch）。
5. **close 於從未連上/已放棄時** — fake client `isOpen===false`：`close()` 視為 no-op、
   不呼叫 `disconnect()`（避免 `ClientClosedError`）、不拋例外。

### worker.ts 429 偵測（`is429`）

把 `is429` 抽成可獨立測試的純函式並覆蓋：

- `isAxiosError` 且 `response.status === 429` → `true`（會觸發 `penalize`）。
- masterchat `AccessDeniedError`（code `"denied"`，**非** 429）→ `false`——**不**呼叫
  `penalize`，避免一支 private/region-blocked/membersOnly 影片污染全域冷卻；應走一般
  stats error log 分支。以 mock `gate.penalize` 斷言**未被呼叫**。
- 其他非 429 的 `AxiosError`（如 500）、一般 `Error` → `false`，走既有 error log 分
  支、不 `penalize`。

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
- **@stu43005/masterchat**（已讀原始碼確認）：錯誤層級中 `AccessDeniedError` 的 `code`
  為泛用 `"denied"`（與限速無專屬區別碼）；限速、private、membersOnly、unavailable 等
  分別由不同子類（`AccessDeniedError`/`NoPermissionError`/`MembersOnlyError`/
  `UnavailableError`）表示。`fetchMetadataFromWatch/Embed` 內以 `err.code === "429"` 判
  斷限速並改丟 `AccessDeniedError("Rate limit exceeded")`，但 axios 對 429 的
  `err.code` 是 `ERR_BAD_REQUEST` → 該判斷不成立 → 實際丟出的是原始 `AxiosError`
  （`status === 429`）。故 `is429` 僅認 `AxiosError 429`、**不**認 `AccessDeniedError`
  （見「`updateVideoStats` 的改動」）。
- **node:timers/promises**：`setTimeout(delay, value, { signal })` 在 `signal` abort
  時 reject（`AbortError`）；worker 既有程式已使用此模式（`src/commands/worker.ts`
  第 17、906、925 行）。

> node-redis 連線/重連行為已於本設計階段讀 `@redis/client@1.5.14` 原始碼確認（見上
> 條，含行號）。計畫階段仍須依專案規範以 research subagent 確認 `eval` 簽名／回傳型
> 別、`SET ... NX` 回傳值、`setTimeout` abort 行為與 masterchat 行為與專案實際版本一
> 致後，才將具體呼叫寫入實作計畫。
