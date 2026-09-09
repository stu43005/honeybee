# crawler 未確認影片清理與批次隔離設計

修掉 `crawler youtube update` 每分鐘失敗一次的 `Video validation failed`，並讓
單筆影片的失敗不再中止整批更新。不動 `Video` / `Channel` 的 schema，不動對外的
data-contract。

## 問題

正式環境的 `crawler youtube update` 反覆丟出：

```
Video validation failed: channelId: Path `channelId` is required., title: Path `title` is required.
```

### 根因

1. `VideoModel.noticeFromRaid()` 以 `updateOne(..., { upsert: true })` 建立佔位
   文件，`$setOnInsert` 明確寫入 `channelId: ""` 與 `title: ""`。driver 層的
   upsert 不執行 mongoose validator，所以這種文件寫得進 DB。
2. mongoose 的 String required validator 判定空字串為未填
   （`SchemaString._checkRequired = v => (...) && v.length`），所以同一份文件
   之後只要走 document `save()` 就必定驗證失敗。
3. `updateVideoFromYoutube()` 在 YouTube 省略該 id 時（已刪除／私人／不存在，
   API 回 200 但 items 不含它）走 else 分支，只設 `status = Missing`、
   `deleted`、`detectedDeletionAt`，不會補上 `channelId` / `title`，接著呼叫
   `save()` → 拋 `ValidationError`。
4. `save()` 失敗表示整份文件沒有落盤，DB 裡的 `status` 仍是 `New`、`crawledAt`
   仍是 `null`。候選清單的前兩條查詢正是 `{ status: New }` 與
   `{ crawledAt: null }`，於是下一分鐘再撿到同一筆，無限重複。

現有的 `if (!ytInfo && !existing) continue;` 守衛只擋「從未見過的 id」，擋不住
已經被佔位寫進 DB 的文件。

### 影響

- **整批中止**：per-video 迴圈沒有 try/catch，`ValidationError` 會逐層向上拋，
  同批（最多 50 筆）排在後面的影片當次全部不更新，`Promise.all` 再讓整個
  agenda job 失敗。
- **候選清單被排擠**：候選清單前兩條查詢沒有 `limit` 也沒有 `sort`，而 `Set`
  依插入順序去重，所以這些永遠卡死的文件會固定佔據 `.slice(0, 100)` 的最前排，
  把按 `crawledAt` 排序的真正 live 影片擠出名額。累積越多排擠越嚴重。
- **無人清理**：`cleanup ended streams` 明確排除 `hbStatus: Created`，而佔位
  文件的 `hbStatus` 正是 `Created`；且該任務對 Video 只設 `hbCleanedAt`，從不
  刪除文件。全 `src/` 沒有任何刪除 videos 文件的程式碼。這些文件會永久留存。

### 佔位文件的其他來源

`noticeFromRaid` 是唯一會同時寫入兩個空字串的路徑，但不是唯一會產生無效文件的
路徑：`updateFromHolodex()` 的 `title` 走 `setIfDefine`，holodex 若沒回傳
title，`$setOnInsert` 就完全不含該 key，插入的文件根本沒有 `title` 欄位，
`availableAt` 同理。因此判定條件必須同時涵蓋「空字串」與「欄位不存在」。

## 目標

1. 未確認的空殼文件不再永久佔據候選清單。
2. 單筆影片或頻道的失敗不再中止整批。
3. 候選清單任何單一類別都無法獨占全部名額。

不改 schema、不改 `noticeFromRaid`、不改 data-contract 是硬約束——詳見
「Non-goals / Accepted limitations」。

## 變更 1：未確認空殼在確認消失時刪除

檔案：`src/modules/youtube.ts`，`updateVideoFromYoutube()` 的 per-video 迴圈開頭。

把現有的守衛擴充為：

```ts
const existing = await VideoModel.findByVideoId(targetVideo);
if (!ytInfo) {
  if (!existing) continue;
  if (!existing.channelId || !existing.title) {
    await VideoModel.deleteOne({ id: targetVideo });
    continue;
  }
}
const video = existing ?? new VideoModel({ id: targetVideo });
```

