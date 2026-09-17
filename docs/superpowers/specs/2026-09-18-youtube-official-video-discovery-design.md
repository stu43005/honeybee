# YouTube 官方影片發現子系統設計

在 crawler 服務新增三個以官方管道發現影片的排程任務：頻道 RSS feed 輪詢、會員限定上傳播放清單（UUMO）掃描、以及已消失影片的復活探測。目的是補上 pubsub 漏送的影片、涵蓋 Holodex 完全不提供的上傳影片與會員影片，並讓消失後又恢復的影片能回到收錄範圍。

不改 data-contract，不改 worker 與 scheduler，不改既有的 Holodex 輪詢與 pubsub 訂閱機制。

## 問題

目前影片發現有三個來源，各有缺口：

1. **Holodex 輪詢**（`crawler holodex update live` / `update past`）——只回傳直播（`VideoType.Stream`），完全不含上傳影片與 shorts，且受 Holodex 自身的抓取延遲影響。
2. **PubSubHubbub push**（`src/modules/youtube-pubsub/`）——官方唯一的即時推送管道，但 hub 不保證送達：租約過期、服務停機、hub 自身丟棄，都會讓該次通知永久消失。通知一旦漏掉，沒有任何機制會重新發現那支影片——所有既有的候選查詢都要求文件已經存在於 videos collection。
3. **Raid 撿漏**（`noticeFromRaid`）——只在別人 raid 過來時才會發現，覆蓋面是偶然的。

此外，`status: Missing` 的影片一旦被標記就沒有回頭路。五條候選查詢裡只有 `findRecentlyEndedVideos(1)` 會碰到 `Missing`，且限縮在 `hbEnd` 一小時內，此外沒有任何機制會再看它一眼。而 `Missing` 有兩種來源，兩種都會永久卡住：

- `updateVideoFromYoutube()` 在 YouTube 省略該 id 時標記 `Missing` + `deleted`。私人轉公開、YouTube 暫時性的查詢失敗，都會讓影片永久停在這裡。
- 同一個函式的狀態機還會因為「排定時間已到但未開播超過 2 天」「有 `actualStart` 卻無觀眾數超過 2 天」（停止串流但沒關台）「無排程也無開播且發布超過 5 天」而標記 `Missing`，這時 `deleted` **不是** true。若該直播後來延期開播了、或後來補按了關台，沒有任何東西會察覺。

會員限定影片則是完全的空白：公開 RSS feed 不含它們，Holodex 不提供，pubsub 的 topic 是公開 feed 所以也推送不到。

## 目標

1. 任何訂閱頻道發布的新影片（含上傳影片、shorts、排程直播），即使 pubsub 漏送，也能在**一小時內**被發現。
2. 會員限定上傳影片能被發現並寫入 videos collection。
3. 消失後恢復可存取的影片，能自動回到收錄範圍；被超時判定為 `Missing` 的直播，若狀態後來真的改變，也有機會被更新。
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

新增 `src/components/youtube-discovery/`，crawler 負責註冊三個 agenda 任務、並在既有的 `crawler youtube update` 候選清單裡加入一條查詢，實作全在 component。所有 googleapis 呼叫集中在既有的 `src/modules/youtube.ts`。

```text
src/models/Video.ts                        差集寫入
  + noticeUnknownVideos(entries)

src/modules/youtube.ts                     唯一呼叫 googleapis 的檔案
  + updateVideoFromPlaylist(playlistId)      playlistItems.list

src/components/youtube-discovery/
  oembed.ts            零配額存在性探測（純 fetch）
  feed-poll.ts         一輪 feed 輪詢
  members-poll.ts      一輪 UUMO 探測 + 掃描
  existence-probe.ts   一輪復活探測
```

`oembed.ts` 同時被 members-poll（判定 UUMO 是否存在）與 existence-probe（判定影片是否恢復）使用，承載狀態碼分類與 URL 編碼的實際邏輯，不是給樣板程式取名的包裝。

`updateVideoFromPlaylist()` 收的是 **playlistId 而非 channelId**：播放清單就是它需要的全部輸入，寫死成「只能抓某個頻道的 UUMO」會讓它在任何其他播放清單上都用不了。本設計只用它掃 UUMO（公開上傳由零配額的 feed 涵蓋，見「feed 與 UU 播放清單等價」），但它對 `UU`、`UUMO` 或任何一般播放清單都成立。

### 共用寫入路徑

差集寫入放在 `VideoModel` 的 static，與既有的 `noticeFromNotification()` / `noticeFromRaid()` 同層：

```text
發現來源 → { videoId, title, channelId }[]
    ↓
VideoModel.noticeUnknownVideos(entries)
    ├ find({ id: { $in: ids } }).select("id")    差集比對
    └ 僅對未知的 id 執行 upsert                    status = New、crawledAt = null
```

放在 model 而不是 component，是因為兩邊都要用它，而分層只有這一個方向說得通：`updateVideoFromPlaylist()` 在 `src/modules/youtube.ts` 裡就要寫入結果，若差集邏輯住在 `src/components/` 底下，module 就得反向依賴 component。model 是兩者共同的下游。

到此為止——**寫入路徑不呼叫 `updateVideoFromYoutube()`**。

