# YouTube 官方影片發現子系統設計

在 crawler 服務新增三個以官方管道發現影片的排程任務：頻道 RSS feed 輪詢、會員限定上傳播放清單（UUMO）掃描、以及已消失影片的復活探測。目的是補上 pubsub 漏送的影片、涵蓋 Holodex 完全不提供的上傳影片與會員影片，並讓消失後又恢復的影片能回到收錄範圍。

不改 data-contract，不改 worker 與 scheduler，不改既有的 Holodex 輪詢與 pubsub 訂閱機制。

## 問題

目前影片發現有三個來源，各有缺口：

1. **Holodex 輪詢**（`crawler holodex update live` / `update past`）——只回傳直播（`VideoType.Stream`），完全不含上傳影片與 shorts，且受 Holodex 自身的抓取延遲影響。
2. **PubSubHubbub push**（`src/modules/youtube-pubsub/`）——官方唯一的即時推送管道，但 hub 不保證送達：租約過期、服務停機、hub 自身丟棄，都會讓該次通知永久消失。通知一旦漏掉，沒有任何機制會重新發現那支影片——所有既有的候選查詢都要求文件已經存在於 videos collection。
3. **Raid 撿漏**（`noticeFromRaid`）——只在別人 raid 過來時才會發現，覆蓋面是偶然的。

此外，`status: Missing` 的影片一旦被標記就沒有回頭路。`updateVideoFromYoutube()` 在 YouTube 省略該 id 時標記 `Missing` + `deleted`，而五條候選查詢裡只有 `findRecentlyEndedVideos(1)` 會碰到 `Missing`，且限縮在 `hbEnd` 一小時內。私人轉公開、YouTube 暫時性的查詢失敗，都會讓影片永久停在 `Missing`。

會員限定影片則是完全的空白：公開 RSS feed 不含它們，Holodex 不提供，pubsub 的 topic 是公開 feed 所以也推送不到。

## 目標

1. 任何訂閱頻道發布的新影片（含上傳影片、shorts、排程直播），即使 pubsub 漏送，也能在**一小時內**被發現。
2. 會員限定上傳影片能被發現並寫入 videos collection。
3. 消失後恢復可存取的影片，能自動回到收錄範圍。
4. 上述三者的每日 YouTube Data API 用量有明確上限，且該上限**不隨訂閱頻道數成長**——頻道變多只會拉長輪詢週期，不會排擠既有的 `videos.list` / `channels.list` 流量。

## 已驗證的事實

以下全部經實際 HTTP 請求驗證（2026-09-17），不是推測。相關結論已存入專案 MEMORY。

### 頻道 RSS feed

`https://www.youtube.com/feeds/videos.xml?channel_id=UC...`

- 固定回傳 15 個 `<entry>`，零 API 配額。
- **含尚未開播的排程直播**：對 4 個當下有 upcoming 的頻道測試，upcoming 的 videoId 全部出現在 feed 中。同時含 shorts 與一般上傳影片。
- **不含會員限定影片**。
- `cache-control: public, max-age=900`，且對同一頻道重複請求時 `age` 單調遞增——這是 CDN edge cache，同一頻道 15 分鐘內重複請求拿到的是同一份快取。
- pubsub 使用的 topic URL `https://www.youtube.com/xml/feeds/videos.xml?channel_id=...`（多一層 `/xml`）是**另一份資源**：463 bytes 的靜態說明文件，零個 entry。它作為 pubsub topic 是正確的，作為 feed 則毫無內容。兩者不可混用。
- 既有的 `parseNotification()`（`src/modules/youtube-pubsub/atom.ts`）可以直接解析這份 feed：15/15 個 entry 的 videoId、channelId、title、link、channelName、published、updated 全部齊全。

### feed 與 UU 播放清單等價

對 6 個頻道比對 feed 的 15 個 videoId 與 `UU<suffix>` 播放清單前 15 筆：**集合與順序完全相同，雙向差集皆空**。因此公開上傳影片不需要動用 `playlistItems.list`，feed 以零配額提供同等資訊。唯一差異是 feed 有 900 秒快取而播放清單即時。

