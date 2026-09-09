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

### 為什麼判定條件要涵蓋「欄位不存在」

`noticeFromRaid` 是目前唯一會寫出無效文件的路徑，而它用的是空字串。判定條件
仍要一併涵蓋「欄位根本不存在」，因為 `updateFromHolodex()` 的 `title` 走
`setIfDefine`（值為 `undefined` / `null` 時整個 key 都不會出現在
`$setOnInsert` 裡），`availableAt` 同理。這條路徑今天不會觸發——holodex.js 的
`Video` 宣告 `get title(): string`，型別上排除了 undefined——但判定條件涵蓋兩種
形狀的成本是零，而漏掉它的代價是同一個永久迴圈重新出現。

## 目標

1. 任何因缺 `channelId` / `title` 而必定驗證失敗的文件，都能在一輪內被刪除，
   不再永久佔據候選清單。
2. 單筆影片或頻道的失敗不再中止整批。
3. 永久卡死、無法被填實也無法被消化的文件，不再獨占候選名額。

目標 3 刻意不涵蓋「任何類別都無法獨占名額」——即將開播那條查詢在尖峰時佔滿名額
是正確的優先級，理由見「Non-goals / Accepted limitations」。

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
    await VideoModel.deleteOne({
      id: targetVideo,
      // 缺席欄位、null、空字串三種寫入來源都要涵蓋。
      $or: [
        { channelId: { $in: ["", null] } },
        { channelId: { $exists: false } },
        { title: { $in: ["", null] } },
        { title: { $exists: false } },
      ],
    });
    continue;
  }
}
const video = existing ?? new VideoModel({ id: targetVideo });
```

判定語意是「**YouTube 從未確認過它，而且 YouTube 現在也查不到它**」——這種文件
沒有任何值得保存的內容，也永遠無法通過驗證，直接刪除。

符合這個條件的實際上只有 raid 佔位文件一種：

- raid 佔位文件：`$setOnInsert` 寫入 `channelId: ""` / `title: ""` → 符合，
  刪除。
- pubsub 建立的文件：`$set` 一定帶非空的 `channelId` 與 `title` → 不符合，保留。
- holodex 建立的文件：`channelId` 是無條件寫入，`title` 由 holodex.js 的型別
  保證存在 → 不符合，保留。
- 曾被 YouTube 確認過的文件：兩個欄位都有值 → 不符合，走既有的 else 分支留下
  `deleted` 墓碑。

### 為什麼刪除條件要在 mongo 端重新檢查一次

記憶體中的 `existing` 只是一個快照。在 `findByVideoId` 與刪除之間，
`noticeFromNotification` 可能收到 pubsub 通知而補上 `channelId` / `title`，或是
另一個行程的 `/mod crawl` 成功寫入完整資料。crawler 服務本身就同時跑 pubsub
listener 與這個 agenda job，兩者會交錯。若刪除只比對 id，就會依據過期的快照刪掉
一份剛被修好的文件。

因此缺欄位條件整份放進 `deleteOne` 的 filter，由 mongo 在單一操作內原子地重新
檢查：條件不再成立時 `deletedCount` 為 0，什麼都不會發生。此時直接 `continue`，
不拿舊快照去 `save()`（那會用過期資料覆蓋剛寫入的內容），下一輪自然會用新資料
重新處理。`deletedCount` 為 0 是預期內的結果，不是錯誤。

`$or` 同時列出 `$in: ["", null]` 與 `$exists: false`，是為了讓條件自我說明地涵蓋
三種來源——空字串、null、欄位根本不存在——而不依賴 null 相等匹配是否延伸到缺席
欄位。

### 為什麼不再比對 lifecycle 狀態

一個直覺的加強是在 filter 裡再要求 `status: New` + `hbStatus: Created`，藉此
確保刪除的是「從未被排程或處理過」的文件。這兩個條件在「缺 `channelId` 或
`title`」的前提下恆為真，因此是冗餘的：

- `status` 只能經由 `video.save()` 改變（`updateVideoFromYoutube` 內全部是
  document 賦值），而 `save()` 對缺欄位文件必定驗證失敗、不落盤。
  `updateFromHolodex()` 對已存在文件的 `$set` 不含 `status`，只有
  `$setOnInsert` 有。所以缺欄位文件的 `status` 永遠停在建立時寫入的 `New`。
- `hbStatus` 雖然可以被 `updateStatus()` / `updateStatusFailed()` /
  `updateResult()` 以 `updateOne` 繞過驗證改寫，但這三者的呼叫端都在 worker 與
  scheduler，而進入 Bee-Queue 的前提是 `isLive()`（`status` 為 `Upcoming` /
  `Live`）或 need-replay（`status` 為 `Past`）。`New` 兩者都不符合，永遠不會被
  排程，所以 `hbStatus` 必然停在 `Created`。

加上它們不只沒有效果，還會製造死角：萬一真的出現一份缺欄位但 lifecycle 不符的
文件，`deleteOne` 不匹配、程式碼 `continue`，它會永遠留在候選清單，每輪重複一次
無效的刪除嘗試——正是這份設計要消滅的狀態。缺欄位這個條件本身已經足夠精確，
再疊 lifecycle 條件只會讓謂詞比它要辨識的事實更窄。

判定鍵選用 `channelId` 與 `title` 而非其他候選：

- 這兩個欄位正是 `save()` 實際會擋下來的欄位，判定條件與失敗原因一對一對應。
- 不用 `validateSync()`：任何其他欄位的驗證問題都會導致誤刪有價值的文件，風險
  不對稱。
- 不用 `crawledAt == null`：holodex 建立的正常文件也是 `crawledAt: null`。

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
- 被刪除的文件不可能有排程中的工作。如上一節所述，缺 `channelId` / `title` 的
  文件其 `status` 必然停在 `New`，而 `New` 不在 `LiveStatus`，`isLive()` 為假，
  insert 與 rearrange 兩條路徑都不會排程它。
- raid 記錄本身存放在 `raids` collection，不受影響。

## 變更 2：per-video try/catch

檔案：`src/modules/youtube.ts`，`updateVideoFromYoutube()`。

把 per-video 迴圈的 body 包進 try/catch，catch 內 `console.error` 帶上該
videoId 與錯誤後繼續下一筆。`continue` 在 try 區塊內仍作用於外層 for，語意不變。

失敗的那一筆不會更新 `crawledAt`，下一輪會重試。這是刻意的：會造成永久重試的
驗證失敗已由變更 1 刪除掉，剩下能走到這個 catch 的是 mongo 暫時性錯誤這類本來
就該重試的狀況。

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

- **為何要 sort**：只加 limit 而不排序，natural order 下的選取結果不確定，
  難以推理哪些文件會被處理到。`_id` 排序讓選取變成確定的 FIFO。要注意排序本身
  不保證進展——真正讓候選集縮小的是被選中的文件在處理後離開候選集（被填實而
  改變 `status` / `crawledAt`，或被變更 1 刪除）。永遠無法離開候選集的文件正是
  變更 1 要根除的對象。
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
模式，新增以下案例：

1. **佔位文件被刪除**：`findByVideoId` 回傳 `channelId: ""` / `title: ""` 的
   文件，YouTube 回傳空 items。斷言 `deleteOne` 被呼叫、該文件的 `save` 未被
   呼叫、回傳陣列為 `[]`。
2. **刪除條件在 mongo 端重新檢查**：以 `toEqual` 比對 `deleteOne` 收到的整個
   filter 物件，確認它含 `id` 以及涵蓋空字串 / null / 欄位不存在的 `$or`。
   這保證有競爭寫入者填實文件時，mongo 會拒絕刪除。
3. **缺席欄位與空字串同樣被涵蓋**：`findByVideoId` 回傳 `channelId` 與 `title`
   兩個 key 都不存在（而非空字串）的文件。斷言 `deleteOne` 被呼叫。
4. **有完整欄位的影片不走這條分支**（回歸保護）：`findByVideoId` 回傳
   `channelId: "UC..."` / `title: "..."` 的文件，YouTube 回傳空 items。斷言
   `deleteOne` 未被呼叫、`deleted` 為 `true`、`detectedDeletionAt` 是 `Date`、
   回傳陣列含該文件。
5. **單筆失敗不影響同批其他影片**：同批兩筆，第一筆的 `save` 拋錯。斷言第二筆
   的 `save` 有被呼叫，且回傳陣列只含第二筆。
6. **單一 channel 失敗不影響同批其他 channel**：`updateChannelFromYoutube` 同批
   兩筆，第一筆的 `save` 拋錯。斷言第二筆的 `save` 有被呼叫，且回傳陣列只含
   第二筆。

每個案例都帶結構性斷言（`toEqual` 比對回傳陣列內容或 filter 物件、欄位值比對），
不只 `toHaveBeenCalled`。

變更 4 的候選清單加界不在此檔測試範圍內——它是 `src/commands/crawler.ts` 中
agenda job 定義內的查詢串接，沒有可獨立呼叫的匯出，為它建立測試接縫需要重構
該 job，代價與收益不成比例。該變更以 code review 驗證。

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
  會永久失敗的驗證錯誤已由變更 1 刪除掉，其餘是暫時性錯誤，重試是正確行為。
  加入失敗計數需要新增 schema 欄位，對目前已知的問題是多餘的機制。
- **`updateChannelFromYoutube` 的「全部查不到就不標記 deleted」不一致仍保留**。
  該函式在 `!ytChannelItems?.length` 時提前 return，與 video 端「查不到就標記
  deleted」的處理不對稱。這不是當前故障的成因，修正它會擴大範圍。
- **即將開播那條候選查詢不加界，尖峰時仍可能佔滿全部名額**。
  - 顧慮：候選清單第三條選出 `scheduledStart` 落在前後 5 分鐘內、尚未開始的
    直播，沒有 limit 且排在 recently-ended 與一般 live 之前。若同時有 100 支
    以上直播落在該窗口（大型聯合活動），它會吃掉整個 `slice(0, 100)`，把進行中
    與剛結束的影片全部排擠掉，因此「任何類別都無法獨占名額」在滿載邊界不成立。
  - 決定：不加界，改為限縮目標 3 的措辭。
  - 理由：那條查詢的語意就是「馬上要開播，必須立刻查」，它在尖峰時佔滿名額是
    正確的優先級，與空殼佔位的情況本質不同——這種尖峰下一分鐘就會消化，而空殼
    是永久卡死、永遠不會離開候選集。反過來為它設配額，會在最需要即時性的時刻
    延遲直播的首次偵測。
