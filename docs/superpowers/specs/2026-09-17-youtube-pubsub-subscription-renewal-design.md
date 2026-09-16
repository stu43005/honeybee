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

**PubSubHubbub（Google hub）**

- hub 端點 `https://pubsubhubbub.appspot.com/subscribe`，topic 是
  `https://www.youtube.com/xml/feeds/videos.xml?channel_id=<id>`。
- 訂閱是兩段式：我們 POST 表單（`hub.callback` / `hub.mode` / `hub.topic` /
  `hub.secret`），hub 回 202 只表示「收到請求」；hub 之後 GET 我們的 callback
  做 verification，**只有那時候才帶 `hub.lease_seconds`**。
- hub 以 **callback URL 為訂閱的 key**：callback URL 的路徑或 query 一改，既有
  訂閱全部失效。本設計不改 callback URL。
- 通知投遞若收到非 2xx，hub 會重送，連續失敗會**自動退訂**。

## 架構

### 檔案佈局

```
src/modules/youtube-pubsub/hub-client.ts   訂閱請求 + 錯誤分類
src/modules/youtube-pubsub/atom.ts         Atom 通知解析
src/modules/youtube-pubsub/routes.ts       fastify plugin：challenge / HMAC / 通知
src/components/pubsub-subscribe.ts         到期驅動的批次續訂（agenda job 實作）
```

各檔都有自己的 `*.spec.ts`。`hub-client.ts` 與 `atom.ts` 是純函式，最容易測；
`routes.ts` 用 `fastify.inject()` 測；批次續訂的候選選取與限流中止在
`pubsub-subscribe.spec.ts` 測。

`crawler.ts` 只剩組裝：註冊 plugin、定義 job、`agenda.every("10 minutes", ...)`。

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

`components/pubsub-subscribe.ts` 對每個候選依序：

1. 先寫 `pubsubRequestedAt = now`。
2. 呼叫 `hub-client` 送出訂閱請求。
3. 回應是 429 或 503 → 立刻結束本輪（job 以成功結束），其餘候選留給下一輪。
4. 其他非 2xx → log warn 後繼續下一個。
5. 成功 → 間隔 `PUBSUB_REQUEST_SPACING_MS` 後處理下一個。

三個刻意的設計點：

- **`pubsubRequestedAt` 先寫再送請求。** hub 有時會在回 202 之前就先打
  verification GET，先寫才不會讓合法的 verification 被時間窗擋掉。
- **不論成功或失敗都寫 `pubsubRequestedAt`。** 一個永遠失敗的頻道（例如頻道已
  被刪除）因此會被排到隊尾，不會固定霸佔隊首、擠掉正常的續訂。
- **不需要 `job.touch()`。** 單輪只有 `PUBSUB_RENEW_BATCH_SIZE` 個請求、約
  1–2 秒，遠短於 agenda 的 10 分鐘 lockLifetime。

`hub-client.ts` 匯出的結果是 discriminated union，讓呼叫端能分辨「限流（中止
本輪）」與「其他失敗（記錄後繼續）」，並且所有 HTTP 失敗都在函式內被 catch，
不會外洩成 unhandled rejection。

### 通知路徑

`modules/youtube-pubsub/routes.ts` 是一個 fastify plugin，用 `register()` 封裝，
讓 content type parser 只作用於這組 route：parser 對
`application/atom+xml` 與 `text/xml` 以 `{ parseAs: 'string' }` 註冊，**直接把
原始字串當成 `request.body`** —— HMAC 要簽的就是 body 本身，因此不需要在
request 上掛 `rawBody`。

同時呼叫 `HttpServerModule.addNoLogRoute("/notifications/youtube")`：通知量大，
每筆都印一行 `request completed` 會淹掉其他 log。

**POST `/notifications/youtube`**

1. 有設 secret 但缺 `x-hub-signature` → 403 + log warn（非 hub 的隨機掃描）。
2. 從 header 取演算法（`sha1=` / `sha256=`），以 secret 對 body 計算 HMAC，用
   `timingSafeEqual` 比對。
3. 簽章不符 → **回 200** + log warn。非 2xx 會讓 hub 重送、連續失敗後自動退訂，
   所以安全的忽略方式是回 200。
4. 解析結果是 `deleted` 或 `unknown` → 回 200（`unknown` 另外 log warn）。
5. 是影片通知 → 沿用現有邏輯：`noticeFromNotification`，其中
   `upsertedCount > 0`（新影片）才呼叫 `updateVideoFromYoutube`；
   `modifiedCount > 0` 只記 log。整段 catch 住，一律回 200。

**GET `/notifications/youtube`**（hub verification），依 `hub.mode` 分流：

- `subscribe`：從 `hub.topic` 取出 channel id，查該頻道的 `pubsubRequestedAt`
  是否落在 `PUBSUB_REQUEST_COOLDOWN_MS` 窗口內。
  - 是 → 寫 `pubsubExpiresAt = now + lease_seconds`（缺 `lease_seconds` 時用
    `PUBSUB_DEFAULT_LEASE_MS`），再以 `text/plain` 回 `hub.challenge`。
  - 否 → 404 + log warn，狀態不變。
- `unsubscribe`：本設計沒有主動退訂流程，一律 404。偽造者因此也無法用
  unsubscribe 竄改狀態。
- `denied`：log warn、回 200，不改狀態（`pubsubRequestedAt` 已更新，天然退避）。

窗口採 15 分鐘的依據：正式環境 log 中 `Subscribing:` 到 `Subscribed:` 是數秒內
（例如 14:01:35 與 14:01:37），15 分鐘約有 60 倍餘裕；真的遲到被擋掉也只是下一輪
重訂，會自我修復。