**差集比對不可省略。** `noticeFromNotification()` 的 `$set` 含 `crawledAt: null`。若每輪對 feed 裡全部 15 支影片（絕大多數是已知的）都呼叫一次，等於持續把數千支已知影片丟回 `crawler youtube update` 的補抓佇列，把真正的 live 影片擠出 `.slice(0, 100)` 的名額——這正是 `2026-09-09-crawler-unconfirmed-video-cleanup-design.md` 記錄過的排擠問題。

pubsub 的 `routes.ts` 維持原樣、不改用這個 static：它需要逐支影片的 `upsertedCount` 來決定要不要立刻補 metadata 與記 log，而它的通知量本來就只有真正變動的那幾支，沒有差集的必要。

### 為什麼不在發現當下補 metadata

`src/modules/youtube-pubsub/routes.ts` 在回應 hub 之後會立刻對新影片呼叫 `updateVideoFromYoutube()`，因為 pubsub 是即時管道——推送到達時直播可能再幾分鐘就開播，metadata 晚一輪就來不及。

本子系統沒有這個需求：feed 發現本身已經落後最多 45 分鐘，UUMO 影片抓不到聊天，再省下的幾分鐘沒有任何價值。而代價很具體：`updateVideoFromYoutube()` 是**每個呼叫**至少消耗 1 unit（`videos.list` 一批最多 50 支），所以在發現當下逐頻道呼叫，配額用量會正比於「有新影片的頻道數」，而那個數字在首次上線、新增訂閱、或長時間停機後的回補時會急遽上升——固定批次大小完全保護不到它。

交給既有的 `crawler youtube update` 之後，補 metadata 的配額是**每分鐘最多 2 units 的固定上限**，與發現量完全無關。

代價是吞吐量：該任務的候選查詢前兩條是 `{ status: New }` 與 `{ crawledAt: null }`，各取 25 筆、都以 `_id` 遞減排序，而 `noticeFromNotification()` 同時寫入 `status: New` 與 `crawledAt: null`——所以本子系統發現的影片會**同時命中兩條查詢**，經 `Set` 去重後實際只佔 25 個名額，不是 50。補 metadata 的吞吐量因此是 **25 支/分鐘 = 36000 支/天**。

這讓本子系統的**全部**配額用量收斂成一個常數：`YOUTUBE_MEMBERS_POLL_BATCH_SIZE` × 每日輪數。

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
3. 取出 `type === "video"` 的 entry，交給 `VideoModel.noticeUnknownVideos()`。
4. 無論成功或失敗，更新 `feedCrawledAt`。

### 發現延遲

```
最壞延遲 = 輪詢週期 + feed 快取延遲
         = (訂閱頻道數 ÷ 每小時處理量) + 15 分鐘
```

300 個訂閱頻道時：20 筆 × 30 輪/小時 = 600 頻道/小時，週期約 30 分鐘，最壞延遲約 **45 分鐘**。

一小時的目標要求週期 ≤ 45 分鐘，也就是訂閱頻道數 ≤ 600 × 0.75 = **450**。超過 450 之後延遲會線性成長（600 個頻道時約 75 分鐘），此時要維持目標只能提高 `YOUTUBE_FEED_POLL_BATCH_SIZE`——feed 是零配額的，唯一的代價是對外請求量，實測餘裕足以支撐。這個門檻記於「Non-goals / Accepted limitations」。

900 秒的 edge cache 同時也是輪詢週期的自然下限：週期壓到 15 分鐘以下只是重複取得同一份快取，沒有任何收益。

## 任務二：UUMO 掃描

任務名稱 `crawler youtube members poll`，每 5 分鐘一輪。一輪內依序做兩件事。

### 存在性探測（零配額）

對每個頻道以 oEmbed 請求 `https://www.youtube.com/playlist?list=UUMO<suffix>`：

| oEmbed 回應                | `hasMembersPlaylist` | `membersProbeNextAt`       |
| -------------------------- | -------------------- | -------------------------- |
| 200                        | `true`               | `now + TTL_MS`（7 天）     |
| 404                        | `false`              | `now + TTL_MS`（7 天）     |
| 其他狀態碼、逾時、網路錯誤 | 不改變               | `now + RETRY_MS`（1 小時） |

候選查詢：

```text
findSubscribed() 且 (membersProbeNextAt 為 null 或早於 now)
依 membersProbeNextAt 遞增排序，取 YOUTUBE_MEMBERS_PROBE_BATCH_SIZE 筆
```

**時間戳記的是「下次何時能再探測」，不是「上次何時探測過」。** 這個方向的選擇是必要的，不是風格偏好：若只記錄上次探測的時間、再由查詢統一套用七天 TTL，每一次不確定的結果都會被迫在兩個壞結果之間二選一——

- 更新時間戳 → 一個判定為 `false`、後來才開會員的頻道，好不容易在七天後輪到重探，只要那一次逾時，過期的判定就又被續了七天。反覆失敗能讓一個早該作廢的否定結論無限續命，而掃描候選的條件是 `hasMembersPlaylist: true`，該頻道的會員影片在這期間完全發現不到。
- 不更新時間戳 → 該頻道永遠排在最前，每輪重試、每輪失敗，把探測名額全部吃光。

把有效期寫進時間戳本身，兩個問題同時消失：結論性的答案推遲七天，不確定的答案只推遲一小時，而兩者都推遲了，所以都不會卡住佇列。

