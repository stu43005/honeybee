# YouTube PubSubHubbub 訂閱續訂重寫

把 `crawler youtube pubsub subscribe` 從「每 12 小時全量重訂、途中會把整個
crawler process 殺掉」改成「每 10 分鐘續訂少量即將到期的頻道」，並讓 honeybee
自己接手 PubSubHubbub 的訂閱請求與通知接收，移除 `youtube-notification` 與
`@fastify/express`。

## 問題

`agendaJobs` 裡這份文件長期停在「執行中但永遠不結束」：

```
name:           crawler youtube pubsub subscribe
repeatInterval: 12 hours
lastRunAt:      2026-09-16T04:35:24.950Z
lastFinishedAt: 2026-09-14T16:35:24.437Z
lockedAt:       2026-09-16T14:55:51.848Z   (持續刷新，但沒有任何一輪在跑)
failReason:     null
```

### 根因

1. 現有 job 逐一走訪 subscribed 頻道，每個呼叫 `ytNotifier.subscribe(id)` 後
   `await setTimeout(250)`（每秒 4 次請求）。
2. `youtube-notification@1.1.0` 的 `_makeRequest` 直接 `post(...)`，**沒有
   `.catch`、也不回傳 promise**，而 `subscribe()` 的回傳型別是 `void`。呼叫端
   在語言層面無法攔截這個請求的失敗。
3. Google 的 hub 會限流。實際回應是 `503` +
   `retry-after: 120`，body `Transient error; please try again later`。
4. 該 rejection 因此成為 unhandled rejection，而 `src/index.ts` 的
   `process.on("unhandledRejection")` 會 `process.exit(1)` —— **整個 crawler
   process 在 job 中途被殺掉**。

正式環境 log 的三輪對照（同一個 pod 名稱是因為 k8s 重啟容器、pod 名不變）：

| job 開始       | 送出 `Subscribing` 筆數 | 結束方式                                        |
| -------------- | ----------------------- | ----------------------------------------------- |
| 09-14 16:34:36 | 182（全部）             | `successed at 16:35:24`                         |
| 09-15 04:34:36 | 78                      | 04:34:57 unhandledRejection 503 → 04:35:01 重啟 |
| 09-15 16:34:58 | 79                      | 16:35:19 unhandledRejection 503 → 16:35:23 重啟 |
| 09-16 04:35:24 | 79                      | 04:35:45 unhandledRejection 503 → 重啟          |

最後一筆 `Subscribing` 與 rejection 相隔 0.14 秒；唯一跑完的那輪完全沒有
rejection。

### 為什麼 DB 欄位長成那樣

- `lastRunAt` 在開始執行時就寫入、`nextRunAt` 同時被推進 12 小時；process 被
  殺掉後 `lastFinishedAt` 永遠沒機會寫回，所以停在最後一次真正成功的時間。
  這也不是 job 失敗，所以 `failReason` 是 null。
- `lockedAt` 持續刷新但沒有任何一輪在跑：`getNextJobToRun` 的第二個 `$or`
  分支是 `{ lockedAt: { $lte: lockDeadline } }`，**不檢查 `nextRunAt`**，所以
  崩潰留下的過期鎖會被重新鎖起來（`lockedAt` 刷新為當下）；接著 JobProcessor
  發現 `nextRunAt` 還很遠，就把它從本地 lockedJobs 移除（「freeing it up」）
  但**不清掉 DB 的 `lockedAt`**。於是每過一個 lockLifetime 就再被鎖一次。

### 影響

- 每天兩次、每次都在第 78–79 個頻道崩潰 → 排在後面約 100 個頻道自 09-15 起
  未再續訂。lease 是 432000 秒（5 天），這批頻道的推播即將／已經失效，新影片
  只能靠 Holodex 輪詢補到。
- 每次崩潰都是一次 crawler 容器重啟，同一個 process 裡的其他 agenda job
  （holodex / youtube update 等）一併中斷。
- 12 小時的排程間隔讓每次崩潰都造成 12 小時的續訂空窗。

## 目標

1. 訂閱請求的失敗必須能被呼叫端攔截並分類，不得再產生 unhandled rejection。
2. 單次崩潰或限流的損失上限是少量頻道，且下一輪在十分鐘內自動接上，不再有
   12 小時空窗。
3. 續訂由「到期時間」驅動，而不是固定週期的全量重掃；哪些頻道真的訂閱成功、
   何時到期，必須是可查的持久狀態。
4. 移除 `youtube-notification` 與 `@fastify/express`，通知路徑（challenge
   驗證、HMAC 驗證、Atom 解析）由本 repo 自己實作並可單獨測試。

## Non-goals / Accepted limitations

- **不實作主動 unsubscribe**。頻道移出 subscribed 條件後就不再續訂，讓 lease
  在 5 天內自然過期。
- **`at:deleted-entry` 沿用現況忽略**，不做影片刪除的業務處理。
- **不改 `unhandledRejection → process.exit(1)` 的政策**。本設計移除的是它在
  pubsub 路徑上的觸發源；是否放寬該政策是獨立議題。
- **不加 pubsub 的 metrics 或告警。**
- **不做與 hub 的訂閱對帳機制**。到期驅動本身就是對帳：hub 端若把訂閱清掉而我們
  仍記著 `pubsubExpiresAt`，最壞情況是到期前收不到該頻道的推播，到期後自動重訂。