判定語意是「**YouTube 從未確認過它，而且 YouTube 現在也查不到它**」——這種文件
沒有任何值得保存的內容，也永遠無法通過驗證，直接刪除。

判定鍵選用 `channelId` 與 `title` 而非其他候選：

- 這兩個欄位正是 `save()` 實際會擋下來的欄位，判定條件與失敗原因一對一對應。
- 不用 `validateSync()`：任何其他欄位的驗證問題都會導致誤刪有價值的文件，風險
  不對稱。
- 不用 `crawledAt == null`：holodex 建立的正常文件也是 `crawledAt: null`。
- `!x` 同時涵蓋空字串與 `undefined`，兩種來源都被涵蓋。

曾正常上架過的影片這兩個欄位必有值，所以仍走既有的 else 分支留下 `deleted`
墓碑，行為完全不變。該墓碑是被依賴的功能：daily-videos 的 finalize pass 用
`status: Missing` + `detectedDeletionAt` 在 48 小時窗口內決定要重新產生哪些
日期的檔案，webhook 的串流結束 embed 用 `deleted` 切換成 "No VOD is
available."。

### 刪除的安全性

- `CollectionWatcher` 只支援 `insert` 與 `update`，沒有任何消費者監聽 delete，
  所以刪除不會觸發 scheduler 或 webhook 的副作用。
- `/mod crawl` 只統計回傳陣列中 `!video.deleted` 的筆數，其餘一律回覆
  "Cannot find the video."。被刪除的 id 不出現在回傳陣列，效果等同既有的
  「從未見過的 id」路徑，訊息仍然正確。
- 被刪除的文件不會被 scheduler 排程：`New` 與 `Missing` 都不在 `LiveStatus`，
  刪除前後都不會進 Bee-Queue。
- raid 記錄本身存放在 `raids` collection，不受影響。

## 變更 2：per-video try/catch

檔案：`src/modules/youtube.ts`，`updateVideoFromYoutube()`。

把 per-video 迴圈的 body 包進 try/catch，catch 內 `console.error` 帶上該
videoId 與錯誤後繼續下一筆。`continue` 在 try 區塊內仍作用於外層 for，語意不變。

失敗的那一筆不會更新 `crawledAt`，下一輪會重試。這是刻意的：唯一會造成永久
重試的來源已由變更 1 根除，其餘失敗（mongo 暫時性錯誤等）本來就該重試。

`needUpdateChannels.push()` 位於 try 區塊內，失敗的那筆不會把 channelId 推進
待更新清單——那正是想要的行為。

## 變更 3：per-channel try/catch

檔案：`src/modules/youtube.ts`，`updateChannelFromYoutube()`。

同樣把 per-channel 迴圈的 body 包進 try/catch。

`Channel.name` 也是 `required`，而該函式在「部分 channel 查得到、部分查不到」
時，會對查不到的那個執行 `new ChannelModel({ id })` 後 `save()`，拋出
`Channel validation failed: name is required`。此函式在
`updateVideoFromYoutube()` 結尾被呼叫，一旦拋出就會把整批 video 更新一起拖垮
（那批 video 其實都已成功寫入）。

這條路徑實務上罕見（需要某個 video 的 channelId 在 DB 查不到，且該 channel
同時被 YouTube 省略；`if (!ytChannelItems?.length) return []` 已擋掉「全部查
不到」的情形），而且失敗的 `new ChannelModel(...)` 不會落盤，不會累積垃圾。
因此只做批次隔離，不加刪除邏輯。

## 變更 4：候選清單加界

檔案：`src/commands/crawler.ts`，`JOB_YOUTUBE_UPDATE_VIDEOS` 的候選清單。

前兩條查詢各加上 `.sort({ _id: 1 }).limit(25)`：

```ts
...mapToId(
  await VideoModel.find({ status: VideoStatus.New })
    .sort({ _id: 1 })
    .limit(25)
    .select("id")
),
...mapToId(
  await VideoModel.find({ crawledAt: null })
    .sort({ _id: 1 })
    .limit(25)
    .select("id")
),
```

- **為何要 sort**：只加 limit 而不排序，natural order 會讓每輪都撿到同一批，
  排在後面的永遠輪不到。
