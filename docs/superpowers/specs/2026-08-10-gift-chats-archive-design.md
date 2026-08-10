# Gift（Jewels）寫入 chats-archive 設計

把 `gifts` collection 的文件納入 `{videoId}.jsonl` 逐筆封存，並讓只收到禮物的
直播也能觸發封存。`{videoId}.meta.json` 不變動。

本設計取代 [2026-08-09-youtube-gift-actions-design.md](./2026-08-09-youtube-gift-actions-design.md)
中「不做 chats-archive 整合」這條非目標；該文件其餘的非目標與已接受的限制仍然
有效。

## Non-goals / Accepted limitations（非目標與已接受的限制）

### 非目標

- **不動 `{videoId}.meta.json`**。`aggregates` 不新增計數器，`stats` 不變，
  `currencyTable` / `jpyTotal` 不收 Jewels —— 那兩個欄位的語意是法定貨幣換算成
  日圓，混入虛擬代幣會毀掉它們。`video-meta.md` 維持 version 2 revision r0。
- **不回填既有封存檔**。已經產生的 `.jsonl` 不會因為這次變更而重新產生；只有
  尚未封存（`ChatsArchiveProcessed` 旗標未設）的影片會帶上 gift 列。
- **不改 `Gift` model**、不改 worker 寫入路徑、不改價格表機制。

### 已接受的限制

- **`amount` 可能永久缺席**。封存是一次性快照（由 `ChatsArchiveProcessed` 旗標
  保證只跑一次），而 Jewels 單價是事後從連擊訊息推導、寫進 `giftprices` 才生效
  的。價格表尚未學到該資產時寫入的 gift 文件 `amount` 為空，封存時照樣為空，
  且不回填。從未被連擊過的資產可能永遠學不到價。
- **低單價禮物無法識別送禮者**。`authorChannelId` 只出現在單價 ≥ 100 Jewels 的
  ticker 上；其餘 gift 列的 `authorChannelId` 是空字串。gift action 也完全不帶
  badge 資訊，因此 `authorType` 恆為 `"other"`、`isVerified` / `isOwner` /
  `isModerator` 恆為 `false` —— 這些不是觀測結果，而是為了滿足 author row 的
  必填保證而填的定值。
- **封存與清除共用同一個 2 小時邊界，不另設保留期**。
  - 顧慮：封存失敗時旗標不會設定、留待下一輪重試，但影片跨過邊界後就同時離開
    封存的挑選窗口、進入清除的資格範圍。若失敗一路持續到跨界，那支影片的 gift
    文件會被刪除而永遠不會被封存；封存工作延遲或 cursor 跑太久也可能與刪除
    交錯，產出不完整的封存檔卻仍視為成功。
  - 決定：不加交接保證（不讓 cleanup 等待 `ChatsArchiveProcessed`，也不拉長
    gift 的保留期）。
  - 理由：這是既有封存管線本來就有的性質，對 superchat、會籍、里程碑一體適用，
    加入 gift 並沒有使它變差。兩個窗口互補，且封存每分鐘跑一次 —— 窗口內約有
    120 次機會，要真的損失資料得在邊界前連續失敗到跨界。只為 gift 加一條特殊
    刪除條件，會讓它成為唯一有例外的 collection，且永遠不會被封存的影片
    （例如 `hbIgnore`）會累積永不刪除的 gift 文件；改成全面修正則是重新設計
    保留與封存的交接機制，遠超出「把 gift 加進 chats-archive」的範圍。
- **封存觸發只認 `VideoStats`，不另設直接查 `gifts` 的備援**。
  - 顧慮：`MessageType.Gift` 加進挑選條件後，gift-only 直播的封存完全取決於
    `MessageTotal` 那條 cron 有沒有跑出對應的 `VideoStats` 列。該 cron 延遲、
    失敗或首次部署時尚未跑過，那支影片就不會被挑中，禮物在清除後永久消失。
  - 決定：不加備援查詢。
  - 理由：所有訊息型別的封存觸發都走 `VideoStats`，那條 cron 失效是全面性的
    失效，不是 gift 獨有的破口。只為 gift 加一條直接掃 `gifts` 的備援，會讓它
    成為唯一有兩條觸發路徑的型別，而且那條查詢沒有 `VideoStats.updatedAt`
    可用來限縮範圍，等於每輪都要掃整個 collection。