- **不為「challenge 回應送出後在網路上遺失」做額外的暫定狀態機。**
  - 概念：先回 challenge 再寫 DB 之後，仍有一個極窄的窗口——回應已經離開我們的
    process，但 hub 沒收到（連線在那一刻斷掉），於是我們記著 `pubsubExpiresAt`
    而 hub 沒建立訂閱。規範沒有規定 hub 會重試 verification，所以該頻道要等到續訂
    窗口才會重來。
  - 決策：不實作 provisional 狀態 + 獨立的復原重試。
  - 理由：這需要在極罕見的例外上加一整套狀態機與額外的重試排程，與這個服務的
    規模不相稱；反轉寫入順序已經把嚴重的方向（4 天靜默）換成無害的方向
    （多重訂一次）。殘留風險是單一頻道在單次極罕見的連線中斷下，最長一個 lease
    週期收不到推播，Holodex 輪詢仍會補到該頻道的影片。
- **不主動請求特定的 `hub.lease_seconds`。** 規範允許訂閱請求表達期望值，但 hub
  可以忽略；到期驅動已經會依 hub 實際給的值調整節奏，所以不送這個參數。
- **過渡期的重複通知不做抑制。** 舊 callback 的訂閱過期前，新舊訂閱並存會讓同一
  部影片收到兩份通知；`noticeFromNotification` 冪等，代價只是多一次 DB 寫入，
  最長 5 天後自然消失。
- **不為設定變更建立訂閱狀態的自動失效機制。**
  - 概念：訂閱的唯一鍵是 `(topic, callback URL)`，而 callback token 由
    `YOUTUBE_PUBSUB_SECRET` 衍生。若之後輪換該 secret 或更改 `PUBLIC_BASE_URL`，
    hub 端既有訂閱的通知會驗不過簽章（被回 200 忽略），而 `pubsubExpiresAt` 看起來
    仍然有效，於是該頻道要等到續訂窗口才會重訂——以 5 天 lease 計最長約 4 天。
  - 決策：不新增 config fingerprint 欄位，也不做「輪換期間保留舊 secret 並行驗證」
    的雙 secret 機制。
  - 理由：這是為了一個幾乎不發生的運維動作，增加永久的狀態欄位與驗證分支，與這個
    服務的規模不相稱。改以運維程序處理（見「部署行為」），代價是一條 mongo 更新，
    效果與自動失效相同。
- **單輪執行時間的上界不涵蓋 MongoDB 操作。**
  - 概念：候選查詢與 `pubsubRequestedAt` 寫入都會 await MongoDB，而
    `MongodbModule` 是裸的 `mongoose.connect(MONGO_URI)`，沒有設定 operation
    timeout。一個卡住的 DB 操作可以讓本輪超過 agenda 的 lockLifetime。
  - 決策：不為這兩個操作加 `maxTimeMS`，也不設批次 deadline。
  - 理由：Mongo 卡住時 agenda 自己也靠 Mongo 鎖 job、寫 `lastRunAt`，整個 crawler
    會一起停擺，替單一 job 加逾時不會改變系統行為；而 crawler 是
    `replicas: 1`，沒有「另一個 worker 搶走過期鎖、原批次稍後復活」的並發情境。
    真要處理 DB 逾時，那是 `MongodbModule` 層級的獨立議題。

## 已驗證的第三方行為

以下都是讀實際安裝的原始碼／官方文件確認過的，不是推測。

**agenda 6.2.4 + @agendajs/mongo-backend 4.0.1**

- `agenda.every(interval, name)` → `job.repeatEvery()`：**就地更新
  `repeatInterval` 並立即重算 `nextRunAt`**；`job.save()` 走 `toJson(true)`，
  排除 processor 管理的欄位，所以**不觸碰 `lockedAt` / `lastRunAt` /
  `lastFinishedAt`**。
- `getNextJobToRun` 的過期鎖分支忽略 `nextRunAt`；`defaultLockLifetime` 是
  10 分鐘、`processEvery` 是 5 秒。所以停留超過 10 分鐘的過期鎖會被重新撿起並
  實際執行。
- `agenda.start()` **不會**清除崩潰留下的鎖；只有 `stop()` / `drain()` 會呼叫
  `unlockJobs()`。
- `job.touch()` 是唯一會在執行期間刷新 `lockedAt` 的機制；若 job 已被 cancel
  則會丟錯。
- process 中途死亡時 `lastFinishedAt` 不會被寫入，沒有崩潰復原的收尾邏輯。

**fastify 4.26.2**

- `addContentTypeParser(contentType, { parseAs: 'string' | 'buffer' }, parser)`
  的 contentType 接受字串、字串陣列或 RegExp。
- `request.rawBody` **不是內建的**；`parseAs: 'string'` 時 parser 收到的第二個
  參數就是原始字串，parser 的回傳值成為 `request.body`。
- content type parser 可以用 `register()` 封裝成只作用於該 scope 的 route。
- 沒有對應 parser 的 content type 會得到 415。

**fast-xml-parser（XML 解析）**