- **為何用 `_id`**：ObjectId 單調遞增，排序等價於插入順序 FIFO；`_id` 有預設
  索引，不會產生 in-memory SORT stage。`createdAt` 雖然也可用（`Video` 繼承的
  `TimeStamps` 基底類啟用了 timestamps，mongoose 會在 `updateOne` upsert 插入
  時透過 `$setOnInsert` 補上 `createdAt`），但它沒有索引，且早期或以
  aggregation pipeline 建立的殘留文件可能沒有該欄位。
- **為何是 25**：兩條合計最多佔掉 100 個名額的一半，另一半保留給 live 與
  recently-ended 影片。

## 變更 5：測試

檔案：`src/modules/youtube.spec.ts`（擴充既有檔案）。

沿用既有的 `jest.unstable_mockModule("googleapis")` + `spyOn(VideoModel, ...)`
模式，新增三個案例：

1. **未確認空殼被刪除**：`findByVideoId` 回傳 `channelId: ""` / `title: ""` 的
   文件，YouTube 回傳空 items。斷言 `deleteOne` 以 `{ id: <videoId> }` 被呼叫、
   該文件的 `save` 未被呼叫、回傳陣列為 `[]`。
2. **有完整欄位的影片不被刪除**（回歸保護）：`findByVideoId` 回傳
   `channelId: "UC..."` / `title: "..."` 的文件，YouTube 回傳空 items。斷言
   `deleteOne` 未被呼叫、`deleted` 為 `true`、`detectedDeletionAt` 是 `Date`、
   回傳陣列含該文件。
3. **單筆失敗不影響同批其他影片**：同批兩筆，第一筆的 `save` 拋錯。斷言第二筆
   的 `save` 有被呼叫，且回傳陣列只含第二筆。

每個案例都帶結構性斷言（`toEqual` 比對回傳陣列內容、欄位值比對），不只
`toHaveBeenCalled`。

## Non-goals / Accepted limitations（非目標與已接受的限制）

### 非目標

- **不放寬 `Video` / `Channel` 的 `required`**。放寬會讓空值文件流進下游：
  `Video.getChannel()` 的 `assert` 會在 worker 的 job 開頭與
  `buildVideoSummary()` 內拋出；`gen-index-file.ts` 呼叫 `buildVideoSummary`
  的位置不在 try/catch 內，一拋就整份 `index.json` 產不出來；六份 data-contract
  文件明文宣告 `title` 與 `channel.id` 為 Always present；Discord embed 的空
  字串 title 會被 API 回 400。刪除方案讓這些下游完全不受影響。
- **不改 `noticeFromRaid`**。佔位文件的用途是把 videoId 丟進候選清單，讓
  crawler 下一分鐘去查：查得到就填實並開始收集，查不到就被變更 1 刪除。改成
  「worker 先查 YouTube 再建文件」會讓 worker 多一個 API 依賴與 quota 消耗，
  且失去 crawler 每分鐘批次合併查詢的優勢。
- **不改對外 data-contract**。本設計不改變任何封存輸出的欄位或語意。
- **不寫一次性清理腳本**。既有的空殼文件本來就永遠落在候選清單裡，變更 1 上線
  後會被逐輪自動刪除。

### 已接受的限制

- **既有殘留的清除速度受 limit 限制**。變更 4 把前兩條查詢各限制在 25 筆，
  若正式環境已累積大量空殼，需要多輪才能清完（每輪最多 25 筆，每分鐘一輪）。
  這是可接受的：清除期間 live 影片的名額已經被保障，而累積量不會再成長。
- **失敗的影片會被無限重試**。變更 2 的 catch 不記錄失敗次數、不推遲下次撿取。
  真正會永久失敗的來源已由變更 1 根除，其餘是暫時性錯誤，重試是正確行為。
  加入失敗計數需要新增 schema 欄位，對目前已知的問題是多餘的機制。
- **`updateChannelFromYoutube` 的「全部查不到就不標記 deleted」不一致仍保留**。
  該函式在 `!ytChannelItems?.length` 時提前 return，與 video 端「查不到就標記
  deleted」的處理不對稱。這不是當前故障的成因，修正它會擴大範圍。
