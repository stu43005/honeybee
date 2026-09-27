# feed 輪詢每日請求預算與限流中止

把 crawler 的頻道 RSS feed 輪詢從約 14400 次/天降到約 10000 次/天，並在一輪內偵測到限流時提早結束該輪。起因是 YouTube 對出口 IP 的 feed 請求有每日上限，超過後該端點以 404/500 回應，直到太平洋時間午夜才恢復。

## 背景：根本原因

上線 feed 輪詢（`2026-09-18-youtube-official-video-discovery-design.md` 的任務一）後，crawler 每天固定約 09:30–14:58（台灣時間）出現大量：

```text
Feed poll failed for [UC-hM6YJuNYVAmUWxeIr9FeA]: Request failed with status code 404
```

從 crawler pod 72 小時的 log（`kubectl logs --since=72h`）取得的證據：

- 共 7069 筆失敗：404 有 5362 筆，500 有 1707 筆。涵蓋 186 個不同頻道，不集中在特定頻道。
- 三天的失敗視窗（UTC）分別是 09-25 的 01:50–06:58、09-26 的 01:33–06:59、09-27 的 01:30–06:58。視窗外失敗數為 0。
- 視窗高峰時，每輪 20 個頻道失敗 18–20 個，接近全數失敗。
- **恢復點固定在 07:00 UTC，而且是瞬間恢復**：06:58 那輪失敗 19–20 個，07:00 那輪失敗 0 個，三天都一樣。07:00 UTC 就是太平洋夏令時間（PDT）午夜。
- **從 07:00 UTC 起算到開始失敗之前，累積的輪數每天幾乎相同**：09-25 07:00 → 09-26 01:33 是 556 輪，09-26 07:00 → 09-27 01:30 是 554 輪。每輪 20 次請求，約 **11100 次**。
- 開始失敗時是逐漸增加的：一開始每輪 1–4 個，約一小時後才接近全數失敗。
- 同一個 pod、同一個出口 IP 對 `www.youtube.com/oembed` 的存在性探測，以及 members poll，在視窗內失敗數都是 0。因此這不是整個 IP 被封，而是 feed 後端（`YouTube RSS Feeds server`）自己的限制。
- 視窗外從本機和 pod 內請求同一個 feed，都回 200。

結論（信心高）：`YOUTUBE_FEED_POLL_BATCH_SIZE = 20` 搭配每 2 分鐘一輪，每天約 14400 次請求，超過 feed 後端對單一 IP 約 11000 次/天的上限（依 PT 日重置）。超過後，這個端點回 404 或 500，而不是 429。

原設計只驗證過瞬間速率（10 req/s 持續、120 並發突發），沒有驗證每日總量。`feed-poll.ts` 的註解把這些失敗描述成「每輪約 1%、幾分鐘後就好」的偶發錯誤，這與上述證據不符。

上限的確切數值是從 log 推算的，Google 沒有公開文件，可能有誤差，也可能計入同 IP 的其他 feed 流量。因此預算要留下餘裕，而不是貼著上限。

## 設計

### 一、降低每日請求量

`YOUTUBE_FEED_POLL_BATCH_SIZE`：20 → **14**。排程維持 `agenda.every("2 minutes", ...)`。

```text
14 次/輪 × 30 輪/小時 × 24 小時 = 10080 次/天
```

這比推算的上限低約 9%。選擇改批次大小而不是改週期（每 3 分鐘 20 個 = 9600 次/天），原因是 10080 較接近 10000 的目標，而且只動一個常數。

發現延遲（公式沿用原設計：輪詢週期 + 15 分鐘 feed 快取）：

- 每小時處理量從 600 降為 420 頻道。
- 目前約 186 個訂閱頻道，週期約 27 分鐘，最壞延遲約 **42 分鐘**，仍在一小時目標內。
- 一小時目標要求週期 ≤ 45 分鐘，因此可容納的訂閱頻道數上限從 450 降為 420 × 0.75 = **315**。

**超過 315 個頻道後不得靠提高批次大小來換延遲**。每日請求量受 feed 端點的每 IP 上限約束，不再是「零配額、只有對外請求量」的自由變數。此時只能接受延遲變長，或另行設計（見 Non-goals）。

### 二、限流時提早結束本輪

在 `pollChannelFeeds()` 的迴圈內維護一個區域變數「連續 HTTP 失敗次數」。

**列入計數**：`axios.isAxiosError(error)` 且 `error.response` 存在，也就是伺服器回了非 2xx 的狀態碼。限流實際表現為 404 與 500，但判斷不綁定特定狀態碼，因為 feed 後端的限流回應本來就不是文件化的行為。

**歸零**：請求取得 2xx 回應，包含 body 不是 feed、`parseNotification()` 回傳 null 的情況。只要伺服器正常回應，就代表沒被限流。

**不影響計數**（既不增加也不歸零）：

- timeout、連線錯誤：axios error 但沒有 `response`。這是網路問題，不是限流訊號。
- 非 axios 的錯誤，例如 `noticeUnknownVideos()` 的 Mongo 寫入失敗。這種情況 HTTP 已經回 2xx，計數器在那一刻已經歸零。

**中止條件**：計數達到 `YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES = 3` 時：

1. 觸發中止的第 3 個頻道仍照常寫入 `feedCrawledAt`，與前兩個失敗的頻道相同。這沿用現有的「成功失敗皆推進時間戳」規則。
2. 本輪剩下的頻道不發請求、不寫時間戳。它們的 `feedCrawledAt` 仍是最舊的，下一輪候選查詢會先選到它們，不會被跳過。
3. 記一行 warn，內容含被延後的頻道數，例如 `Feed poll: stopping round after 3 consecutive HTTP failures, 11 channels deferred`。
4. 不再 `sleep` 等待請求間隔，直接結束本輪。