- 原生 ESM、內建 TypeScript 型別，不需要 `@types/*`；`parse()` 同步。
- 不像 xml2js 的 `explicitArray: true` 會把單一元素包成陣列；只有真正重複的
  元素才變陣列，所以取值前需要判斷。
- 不像 xml2js 的 `normalizeTags: true` 會把 tag 名轉小寫：`yt:videoId` 保持原
  大小寫。`removeNSPrefix: true` 可去掉 `yt:` / `at:` 前綴；
  `ignoreAttributes: false` 才能讀到 `link` 的 `href`。
- 目前 repo 沒有任何 XML parser 直接依賴，`xml2js@0.4.23` 只存在於
  `youtube-notification` 的依賴樹中。

**googleapis 173.0.0 / gaxios 7.1.5（YouTube API 逾時）**

- **gaxios 沒有預設逾時**：`common.d.ts` 的 `timeout?: number` 註解就是
  「A timeout for the request, in milliseconds. No timeout by default.」，而
  `#appendTimeoutToSignal` 只在 `opts.timeout` 有值時才建立
  `AbortSignal.timeout(...)`。所以現行的 `youtube.videos.list(...)` 可以無限掛住。
- 逾時可以在建立 client 時一次設定：`google.youtube({ version, auth, timeout })`
  （`MethodOptions extends GaxiosOptions`，單次呼叫也能各自帶 `timeout`）。逾時是
  以原生 `AbortSignal` 強制執行的。
- **retry 預設是關閉的**（要明確給 `retry: true` 或 `retryConfig` 才會重試），所以
  設定逾時不會變成「逾時 × 重試次數」。
- 本專案用 API key 認證（`auth: GOOGLE_API_KEY`），不走 OAuth token 交換，所以
  google-auth-library 那條同樣沒有逾時的 token 取得路徑在這裡不會發生。

**PubSubHubbub / WebSub（W3C Recommendation + Google hub）**

- hub 端點 `https://pubsubhubbub.appspot.com/subscribe`，topic 是
  `https://www.youtube.com/xml/feeds/videos.xml?channel_id=<id>`。
- 訂閱是兩段式：我們 POST 表單（`hub.callback` / `hub.mode` / `hub.topic` /
  `hub.secret`），hub 回 202 只表示「收到請求」；hub 之後 GET 我們的 callback
  做 verification。`hub.lease_seconds` 在 subscribe 的 verification 上是
  **REQUIRED**，所以正常情況必定帶。
- **verification 的成功條件是「2xx **且** 回應 body 完全等於
  `hub.challenge`」**。body 不符即使回 2xx，hub 也必須視為驗證失敗。
- **verification 失敗後 hub 會不會重試，規範沒有規定**（重試只對內容投遞有
  規範）。因此不能假設驗證失敗會被自動重試。
- **verification 的 GET 完全沒有認證**：`X-Hub-Signature` 只出現在內容投遞的
  POST 上。`hub.secret` 的唯一用途就是讓 hub 對投遞的 body 算 HMAC。
- `hub.verify_token` 不在現行規範中（舊 0.3 草案的東西，現已不存在）。
- lease 沒有規範上的最小／最大值，但規範的安全章節建議
  「Hubs SHOULD enforce short lived hub.lease_seconds (10 days is a good
  default)」。Google hub 實際給的值沒有文件化，正式環境實測是 432000 秒
  （5 天）。訂閱請求可以帶 `hub.lease_seconds` 表達期望值，但 hub 可以忽略。
- **訂閱的唯一鍵是 `(topic URL, callback URL)` 的 tuple**。同一個 topic 用兩個
  不同的 callback URL 訂閱＝兩個獨立訂閱，hub 會**對兩邊都投遞**。
- callback URL **可以**包含路徑片段與 query 參數；hub 必須在 verification 時
  保留原有 query（以 `&` 附加自己的參數）。
- 內容投遞收到非 2xx 時，hub SHOULD 在自訂上限內重試，但
  **不會因此退訂**——「The hub MUST keep the subscription active until the end
  of the lease duration」。所以忽略一筆無效通知的正確做法是回 2xx，理由是避免
  hub 反覆重試同一筆，而不是避免被退訂。

## 架構

### 檔案佈局

```
src/modules/youtube-pubsub/hub-client.ts     訂閱請求 + 錯誤分類
src/modules/youtube-pubsub/atom.ts           Atom 通知解析
src/modules/youtube-pubsub/routes.ts         fastify plugin：challenge / HMAC / 通知
src/modules/youtube-pubsub/renewal.ts        到期驅動的批次續訂（agenda job 實作）
src/modules/youtube-pubsub/youtube-pubsub.ts Application module：route 註冊 + job
```

整個子系統收在一個目錄裡，對外只露出一個 `Application` module。`crawler.ts` 因此
只剩 `app.use(new YoutubePubsubModule(app))` 一行，完全不知道 pubsub 的細節——這也
是續訂不放 `src/components/` 的原因：那裡放的是由別的服務驅動的領域任務（幾乎都是
`manager` 的），而這一輪續訂是由這個 module 自己的 agenda job 驅動、組合的也是隔壁
那幾個檔案。

各檔都有自己的 `*.spec.ts`。`hub-client.ts` 與 `atom.ts` 是純函式，最容易測；
`routes.ts` 用 `fastify.inject()` 測；批次續訂的候選選取與限流中止在
`renewal.spec.ts` 測；module 本身用一個記錄行為的假 `Application` 測。