這裡刻意**不**照抄 `findPubsubRenewalCandidates` 的兩欄位形狀（`pubsubExpiresAt` + `pubsubRequestedAt`）。那邊必須拆成兩個，是因為 `pubsubExpiresAt` 是 hub 給的租約到期時間——外部事實，不由我們決定，所以節流只能用另一個欄位表達。這裡的有效期完全由我們自己算，直接算成「下次可探測時間」就夠了。

七天與一小時的差別對應的是**答案的可信度**：「這個頻道有沒有開會員」幾乎不變，所以問到答案就能放心擱七天；沒問到答案則什麼都沒學到，一小時後該再問一次。一小時也夠長，讓持續失敗的頻道不會反覆佔住探測名額。

新頻道的 `membersProbeNextAt` 為 null，排序時排最前，會優先被探測——與 `findPubsubRenewalCandidates` 相同的技巧。

### 播放清單掃描（每頻道 1 unit）

候選查詢：`ChannelModel.findSubscribed()` 且 `hasMembersPlaylist: true`，依 `membersCrawledAt` 遞增排序，取 `YOUTUBE_MEMBERS_POLL_BATCH_SIZE` 筆。

每個頻道把 `UC<suffix>` 轉成 `UUMO<suffix>` 後呼叫 `updateVideoFromPlaylist(playlistId)`（`playlistItems.list`，`part: ["snippet", "contentDetails"]`，`maxResults: 50`，不翻頁），它把每筆項目映射成 `{ videoId, title, channelId }` 並交給 `noticeUnknownVideos()`；回來之後更新 `membersCrawledAt`。

映射取的是 `contentDetails.videoId`（不是 `snippet.resourceId.videoId`——兩者同值，但前者是 playlistItems 專為此提供的欄位）、`snippet.title`、以及 `snippet.videoOwnerChannelId`。最後一個是**影片擁有者**的頻道，與「誰把它加進播放清單」的 `snippet.channelId` 不同；對 UU / UUMO 這種自動播放清單兩者相同，但取擁有者欄位在其他播放清單上也正確。

分成兩條候選查詢而非一條的原因：沒有會員影片的頻道若混在掃描佇列裡，會白白佔用名額卻不產生任何發現。分開之後，配額預算直接等於 `YOUTUBE_MEMBERS_POLL_BATCH_SIZE`，與「有多少頻道沒開會員」無關。

### 覆蓋週期

15 筆 × 12 輪/小時 = 每小時可掃 180 個有 UUMO 的頻道。若 300 個訂閱頻道中有 240 個開了會員，週期約 **80 分鐘**，超過一小時目標。這是配額硬約束下的必然結果，記於「Non-goals / Accepted limitations」。

## 任務三：復活探測

`Missing` 有兩種來源，而 oEmbed 只回答得了其中一種，所以兩者用不同手段處理。

| `Missing` 的來源                                        | `deleted` | 影片在 YouTube 上 | oEmbed 能回答嗎                    |
| ------------------------------------------------------- | --------- | ----------------- | ---------------------------------- |
| `videos.list` 查不到（已刪除 / 轉私人）                 | `true`    | 不可存取          | **能**：404 仍消失，200 是真的復活 |
| 排定時間已到但未開播超過 2 天                           | 不是 true | **存在**          | 不能：**恆為 200**                 |
| 有 `actualStart`、無觀眾數、超過 2 天（停止串流未關台） | 不是 true | **存在**          | 不能：**恆為 200**                 |
| 無排程也無開播，`publishedAt` 超過 5 天                 | 不是 true | **存在**          | 不能：**恆為 200**                 |

後三種被標為 `Missing` 的原因與「影片是否存在」無關，對它們做存在性探測拿不到任何新資訊：結果必然是 200，轉回 `New` 之後 `videos.list` 必然重新走同一段狀態機、得出同一個 `Missing`。那會形成一個只增不減的空轉——這類影片每有一場停串未關台的直播就多一筆且永久留存，而每一輪都會挑出固定筆數送回去重查。

### deleted 的 Missing：oEmbed 探測

任務名稱 `crawler youtube existence probe`，每 5 分鐘一輪。兩個分桶，各自獨立查詢、各取 `YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE` 筆：

| 桶  | `deleted` | `availableAt`                                  |
| --- | --------- | ---------------------------------------------- |
| 1   | `true`    | 晚於 `now - YOUTUBE_EXISTENCE_PROBE_RECENT_MS` |
| 2   | `true`    | 早於該界線                                     |

兩桶皆附加 `status: VideoStatus.Missing`，依 `crawledAt` 遞增排序。

分桶的目的是公平性：兩週以前消失的族群遠大於近期的，單一查詢會讓它獨占所有名額，近期消失、最可能復活的影片永遠排不到。

每支影片以 oEmbed 請求 `https://www.youtube.com/watch?v=<id>`：

- **200** → `updateOne`：`status` 設為 `New`，移除 `deleted` 與 `detectedDeletionAt`，`crawledAt` 設為 null。
- **其他**（404 私人或不存在、400 無效 id、網路錯誤）→ 只把 `crawledAt` 更新為 now。

使用 `updateOne` 而非 document `save()`：這些正是 `2026-09-09-crawler-unconfirmed-video-cleanup-design.md` 描述的族群，可能缺少 `title` / `channelId` 這類 required 欄位，`save()` 會被 validator 擋下、寫不進去，於是每輪重複被選中。

