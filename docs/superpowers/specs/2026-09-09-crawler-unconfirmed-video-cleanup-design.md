# crawler 已消失影片的標記與批次隔離設計

修掉 `crawler youtube update` 每分鐘失敗一次的 `Video validation failed`，並讓
單筆影片的失敗不再中止整批更新。不動 `Video` / `Channel` 的 schema，不動對外的
data-contract，也不刪除任何文件。

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

### 無效文件的其他來源

`noticeFromRaid` 是目前唯一會寫出兩欄皆空文件的路徑，但問題的形狀比它更廣：
任何繞過 validator 的 upsert 都可能寫出 `save()` 過不了的文件。
`VideoModel.updateFromHolodex()` 的 `title` 走 `setIfDefine`（值為 `undefined`
/ `null` 時整個 key 都不會出現在 `$setOnInsert` 裡）、`availableAt` 同理；
`title` 若是空字串則會照樣寫入。因此修正不該建立在「哪些欄位、由哪條路徑寫成
什麼形狀」的窮舉上——那份清單會隨著上游改變而過期。

同一個結構也存在於 channel：`ChannelModel.updateFromHolodex()` 是
`findOneAndUpdate` + `upsert`，`name`（`required`）同樣走 `setIfDefine`。缺
`name` 的 channel 文件之後只要被 YouTube 省略，`save()` 就會失敗、`crawledAt`
寫不進去，於是每輪都被 `ChannelModel.find({ crawledAt: null })` 重新撿到——與
video 端同構的永久迴圈。因此兩邊套用相同的處理，見變更 1 與變更 3。

## 目標

1. 「YouTube 已經查不到」這個事實，無論文件本身是否通過驗證，都必須能被寫進
   資料庫，讓文件離開候選清單。video 與 channel 兩邊以相同的方式處理。
2. 單筆影片或頻道的失敗不再中止整批。
3. 永久卡死、無法被填實也無法被消化的文件，不再獨占候選名額。

目標 3 刻意不涵蓋「任何類別都無法獨占名額」——即將開播那條查詢在尖峰時佔滿名額
是正確的優先級，理由見「Non-goals / Accepted limitations」。

不改 schema、不改 `noticeFromRaid`、不改 data-contract、不刪除任何文件是硬約束
——詳見「Non-goals / Accepted limitations」。

## 變更 1：確認消失時跳過驗證寫入

檔案：`src/modules/youtube.ts`，`updateVideoFromYoutube()` 的 per-video 迴圈結尾。

`save()` 改為在「YouTube 查不到這支影片」時跳過驗證：

```ts
// YouTube 查不到時要寫入的只有「已消失」這個事實，而文件可能因為它被建立的
// 方式（繞過 validator 的 upsert）而缺少 required 欄位。驗證會擋下這次寫入，
// 讓文件永遠停在原本的狀態、每輪重新被選中。
await video.save({ validateBeforeSave: !!ytInfo });
```

其餘部分維持原狀：`if (!ytInfo && !existing) continue;` 的守衛仍然擋掉「從未
見過又已消失」的 id（那種情況沒有文件可標記，建立一份全空的新文件毫無意義）。

### 為什麼這樣就夠

`else` 分支寫入的是 `status = Missing`、`deleted = true`、`detectedDeletionAt`，
迴圈結尾再統一寫 `crawledAt = new Date()`。這些欄位一旦落盤，文件就同時離開
候選清單的兩條無界查詢：`status` 不再是 `New`，`crawledAt` 不再是 `null`。
永久迴圈就此中斷，而且不需要辨識文件是由哪條路徑、寫成什麼形狀建立的。

### 為什麼不刪除文件

`deleted` 是**可逆狀態**，而刪除不是。影片恢復（從私人轉回公開）後，下一次
crawl 會查到它，既有程式碼把 `deleted` 設回 `false`、清掉 `detectedDeletionAt`，
爬取自動接續。刪除文件則會連帶抹掉「raid 曾經指向這支影片」這件事，之後只能
等另一次外部通知重新發現它。