callback URL 與它的 token 由 `hub-client.ts` 一併匯出（它是「我們交給 hub 的
位址」的擁有者），`routes.ts` 從那裡 import 同一個 token 來驗證，避免兩邊各自
拼出可能不一致的字串，也不必為一個衍生函式多開一個檔案。

**route 註冊必須在 module 的 constructor，不能在 `init()`。**
`Application.init()` 依註冊順序逐一 init，而 `HttpServerModule` 是
`Application` 建構時第一個註冊的，所以它的 `fastify.listen()` 會在其他 module 的
`init()` 之前跑完；fastify 在 listen 之後拒絕再加 route（`lib/route.js` 的
`throwIfAlreadyStarted('Cannot add route!')` → 丟
`FST_ERR_INSTANCE_ALREADY_LISTENING`），content type parser 也有同樣的檢查。
`OAuthModule` 正是用同一個做法解決的，並在註解裡寫明了原因。

現行程式把 `fastify.use(ytNotifier.listener())` 放在 `app.init()` **之後**仍能運作，
是因為那是 express middleware 走 `@fastify/express` 的動態掛載、不經 fastify 的
route 註冊路徑——改用原生 route 後這個位置就不再成立。

**`register()` 不需要 await**（constructor 本來也不能 await）：它只是把 plugin 排進
佇列，實際載入發生在 `listen()`。這一點連同上面那條限制都以實際執行驗證過：未 await
的 `register()` 在 listen 後其 route 正常回應，而 listen 之後再加 route 會丟
`FST_ERR_INSTANCE_ALREADY_LISTENING`。這個錯誤是啟動即失敗、不會靜默，所以不為它
另外建立一套真實啟動的整合測試。

`agenda.define` / `every` 不受這個限制，放在 module 的 `init()`（此時
`AgendaModule` 已經 init 完畢，因為它註冊在前面）。

`routes.ts` 直接 import `ChannelModel` / `VideoModel`，不為了可測而抽介面或改成
依賴注入；測試以 `jest.unstable_mockModule` 攔截模組。

### 資料模型

`Channel` 新增兩個欄位：

- `pubsubRequestedAt?: Date` —— 我們上次向 hub 送出訂閱請求的時間。
- `pubsubExpiresAt?: Date` —— verification 帶回的 `lease_seconds` 換算出的訂閱
  到期時間。

新增 static query：

```
findPubsubRenewalCandidates(limit, now)
  = SubscribedQuery
  AND (pubsubExpiresAt 不存在 OR pubsubExpiresAt < now + PUBSUB_RENEW_BEFORE_MS)
  AND (pubsubRequestedAt 不存在 OR pubsubRequestedAt < now - PUBSUB_REQUEST_COOLDOWN_MS)
  sort  { pubsubRequestedAt: 1 }
  limit limit
```

排序讓缺值（從未請求過）排最前，其餘最久沒請求的優先。搭配
`@index({ pubsubExpiresAt: 1, pubsubRequestedAt: 1 })`。

### 訂閱路徑

`modules/youtube-pubsub/renewal.ts` 對每個候選依序：

1. 先寫 `pubsubRequestedAt = now`。
2. 呼叫 `hub-client` 送出訂閱請求，帶 `PUBSUB_REQUEST_TIMEOUT_MS` 的逾時。
3. 回應是 429 或 503 → 立刻結束本輪（job 以成功結束），其餘候選留給下一輪。
4. 其他非 2xx、逾時、或連線層錯誤 → log warn 後繼續下一個。
5. 成功 → 間隔 `PUBSUB_REQUEST_SPACING_MS` 後處理下一個。

四個刻意的設計點：

- **`pubsubRequestedAt` 先寫再送請求。** hub 有時會在回 202 之前就先打
  verification GET，先寫才不會讓合法的 verification 被時間窗擋掉。
- **不論成功或失敗都寫 `pubsubRequestedAt`。** 一個永遠失敗的頻道（例如頻道已
  被刪除）因此會被排到隊尾，不會固定霸佔隊首、擠掉正常的續訂。
- **每個請求都必須有逾時。** axios 的預設是 `timeout: 0`，也就是無限等待——一個
  永遠不回應的連線會讓整輪卡住而且永遠進不了 catch，那正是本次要修掉的 bug 的
  同一種形狀。
- **不需要 `job.touch()`。** 單輪在 hub 請求這一側的最壞情況是
  `PUBSUB_RENEW_BATCH_SIZE × (PUBSUB_REQUEST_TIMEOUT_MS + PUBSUB_REQUEST_SPACING_MS)`
  ＝ 5 ×（10 秒 + 250 毫秒）≈ 51 秒，遠短於 agenda 的 10 分鐘 lockLifetime。
  這個上界**只涵蓋 hub 請求**，不涵蓋候選查詢與 `pubsubRequestedAt` 寫入所等待的
  MongoDB 操作（本專案沒有設定 operation timeout）；為什麼不另外處理，見
  Non-goals。