`crawledAt` 設為 null 會讓該影片在分桶查詢裡排到最前，但它此時 `status` 已是 `New`、不再命中 `status: Missing` 的分桶，不會被重複探測；同時 `crawler youtube update` 的 `{ crawledAt: null }` 查詢會撿回去補 metadata。

### 非 deleted 的 Missing：加進 crawler youtube update 的候選清單

這類影片需要的是 `videos.list`——只有它看得出直播狀態有沒有改變（延期的直播後來真的開播了、停串的直播後來補按了關台）。目前沒有任何機制會重查它們：五條候選查詢裡只有 `findRecentlyEndedVideos(1)` 碰得到 `Missing`，且限縮在 `hbEnd` 一小時內。

因此在 `crawler youtube update` 的候選清單裡加入第六條查詢：

```text
{ status: Missing, deleted: { $in: [null, false] } }
依 crawledAt 遞增排序，取 2 筆
```

筆數寫成字面值、理由寫進候選清單上方的區塊註解，與該處既有的每一個 `limit` 一致，不抽成常數。取 2 是因為這條查詢的期望收益低而族群龐大：多數「停串未關台」的直播，YouTube 端永遠不會補上 `actualEnd`，設高只會等比例放大無效重查。每天 2880 筆，對照約 36000 個補抓名額。

影片全程維持 `Missing`，不再有 `Missing → New → Missing` 的狀態往返；重查後 `crawledAt` 被更新為 now，它自然排到隊尾，族群再大也只是拉長輪替週期。

**插入位置是 `findRecentlyEndedVideos(1)` 之後、最後那條 `findLiveVideos()` 之前**，而既有的每一條查詢都不動——包括最後那條的 `limit(100)`。

那段 `Set` 的順序決定實際優先級，`.slice(0, 100)` 是總上限，而最後那條 `findLiveVideos().sort({ crawledAt: 1 }).limit(100)` 的角色是**填滿剩下的空間**：它的 100 不是配給 live 的名額，而是確保前面幾條即使全部落空，它也有足夠的候選把整個 slice 填滿。因此新查詢放在它之前，就是在 slice 裡穩定取得那 2 個位置，而最終入選的 live 影片相應少 2 個——這是排序自然產生的結果，不需要也不應該去改它的 limit。

反過來放在最末則不可行：live 那條涵蓋**所有** Upcoming 與 Live 影片，在數百個訂閱頻道下經常就能把 slice 填滿，排在它後面的查詢等於永遠輪不到。

這是本設計唯一一處改動 `crawler youtube update` 的既有邏輯，而且是純粹的新增——插入一條查詢，不修改任何既有查詢。

## Schema 變更

`Channel` 新增四個欄位，全部 optional，不影響既有文件：

```ts
/** When we last fetched this channel's RSS feed. */
@prop()
public feedCrawledAt?: Date;

/** Whether the channel has a members-only uploads playlist. Unset until a
 * probe reaches a conclusion. */
@prop()
public hasMembersPlaylist?: boolean;

/** Earliest time the existence probe may run for this channel again. Set to
 * now plus the long TTL after a conclusive answer, now plus the short retry
 * after an inconclusive one. */
@prop()
public membersProbeNextAt?: Date;

/** When we last read the members-only uploads playlist. */
@prop()
public membersCrawledAt?: Date;
```

探測（`membersProbeNextAt`）與掃描（`membersCrawledAt`）是兩個欄位，因為節奏差兩個數量級：探測是七天一次的零配額動作，掃描是每輪都花 1 unit 的動作，合併會讓其中一邊失去意義。

`Video` **不新增欄位**，只新增一個 static（`noticeUnknownVideos()`，見「共用寫入路徑」）。

### 索引

| 查詢            | 索引                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| feed 候選       | `{ feedCrawledAt: 1 }`                                                       |
| UUMO 掃描候選   | `{ hasMembersPlaylist: 1, membersCrawledAt: 1 }`                             |
| UUMO 探測候選   | `{ membersProbeNextAt: 1 }`                                                  |
| 復活探測兩分桶  | `{ deleted: 1, availableAt: 1, crawledAt: 1 }`，partial on `status: Missing` |
| 非 deleted 重查 | 同上（`deleted` 相等、`crawledAt` 排序，`availableAt` 不參與）               |

兩種查詢共用同一個索引。分桶查詢的排序欄位排在範圍條件之後、非 deleted 重查則整個跳過中間的 `availableAt`，兩者理論上都會落在 in-memory sort；但 `limit` 只有 5 與 2，使其成為 top-k 排序，記憶體用量是常數，不觸及 32MB 上限。

`deleted` 的「非刪除」分支寫成 `{ $in: [null, false] }` 而非 `{ $ne: true }`，維持 equality 形狀以利用索引；欄位不存在時 `null` 也會命中。

三條 Channel 候選查詢全部建立在 `findSubscribed()` 之上（沿用既有的 `SubscribedQuery`），與 `findPubsubRenewalCandidates` 同一個形狀——不再訂閱的頻道自動退出輪替，不需要額外的清理機制。

## 常數

新增於 `src/constants.ts`。時間類常數依專案慣例以 `_MS` 結尾並以毫秒儲存。

