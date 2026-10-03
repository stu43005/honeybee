# feed 輪詢：單一頻道重試與錯誤假設的更正

把 crawler 的 feed 輪詢批次改回 20，每個頻道最多嘗試 3 次（只重試 HTTP 失敗），失敗時只記錄最後一次的錯誤，並保留「連續失敗即中止本輪」的機制，但計數單位改為頻道的最終結果。同時更正 `2026-09-27-feed-poll-rate-budget-design.md` 寫進程式註解與文件的錯誤根因。

## 背景：前一版根因假設被推翻

前一版設計認為 YouTube feed 後端對單一出口 IP 有每日約 11000 次的上限，因此把批次從 20 降到 14（約 10080 次/天）。上線五天後的 log 推翻了這個假設：

- 新版（約 2026-09-27 19:00 UTC 上線）之後，每天的失敗視窗仍是約 01:00–07:00 UTC：
  - 09-28 為 02:01–06:59
  - 09-29 為 02:12–06:59
  - 09-30 為 00:57–06:59
  - 10-01 為 01:08–06:58
  - 10-02 為 01:19–06:59
- 09-30 開始失敗時，從 07:00 UTC 起只累積了約 7600 次請求，比舊版的開始點（約 11100 次）還少。開始時間與我們的請求量無關。
- 2026-10-03 05:20 UTC（視窗內）加上隨機參數 `&nocache=<random>` 強制回源，同一個頻道各打 15 次：

  | 出口                                                        | 成功 |
  | ----------------------------------------------------------- | ---- |
  | 本機 HiNet（1.165.185.246）                                 | 3/15 |
  | 日本 Oracle Cloud VPN（168.138.207.67，不同國家、不同 ASN） | 5/15 |
  | crawler pod                                                 | 4/15 |

  換了 IP 一樣失敗，所以是 feed 源站本身的故障，不是針對我們的限制。

- 不加隨機參數時，常見到帶 `age:` header 的 200，那是 edge 快取命中（`max-age=900`）。每個頻道的輪詢間隔超過 15 分鐘，幾乎每次都會回源，所以幾乎都失敗。
- 同一個頻道連續請求，結果是隨機的 200/404/500，失敗以單次請求為單位，不是以頻道為單位。
- 視窗內每輪約 1–4 秒就結束（3 次失敗加 2 次 250 ms 間隔），代表 HTTP 失敗很快就回來。

結論：降頻對這個問題沒有效果，前一版寫進註解與文件的「每 IP 每日約 11000 次上限」是錯誤描述。「連續 HTTP 失敗就中止本輪」仍然有用：視窗內 log 從每小時約 550 行降到約 125 行。

## 設計

### 一、常數（`src/constants.ts`）

- `YOUTUBE_FEED_POLL_BATCH_SIZE`：14 → **20**。
  - 每 2 分鐘一輪就是每小時 600 個頻道。
  - 延遲目標恢復為原設計的計算：訂閱頻道 ≤ 450 時，一小時內可以發現新影片。
  - 註解刪除「每日上限」與「不可調高」的說法，改為說明實際的考量：feed 的 15 分鐘快取，以及延遲目標。
- 新增 `YOUTUBE_FEED_POLL_ATTEMPTS = 3`：每個頻道最多嘗試的次數，包含第一次。
  - 註解說明取值理由：視窗內單次回源成功率約 27%（45 次成功 12 次），3 次至少成功一次的機率約 61%。每多一次嘗試，就多打一次正在故障的源站。
  - 這是次數，不是時間，所以不使用 `_MS` 後綴。
- `YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES = 3`：數值不變，註解改寫。
  - 計數單位是「用完所有嘗試仍以 HTTP 失敗結束的頻道」。
  - 視窗外 72 小時內失敗數為 0，所以不會誤觸。
  - 在視窗內，單一頻道用完嘗試仍失敗的機率約 39%（0.73³），任意連續 3 個約 6%。以 20 個頻道、各頻道獨立估算，一輪中出現連續 3 個失敗而中止的機率約 55%；中止前通常已處理了一部分頻道。源站全面拒絕時，一輪最多 3 個頻道 × 3 次 = 9 次請求。
- `YOUTUBE_DISCOVERY_REQUEST_SPACING_MS = 250`：數值不變，註解刪除「每日上限」的說法。這個常數同時用作重試間隔，註解要一併說明。
- 新增 `YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS = 60 * 1000`，用途見「四、耗時與 agenda lock」。

### 二、單一頻道的處理（`src/services/crawler/discovery/feed-poll.ts`）

每個頻道最多請求 `YOUTUBE_FEED_POLL_ATTEMPTS` 次，每次都用同一個 URL。不加隨機參數，因為 edge 快取命中正是可以拿到資料的情況。