同一個頻道的實際重試間隔是**至少 20 分鐘**，不是 10 分鐘：冷卻 15 分鐘大於排程
間隔 10 分鐘，所以最快要等到第二次排程才會再被選中，前面還有其他候選時會更久。
這是刻意的——冷卻的目的就是讓候選輪替，而不是讓同一個頻道連續重試。

`hub-client.ts` 匯出的結果是 discriminated union：`ok` / `rateLimited`
（429、503）/ `failed`（其餘非 2xx、逾時、連線錯誤）。所有失敗都在函式內被
catch，不會外洩成 unhandled rejection。逾時與 HTTP 錯誤在回傳值上必須可區分，
否則測試無法驗證逾時路徑。

### 通知路徑

`modules/youtube-pubsub/routes.ts` 是一個 fastify plugin，用 `register()` 封裝，
讓 content type parser 只作用於這組 route：parser 對
`application/atom+xml` 與 `text/xml` 以 `{ parseAs: 'string' }` 註冊，**直接把
原始字串當成 `request.body`** —— HMAC 要簽的就是 body 本身，因此不需要在
request 上掛 `rawBody`。

module 的 constructor 同時呼叫 `HttpServerModule.addNoLogRoute("/notifications/youtube")`：
通知量大，每筆都印一行 `request completed` 會淹掉其他 log。比對是 startsWith，所以
帶 token 的路徑也涵蓋在內。

#### callback URL 與三條 route

verification 的 GET 沒有任何來自 hub 的憑證可驗，所以認證只能靠**我們自己放在
callback URL 裡、而 hub 必定原樣帶回**的東西。callback 因此改成：

```
<PUBLIC_BASE_URL>/notifications/youtube/<token>
token = HMAC(YOUTUBE_PUBSUB_SECRET, "pubsub-callback") 的 hex 前 32 字元
```

token 由既有的 `YOUTUBE_PUBSUB_SECRET` 衍生，**不新增環境變數**。沒有 secret 時
不啟用 pubsub（既有行為已經是「沒有 `PUBLIC_BASE_URL` 就不啟用」）。

因為訂閱的唯一鍵是 `(topic, callback URL)`，改 callback URL 會讓 hub 端既有的
訂閱與新訂閱並存，所以註冊三條 route：

| Route                                | 驗證                           | 用途                   |
| ------------------------------------ | ------------------------------ | ---------------------- |
| `GET /notifications/youtube/:token`  | 驗 token（`timingSafeEqual`）  | 新訂閱的 verification  |
| `POST /notifications/youtube/:token` | 只驗 HMAC 簽章，**不驗 token** | 新訂閱的通知           |
| `POST /notifications/youtube`        | 只驗 HMAC 簽章                 | 既有訂閱的通知，過渡用 |

POST 不驗 token 是刻意的：投遞的 body 已經有 `X-Hub-Signature` 可驗，再驗一次
token 是多餘的；而保留無 token 的舊 POST 路徑，是為了讓上線瞬間既有訂閱的通知
不中斷。沒有無 token 的 GET route（既有訂閱不會再收到 verification）。

**POST**（兩條共用同一個 handler）：

1. 有設 secret 但缺 `x-hub-signature` → 403 + log warn（非 hub 的隨機掃描）。
2. 從 header 取演算法（`sha1=` / `sha256=`），以 secret 對 body 計算 HMAC，用
   `timingSafeEqual` 比對。
3. 簽章不符 → **回 200** + log warn。非 2xx 會讓 hub 在自訂上限內反覆重試同一筆
   通知（不會導致退訂），所以安全的忽略方式是回 200。
4. 解析不出 feed 結構 → 回 200 + log warn。
5. **第一階段——逐一寫入解析出來的每一個 entry**（見下方「為什麼是集合」）：
   - 刪除類 entry → 略過（沿用現況忽略）。
   - 影片類 entry → `noticeFromNotification`；把 `upsertedCount > 0`（新影片）的
     id 記下來，`modifiedCount > 0` 只記 log。這一階段**只碰資料庫**。
6. 任何一筆 `noticeFromNotification` 拋錯 → **回 500** + log error，讓 hub 重試
   投遞（不進第二階段）。這是對現有行為的修正：現況是 catch 後回 200，而回 200
   等於告訴 hub 投遞成功、放棄重試。`[crawler youtube update]` 的候選查詢全都要求
   資料庫裡已經有該影片的文件，Holodex 的 live／past 輪詢也補不到普通上傳，所以
   一次寫入失敗可以讓一部影片**永久**不被發現。非 2xx 會讓 hub 在自訂上限內重試，
   而且已確認不會導致退訂，所以回 500 是這裡唯一有持久重試能力的選項。重送整筆是
   安全的：`noticeFromNotification` 是 upsert，已經寫成功的 entry 重放一次不會有
   副作用。
7. 全部寫入成功 → **回 200**。
8. **第二階段——回應之後**，對第一階段記下的新影片 id 呼叫
   `updateVideoFromYoutube` 補 metadata，整段包在 try/catch 裡，失敗只 log warn。

**為什麼 enrichment 一定要在回應之後、而且一定要 catch。**

- 放在回應之後：`updateVideoFromYoutube` 會 await YouTube Data API。就算加上逾時
  （見下方「YouTube API 逾時」），一次慢回應仍然會把同一筆通知裡後面的 entry 擋在
  資料庫外面——而那些影片沒有任何其他機制會補回來，正是第 6 點要避免的那種永久
  遺失。逾時管的是「不會無限掛住」，順序管的是「不阻塞寫入與回應」，兩者互補。