### 會員限定上傳播放清單

- 播放清單 id 慣例：頻道 `UC<suffix>` → 公開上傳 `UU<suffix>` → 會員限定上傳 `UUMO<suffix>`。
- `playlistItems.list` 讀取 UUMO **只需純 API key，不需要 OAuth，也不需要頻道會員身分**。有會員影片的頻道回 200 並列出影片；沒有的回 404 `The playlist identified with the request's playlistId parameter cannot be found.`
- oEmbed 可以零配額判定 UUMO 是否存在：有會員影片的頻道回 200 `"Members-only videos"`，沒有的回 404。

### playlistItems 無法取代 videos.list

`playlistItems.list` 提供 `snippet`（title、description、publishedAt、thumbnails、channelId、resourceId.videoId）、`contentDetails`（videoId、videoPublishedAt）、`status`（privacyStatus），但**不提供** `liveStreamingDetails`、`contentDetails.duration`、`status.uploadStatus`、`statistics`。

`updateVideoFromYoutube()` 的整套狀態判定——Upcoming / Live / Past / Missing 的分支、`duration`、`premiere`、`memberLimited`（正是靠 `statistics.viewCount === undefined` 判定）、`viewers`、`likes`——全部建立在這四塊缺失的資料上。因此 `videos.list` 無法省略。

不過 `playlistItems` 的 `snippet.title` 與 `channelId` 已足以完成 upsert，與 feed 提供的資訊等價，所以 UUMO 路徑不需要額外的查詢步驟。

### oEmbed 的回應分類

`https://www.youtube.com/oembed?url=<encoded>&format=json`

| 情境                                   | 狀態碼     |
| -------------------------------------- | ---------- |
| 公開可存取的影片                       | 200 + JSON |
| 已轉為私人的影片（實測 `tnj9je6IspU`） | 404        |
| 格式合法但不存在的 id                  | 404        |
| 格式無效的 id                          | 400        |

**只有 200 代表影片真的恢復可存取**，私人影片不會被誤判。

### 速率限制

740 次實際請求（30 並發突發、10 req/s 持續 10 秒、120 並發突發，各端點各 370 次）：

- oEmbed 與 feed **全部 200，零 429，無任何速率限制 header**。
- 連續打完 740 次後立刻請求 watch page → 200；反向順序（先 watch 後 oEmbed）亦全部 200。**未觀察到交叉污染**。
- 三個端點回應的 `server` header 各不相同（oEmbed 是 `scaffolding on HTTPServer2`、feed 是 `YouTube RSS Feeds server`、watch page 是動態渲染），是三套不同的後端服務。

證據支持這兩個端點**不共用** `YoutubeWatchGate` 所防護的限速器（全域 1 req/s、429 後冷卻 60 秒）。找不到任何官方文件說明這兩個端點的速率限制；實測只確立安全下限，未測出實際上限，也未測試數小時等級的持續負載。

## 架構

新增 `src/components/youtube-discovery/`，crawler 只負責註冊三個 agenda 任務，實作全在 component。所有 googleapis 呼叫集中在既有的 `src/modules/youtube.ts`。

```
src/modules/youtube.ts                     唯一呼叫 googleapis 的檔案
  + fetchMembersUploads(channelId)           UUMO 的 playlistItems.list

src/components/youtube-discovery/
  oembed.ts            零配額存在性探測（純 fetch）
  ingest.ts            共用寫入路徑
  feed-poll.ts         一輪 feed 輪詢
  members-poll.ts      一輪 UUMO 探測 + 掃描
  existence-probe.ts   一輪復活探測
```

`oembed.ts` 同時被 members-poll（判定 UUMO 是否存在）與 existence-probe（判定影片是否恢復）使用；`ingest.ts` 被 feed-poll 與 members-poll 使用。兩者都承載實際邏輯（狀態碼分類與 URL 編碼、差集比對與兩階段寫入），不是為了給樣板程式取名而抽出的包裝。

### 共用寫入路徑

四個發現來源（pubsub、feed、UUMO、raid）最終都走同一組 model 方法，寫入語意一致：