```ts
// --- YouTube official video discovery (src/components/youtube-discovery/) ---

// Channels fetched in one feed-poll round. On the 2-minute schedule that is 600
// channels/hour. Discovery latency is one rotation plus the feed's 15-minute
// edge cache, so the one-hour target holds up to 450 subscribed channels; 300
// channels land around 45 minutes. Raise this if the subscription list grows
// past that — the feed costs no quota, only outbound requests.
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
// costs one quota unit, so on the 5-minute schedule this is 4320 units/day.
// That is what the 10000-unit daily budget can spare once every existing
// consumer is counted, not just the two scheduled jobs: the pubsub notification
// handler hydrates each newly inserted video outside any cap, and the raid
// handle lookup and the moderator commands are uncapped too. The buffer left
// over absorbs the ones that cannot be bounded in advance.
export const YOUTUBE_MEMBERS_POLL_BATCH_SIZE = 15;

// Channels probed per round for whether a members-only uploads playlist exists.
// Costs no quota; 3 per round is 864 probes/day, enough to re-probe every
// channel well inside the TTL below.
export const YOUTUBE_MEMBERS_PROBE_BATCH_SIZE = 3;

// How far ahead a CONCLUSIVE probe pushes the channel's next probe. Whether a
// channel offers memberships almost never changes, so a channel that newly
// opens them is picked up within a week and asking more often buys nothing.
export const YOUTUBE_MEMBERS_PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// How far ahead an INCONCLUSIVE probe pushes it instead (a 5xx, a timeout, a
// network error). A channel with no conclusion is excluded from the playlist
// scan, so pushing a failure out by the full week would hide that channel's
// members-only videos until then — and on first rollout every channel takes
// that path. An hour keeps the blast radius in hours, and still pushes a
// persistently failing channel far enough back that it cannot reclaim a probe
// slot every round.
export const YOUTUBE_MEMBERS_PROBE_RETRY_MS = 60 * 60 * 1000;

// Videos each of the two buckets contributes to one existence-probe round.
// Two buckets x 5 x 288 rounds/day = 2880 probes/day, all quota-free. Only
// videos YouTube no longer returns are probed: for the ones marked Missing by a
// timeout heuristic the video still exists, so oEmbed would answer 200 every
// time and teach us nothing.
export const YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE = 5;

// The availableAt boundary splitting recent Missing videos from old ones. A
// video that vanished in the last two weeks is far likelier to return than one
// gone for years, and the split stops the much larger old population from
// starving the recent one.
export const YOUTUBE_EXISTENCE_PROBE_RECENT_MS = 14 * 24 * 60 * 60 * 1000;
```

非 deleted 重查的筆數**不在這裡**。`crawler youtube update` 的候選清單把每一個 `limit` 都寫成字面值、理由集中在清單上方的區塊註解，新查詢照同一個慣例走，不抽成常數。

## 配額與速率預算

### 既有消費者

專案裡呼叫 YouTube Data API 的**全部**位置，不只排程任務：

| 呼叫點                                               | 觸發                     | 有無上限          | 估計/天 |
| ---------------------------------------------------- | ------------------------ | ----------------- | ------- |
| `crawler.ts` `crawler youtube update`                | 排程，每分鐘             | 有：每輪最多 2 批 | 2880    |
| `crawler.ts` `crawler youtube update channels`       | 排程，每 5 分鐘          | 有：每輪 1 批     | 288     |
| `routes.ts` pubsub 通知後的 `updateVideoFromYoutube` | 每次通知含新影片         | **無**            | 約 600  |
| `worker.ts` `updateChannelByHandle`                  | raid 遇到未知 handle     | **無**            | 數十    |
| `mod/crawl.ts`、`mod/set-channel.ts`                 | Discord 管理員手動       | 人工              | 個位數  |
| `youtube.ts` 內部補抓未知頻道                        | 影片的頻道不在 DB 時隨附 | 隨附於上          | 少量    |

前兩列是**固定上限**：`crawler youtube update` 每輪最多把 100 個 videoId 切成 2 批，不論候選清單裡有多少東西。其餘幾列**沒有上限**，只能估算：pubsub 那一列約等於每天新影片數（每則含新影片的通知一次呼叫），raid handle 與管理員指令則取決於使用情形。

保守合計約 **3900 units/天**，剩約 6100。

### 本子系統的支出

| 來源              | 配額/天  | 對外請求/天 |
| ----------------- | -------- | ----------- |
| feed 輪詢         | 0        | 14400       |
| UUMO 存在性探測   | 0        | 864         |
| UUMO 播放清單掃描 | 4320     | —           |
| 復活探測          | 0        | 2880        |
| 非 deleted 重查   | 0        | —           |
| **合計**          | **4320** | **18144**   |

加上既有的約 3900，總計約 **8220 units/天**，留約 1780 緩衝。緩衝的用途正是吸收上表那三列估不準的部分——新影片數暴增、raid 密集、管理員大量手動抓取。

非 deleted 重查的配額是 0，因為它不新增任何 API 呼叫：它只是往 `crawler youtube update` 的候選清單多塞兩個 id，而那一輪的呼叫次數由 `.slice(0, 100)` 決定，與清單裡有多少東西無關。代價是從 live 影片的補抓那裡挪走兩個名額，不是配額。