- 一定要 catch：回應之後的工作若拋出未處理的 rejection，會觸發
  `process.on("unhandledRejection") → process.exit(1)`，那就是本案的根因。
- 失敗或卡住的後果很輕：影片文件已經寫好了、`crawledAt` 是 null，每分鐘一次的
  `[crawler youtube update]` 正是以此為候選條件，最多晚一分鐘補上 metadata。

**為什麼解析結果是集合而不是單一影片。** YouTube 實務上每筆推播只帶一個
`entry`（`youtube-notification` 也是直接取 `feed.entry[0]`），但 WebSub 允許 hub
投遞整份 topic 內容而不只是差異，而 `videos.xml` 這個 topic feed 本身含有該頻道
最近多部影片。一旦真的收到多 entry 的 body，「只處理第一筆再回 200」就是靜默丟棄
其餘影片，而且沒有任何其他機制會補回普通上傳。改成集合的成本幾乎是零：
fast-xml-parser 在多 entry 時給陣列、單一時給物件，所以無論如何都得寫這個判斷。

**GET `/notifications/youtube/:token`**（hub verification）：

1. token 不符 → 404，不做其他事。
2. 依 `hub.mode` 分流：
   - `subscribe`：從 `hub.topic` 取出 channel id，查該頻道的 `pubsubRequestedAt`
     是否落在 `PUBSUB_REQUEST_COOLDOWN_MS` 窗口內。
     - 否 → 404 + log warn，狀態不變。
     - 是 → **先**以 `text/plain` 回 `hub.challenge`，**再**寫
       `pubsubExpiresAt`。
   - `unsubscribe`：本設計沒有主動退訂流程，一律 404。
   - `denied`：log warn、回 200，不改狀態（`pubsubRequestedAt` 已更新，天然
     退避）。

**先回 challenge 再寫 DB 的順序是刻意的。** 兩種順序的失效方向相反：

- 先寫 DB 再回應：若回應沒送達 hub，我們記著 `pubsubExpiresAt` 但 hub 其實沒
  建立訂閱，而規範沒有規定 hub 會重試 verification，於是該頻道要等到
  `pubsubExpiresAt - PUBSUB_RENEW_BEFORE_MS` 才會重訂——以 5 天 lease 計，最長約
  4 天收不到推播。
- 先回應再寫 DB：DB 有寫入幾乎必然表示回應已經送出。殘留只剩「回應送出後在網路
  上遺失」，見 Non-goals。

`lease_seconds` 必須驗證後才採用：非正整數或缺失 → 用 `PUBSUB_DEFAULT_LEASE_MS`；
超過 `PUBSUB_MAX_LEASE_MS` → clamp 到上界。這是深度防禦（token 一旦洩漏，或 hub
回了異常值，都不能讓單一頻道被推到永遠不續訂）。

窗口採 15 分鐘的依據：正式環境 log 中 `Subscribing:` 到 `Subscribed:` 是數秒內
（例如 14:01:35 與 14:01:37），15 分鐘約有 60 倍餘裕；真的遲到被擋掉也只是下一輪
重訂，會自我修復。

`atom.ts` 以 `removeNSPrefix: true` + `ignoreAttributes: false` 解析，回傳**一個
entry 陣列**（每個 entry 是 `video` 或 `deleted` 的 discriminated union），或在
body 根本不是 feed 時回 null。單一 entry 是長度 1 的陣列，呼叫端不需要分兩種寫法。
實際欄位名與陣列包裝行為由測試鎖住。

順手丟掉套件的記憶體去重（`_recieved` 陣列）：`noticeFromNotification` 是
upsert、本來就冪等，而且從 log 看重複通知極多、那段去重幾乎沒生效。

### YouTube API 逾時

`getYoutubeApi()` 建立 client 的地方加上 `timeout: YOUTUBE_API_TIMEOUT_MS`。這是
整個 repo 唯一建立 youtube client 的位置，所以一處設定就涵蓋所有 YouTube API
呼叫——包含每分鐘一次的 `[crawler youtube update]`（它同樣沒有 `job.touch()`，被
無限掛住的請求擋住的話會以同樣的形狀卡死）。

這一項嚴格說超出「修訂閱」的範圍，但它與本設計要修的 bug 是同一個形狀（沒有界限
的 await 讓工作永遠不結束），而且已確認 gaxios 不會自己給任何逾時、retry 也預設
關閉，所以成本是一行加一個常數。

## 新增常數

都放 `src/constants.ts`，依 `_MS` 慣例，每個帶一行說明選值理由的註解。