- **封存沒有一致的讀取快照**。
  - 顧慮：新增的 gift cursor 與既有 cursor 一樣走 `secondaryPreferred`，沒有
    固定的 cutoff 時間、沒有統一的 read concern、寫旗標前也不核對來源筆數。
    禮物仍在寫入、複製延遲、或各 collection 落在不同 secondary 時，k-way merge
    可能漏列，產出的檔案不對應任何一個真實的時間點。
  - 決定：不建立快照機制。
  - 理由：現有 10 條 cursor 全部都是這個樣子，gift 只是第 11 條，並沒有讓情況
    變差。要修就得重新設計整個封存的讀取一致性，並把所有型別從 secondary 搬回
    primary（增加 primary 負載）—— 那是另一份 spec 的題目。

## 事實基準

### 既有的封存流程

`src/components/chats-archive.ts` 的 `archiveAllChats` 每分鐘跑一次，從
`VideoStats` 找出「近 `MAX_HOURS_BEFORE_CLEANUP`（2 小時）內有活動、且尚未帶
`ChatsArchiveProcessed` 旗標」的影片，逐一呼叫 `archiveVideo(videoId)`，成功後
設旗標。目前的挑選條件是下列任一：

- `type = MessageTotal` 且 `messageType` 屬於 `SuperChat`、`SuperSticker`、
  `Membership`、`MembershipGift`、`MembershipGiftPurchase`、`Milestone`
- `type = MessageTotal` 且 `messageType = Chat` 且 `authorType` 是 `Owner` 或
  `Moderator`

`src/components/chats-archive/archive-video.ts` 對每種訊息各開一條依 `timestamp`
遞增排序的 cursor，交給 `multiCursorOrderedPeek` 做 k-way merge，逐筆丟給
`buildJsonlRow` 轉成一列 JSON，寫入 `{videoId}.jsonl.tmp`，同時由
`bumpAggregate` 累加 `meta.json` 的計數器。全部寫完後先 rename `.jsonl` 再
rename `.meta.json`，確保讀者拿到 meta 時 jsonl 已就位；一列都沒有時丟棄
`.jsonl.tmp`、只寫 meta。

### 禮物已經會產生 `VideoStats` 的 `MessageTotal` 列

上述挑選條件查的是 `VideoStats`，因此把 `MessageType.Gift` 加進去只有在「收到
禮物真的會寫出對應的 `VideoStats` 列」時才有作用。這一點已經成立：
`src/components/video-stats.ts` 對 `messageTypes` 陣列的**每一項**都註冊一條
`updateStats(VideoStatsType.MessageTotal, type.messageType, type.model, …)` 的
cron，而該陣列已含 `{ messageType: MessageType.Gift, model: GiftModel }`。因此
一支收到禮物的直播必定有 `type = MessageTotal`、`messageType = "gift"` 的
`VideoStats` 列，`updatedAt` 隨禮物持續進來而更新。
`src/components/video-stats.spec.ts` 已針對這條 cron 的註冊做了斷言。

`buildJsonlRow` 以 `doc.collection.name` 分派。author 類的訊息共用
`makeAuthorRow(type, doc, extra)`，它把文件的 `id` / `timestamp` /
`authorName` / `authorPhoto` / `authorChannelId` / `authorType` / `membership` /
`isVerified` / `isOwner` / `isModerator` 搬進列裡，再併上該型別專屬的 `extra`。
`setIfDefine(key, value)`（`src/util.ts`）在值為 `undefined` 或 `null` 時回傳
`{}`，否則回傳 `{ [key]: value }`。

### 時序：gift 文件在封存時仍然存在