新發現影片的 metadata 補抓**不出現在本子系統這張表裡**，因為它不是本子系統的支出：發現路徑只寫 DB，補抓由既有的 `crawler youtube update` 在它固定的 2 units/分鐘預算內完成。這是本設計唯一能讓「配額上限與發現量無關」成立的前提——若改成在發現當下逐頻道呼叫 `videos.list`，配額就會正比於有新影片的頻道數，而首次上線與長時間停機後的回補會讓那個數字暴增。

因此本子系統的每日配額是一個**可以直接算出來的常數**：

```text
YOUTUBE_MEMBERS_POLL_BATCH_SIZE × 每日輪數 = 15 × 288 = 4320
```

它不隨訂閱頻道數、不隨發現影片數、不隨首次上線的回補量變化。頻道變多只會拉長輪詢週期。

本設計**不**新增跨 process 的配額計數器或預留機制。要讓「保留多少額度給 metadata 更新」成為可強制執行的約束，需要一個共享的每日計數器（Redis）、每個呼叫點都去扣減、以及超額後的降級策略——那等於為所有既有呼叫點補上它們現在沒有的節流，範圍遠超本設計。這裡採取的做法是把唯一由本設計引入的支出定死成常數，並把緩衝留給估不準的既有消費者；若日後真的觀察到配額耗盡，該處理的是那些無上限的既有呼叫點，不是本子系統。

請求速率：每輪突發 4 req/s（spacing 250 ms），三個任務若同時觸發最壞 12 req/s，平均 0.244 req/s。實測安全值是 10 req/s 持續與 120 並發突發，平均速率遠低於此。

**不接上 `YoutubeWatchGate`。** 證據顯示這些端點與 watch page 是不同後端、不共用限速器；硬接上去會讓 feed 輪詢排隊等 worker 的全域 1 req/s 預算，把一輪 20 個頻道從 5 秒拖到 20 秒，換來的是對一個未觀察到的耦合做防護。若日後實際觀察到 429，那是另一份設計要處理的事。

## 錯誤處理

**時間戳一律推進，成功失敗皆然。** 一個持續失敗的頻道若不推進時間戳，會固定佔住輪替佇列最前排，每輪重試、每輪失敗，吃光整輪名額。推進後它自然掉到隊尾。這與 `renewPubsubSubscriptions()` 對 `pubsubRequestedAt` 的處理同一個理由。

推進的**幅度**才隨結果而異，這一點對 `membersProbeNextAt` 尤其關鍵：得到結論推七天，沒得到結論只推一小時（見「存在性探測」）。`feedCrawledAt` 與 `membersCrawledAt` 沒有這個區分——它們記錄的是「上次處理時間」，失敗與成功一樣寫入 now。

**單筆失敗不中斷整輪**，唯一例外是配額耗盡。`playlistItems.list` 回 403 `quotaExceeded` 是全域狀態，繼續只會繼續失敗——照 `renewPubsubSubscriptions()` 對 throttled 的處理，記一行 warn 後中止本輪，已處理頻道的時間戳保留，其餘留給下一輪。

**逾時與 agenda lock。** 每輪最壞耗時：

| 任務     | 每輪筆數 | 最壞耗時 |
| -------- | -------- | -------- |
| feed     | 20       | 3.4 分   |
| UUMO     | 15 + 3   | 4.3 分   |
| 復活探測 | 10       | 1.7 分   |

feed 的週期是 2 分鐘，最壞耗時會與下一輪重疊，由 agenda 的 job lock 保證不並發、重疊時順延。這是安全的降級——全部請求同時逾時是極端情況，正常一輪約 5 秒。agenda 的 `lockLifetime` 預設值與重疊時的實際行為屬第三方套件行為，實作計畫階段須以 research 確認後再決定是否需要顯式設定，本設計不對其做假設。

## 測試策略

Jest ESM（`jest.unstable_mockModule` + 動態 import）。重點放在能抓到迴歸的斷言，而非覆蓋率。

| 測試                 | 斷言                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 差集（全部已知）     | 15 筆全是已知影片 → `noticeUnknownVideos()` 內部零次 upsert                                                                               |
| 差集（部分未知）     | 15 筆中 2 筆未知 → 實際被 upsert 的 id 集合 `toEqual` 恰好那 2 個                                                                         |
| 發現路徑不花配額     | 一輪 feed 輪詢處理完含新影片的頻道後，`videos.list` 零次呼叫                                                                              |
| 播放清單欄位映射     | 一筆 `playlistItems` 項目 → `toEqual({ videoId: contentDetails.videoId, title: snippet.title, channelId: snippet.videoOwnerChannelId })`  |
| 配額中止             | 第 3 個頻道回 `quotaExceeded` → 第 4 個起不再呼叫 API，前 3 個的 `membersCrawledAt` 已寫入                                                |
| 失敗不卡前排         | 頻道 A 拋錯 → `feedCrawledAt` 仍更新；第二輪的候選查詢不再選到 A                                                                          |
| 分桶公平性           | 其中一桶為空 → 另一桶仍取滿 N                                                                                                             |
| 不探測非 deleted     | 候選集合含 `deleted` 非 true 的 `Missing` 影片 → 該輪對它零次 oEmbed 呼叫，且它的 `status` 不被改成 `New`                                 |
| 非 deleted 走重查    | `crawler youtube update` 的候選 id 集合含 `deleted` 非 true 的 `Missing` 影片，且該影片全程維持 `status: Missing`（不經過 `New`）         |
| 復活寫入             | oEmbed 200 → `status: New`、`deleted` 與 `detectedDeletionAt` 被移除、`crawledAt` 為 null；404/400 → 只更新 `crawledAt`，`status` 不動    |
| oEmbed 分類          | 200/404/400/網路錯誤 四種輸入的分類結果，以及 URL 編碼正確（內層 `?v=` 必須被編碼）                                                       |
| 結論性探測套 TTL     | 得到 200 或 404 的頻道，在七天內不再進入探測候選；`hasMembersPlaylist: false` 的頻道不觸發任何 API 呼叫                                   |
| 首次探測失敗可重試   | 首次探測逾時（`hasMembersPlaylist` 仍未知）→ 該頻道在一小時後**重新**進入探測候選，而非七天後                                             |
| 已有結論者失敗可重試 | `false` 的頻道在 TTL 到期後重探又逾時 → `membersProbeNextAt` 只推進一小時；連續三次逾時後它仍每小時回到候選，證明過期的結論沒有被續成七天 |