| 這次請求的結果                                                                         | 處理                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 2xx                                                                                    | 停止重試，照現有方式解析並寫入（含 body 不是 feed 的 warn）  |
| HTTP 失敗（`axios.isAxiosError(error) && error.response !== undefined`），還有剩餘次數 | 等待 `YOUTUBE_DISCOVERY_REQUEST_SPACING_MS` 後重試，不記 log |
| HTTP 失敗，已用完次數                                                                  | 這個頻道以失敗結束                                           |
| timeout、連線錯誤（axios error 但沒有 `response`）                                     | 不重試，這個頻道以失敗結束                                   |
| 2xx 之後的錯誤（例如 `noticeUnknownVideos()` 寫入失敗）                                | 不重試，HTTP 已經成功                                        |

失敗時的 log：

- 每個頻道只記一行，內容取最後一次的錯誤。
- HTTP 或其他 axios 錯誤：`Feed poll failed for [<id>] after <n> attempts: <message>`。`<n>` 是實際嘗試的次數；timeout 在第一次就結束時是 1。
- 非 axios 錯誤：維持現狀，記錄完整的 error 物件，因為它的 stack 是唯一的線索。格式為 `Feed poll failed for [<id>] after <n> attempts:` 加上 error 物件。
- 中間被重試掉的失敗都不記錄。

`feedCrawledAt` 不論結果都會寫入，與現在相同。寫入失敗的處理也不變。

### 三、批次中斷（保留，計數單位改為頻道的最終結果）

計數器仍是每一輪的區域變數：

- **+1**：頻道用完所有嘗試，最後一次是 HTTP 失敗。
- **歸零**：頻道任何一次嘗試拿到 2xx。包含 body 不是 feed，以及之後寫入失敗的情況。
- **不變**：頻道以 timeout、連線錯誤或非 axios 錯誤結束。其中「HTTP 失敗 → HTTP 失敗 → timeout」也算不變，因為最後一次不是 HTTP 失敗。

計數達到 `YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES` 時的行為與現在相同：

- 當下的頻道已經寫入 `feedCrawledAt`。
- 記一行 `Feed poll: stopping round after 3 consecutive HTTP failures, N channels deferred`。
- 直接 return，不再 sleep。
- 剩下的頻道不寫 `feedCrawledAt`，下一輪優先處理。

最後一個頻道觸發時也記這一行，內容為 `0 channels deferred`。

### 四、耗時與 agenda lock

只重試 HTTP 失敗，timeout 不重試。在「HTTP 失敗都很快就回來」的前提下，單一頻道最壞的情況是：前兩次很快回 HTTP 失敗，第三次 timeout，耗時約 10 秒 + 2 × 250 ms。整輪約 20 × (10 s + 0.5 s + 0.25 s) ≈ **3.6 分**。這個前提有觀測依據：視窗內每輪 3 次失敗只要 1–4 秒。

但這個前提沒有保證。若每次嘗試都在接近 10 秒時才回 HTTP 錯誤（例如每個頻道都是兩次慢速失敗後才成功，此時計數一再歸零，中止機制也擋不住），整輪會到 20 × 30.75 秒 ≈ 10.3 分，超過 agenda 預設的 10 分鐘 lock。lock 過期後，同一個 job 可能被再次取得而重疊執行。

**處理方式：執行期間定期 touch job。**

- `pollChannelFeeds(job?: Job)` 接受可省略的 agenda `Job`，與 `genRealtimeAndUpcomingFiles(job?: Job)` 等既有函式的慣例相同。crawler 的 `agenda.define` handler 把自己的 `job` 傳進來。
- 函式開始時記下時間。每處理一個頻道之前，若距離上次 touch（或函式開始）已達 `YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS`，就呼叫 `await job?.touch()` 並更新時間。
- `YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS = 60 * 1000`：每分鐘一次。
  - 單一頻道最長約 31 秒，所以兩次 touch 之間最長約 1.5 分鐘，遠小於 10 分鐘的 lock。
  - 每輪通常只需 0–4 次 touch，對 DB 的額外寫入可以忽略。
  - 頻道與頻道之間檢查一次就夠了，不需要另開計時器。
- `job.touch()` 會刷新 `lockedAt`。agenda 6.2.4 中，job 已被 cancel 時 touch 會丟錯。這個錯誤**不捕捉**，讓它結束本輪：失去 lock 之後不應該再繼續處理。已處理的頻道已經寫入時間戳，未處理的留給下一輪，與中止機制的結果相同。

請求量：

- 視窗外每天約 14400 次，每個頻道一次就成功。
- 視窗內每小時最多約 600 × 3 = 1800 次。

### 五、需更正的註解與文件

- `src/constants.ts`：見「一、常數」。
- `src/services/crawler/discovery/feed-poll.ts`：
  - JSDoc 中「Once the outbound address has used up the feed's daily allowance…」改為如實描述：源站每天約 01–07 UTC 對任何來源都大量回 404/500。
  - catch 區塊的註解也做同樣的更正。
  - 補上重試的說明。