`cleanup` 的 `cleanEndedStreams` 每 5 分鐘跑一次，刪除結束超過
`MAX_HOURS_BEFORE_CLEANUP`（2 小時）的影片文件，其中已包含
`Gift.deleteMany({ originVideoId: ... })`。

兩邊的窗口是互補的，用的是同一個常數：cleanup 要求「該影片 `MessageTotal` 的
最後 `updatedAt` 早於 2 小時前」才刪，而封存挑的是「`updatedAt` 在 2 小時內」。
同一瞬間一支影片只會落在其中一邊，因此正常情況下 gift 文件在封存時尚未被清除。
邊界失敗的情形見「已接受的限制」。

### `Gift` model 的欄位

`src/models/Gift.ts`：

| 欄位              | 必填 | 說明                                        |
| ----------------- | ---- | ------------------------------------------- |
| `id`              | ✓    | 唯一鍵；一份禮物一份文件                    |
| `timestamp`       | ✓    | 送禮時間                                    |
| `authorType`      | ✓    | 恆為 `"other"`（`MessageAuthorType.Other`） |
| `currency`        | ✓    | 恆為 `"JEWEL"`                              |
| `originVideoId`   | ✓    |                                             |
| `originChannelId` | ✓    |                                             |
| `authorName`      |      |                                             |
| `authorPhoto`     |      |                                             |
| `authorChannelId` |      | 只有 ticker（單價 ≥ 100 Jewels）帶得到      |
| `message`         |      | 原始文字，可能是整波摘要                    |
| `giftName`        |      | 顯示名稱；非英文 locale 解不出來            |
| `assetName`       |      | 圖檔名，如 `finger_heart`；價格表的 key     |
| `image`           |      | 圖片 URL                                    |
| `jewelCount`      |      | 只餵價格推導                                |
| `comboCount`      |      | 只餵價格推導                                |
| `hasGiftImageUrl` |      | 只餵價格推導                                |
| `amount`          |      | 這一份禮物的 Jewels 單價                    |
| `isReplay`        |      |                                             |

`Gift` 不繼承 `TimeStamps`，沒有 `createdAt` / `updatedAt`。

### 契約現況

`docs/data-contract/video-chats.md` 目前是 version 2、revision r0，
`JsonlRow` 是 10 種列的可辨識聯集，判別欄位是 `type`。`AuthorRowBase` 宣告
`authorChannelId: string`、`authorType`、`isVerified`、`isOwner`、`isModerator`
皆為必填，reader guidance 也明寫這五個「每個 author row 必有」。reader guidance
另有「未知的 `type` 值：跳過該列」，因此新增列型別對既有讀者是安全的。

`aggregates.giftCount` 與 `stats.giftCount` 指的都是**會籍禮物**
（`membershipgifts`），與本設計的 Jewels 禮物無關，名稱不可混用。

## 設計

### 一、jsonl 新增 `gift` 列

`GiftRow` 沿用 `AuthorRowBase`，讓讀者既有的 author 處理路徑能直接吃：

```ts
interface GiftRow extends AuthorRowBase {
  type: "gift";
  giftName?: string;
  assetName?: string;
  image?: string;
  amount?: number;
  currency: string;
}
```

`message` 刻意不放進列裡。它存的是原始文字，而 YouTube 會把一波連發中的其中一則
改寫成 `comboed x8 Heart for 80 Jewels` 這種整波摘要 —— 但那一列仍然只代表**一
份**禮物。照字面顯示會讓讀者以為那一列是 8 份、80 Jewels，而封存檔沒有任何欄位
能讓讀者分辨哪些列被改寫過。

`assetName` 放進列裡，是因為 `giftName` 隨 locale 變動、且兩種不同禮物可能共用
同一個顯示名稱；`assetName` 是穩定的禮物類型識別碼。

### 二、寫入端變更

`src/components/chats-archive/archive-video.ts`：