前三項是最重要的迴歸防線。第一、二項守住「每輪把數千支已知影片丟回補抓佇列」這個會靜默拖垮 `crawler youtube update` 的失誤；第三項守住整份設計的配額前提——一旦有人在發現路徑上加回 `updateVideoFromYoutube()`，配額就不再是常數，而這個測試會立刻失敗。

最後兩項守住「不確定的探測只推遲一小時」這條規則。前者對應首次上線的必經路徑（每個頻道都是第一次探測）；後者對應更難發現的那條路徑——已有結論的頻道在 TTL 到期後重探失敗，若失敗也套用七天，過期的結論會被無限續命。兩者都要用 stateful fake 記下前一輪寫入的 `membersProbeNextAt`，再以推進後的時間重跑候選查詢，才能觀察到推遲的究竟是一小時還是七天。

資料庫狀態使用 stateful fake（一個 `Set` 裝已知 videoId、一個 `Map` 裝 channel 文件），不是裸 `jest.fn()`——「第二輪不再選到 A」這類斷言必須能觀察到第一輪寫入的時間戳。

## Non-goals / Accepted limitations

以下項目經評估後明確不做，或接受其限制。

### 不回補頻道歷史影片

只做增量發現：feed 的 15 筆窗口、UUMO 播放清單的首頁 50 筆，不翻頁、不做一次性深掃。頻道歷史影片的價值遠低於導入成本（大量文件湧入會排擠即時影片的 metadata 補抓名額）。

### 會員影片只做記錄，不抓聊天

worker 沒有任何 cookie / credentials 設定，`src/commands/worker.ts` 對會員限定影片直接回 `ErrorCode.MembersOnly`。UUMO 掃描寫入的影片，價值在於 metadata 記錄、webhook 通知與 track 統計，不在聊天收集。要抓會員聊天需要 worker 具備會員身分，屬於另一份設計的範圍。

### UUMO 覆蓋週期可能超過一小時

若訂閱頻道中開了會員的超過 180 個，UUMO 的輪替週期會線性超過一小時（240 個時約 80 分鐘）。要壓回一小時內，唯一的辦法是提高 `YOUTUBE_MEMBERS_POLL_BATCH_SIZE`，而那必須從別處挪配額——削減 `crawler youtube update` 的頻率，或壓縮留給那些無上限既有呼叫點的緩衝。前者是拿公開影片的即時性換會員影片的即時性，後者是拿安全邊際換即時性。鑑於會員影片本來就抓不到聊天（見上），兩種交換都不划算，因此接受這個限制。

### 一小時的發現目標以 450 個訂閱頻道為界

feed 輪詢的吞吐量是常數（600 頻道/小時），而延遲還要加上最多 15 分鐘的快取，所以一小時的目標只在訂閱頻道數 ≤ 450 時成立。超過之後延遲線性成長（600 個頻道約 75 分鐘）。

這不是設計缺陷而是刻意的優先序：批次大小固定正是讓配額與請求量可預測的手段，若改成隨頻道數自動放大，成長就會直接吃掉既有流量的餘裕。頻道真的成長到 450 以上時，調整方式很單純——提高 `YOUTUBE_FEED_POLL_BATCH_SIZE`。feed 是零配額的，唯一的代價是對外請求量，而實測餘裕（10 req/s 持續、120 並發無 429）遠大於調整所需。本設計不自動化這個調整，因為自動化需要的觸發條件與安全上限，會比一個常數複雜得多。

### feed 快取造成最多 15 分鐘的額外延遲

feed 是 900 秒 edge cache，所以發現延遲是「輪詢週期 + 最多 15 分鐘」。這無法規避——它是 YouTube 端的行為。同時它也讓輪詢週期壓到 15 分鐘以下變得沒有意義。pubsub 仍是即時管道，本子系統定位為補漏。

### 復活探測重用 crawledAt 的副作用

探測會把 `crawledAt` 更新為 now，而 `findRecentlyEndedVideos(1)` 以 `sort({ crawledAt: 1 })` 取 5 筆。對 `hbEnd` 落在一小時內、又剛好被探測到的 `Missing` 影片，會讓它在那條查詢裡往後排，少被 `videos.list` 抓一次。影響範圍是「剛結束一小時內」與「被判為 Missing」的交集，非常窄；為它新增一個 `Video` 欄位與對應索引不成比例。