| 常數                         | 值      | 理由                                                                                                                                               |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBSUB_RENEW_BEFORE_MS`     | 24 小時 | 提前一天續訂，容得下一整天的排程中斷仍不掉訂閱                                                                                                     |
| `PUBSUB_REQUEST_COOLDOWN_MS` | 15 分鐘 | 同一頻道的最短重試間隔，同時是 verification 的接受窗口；刻意大於 10 分鐘的排程間隔，確保候選輪替                                                   |
| `PUBSUB_RENEW_BATCH_SIZE`    | 5       | 單輪上限，也就是一次崩潰或限流的損失上限                                                                                                           |
| `PUBSUB_REQUEST_SPACING_MS`  | 250     | 單輪內請求之間的間隔                                                                                                                               |
| `PUBSUB_DEFAULT_LEASE_MS`    | 24 小時 | hub 未提供或提供了不合法的 `lease_seconds` 時的保守預設，確保仍會續訂而不是永不續訂                                                                |
| `PUBSUB_MAX_LEASE_MS`        | 10 天   | `lease_seconds` 的上界；取自規範安全章節建議的「10 days is a good default」，超過就 clamp                                                          |
| `PUBSUB_REQUEST_TIMEOUT_MS`  | 10 秒   | 單次 hub 請求的逾時；axios 預設是無限等待，必須明確設定                                                                                            |
| `YOUTUBE_API_TIMEOUT_MS`     | 15 秒   | 所有 YouTube Data API 呼叫的逾時；gaxios 沒有預設值。取比 hub 請求寬鬆的值，因為單次呼叫最多帶 50 個 id，但仍遠短於 agenda 的 10 分鐘 lockLifetime |

hub 端點與 topic 前綴是固定值，放 `hub-client.ts` 內部常數，不走環境變數。
callback token 由 `YOUTUBE_PUBSUB_SECRET` 衍生，也不是新的環境變數。

穩態驗算：182 個 subscribed 頻道 ÷ 5 天 lease ≈ 每天需續 36 個；每 10 分鐘 5 個
＝ 每天 720 個容量。首次鋪滿 182 個約 6 小時。

## 失效模式

| 狀況                                           | 行為                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| hub 429／503                                   | 本輪中止、job 正常成功；最多 `PUBSUB_RENEW_BATCH_SIZE` 個頻道延後到之後的某一輪（同頻道受 15 分鐘冷卻限制，實際至少 20 分鐘） |
| hub 400 或其他非 2xx                           | log warn、該頻道 `pubsubRequestedAt` 已更新（排到隊尾）、繼續下一個                                                           |
| hub 連線掛住不回應                             | `PUBSUB_REQUEST_TIMEOUT_MS` 逾時後歸類為一般失敗，繼續下一個；單輪總時長有上界                                                |
| 請求送出但 verification 從未到達               | `pubsubExpiresAt` 不變 → 冷卻後回到候選；因最舊優先排序，不會霸佔隊首                                                         |
| verification 遲到超過窗口                      | 404 拒絕、狀態不變 → 下一輪重訂                                                                                               |
| 偽造的 verification（無 token）                | token 不符 → 404，不查 DB、不改狀態                                                                                           |
| verification 帶異常 `lease_seconds`            | 非正整數或缺失 → 用預設值；超過 `PUBSUB_MAX_LEASE_MS` → clamp 到上界                                                          |
| HMAC 不符／缺簽章                              | 不符回 200 忽略（避免 hub 反覆重試同一筆）、缺簽章回 403，都 log warn                                                         |
| Atom 形狀非預期                                | 解析回 null → 回 200 + log warn，不 throw                                                                                     |
| 一筆通知含多個 entry                           | 全部逐一處理；任一影片寫入失敗就回 500，重送時已成功的 entry 因 upsert 冪等而安全                                             |
| 通知寫入影片文件失敗                           | log error + **回 500**，讓 hub 重試投遞（唯一有持久重試能力的路徑）                                                           |
| 寫入成功但 `updateVideoFromYoutube` 失敗或卡住 | 已回 200；catch 後 log warn（不 catch 會殺掉 process），文件已在，交給每分鐘的 `[crawler youtube update]`                     |
| challenge 回應後寫 DB 失敗                     | log warn；該頻道 15 分鐘後回到候選，重訂一次（hub 端冪等）                                                                    |
| process 崩潰                                   | 最多損失本輪的頻道；下一次排程 10 分鐘後就繼續處理候選（受影響的頻道本身仍受 15 分鐘冷卻限制）                                |

## 測試策略

每個 `it` 都要有結構斷言（`toEqual` 或順序斷言，不只 `toHaveBeenCalled`）、明確
的 drain point、以及 stateful fake 而非裸 `jest.fn()`。

- **`atom.spec.ts`** —— 真實 Atom 樣本：單一新影片、**多個 entry**、
  **影片與 `at:deleted-entry` 混合的 feed**、缺欄位、非預期根元素，對整個解析結果
  （entry 陣列）做 `toEqual`，包含 entry 的順序。
- **`hub-client.spec.ts`** —— mock axios：202 → 成功；429、503 → 限流；400 →
  非限流失敗；逾時與連線錯誤 → 可與 HTTP 失敗區分的失敗。並斷言送出的表單內容
  （`hub.callback` 帶 token / `hub.mode` / `hub.topic` / `hub.secret`）完整正確，
  以及請求確實帶上了 `PUBSUB_REQUEST_TIMEOUT_MS`。
- **`renewal.spec.ts`** —— stateful fake Channel，記錄寫入序列：批量
  上限、`pubsubRequestedAt` 寫在請求之前的順序、第三個候選回 429 時只送出三次
  請求且第四／第五個沒有被寫入、候選查詢條件。另外要有一個「請求永遠不 resolve」
  的案例：以 fake timer 推進到逾時，斷言該候選被歸類為失敗**且後續候選仍然被
  處理**，整輪在上界內結束。
- **`routes.spec.ts`** —— `fastify.inject()` 實際發請求：token 正確／錯誤兩態
  （錯誤時不得碰 DB）、HMAC 正確／錯誤／缺失三態、challenge 回應與窗口過期的
  404、`lease_seconds` 缺失／非數字／超過上界三種取值、`deleted-entry`、無 token
  的舊 POST 路徑仍可接收通知、以及通知確實以正確參數觸發
  `noticeFromNotification`。其中 challenge 案例要斷言**回應 body 完全等於
  `hub.challenge`**（body 不符會讓 hub 判定驗證失敗）。另外要有這幾個對照案例：
  `noticeFromNotification` 拋錯時回 **500**，而 `updateVideoFromYoutube` 拋錯時仍
  回 **200**；含兩個 entry 的通知會寫入兩部影片（斷言兩次呼叫的參數）；**第二個
  entry 寫入失敗 → 回 500，重送同一筆 body 後兩部影片都在**（用 stateful fake
  記錄寫入，驗證重放補齊而不是重複建立）；以及**`updateVideoFromYoutube` 永遠不
  resolve 時，兩個 entry 仍然都已寫入資料庫且回應已經送出**（證明 enrichment 不在
  寫入與回應的路徑上）。
- **`src/modules/youtube.spec.ts`**（既有檔案）—— 斷言 `getYoutubeApi()` 建立
  client 時帶了 `timeout: YOUTUBE_API_TIMEOUT_MS`。這是唯一建立 client 的位置，
  漏掉就等於所有 YouTube 呼叫都沒有逾時。

## 部署行為

1. **job 名稱不變**。改名會讓舊文件永遠 locked 殘留在 `agendaJobs`（沒有任何
   程式碼會清它）。
2. `every("10 minutes", ...)` 就地更新 `repeatInterval` 並重算 `nextRunAt`，不碰
   `lockedAt`；目前卡住的 `lockedAt` 在 10 分鐘後被視為過期而重新鎖並實際執行
   ——**不需要手動改 DB**。`lastFinishedAt` 在第一次成功後自我修復。
3. **callback URL 會改變**（加上 token 路徑片段），但**舊的無 token POST route
   保留**，所以 hub 端既有訂閱的通知在上線瞬間不中斷，6 小時的鋪滿期間不會漏
   通知。
4. 既有頻道都沒有這兩個新欄位，全部符合候選條件，因此上線後會按節奏逐批以新的
   callback URL 重訂。
5. **過渡期會有重複通知**：訂閱的唯一鍵是 `(topic, callback URL)`，所以同一個
   頻道在舊 callback 的訂閱過期前，新舊兩個訂閱並存、hub 對兩邊都投遞。
   `noticeFromNotification` 是 upsert、冪等，所以後果只是多一次 DB 寫入。舊訂閱
   最長在 5 天後（既有 lease 上限）全部自然過期，屆時無 token 的 POST route 就
   可以移除。

### 日後變更 secret 或 base URL 時的運維程序

`YOUTUBE_PUBSUB_SECRET` 或 `PUBLIC_BASE_URL` 一旦變更，hub 端既有訂閱就會失效
（簽章驗不過、或 callback 位址不再指向我們），但資料庫裡的 `pubsubExpiresAt` 不會
自動知道這件事。變更時要一併清掉它，讓全部頻道回到候選。

**順序很重要，而且只有一種正確順序：**

1. 套用新設定並重新部署 crawler。
2. **等 rollout 結束、舊 pod 完全終止**（`kubectl rollout status deploy/crawler`）。
3. 才執行：

   ```
   db.channels.updateMany({}, { $unset: { pubsubExpiresAt: "" } })
   ```

先清再部署是錯的：舊設定的 process 還活著時，它送出的訂閱請求對應的
verification 可能在清除**之後**才回來，而那個 handler 只檢查
`pubsubRequestedAt` 的時間窗、不知道設定已經換了，於是會把描述舊 callback 的
`pubsubExpiresAt` 寫回去——該頻道就被排除在續訂之外約 4 天。等舊 pod 終止之後再
清，就沒有任何寫入者能污染清除後的狀態（crawler 是 `replicas: 1`，rollout 完成
後不存在舊設定的寫入者）。

清完之後不需要其他動作，續訂會按既有節奏在約 6 小時內重新鋪滿。這一步刻意留在
運維程序而不是程式邏輯，理由見 Non-goals。

## 移除清單

- `youtube-notification` 依賴與手寫的 `src/types/youtube-notification.d.ts`
- `@fastify/express` 依賴與 `crawler.ts` 裡的 `fastify.register(fastifyExpress)`
  （整個 repo 只為了掛這個 listener 而存在）
- `crawler.ts` 裡的 `YouTubeNotifier` 實例、四個事件監聽器、原本每 12 小時全量
  重掃的 job body，以及整個 `//#region youtube pubsub` 區塊——pubsub 的組裝全部
  移進 module，crawler 只留一行 `app.use(new YoutubePubsubModule(app))`

新增 `fast-xml-parser` 到 `dependencies`（crawler 在生產執行期會 import）。