1. `ChatRowDoc` 聯集加入 `Gift`。
2. 新增 `GiftModel.find({ originVideoId: videoId }).sort({ timestamp: 1 })`
   的 cursor（`readPreference: "secondaryPreferred"`，比照其餘 cursor），併入
   `multiCursorOrderedPeek` 的參數。gift 列因此依 `timestamp` 混排進其他訊息
   之間，維持整份檔案的時間遞增。
3. `buildJsonlRow` 新增 `case "gifts"`，呼叫 `makeAuthorRow("gift", d, ...)`，
   `extra` 為 `giftName` / `assetName` / `image` / `amount`（各自
   `setIfDefine`）與 `currency`。
4. `makeAuthorRow` 補上定值退回：`authorChannelId` 缺值時寫 `""`，
   `isVerified` / `isOwner` / `isModerator` 缺值時寫 `false`。

第 4 點是必要的，不是防禦性程式碼：gift 文件這四個欄位都是 `undefined`，而
`JSON.stringify` 會丟棄值為 `undefined` 的鍵，不補就會產出缺這四個欄位的
author row，違反契約明寫的必填保證。對既有的九種列而言這是 no-op（那些文件一定
有值），但改完之後「every author row 必有這五個欄位」是由這個函式保證的，而不是
靠每個 collection 剛好都有。

`bumpAggregate` **不新增 case**。它以 `doc.collection.name` 分派且沒有 default
分支，`"gifts"` 自然不計入任何 aggregate，符合「不動 meta.json」。

gift 列會讓列數計數器 `no` 遞增，因此一支只有禮物的直播會產生 `.jsonl`，而
`meta.json` 的 aggregates 全為 0。這是預期行為：aggregates 是各類訊息的計數器，
本來就不是用來反映 jsonl 是否有內容。

### 三、觸發條件

`src/components/chats-archive.ts` 的 `archiveAllChats` 中，
`messageType: { $in: [...] }` 加入 `MessageType.Gift`。只收到禮物的直播因此也會
被封存；否則那些禮物會在 cleanup 後永久消失。

### 四、契約變更（Path A，additive）

只動 `docs/data-contract/video-chats.md`，version 維持 2，新增 revision **r1**：

- `JsonlRow` 聯集加入 `GiftRow`，並補上 `GiftRow` 介面（如上）
- 修訂歷史新增一列：`2 | r1 | 2026-08-10 | —`。`PR` 欄用 `—`，比照既有兩列 ——
  本 repo 直接推 `dev`，沒有 PR 編號。
- 檔頭 `Current writer emits` 改為 `version 2, revision r1`
- 章節末的 cumulative JSON example 重新產生，加入一筆 gift 列
- Reader guidance 補三點：
  - `gift` 列的欄位，標注 `since r1`；`giftName` / `assetName` / `image` /
    `amount` 列在「May be absent depending on revision」
  - `amount` 缺席的成因：單價是事後從連擊訊息推導的，價格表尚未學到該資產時
    就沒有金額
  - `authorChannelId` 在 gift 列上可能是空字串：只有單價 ≥ 100 Jewels 的禮物
    帶得到送禮者頻道；同時 `authorType` 恆為 `"other"`，三個布林恆為 `false`

分類為 additive 的依據：新增的是聯集的一個新成員與該成員自己的可選欄位，既有
九種列的欄位名稱、型別、可選性、語意、編碼、單位、排序全部不變，符合
`docs/data-contract/README.md` §4 的 additive 條件。`video-meta.md` 完全不動，
其 version 2 章節不受影響。

`README.md` §2 的檔案型別索引不需要變更（`video-chats` 的 current active
version 仍是 2）。

`§8.1` 要求的資料來源 research：masterchat 的 gift action 形狀已在
[2026-08-09-youtube-gift-actions-design.md](./2026-08-09-youtube-gift-actions-design.md)
經 research subagent 讀 `node_modules/@stu43005/masterchat` 原始碼確認並實作
完成，`Gift` model 即該次產出。本設計不引入任何新的資料來源欄位 —— 寫進 jsonl
的每個欄位都直接取自既有的 `Gift` 文件。