```
發現來源 → { videoId, title, channelId }[]
    ↓
VideoModel.find({ id: { $in: ids } }).select("id")     差集比對
    ↓ 僅未知的 id
VideoModel.noticeFromNotification()                     upsert，status = New
    ↓
updateVideoFromYoutube(newIds)                          videos.list 補 metadata
```

**差集比對不可省略。** `noticeFromNotification()` 的 `$set` 含 `crawledAt: null`。若每輪對 feed 裡全部 15 支影片（絕大多數是已知的）都呼叫一次，等於持續把數千支已知影片丟回 `crawler youtube update` 的補抓佇列，把真正的 live 影片擠出 `.slice(0, 100)` 的名額——這正是 `2026-09-09-crawler-unconfirmed-video-cleanup-design.md` 記錄過的排擠問題。

寫入順序固定為**先 DB 後 API**：先 upsert 落盤，再呼叫 `updateVideoFromYoutube()`。metadata 抓取失敗不影響已落盤的影片，它 `status = New`，`crawler youtube update` 下一分鐘就會撿到。這與 `src/modules/youtube-pubsub/routes.ts` 的兩階段寫法同一個理由。

### 共用輪替模式

三個任務都採用與 `renewPubsubSubscriptions()` 相同的形狀：

```
撈出「最久沒處理過」的 M 筆 → 逐一處理（每筆之間 spacing）→ 蓋上時間戳
```

**批次大小是常數，不隨頻道數變化。** 這讓每日配額成為硬上限：頻道從 300 成長到 600，輪詢週期會從 30 分鐘變成 60 分鐘，但配額用量不變。相反的設計（批次大小隨頻道數調整）會讓頻道成長直接吃掉 `crawler youtube update` 的配額。

## 任務一：feed 輪詢

任務名稱 `crawler youtube feed poll`，每 2 分鐘一輪。

候選查詢：`ChannelModel.findSubscribed()`，依 `feedCrawledAt` 遞增排序（未抓過的為 null，排最前），取 `YOUTUBE_FEED_POLL_BATCH_SIZE` 筆。

每個頻道：

1. GET `https://www.youtube.com/feeds/videos.xml?channel_id=<id>`，逾時 `YOUTUBE_FEED_TIMEOUT_MS`。
2. `parseNotification()` 解析。回傳 null（非 feed 或格式錯誤）時記一行 warn 後跳過。
3. 取出 `type === "video"` 的 entry，交給共用寫入路徑。
4. 無論成功或失敗，更新 `feedCrawledAt`。

### 發現延遲

```
最壞延遲 = 輪詢週期 + feed 快取延遲
         = (訂閱頻道數 ÷ 每小時處理量) + 15 分鐘
```

300 個訂閱頻道時：20 筆 × 30 輪/小時 = 600 頻道/小時，週期約 30 分鐘，最壞延遲約 **45 分鐘**，在一小時目標內且留有一倍餘裕。頻道數要到 540 左右才會逼近一小時。

900 秒的 edge cache 同時也是輪詢週期的自然下限：週期壓到 15 分鐘以下只是重複取得同一份快取，沒有任何收益。

## 任務二：UUMO 掃描

任務名稱 `crawler youtube members poll`，每 5 分鐘一輪。一輪內依序做兩件事。

### 存在性探測（零配額）

候選查詢：`ChannelModel.findSubscribed()` 且（`membersProbedAt` 為 null 或早於 `now - YOUTUBE_MEMBERS_PROBE_TTL_MS`），依 `membersProbedAt` 遞增排序，取 `YOUTUBE_MEMBERS_PROBE_BATCH_SIZE` 筆。

對每個頻道以 oEmbed 請求 `https://www.youtube.com/playlist?list=UUMO<suffix>`，200 → `hasMembersPlaylist = true`，404 → `false`。其餘狀態碼與網路錯誤不改變既有判定（避免一次暫時性失敗就讓頻道停掃一週），但仍更新 `membersProbedAt`。

七天的 TTL 是因為「頻道有沒有開會員」幾乎不變；更頻繁的探測買不到任何東西。新頻道的 `membersProbedAt` 為 null，排序時排最前，會優先被探測——與 `findPubsubRenewalCandidates` 相同的技巧。