各頻道自己的 `Feed poll failed for [...]` 那一行照舊記錄。

中止只影響當輪，不在 process 或 DB 保存任何冷卻狀態，下一輪照常開始。萬一限流期間仍持續輪詢，而且一輪的前 3 次請求都以 HTTP 失敗收場（全面限流時的常態），該輪只會發 3 次請求、記 4 行 log。若中間夾著成功或 timeout，計數會歸零或停在原值，那一輪可能發出更多請求，但每輪上限仍是批次大小。限流解除後的第一輪自然恢復，不需要人為介入，也不需要把「PT 午夜重置」這個推論寫進程式。

**為什麼是 3**：限流視窗外 72 小時內失敗數為 0，所以正常情況下連續 3 次 HTTP 失敗幾乎不會發生。單一頻道真的回 404（例如頻道被刪除）只會讓計數到 1，下一個成功的頻道就歸零，不會誤觸中止。另外，限流開始時失敗是逐漸出現的，那段時間可能要到失敗比例夠高才會觸發中止，這是可接受的，因為那段期間仍有部分請求成功。

`YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES` 是次數，不是時間，所以不適用 `_MS` 命名慣例。它放在 `src/constants.ts`，附一行註解說明取值理由。

### 三、需更正的註解與文件

以下既有描述與新事實不符，一併更正：

- `src/constants.ts` 的 `YOUTUBE_FEED_POLL_BATCH_SIZE` 註解：改為每小時 420、每天約 10080 次，說明這個預算受每 IP 每日約 11000 次上限約束，以及 315 個頻道的延遲門檻。移除「feed costs no quota, only outbound requests」這類暗示可以自由調高的說法。
- `src/constants.ts` 的 `YOUTUBE_DISCOVERY_REQUEST_SPACING_MS` 註解：補上「驗證的只是瞬間速率，每日總量另有上限」。
- `src/services/crawler/index.ts` 排程處的「Two minutes covers 600 channels an hour」註解，以及 lock 說明裡 feed 的最壞耗時：14 × (10 秒 + 250 ms) ≈ 2.4 分鐘，取代 3.4 分鐘。
- `src/services/crawler/discovery/feed-poll.ts` catch 區塊裡「a percent or so of every round」「serves it again minutes later」的描述：改為如實說明，也就是 404/500 可能來自每日限流，而連續失敗由中止邏輯處理。「只記錄 message、不記錄整個 axios error」的理由仍然成立，保留。
- `docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md`：「發現延遲」段落的數字與 450 門檻、常數區塊中 `YOUTUBE_FEED_POLL_BATCH_SIZE = 20` 與其註解、Non-goals「一小時的發現目標以 450 個訂閱頻道為界」一節（門檻改為 315，並刪除「提高批次大小即可」的調整建議，改為指向每 IP 每日上限）、「本子系統的支出」表中 feed 輪詢的 14400（改為 10080，合計從 18144 改為 13824）、逾時表中 feed 那一列（14 筆、2.4 分），以及「單筆失敗不中斷整輪」段落補上 feed 的限流中止例外。

## 測試

在 `src/services/crawler/discovery/feed-poll.spec.ts` 新增測試，沿用現有的 axios mock、`mockSleep` 與 stateful 的 `fakeChannels`：

| 情境                                           | 斷言                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 前 3 個頻道回 HTTP 失敗（有 `response`）       | `mockGet` 的呼叫 URL 清單恰好是前 3 個頻道；寫入時間戳的頻道恰好是這 3 個；warn 呼叫清單包含中止那一行與正確的延後數                |
| 失敗、失敗、成功、失敗、失敗…交錯出現          | 整輪所有頻道都被請求，所有頻道都寫入時間戳                                                                                          |
| 連續 3 次 timeout（axios error 無 `response`） | 不中止，整輪所有頻道都被請求                                                                                                        |
| 中止後跑第二輪                                 | 第二輪的請求清單以第一輪被延後的頻道開頭                                                                                            |
| 中止時                                         | 前 3 個頻道失敗時，`mockSleep` 的呼叫清單恰好是 2 次 `YOUTUBE_DISCOVERY_REQUEST_SPACING_MS`（第 1、2 次請求之後），中止後不再 sleep |

既有「一輪最多取 `YOUTUBE_FEED_POLL_BATCH_SIZE` 個」的測試是從常數讀值，不需要修改。

## Non-goals / Accepted limitations

- **不做跨輪的冷卻狀態**。
  - Concern：限流期間每輪仍會打 3 次請求，並產生幾行 log。
  - Decision：不實作。
  - Rationale：使用者選擇只結束本輪。降頻之後正常情況不會觸發限流，中止只是保險；冷卻狀態需要額外保存狀態，還要把從 log 推論出來的 PT 午夜重置規則寫死。
- **超過 315 個訂閱頻道後，發現延遲會超過一小時**。
  - Decision：本設計不處理。
  - Rationale：目前約 186 個頻道，有足夠餘裕。屆時若要維持目標，需要另一個出口 IP 或其他發現管道，屬於另一份設計。
- **每日上限的數值是推算值**。
  - Decision：不做自動偵測或自適應調整。
  - Rationale：10080 對推算的約 11100 留有約 9% 餘裕；若上限實際更低，中止邏輯會在全面限流期間把損害限制在每輪約 3 次請求，並且在 log 留下可觀察的訊號。