## 資料流

```
worker ─→ gifts collection
                │
                │  (archiveAllChats 每分鐘挑選未封存且近 2 小時有活動的影片)
                ▼
        archiveVideo(videoId)
                │
                ├─ GiftModel cursor (sort timestamp)  ┐
                ├─ ChatModel / SuperChat / ... cursor ├─→ multiCursorOrderedPeek
                │                                     ┘         │
                │                                               ▼
                │                                     buildJsonlRow → makeAuthorRow
                │                                               │
                ▼                                               ▼
        aggregates（gift 不計入）              {videoId}.jsonl（含 gift 列）
                │                                               │
                ▼                                               │
        {videoId}.meta.json ←── rename 順序：先 jsonl 再 meta ───┘
```

## 錯誤處理與邊界

- **影片沒有任何 gift 文件**：cursor 立即耗盡，`multiCursorOrderedPeek` 不產出
  任何 gift 列，其餘行為不變。
- **只有 gift 文件**：`.jsonl` 照常寫出，`meta.json` 的 aggregates 全為 0。
- **`amount` / `giftName` / `assetName` / `image` 缺值**：`setIfDefine` 讓該鍵
  整個不出現在列裡，讀者依 reader guidance 當作缺席處理。
- **`authorChannelId` 缺值**：寫 `""`（見上）。
- **`timestamp`**：`Gift` 一定有這個欄位（model 標為 required），
  `getTimestamp` 的第一個分支就會命中，不會退回 `_id` 的時間。
- **封存失敗**：`archiveAllChats` 既有的 try/catch 會記 log 並繼續處理下一支
  影片，旗標不設，下一輪重試 —— 行為不變。
- **同一支影片重複封存**：`ChatsArchiveProcessed` 旗標擋掉；`archiveVideo` 本身
  也是覆寫式寫入（寫 `.tmp` 再 rename），重跑不會產生半份檔案。

## 測試

`archive-video.ts` 目前沒有測試檔。本設計新增
`src/components/chats-archive/archive-video.spec.ts`，只測 `buildJsonlRow` ——
它是 `(doc, videoId) → 列` 的純函式，只讀 `doc.collection.name` 與文件欄位，用
手寫的普通物件就能餵，不需要資料庫，也不需要 mock 任何模組。為此把
`buildJsonlRow` 從模組私有改為 export。

測試項目：

1. **gift 文件轉出完整的列**：帶齊所有欄位的 gift 文件 → 用 `toEqual` 斷言整
   列的結構，含 `type: "gift"`、`currency: "JEWEL"`、四個可選欄位都在。
2. **缺值欄位整個不出現**：只有必填欄位的 gift 文件 → 斷言列上**沒有**
   `giftName` / `assetName` / `image` / `amount` 這四個鍵（用
   `not.toHaveProperty`，而不是斷言其值為 undefined —— 後者無法分辨「鍵不存在」
   與「鍵存在但值為 undefined」，而只有前者才會被 `JSON.stringify` 正確省略）。
3. **author 必填欄位被補齊**：同上那份最小 gift 文件 → 斷言
   `authorChannelId === ""`、`isVerified === false`、`isOwner === false`、
   `isModerator === false`、`authorType === "other"`。
4. **既有列型別不受影響**：一份 superchat 文件 → 斷言轉出的列與變更前一致
   （含 `authorChannelId` 保留原值、三個布林保留原值），證明第 4 點的定值退回
   沒有覆蓋既有資料。

## 驗證

- `npm run build && npm run lint && npm run format:check && npm test` 全數通過
- 契約審查：本設計與其實作計畫須通過 `docs/data-contract/README.md` §8 的
  reviewer checklist（Path A）
- 部署後在有禮物的影片上抽驗 `{videoId}.jsonl`：應含 `"type":"gift"` 的列，
  時間順序與相鄰列一致；低單價禮物的列 `"authorChannelId":""`