### 播放清單掃描（每頻道 1 unit）

候選查詢：`ChannelModel.findSubscribed()` 且 `hasMembersPlaylist: true`，依 `membersCrawledAt` 遞增排序，取 `YOUTUBE_MEMBERS_POLL_BATCH_SIZE` 筆。

每個頻道呼叫 `fetchMembersUploads(channelId)`（`playlistItems.list`，`part: ["snippet", "contentDetails"]`，`maxResults: 50`，不翻頁），把結果映射成 `{ videoId, title, channelId }` 交給共用寫入路徑，然後更新 `membersCrawledAt`。

分成兩條候選查詢而非一條的原因：沒有會員影片的頻道若混在掃描佇列裡，會白白佔用名額卻不產生任何發現。分開之後，配額預算直接等於 `YOUTUBE_MEMBERS_POLL_BATCH_SIZE`，與「有多少頻道沒開會員」無關。

### 覆蓋週期

17 筆 × 12 輪/小時 = 每小時可掃 204 個有 UUMO 的頻道。若 300 個訂閱頻道中有 240 個開了會員，週期約 **70 分鐘**，略超一小時目標。這是配額硬約束下的必然結果，記於「Non-goals / Accepted limitations」。

## 任務三：復活探測

任務名稱 `crawler youtube existence probe`，每 5 分鐘一輪。

四個分桶，各自獨立查詢、各取 `YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE` 筆：

| 桶  | `deleted`                | `availableAt`                                  |
| --- | ------------------------ | ---------------------------------------------- |
| 1   | `true`                   | 晚於 `now - YOUTUBE_EXISTENCE_PROBE_RECENT_MS` |
| 2   | `true`                   | 早於該界線                                     |
| 3   | `{ $in: [null, false] }` | 晚於該界線                                     |
| 4   | `{ $in: [null, false] }` | 早於該界線                                     |

四桶皆附加 `status: VideoStatus.Missing`，依 `crawledAt` 遞增排序。

分桶的目的是公平性：`deleted: true` 的族群（YouTube 確認查不到）遠大於超時判定的族群，而兩週以前的族群又遠大於近期的。單一查詢會讓最大的族群獨占所有名額，近期消失、最可能復活的影片永遠排不到。

每支影片以 oEmbed 請求 `https://www.youtube.com/watch?v=<id>`：

- **200** → `updateOne`：`status` 設為 `New`，移除 `deleted` 與 `detectedDeletionAt`，`crawledAt` 設為 null。
- **其他**（404 私人或不存在、400 無效 id、網路錯誤）→ 只把 `crawledAt` 更新為 now。

使用 `updateOne` 而非 document `save()`：這些正是 `2026-09-09-crawler-unconfirmed-video-cleanup-design.md` 描述的族群，可能缺少 `title` / `channelId` 這類 required 欄位，`save()` 會被 validator 擋下、寫不進去，於是每輪重複被選中。

`crawledAt` 設為 null 會讓該影片在分桶查詢裡排到最前，但它此時 `status` 已是 `New`、不再命中 `status: Missing` 的分桶，不會被重複探測；同時 `crawler youtube update` 的 `{ crawledAt: null }` 查詢會撿回去補 metadata。

### 為什麼重用 crawledAt 而非新增欄位

`crawler youtube update` 的五條候選查詢中，只有 `findRecentlyEndedVideos(1)` 會碰到 `Missing` 影片，且限縮在 `hbEnd` 一小時內；其餘四條（`status: New`、`crawledAt: null`、兩條 `findLiveVideos()`）都碰不到。對絕大多數 `Missing` 影片而言 `crawledAt` 是無人讀取的欄位，拿來當探測時間戳不會與任何查詢衝突，而「剛爬過的影片不必再探測」本來就是正確的語意。

副作用記於「Non-goals / Accepted limitations」。

## Schema 變更

`Channel` 新增四個欄位，全部 optional，不影響既有文件：