`atom.ts` 以 `removeNSPrefix: true` + `ignoreAttributes: false` 解析，回傳
`video` / `deleted` / `unknown` 三態的 discriminated union。實際欄位名與陣列包裝
行為由測試鎖住。

順手丟掉套件的記憶體去重（`_recieved` 陣列）：`noticeFromNotification` 是
upsert、本來就冪等，而且從 log 看重複通知極多、那段去重幾乎沒生效。

## 新增常數

都放 `src/constants.ts`，依 `_MS` 慣例，每個帶一行說明選值理由的註解。

| 常數                         | 值      | 理由                                                                                             |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `PUBSUB_RENEW_BEFORE_MS`     | 24 小時 | 提前一天續訂，容得下一整天的排程中斷仍不掉訂閱                                                   |
| `PUBSUB_REQUEST_COOLDOWN_MS` | 15 分鐘 | 同一頻道的最短重試間隔，同時是 verification 的接受窗口；刻意大於 10 分鐘的排程間隔，確保候選輪替 |
| `PUBSUB_RENEW_BATCH_SIZE`    | 5       | 單輪上限，也就是一次崩潰或限流的損失上限                                                         |
| `PUBSUB_REQUEST_SPACING_MS`  | 250     | 單輪內請求之間的間隔                                                                             |
| `PUBSUB_DEFAULT_LEASE_MS`    | 24 小時 | hub 未提供 `lease_seconds` 時的保守預設，確保仍會續訂而不是永不續訂                              |

hub 端點與 topic 前綴是固定值，放 `hub-client.ts` 內部常數，不走環境變數。

穩態驗算：182 個 subscribed 頻道 ÷ 5 天 lease ≈ 每天需續 36 個；每 10 分鐘 5 個
＝ 每天 720 個容量。首次鋪滿 182 個約 6 小時。

## 失效模式

| 狀況                             | 行為                                                                      |
| -------------------------------- | ------------------------------------------------------------------------- |
| hub 429／503                     | 本輪中止、job 正常成功；最多 `PUBSUB_RENEW_BATCH_SIZE` 個頻道延後 10 分鐘 |
| hub 400 或其他非 2xx             | log warn、該頻道 `pubsubRequestedAt` 已更新（排到隊尾）、繼續下一個       |
| 請求送出但 verification 從未到達 | `pubsubExpiresAt` 不變 → 冷卻後回到候選；因最舊優先排序，不會霸佔隊首     |
| verification 遲到超過窗口        | 404 拒絕、狀態不變 → 下一輪重訂                                           |
| 偽造的 verification              | `pubsubRequestedAt` 不在窗口內 → 404 + log warn，無法竄改到期時間         |
| HMAC 不符／缺簽章                | 不符回 200 忽略（避免 hub 自動退訂）、缺簽章回 403，都 log warn           |
| Atom 形狀非預期                  | 解析回 `unknown` → 回 200 + log warn，不 throw                            |
| 通知處理中 DB 錯誤               | catch + log（沿用現況），回 200                                           |
| process 崩潰                     | 最多損失本輪的頻道；下一輪 10 分鐘後自動接上                              |

## 測試策略

每個 `it` 都要有結構斷言（`toEqual` 或順序斷言，不只 `toHaveBeenCalled`）、明確
的 drain point、以及 stateful fake 而非裸 `jest.fn()`。

- **`atom.spec.ts`** —— 真實 Atom 樣本：新影片、`at:deleted-entry`、缺欄位、
  非預期根元素，對整個解析結果做 `toEqual`。
- **`hub-client.spec.ts`** —— mock axios：202 → 成功；429、503 → 限流；400 →
  非限流失敗；網路錯誤。並斷言送出的表單內容（`hub.callback` / `hub.mode` /
  `hub.topic` / `hub.secret`）完整正確。
- **`pubsub-subscribe.spec.ts`** —— stateful fake Channel，記錄寫入序列：批量
  上限、`pubsubRequestedAt` 寫在請求之前的順序、第三個候選回 429 時只送出三次
  請求且第四／第五個沒有被寫入、候選查詢條件。
- **`routes.spec.ts`** —— `fastify.inject()` 實際發請求：HMAC 正確／錯誤／缺失
  三態、challenge 回應與窗口過期的 404、`deleted-entry`、以及通知確實以正確參數
  觸發 `noticeFromNotification`。

## 部署行為

1. **job 名稱不變**。改名會讓舊文件永遠 locked 殘留在 `agendaJobs`（沒有任何
   程式碼會清它）。
2. `every("10 minutes", ...)` 就地更新 `repeatInterval` 並重算 `nextRunAt`，不碰
   `lockedAt`；目前卡住的 `lockedAt` 在 10 分鐘後被視為過期而重新鎖並實際執行
   ——**不需要手動改 DB**。`lastFinishedAt` 在第一次成功後自我修復。
3. **callback URL 完全不變**，hub 端既有訂閱仍然有效，所以 6 小時的鋪滿期間不會
   漏通知；重訂對 hub 而言只是刷新 lease，冪等。
4. 既有頻道都沒有這兩個新欄位，全部符合候選條件，因此上線後會按節奏逐批重訂。

## 移除清單

- `youtube-notification` 依賴與手寫的 `src/types/youtube-notification.d.ts`
- `@fastify/express` 依賴與 `crawler.ts` 裡的 `fastify.register(fastifyExpress)`
  （整個 repo 只為了掛這個 listener 而存在）
- `crawler.ts` 裡的 `YouTubeNotifier` 實例、四個事件監聽器，以及原本每 12 小時
  全量重掃的 job body

新增 `fast-xml-parser` 到 `dependencies`（crawler 在生產執行期會 import）。