`crawledAt` 現在同時是三件事的時間戳：`crawler youtube update` 記錄的抓取時間、復活探測的探測時間、以及非 deleted 重查的輪替順序。三者不衝突，因為它們表達的是同一件事——「這份文件上次被檢視是什麼時候」——而每一個都想要「最久沒被檢視的優先」。

### 兩個輪替都可能耗時數週

復活探測每桶每天 1440 筆；非 deleted 的重查每天 2880 筆。任一族群累積到數萬筆時，輪完一圈都要數週。

兩者的成因不同但結論一樣。復活是罕見事件，加快只能靠提高每輪筆數，卻幾乎不會多發現任何東西。非 deleted 的重查則是命中率本來就低——多數「停串未關台」的直播，YouTube 端永遠不會補上 `actualEnd`，重查一萬次結論都一樣；這條查詢存在的價值只在於「延期後真的開播了」與「後來補按關台」這兩種確實會發生、但目前完全沒有機制能察覺的情況。把它的每輪筆數壓在 2，正是因為它的期望收益低而族群龐大——設高只會等比例放大無效重查。

### 不為首次上線的 metadata 積壓做優先佇列

**關切**：本子系統發現的影片同時命中 `crawler youtube update` 的 `{ status: New }` 與 `{ crawledAt: null }` 兩條候選查詢，`Set` 去重後只佔 25 個名額，所以補 metadata 的吞吐量是 25 支/分鐘。首次上線時最多約 4500 支未知影片需要約三小時消化；而兩條查詢都是 `sort({ _id: -1 })`，後發現的影片會把先發現的往後推。積壓期間，一支「漏掉 pubsub 的直播」可能要等到開播之後才拿到 metadata、被 scheduler 看見。

**決定**：不實作有界的上線導入，也不實作按緊急度排序的 metadata 佇列。

**理由**：積壓的內容幾乎全是上傳影片與 shorts——直播早就被 Holodex 輪詢與 pubsub 收錄了，首次上線時真正「未知」的正是那些從來沒有任何來源提供過的非直播影片，而它們沒有時效性。積壓只發生在首次上線這個一次性事件，穩定狀態下每分鐘的新影片遠少於 25，佇列是空的。相對地，優先佇列要改寫 `crawler youtube update` 的候選查詢，而那段查詢的 cap 設計有明確的歷史教訓（`2026-09-09-crawler-unconfirmed-video-cleanup-design.md`），為一次性事件去動它不成比例。

### 不把復活傳播到歷史 daily export

**關切**：`src/components/chats-archive/gen-daily-videos-file.ts` 的 `finalizeFilter` 有三個分支——卡住的 `Live`、`actualEnd` 在最近視窗內的 `Past`、`detectedDeletionAt` 在最近視窗內的 `Missing`。一支幾週前結束、被標為 `Missing`、現在復活回到 `Past` 的影片三個分支都不命中（`actualEnd` 太舊，而 `detectedDeletionAt` 已被復活流程移除），它所屬日期的 daily JSON 會一直保留 `Missing` 狀態，除非該日碰巧有別的影片觸發重產生。

**決定**：不在復活時排程重產受影響的歷史日期，也不加重試機制。

**理由**：復活本身是罕見事件，影響範圍是歷史歸檔 JSON 裡的一個狀態欄位過時，不影響任何即時行為。而修法必須動到 `chats-archive`（新增 `Video` 欄位並擴充 `finalizeFilter`），那需要通過 data-contract checklist，超出本設計「不改 data-contract、不動 chats-archive」的硬約束。

### 分桶依據是影片時間，不是「消失時間」

**關切**：復活探測以 `availableAt` 分新舊兩桶，而 `availableAt` 是影片的開播或發布時間，不是它變成 `Missing` 的時間。一支幾個月前的錄影今天轉為私人，會立刻落進「舊」的那一桶，排在累積數週的老候選後面。

**決定**：維持 `availableAt`，不改用 `detectedDeletionAt`，也不新增「何時變成 Missing」的時間戳。

**理由**：這個關切的前提不成立。`Missing` 不等於被刪除——超時判定那一類根本沒有任何「消失事件」可以標時間；而 `detectedDeletionAt` 記的是「我們**看到**它消失的時間」，由輪詢排程決定，不是影片真正變得不可存取的時間，拿它當「剛消失」的依據一樣不準。分桶的目的也不是按消失時間排序，而是**讓比較新的影片有機會分到名額**，不被數量龐大的老影片完全擠掉——`availableAt` 正是表達「比較新」的正確欄位。舊影片重新抓取本來就慢，那是預期內的。

### 不接上 YoutubeWatchGate

如上「配額與速率預算」所述。實測證據顯示這些端點與 watch page 不共用限速器；接上去的代價（輪詢速度降為四分之一）換來的是對未觀察到的耦合做防護。

### 不改動 pubsub 訂閱機制

pubsub 仍是即時主力，其續訂節奏（每 10 分鐘 5 個頻道）與本子系統無關，不在本設計的變更範圍。兩者的寫入路徑共用同一組 model 方法，`noticeFromNotification()` 是 upsert，同一支影片被兩邊同時發現是冪等的。