```ts
/** When we last fetched this channel's RSS feed. */
@prop()
public feedCrawledAt?: Date;

/** Whether the channel has a members-only uploads playlist, as last probed. */
@prop()
public hasMembersPlaylist?: boolean;

/** When that existence probe last ran. */
@prop()
public membersProbedAt?: Date;

/** When we last read the members-only uploads playlist. */
@prop()
public membersCrawledAt?: Date;
```

探測時間與掃描時間刻意分成兩個欄位：探測是七天一次的零配額動作，掃描是每輪都花 1 unit 的動作，兩者節奏差兩個數量級，共用一個時間戳會讓其中一邊失去意義。

`Video` **不新增欄位**。

### 索引

| 查詢           | 索引                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| feed 候選      | `{ feedCrawledAt: 1 }`                                                       |
| UUMO 掃描候選  | `{ hasMembersPlaylist: 1, membersCrawledAt: 1 }`                             |
| UUMO 探測候選  | `{ membersProbedAt: 1 }`                                                     |
| 復活探測四分桶 | `{ deleted: 1, availableAt: 1, crawledAt: 1 }`，partial on `status: Missing` |

分桶查詢的排序欄位排在範圍條件之後，理論上會落在 in-memory sort，但每桶 `limit 5` 使其成為 top-k 排序，記憶體用量是常數，不觸及 32MB 上限。

`deleted` 的「非刪除」分支寫成 `{ $in: [null, false] }` 而非 `{ $ne: true }`，維持 equality 形狀以利用索引；欄位不存在時 `null` 也會命中。

三條 Channel 候選查詢全部建立在 `findSubscribed()` 之上（沿用既有的 `SubscribedQuery`），與 `findPubsubRenewalCandidates` 同一個形狀——不再訂閱的頻道自動退出輪替，不需要額外的清理機制。

## 常數

新增於 `src/constants.ts`。時間類常數依專案慣例以 `_MS` 結尾並以毫秒儲存。

```ts
// --- YouTube official video discovery (src/components/youtube-discovery/) ---

// Channels fetched in one feed-poll round. On the 2-minute schedule that is 600
// channels/hour, so 300 subscribed channels get a round roughly every 30
// minutes, leaving room to double before the one-hour target slips.
export const YOUTUBE_FEED_POLL_BATCH_SIZE = 20;

// Gap between two outbound requests inside any discovery round. Both endpoints
// served 10 req/s for 10 seconds and 120-concurrent bursts without a single
// 429, so 4 req/s keeps a 2.5x margin below what was actually verified.
export const YOUTUBE_DISCOVERY_REQUEST_SPACING_MS = 250;

// Per-request timeout for the channel RSS feed. A healthy response takes about
// 100 ms; this is generous enough to ride out a slow edge node while keeping a
// fully stalled round inside agenda's lock.
export const YOUTUBE_FEED_TIMEOUT_MS = 10 * 1000;

// Per-request timeout for oEmbed probes. Measured latency is 40-50 ms; same
// reasoning as the feed timeout.
export const YOUTUBE_OEMBED_TIMEOUT_MS = 10 * 1000;

// Channels whose members-only uploads playlist is read in one round. Each read
// costs one quota unit, so on the 5-minute schedule this is 4896 units/day —
// the largest slice the 10000-unit daily budget can spare alongside the
// existing videos.list and channels.list traffic (about 3168 units/day).
export const YOUTUBE_MEMBERS_POLL_BATCH_SIZE = 17;

// Channels probed per round for whether a members-only uploads playlist exists.
// Costs no quota; 3 per round is 864 probes/day, which re-probes every channel
// well inside the TTL below.
export const YOUTUBE_MEMBERS_PROBE_BATCH_SIZE = 3;

// How long a probe's answer is trusted. Whether a channel offers memberships
// almost never changes, so a channel that newly opens them is picked up within
// a week and more frequent probing buys nothing.
export const YOUTUBE_MEMBERS_PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Videos each of the four buckets contributes to one existence-probe round.
// Four buckets x 5 x 288 rounds/day = 5760 probes/day, all quota-free.
export const YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE = 5;

// The availableAt boundary splitting recent Missing videos from old ones. A
// video that vanished in the last two weeks is far likelier to return than one
// gone for years, and the split stops the much larger old population from
// starving the recent one.
export const YOUTUBE_EXISTENCE_PROBE_RECENT_MS = 14 * 24 * 60 * 60 * 1000;
```