這也與 `hbIgnore` 的語意明確區隔：`hbIgnore` 是「把這支影片永久排除在系統之外」，
`deleted` 是「這支影片現在看不到了，看得到就繼續」。兩者不可互相取代。

### 為什麼跳過驗證是安全的

- **只在 `!ytInfo` 時跳過。** 有 `ytInfo` 的路徑照常驗證，資料品質不受影響。
  跳過驗證的那次寫入不引入任何新的欄位值——`status` / `deleted` /
  `detectedDeletionAt` / `crawledAt` 都是既有 else 分支本來就要寫的。
- **競態下比刪除安全。** `save()` 對既有文件走 `$__delta()`，只送出這次真正
  修改過的路徑，不會拿記憶體中的舊快照覆蓋整份文件。所以就算 pubsub 或
  `/mod crawl` 在 `findByVideoId` 之後補上了 `channelId` / `title`，那些欄位
  不會被抹掉。最壞情況是一支剛恢復的影片被短暫標成 `deleted`，下一輪 crawl
  就會自動修正。
- **無效文件不會流進 archive writer。** 標記後的佔位文件是
  `status: Missing`、沒有 `actualStart`、沒有 `hbEnd`，而每個
  `buildVideoSummary()` 的呼叫端都會先被過濾掉：
  - `gen-daily-videos-file` 的 finalize filter 要求
    `actualStart: { $exists: true, $ne: null }`
  - `gen-index-file` 走 `findLiveVideos()`（`status` ∈ `Upcoming` / `Live`）與
    `findRecentlyEndedVideos()`（Missing 分支要求 `hbEnd` 落在窗口內）
  - `gen-realtime-file` 只取 `status` 為 `Live` / `Upcoming` 的文件
  - `gen-channel-index-file` 以 `channelId` 查詢，且有 `if (!channel) return;`
    的早退保護
    因此 `getChannel()` 的 `assert` 不會被觸發，index / daily-videos / realtime
    的產生流程都不受影響。
- **不會觸發 webhook。** webhook 服務沒有訂閱 videos collection 的變更，它只用
  `findByVideoId` 解析訊息事件的參數。
- **不會被 scheduler 排程。** `Missing` 不在 `LiveStatus`，`isLive()` 為假；
  它也不是 `Past`，不符合 need-replay。

### 對既有正常影片的行為不變

欄位完整、曾正常上架的影片走的是同一段程式碼，`validateBeforeSave` 對它們沒有
可觀察的差別（它們本來就通過驗證）。既有的 `deleted` 墓碑語意完全保留：
daily-videos 的 finalize pass 用 `status: Missing` + `detectedDeletionAt` 在
48 小時窗口內決定要重新產生哪些日期的檔案，webhook 的串流結束 embed 用
`deleted` 切換成 "No VOD is available."。

## 變更 2：per-video try/catch

檔案：`src/modules/youtube.ts`，`updateVideoFromYoutube()`。

把 per-video 迴圈的 body 包進 try/catch，catch 內 `console.error` 帶上該
videoId 與錯誤後繼續下一筆。`continue` 在 try 區塊內仍作用於外層 for，語意不變。

失敗的那一筆不會更新 `crawledAt`，下一輪會重試。這是刻意的：會造成永久重試的
驗證失敗已由變更 1 消除，剩下能走到這個 catch 的是 mongo 暫時性錯誤這類本來
就該重試的狀況。

`needUpdateChannels.push()` 位於 try 區塊內，失敗的那筆不會把 channelId 推進
待更新清單——那正是想要的行為。

## 變更 3：channel 端做完全對稱的處理

檔案：`src/modules/youtube.ts`，`updateChannelFromYoutube()`。