- `src/services/crawler/index.ts`：
  - lock 註解說三個 job 都不設 lockLifetime、也不呼叫 `job.touch()`，並且「retries are off」，這些都已經不適用於 feed poll。改寫為：feed poll 在 HTTP 失敗時會重試，以每分鐘 touch 維持 lock，快速失敗下的估計耗時約 3.6 分；另外兩個 job 的說明不變。
  - feed poll 的 `agenda.define` handler 改為 `await pollChannelFeeds(job)`。
  - 排程註解的 420 頻道/小時改回 600，並刪除「per-address daily ceiling」的說法。
- `docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md`：
  - 2026-09-27 那次 commit（`7cc82d4`）改過的段落，數字改回以 20 為準：600 頻道/小時、450 門檻、14400 與 18144、平均 0.244 req/s、3.4 分改為 3.6 分（含重試）、週期 30/60 分、正常一輪約 5 秒。
  - 「每 IP 每日上限」的描述改為故障視窗的事實。
  - 「第二個例外」那段改寫為以頻道最終結果計數，並加上重試的說明。
- `docs/superpowers/specs/2026-09-27-feed-poll-rate-budget-design.md`：在標題下加一段說明，指出其根因假設已被推翻、降頻已撤回，並指向本文件。其餘內容保留作為歷史紀錄，不改寫。

## 測試

在 `src/services/crawler/discovery/feed-poll.spec.ts` 中，沿用現有的 axios mock、`mockSleep`、stateful 的 `fakeChannels`，以及 `httpError()`、`timeoutError()`、`requestedChannels()` 這些 helper。

新增：

| 情境                                | 斷言                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| HTTP 失敗、HTTP 失敗、2xx           | 同一個頻道被請求 3 次；有寫入影片；沒有失敗 log；`mockSleep` 依序有 2 次重試間隔                                         |
| 3 次都是 HTTP 失敗（404、500、404） | 請求 3 次；warn 只有一行 `Feed poll failed for [UC1] after 3 attempts: Request failed with status code 404`              |
| 第一次就 timeout                    | 只請求 1 次；warn 為 `... after 1 attempts: timeout of ...`                                                              |
| 2xx 但 body 不是 feed               | 只請求 1 次，不重試                                                                                                      |
| HTTP 失敗後 timeout                 | 請求 2 次；這個頻道不計入中止計數（以後續頻道的行為驗證）                                                                |
| 連續 3 個頻道各 3 次 HTTP 失敗      | 請求 9 次後中止；剩下的頻道不請求、不寫時間戳；記錄中止那一行                                                            |
| 頻道在第 3 次才成功                 | 計數歸零：前面的頻道失敗 2 個，這個成功，後面再失敗 2 個，整輪不中止                                                     |
| 時間推進跨過 touch 間隔             | 以 `jest.spyOn(Date, "now")` 控制時間：處理第 2 個頻道前已過 60 秒 → `job.touch` 被呼叫 1 次；未滿 60 秒的頻道之間不呼叫 |
| `job.touch` 丟錯（job 已被 cancel） | `pollChannelFeeds` 以該錯誤 reject；觸發時之後的頻道不請求、不寫時間戳                                                   |
| 不傳 `job`                          | 行為與傳入時相同，不丟錯（既有測試全部以不傳 `job` 的方式繼續通過）                                                      |

既有測試配合調整：

- 依賴「一次失敗就結束這個頻道」的 mock 序列，改用 `mockRejectedValue` 讓每次嘗試都失敗，或明確排好每次嘗試的結果。
- 斷言請求次數或 `mockSleep` 呼叫的測試，依新的嘗試次數更新期望值。
- warn 文字斷言改為新的 `after <n> attempts` 格式。
- 原有的中止相關測試（中止後不 sleep、延後的頻道下一輪優先、每輪計數歸零、最後一個頻道也記中止行）保留其意圖，只更新 mock 序列與期望值。

## Non-goals / Accepted limitations

- **不在固定時段跳過輪詢。** 故障時段是從 log 推論的，Google 隨時可能改變，寫死在程式裡只會讓它過期。
- **不加 cache-busting 參數。** 快取命中是視窗內唯一穩定能拿到資料的途徑。
- **視窗內 feed 仍會漏掉約 39% 的頻道**（每輪抽樣的機率估計）。這段時間的發現仍要靠 pubsub 與 Holodex，與前一版相同。
- **單次 DB 操作卡住超過 lock 期限。**
  - Concern：touch 只在處理每個頻道之前檢查。若 `noticeUnknownVideos()` 或寫入 `feedCrawledAt` 的 Mongo 操作卡住超過 10 分鐘，下一次 touch 會來不及，lock 可能在執行中過期而被重疊執行。
  - Decision：不處理，不改用獨立計時器 touch。
  - Rationale：Mongo 單次操作卡住 10 分鐘以上極為罕見，而且專案裡所有 agenda job 都有相同的風險，不是這次改動帶進來的。為此加上計時器、清理與錯誤回傳的成本，與風險不成比例。