## 配額與速率預算

現有基線（取上限值）：`videos.list` 每分鐘最多 2 次 = 2880 + `channels.list` 每 5 分鐘 1 次 = 288，合計 **3168 units/天**，剩餘 6832。

| 來源                   | 配額/天     | 對外請求/天 |
| ---------------------- | ----------- | ----------- |
| feed 輪詢              | 0           | 14400       |
| UUMO 存在性探測        | 0           | 864         |
| UUMO 播放清單掃描      | 4896        | —           |
| 復活探測               | 0           | 5760        |
| 新影片補 metadata      | 約 15       | —           |
| **合計（含既有基線）** | **約 8080** | **21024**   |

留約 1900 units 緩衝。

請求速率：每輪突發 4 req/s（spacing 250 ms），三個任務若同時觸發最壞 12 req/s，平均 0.244 req/s。實測安全值是 10 req/s 持續與 120 並發突發，平均速率遠低於此。

**不接上 `YoutubeWatchGate`。** 證據顯示這些端點與 watch page 是不同後端、不共用限速器；硬接上去會讓 feed 輪詢排隊等 worker 的全域 1 req/s 預算，把一輪 20 個頻道從 5 秒拖到 20 秒，換來的是對一個未觀察到的耦合做防護。若日後實際觀察到 429，那是另一份設計要處理的事。

## 錯誤處理

**時間戳一律更新，成功失敗皆然。** 一個持續失敗的頻道若不更新時間戳，會固定佔住輪替佇列最前排，每輪重試、每輪失敗，吃光整輪名額。更新後它自然掉到隊尾。這與 `renewPubsubSubscriptions()` 對 `pubsubRequestedAt` 的處理同一個理由。

**單筆失敗不中斷整輪**，唯一例外是配額耗盡。`playlistItems.list` 回 403 `quotaExceeded` 是全域狀態，繼續只會繼續失敗——照 `renewPubsubSubscriptions()` 對 throttled 的處理，記一行 warn 後中止本輪，已處理頻道的時間戳保留，其餘留給下一輪。

**逾時與 agenda lock。** 每輪最壞耗時：

| 任務     | 每輪筆數 | 最壞耗時 |
| -------- | -------- | -------- |
| feed     | 20       | 3.4 分   |
| UUMO     | 17 + 3   | 4.7 分   |
| 復活探測 | 20       | 3.4 分   |

feed 的週期是 2 分鐘，最壞耗時會與下一輪重疊，由 agenda 的 job lock 保證不並發、重疊時順延。這是安全的降級——全部請求同時逾時是極端情況，正常一輪約 5 秒。agenda 的 `lockLifetime` 預設值與重疊時的實際行為屬第三方套件行為，實作計畫階段須以 research 確認後再決定是否需要顯式設定，本設計不對其做假設。

## 測試策略

Jest ESM（`jest.unstable_mockModule` + 動態 import）。重點放在能抓到迴歸的斷言，而非覆蓋率。

| 測試             | 斷言                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 差集（全部已知） | feed 15 筆全是已知影片 → `noticeFromNotification` 零次呼叫、`updateVideoFromYoutube` 零次呼叫                                          |
| 差集（部分未知） | 15 筆中 2 筆未知 → 傳入 `updateVideoFromYoutube` 的陣列 `toEqual` 恰好那 2 個 id                                                       |
| 配額中止         | 第 3 個頻道回 `quotaExceeded` → 第 4 個起不再呼叫 API，前 3 個的 `membersCrawledAt` 已寫入                                             |
| 失敗不卡前排     | 頻道 A 拋錯 → `feedCrawledAt` 仍更新；第二輪的候選查詢不再選到 A                                                                       |
| 分桶公平性       | 其中一桶為空 → 其餘三桶仍各取滿 N                                                                                                      |
| 復活寫入         | oEmbed 200 → `status: New`、`deleted` 與 `detectedDeletionAt` 被移除、`crawledAt` 為 null；404/400 → 只更新 `crawledAt`，`status` 不動 |
| oEmbed 分類      | 200/404/400/網路錯誤 四種輸入的分類結果，以及 URL 編碼正確（內層 `?v=` 必須被編碼）                                                    |
| 探測 TTL         | `membersProbedAt` 在 TTL 內的頻道不進入探測候選；`hasMembersPlaylist: false` 的頻道不觸發任何 API 呼叫                                 |