channel 端有與 video 端同構的問題。`Channel.name` 是 `required`，而
`ChannelModel.updateFromHolodex()` 是 `findOneAndUpdate` + `upsert`，`name` 走
`setIfDefine`——holodex 沒給 name 時，插入的文件根本沒有 `name` 欄位，而 upsert
不跑 validator。這種 channel 之後只要被 YouTube 省略，`save()` 就會拋
`Channel validation failed: name is required`，`crawledAt` 寫不進去，於是每輪
都會被 `ChannelModel.find({ crawledAt: null })` 重新撿到——與 video 端完全一樣
的永久迴圈。

此外，`updateChannelFromYoutube()` 在 `updateVideoFromYoutube()` 結尾被呼叫，
一旦拋出就會把整批 video 更新一起拖垮（那批 video 其實都已成功寫入）。

因此套用與 video 端相同的三項處理：

1. **跳過驗證寫入**：`await channel.save({ validateBeforeSave: !!ytInfo })`。
2. **不建立幽靈文件**：加上與 video 端對稱的守衛，`ytInfo` 與既有文件都不存在
   時直接 `continue`，不要 `new ChannelModel({ id }).save()` 出一份只有 id 的
   文件。這需要把現有的「先取文件、再找 ytInfo」順序對調。
3. **per-channel try/catch**：迴圈 body 包進 try/catch，`console.error` 帶上該
   channelId 後繼續下一筆。

同時移除 `if (!ytChannelItems?.length) return [];` 這個提前 return，改成
`const ytChannelItems = response?.data?.items ?? [];` 並照常進入迴圈——這正是
video 端已經採用的形狀。保留它的話，「整批 channel 都查不到」時一個都不會被
標記為 `deleted`，卡死的文件也永遠不會離開候選清單，處理就不對稱了。

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
  不保證進展——真正讓候選集縮小的是被選中的文件在處理後離開候選集（被填實或被
  標記為已消失，兩者都會改變 `status` / `crawledAt`）。永遠無法離開候選集的
  文件正是變更 1 要根除的對象。
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

1. **查不到的影片以跳過驗證的方式寫入**：`findByVideoId` 回傳
   `channelId: ""` / `title: ""` / `status: New` 的文件，YouTube 回傳空 items。
   以 `toEqual` 比對 `save` 收到的 options 為 `{ validateBeforeSave: false }`，
   並斷言該文件的 `status` 為 `Missing`、`deleted` 為 `true`、`crawledAt` 是
   `Date`——後兩者是它離開候選清單兩條查詢的依據。
2. **查得到的影片照常驗證**：YouTube 回傳該影片的 item。斷言 `save` 收到的
   options 為 `{ validateBeforeSave: true }`。
3. **有完整欄位但已下架的影片行為不變**（回歸保護）：`findByVideoId` 回傳
   `channelId: "UC..."` / `title: "..."` 的文件，YouTube 回傳空 items。斷言
   `deleted` 為 `true`、`detectedDeletionAt` 是 `Date`、回傳陣列以 `toEqual`
   比對含該文件。
4. **首次偵測才寫入 `detectedDeletionAt`**：既有案例已涵蓋，確認跳過驗證的
   寫法不改變這個行為。
5. **從未見過又已消失的 id 仍然被跳過**：既有案例已涵蓋，確認不會建立新文件。
6. **單筆失敗不影響同批其他影片**：同批兩筆，第一筆的 `save` 拋錯。斷言第二筆
   的 `save` 有被呼叫，且回傳陣列只含第二筆。

channel 端以 `spyOn(ChannelModel, "findByChannelId")` 加上 mock 的
`channels.list` 做對稱覆蓋：

1. **查不到的頻道以跳過驗證的方式寫入**：`findByChannelId` 回傳沒有 `name` 的
   文件，YouTube 回傳空 items。斷言 `save` 收到
   `{ validateBeforeSave: false }`、該文件的 `deleted` 為 `true`、`crawledAt`
   是 `Date`。