第一項是最重要的迴歸防線：它守住「每輪把數千支已知影片丟回補抓佇列」這個會靜默拖垮 `crawler youtube update` 的失誤。

資料庫狀態使用 stateful fake（一個 `Set` 裝已知 videoId、一個 `Map` 裝 channel 文件），不是裸 `jest.fn()`——「第二輪不再選到 A」這類斷言必須能觀察到第一輪寫入的時間戳。

## Non-goals / Accepted limitations

以下項目經評估後明確不做，或接受其限制。

### 不回補頻道歷史影片

只做增量發現：feed 的 15 筆窗口、UUMO 播放清單的首頁 50 筆，不翻頁、不做一次性深掃。頻道歷史影片的價值遠低於導入成本（大量文件湧入會排擠即時影片的 metadata 補抓名額）。

### 會員影片只做記錄，不抓聊天

worker 沒有任何 cookie / credentials 設定，`src/commands/worker.ts` 對會員限定影片直接回 `ErrorCode.MembersOnly`。UUMO 掃描寫入的影片，價值在於 metadata 記錄、webhook 通知與 track 統計，不在聊天收集。要抓會員聊天需要 worker 具備會員身分，屬於另一份設計的範圍。

### UUMO 覆蓋週期可能超過一小時

若訂閱頻道中開了會員的超過 204 個，UUMO 的輪替週期會線性超過一小時（240 個時約 70 分鐘）。要壓回一小時內，唯一的辦法是提高 `YOUTUBE_MEMBERS_POLL_BATCH_SIZE` 並相應削減 `crawler youtube update` 的頻率——那是拿公開影片的即時性換會員影片的即時性。鑑於會員影片本來就抓不到聊天，這個交換不划算，因此接受這個限制。

### feed 快取造成最多 15 分鐘的額外延遲

feed 是 900 秒 edge cache，所以發現延遲是「輪詢週期 + 最多 15 分鐘」。這無法規避——它是 YouTube 端的行為。同時它也讓輪詢週期壓到 15 分鐘以下變得沒有意義。pubsub 仍是即時管道，本子系統定位為補漏。

### 復活探測重用 crawledAt 的副作用

探測會把 `crawledAt` 更新為 now，而 `findRecentlyEndedVideos(1)` 以 `sort({ crawledAt: 1 })` 取 5 筆。對 `hbEnd` 落在一小時內、又剛好被探測到的 `Missing` 影片，會讓它在那條查詢裡往後排，少被 `videos.list` 抓一次。影響範圍是「剛結束一小時內」與「被判為 Missing」的交集，非常窄；為它新增一個 `Video` 欄位與對應索引不成比例。

### 復活探測輪完一圈可能耗時數週

每桶每天 1440 筆。若某桶累積數萬筆，輪完一圈要數週。復活是罕見事件，這個速度是刻意的取捨——加快只能靠提高每輪筆數，而那會線性增加對外請求量，卻幾乎不會多發現任何東西。

### 不接上 YoutubeWatchGate

如上「配額與速率預算」所述。實測證據顯示這些端點與 watch page 不共用限速器；接上去的代價（輪詢速度降為四分之一）換來的是對未觀察到的耦合做防護。

### 不改動 pubsub 訂閱機制

pubsub 仍是即時主力，其續訂節奏（每 10 分鐘 5 個頻道）與本子系統無關，不在本設計的變更範圍。兩者的寫入路徑共用同一組 model 方法，`noticeFromNotification()` 是 upsert，同一支影片被兩邊同時發現是冪等的。