2. **查得到的頻道照常驗證**：斷言 `save` 收到 `{ validateBeforeSave: true }`。
3. **從未見過又已消失的頻道不建立文件**：`findByChannelId` 回傳 `null`，
   YouTube 回傳空 items。斷言沒有任何 `save` 被呼叫、回傳陣列為 `[]`。
4. **整批都查不到時仍逐筆標記**：兩筆都不在 YouTube 回應中，且兩筆在 DB 都
   存在。斷言兩筆的 `deleted` 都是 `true`——這是移除提前 return 後才成立的
   行為。
5. **單一 channel 失敗不影響同批其他 channel**：同批兩筆，第一筆的 `save`
   拋錯。斷言第二筆的 `save` 有被呼叫，且回傳陣列只含第二筆。

每個案例都帶結構性斷言（`toEqual` 比對回傳陣列內容或 `save` 的 options、欄位值
比對），不只 `toHaveBeenCalled`。

變更 4 的候選清單加界不在此檔測試範圍內——它是 `src/commands/crawler.ts` 中
agenda job 定義內的查詢串接，沒有可獨立呼叫的匯出，為它建立測試接縫需要重構
該 job，代價與收益不成比例。該變更以 code review 驗證。

## Non-goals / Accepted limitations（非目標與已接受的限制）

### 非目標

- **不放寬 `Video` / `Channel` 的 `required`**。放寬是全域性的，會讓空值文件從
  任何路徑流進下游：`Video.getChannel()` 的 `assert` 會在 worker 的 job 開頭與
  `buildVideoSummary()` 內拋出；`gen-index-file.ts` 呼叫 `buildVideoSummary`
  的位置不在 try/catch 內，一拋就整份 `index.json` 產不出來；六份 data-contract
  文件明文宣告 `title` 與 `channel.id` 為 Always present；Discord embed 的空
  字串 title 會被 API 回 400。變更 1 的 `validateBeforeSave: false` 是逐次呼叫
  的局部豁免，只套用在「寫入已消失這個事實」的那一次 `save()`，schema 的保證
  對其他所有寫入路徑維持不變。
- **不刪除任何 video 文件**。`deleted` 是可逆狀態，刪除不是；詳見變更 1 的
  「為什麼不刪除文件」。
- **不改 `noticeFromRaid`**。佔位文件的用途是把 videoId 丟進候選清單，讓
  crawler 下一分鐘去查：查得到就填實並開始收集，查不到就被標記為已消失。改成
  「worker 先查 YouTube 再建文件」會讓 worker 多一個 API 依賴與 quota 消耗，
  且失去 crawler 每分鐘批次合併查詢的優勢。
- **不改對外 data-contract**。本設計不改變任何封存輸出的欄位或語意。
- **不寫一次性清理腳本**。既有的無效文件本來就永遠落在候選清單裡，變更 1 上線
  後會被逐輪自動標記並離開清單。

### 已接受的限制

- **既有殘留的消化速度受 limit 限制**。變更 4 把前兩條查詢各限制在 25 筆，
  若正式環境已累積大量無效文件，需要多輪才能全部標記完（每輪最多 25 筆，每分鐘
  一輪）。這是可接受的：期間 live 影片的名額已經被保障，而累積量不會再成長。
- **被標記的文件永久留在 collection 裡**。它們的 `channelId` / `title`
  （channel 則是 `name`）仍是空的，只是不再進入任何候選清單或 archive 查詢。
  這是刻意的取捨：保留「這個 videoId 曾被 raid 指向過」的痕跡，以及影片或頻道
  恢復後自動接續爬取的能力，代價是 collection 裡多出一些永遠不會被讀取的列。
- **失敗的影片會被無限重試**。變更 2 的 catch 不記錄失敗次數、不推遲下次撿取。
  會永久失敗的驗證錯誤已由變更 1 消除，其餘是暫時性錯誤，重試是正確行為。
  加入失敗計數需要新增 schema 欄位，對目前已知的問題是多餘的機制。
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
