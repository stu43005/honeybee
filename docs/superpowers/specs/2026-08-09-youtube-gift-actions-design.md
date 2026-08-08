# YouTube Gift（Jewels）action 收集與統計 設計

## 目標

收集 masterchat 新增的兩種 action —— `addGiftItemAction` 與
`addGiftTickerAction` —— 寫入新的 `gifts` collection，並在 VideoStats 產出兩項
統計：`message_total`（gift 訊息筆數）與 `purchase_amount_total`（jewel 合計）。

Gift 是 YouTube 以 **Jewels 虛擬代幣**購買的打賞道具，行為近似 SuperSticker，但
不帶任何金額欄位（大多數情況）、不帶 badge 資訊、也不帶真實貨幣。單價必須由
系統自行推導並維護一份 **Gift 價格總表**。

## 非目標

- 不做 chats-archive 整合：`gifts` 不寫進 `{videoId}.jsonl` 或 video-meta 摘要，
  `docs/data-contract/` 不變動。
- 不做 jpy 換算：不產出 `purchase_amount_jpy_total`，Gift 不進
  `recalcVideoHbStats`。`hbStats.totalGifts` 維持「會籍禮物」語意，不混用。
- 不做 users 統計：不開 `calcUsersTotal`，不寫 `VideoUserStats`。
- 不回填歷史 `amount`：價格表學到新價格後不回頭修正既有文件（見「已接受的
  不準確」）。
- 不處理跨版本部署 / 回滾 / 混版安全（依專案既有慣例不在本設計範圍）。

## 名詞與既有機制（事實基準）

以下皆為實際讀取原始碼 / 生產資料取得，非推測。

### masterchat 2.1.0 型別（`node_modules/@stu43005/masterchat/lib/masterchat.d.ts`）

專案 `package.json` 宣告 `"@stu43005/masterchat": "^2.1.0"`，`node_modules` 內
實際安裝版本為 `2.1.0`。

```ts
interface AddGiftItemAction {
  type: "addGiftItemAction";
  id: string;
  /**
   * Recovered from `id` — YouTube ships no timestamp field on a gift. Absent
   * when the id does not follow the shape `timestampUsecFromChatItemId` reads.
   */
  timestamp?: Date;
  timestampUsec?: string;
  authorName: string;
  /** absent in the generic `image` variant */
  authorPhoto?: string;
  /** raw text content, always present, e.g. "sent Heart for 10 Jewels" */
  message: string;
  /** parsed from `message`; undefined outside the English locale */
  giftName?: string;
  /** parsed from `message`; thousands separators removed */
  jewelCount?: number;
  /** parsed from `message`; present only for combo gifts */
  comboCount?: number;
  /** absent in the generic `image` variant */
  giftImageUrl?: string;
  giftA11yLabel?: string;
}

interface AddGiftTickerAction {
  type: "addGiftTickerAction";
  id: string;
  authorChannelId: string;
  /** absent when the ticker carries no sponsor thumbnails */
  authorPhoto?: string;
  durationSec: number;
  fullDurationSec: number;
  contents: GiftTickerContent;
  startBackgroundColor: Color;
  endBackgroundColor: Color;
}

interface GiftTickerContent {
  id: string;
  timestamp: Date;
  timestampUsec: string;
  authorChannelId: string;
  authorName?: string;
  authorPhoto?: string;
  /** from purchaseText.runs[1].text, or the gift text regex as a fallback */
  giftName?: string;
  purchaseText?: string;
  stickerUrl?: string;
}
```

兩者皆為 `Action` union 的成員，discriminant 分別是 `"addGiftItemAction"` 與
`"addGiftTickerAction"`。與 `AddSuperChatItemAction` /
`AddSuperStickerItemAction` 不同，Gift 兩型**都不 extends `Badges`**（沒有
`isOwner` / `isModerator` / `isVerified` / `membership`），也**不 extends
`SuperChat<T>`**（沒有 `amount` / `currency` / `color` / `significance`）。

masterchat 的 doc comment 明示：同一份禮物會同時產生 item 與 ticker 兩個 action、
共用同一個 `id`，且 masterchat **不做去重**，由消費端自行處理。

`message` 由 masterchat 內部的 `GIFT_TEXT_RE`
（`/^(?:sent|comboed x(\d+)) (.+?)(?: for ([\d,]+) Jewels?)?$/i`）解析成
`giftName` / `jewelCount` / `comboCount`；regex 未命中時三者皆 undefined，但原始
`message` 仍保留。

### 生產資料觀測到的 combo 三種面貌

一波連擊在資料裡有三種形態，取決於觀測時機與 YouTube 給出的呈現方式。

**（一）detailed 進行中 —— 每一份都是獨立訊息、各自不同 `id`**

`9hFxGFgx8Pc` 的送禮者送 Heart（單價 10）：

```text
sent at    message
+  0.000   sent Heart for 10 Jewels
+  3.692   comboed x2 Heart for 10 Jewels
+  5.125   comboed x3 Heart for 10 Jewels
+  7.833   comboed x4 Heart for 10 Jewels
+  8.417   comboed x5 Heart for 10 Jewels
+140.296   sent Heart for 10 Jewels        ← 140 秒後的新一波，combo 歸零
```

6 個完全不同的 `id`。第一份寫 `sent`，沒有 `comboed x1`。`for 10 Jewels` 從頭到
尾都是 **10 —— 那是單價不是累計**。每一則代表 1 份。

**（二）detailed 結算 —— 同一個 `id` 被重發，金額變成總額**

```text
id ChwKGkNNeThscC1yMXBFREZjRVlyUVlkQmYwWmlB

   13:33:23  收到   sent Heart for 10 Jewels        ← 單價
   14:46:07  收到   comboed x8 Heart for 80 Jewels  ← 8 × 10，同一個 id
```

這波送了 8 份，但**只有第 1 份的 `id` 被改寫成 x8，其餘 7 份仍是各自獨立的 chat
item**。因此若把 combo 訊息的金額也加總，會重複計算（80 + 7×10 = 150，實際 80）。

**（三）merged —— 整波只有一則訊息，原地更新**

`62hbNGH85Po` 的送禮者送 Star（單價 2）：

```text
id ChwKGkNPSFA5NFQtLXBJREZRNlZ3Z1FkM09RMTJ3

   15:47:52  收到   sent Star                      ← 沒有金額
   17:26:05  收到   sent Star                      ← 重送，仍無金額
   17:52:46  收到   comboed x4 Star for 8 Jewels   ← 4 × 2，同一個 id
```

整波 4 份禮物只有一個 `id`。第 2、3、4 份完全不會產生新的 chat item —— 它們被
摺進第一則。三次投遞的訊息時間戳完全相同（都來自同一個 `id`），變的只有內容。

**兩種模式由 `giftImageUrl` 的有無區分：**

|                             | merged（**有** `giftImageUrl`，約 90%） | detailed（**無** `giftImageUrl`，約 10%）  |
| --------------------------- | --------------------------------------- | ------------------------------------------ |
| 一波 combo 的 `id` 數       | 1 個，原地更新                          | 每份一個，各自獨立                         |
| `sent X`                    | 不帶 `jewelCount`                       | `for P Jewels`，**P = 單價**               |
| `comboed xN X for J Jewels` | **J = 整波總額**（單價 = J / N）        | **J = 單價**（形態一）或整波總額（形態二） |
| 一則訊息代表                | 整波 N 份                               | **恆為 1 份**                              |

這解釋了為何 `price = jewelCount / comboCount` 只在有 `giftImageUrl` 時安全：
merged 模式的 `sent` 不帶金額，帶金額的一定是已結算的 combo 訊息。

### 其他實測規則

- ticker 全都帶 `stickerUrl`（即 `giftImageUrl` 的同源資產）；item 約 10% 缺
  `giftImageUrl`。
- `authorChannelId` **只出現在 ticker**。
- ticker **只出現在單價 ≥ 100 Jewels 的禮物上**。低單價禮物（如 Heart 10、
  Star 2）永遠不會有 ticker。
- 去重方式與其他 action 一致：以 `id` 為唯一鍵；item 與 ticker 共用同一個 `id`。

### giftImageUrl / stickerUrl 實際型態

前綴一律是 `https://www.gstatic.com/youtube/img/pdg/gift/`：

```text
giftName        giftImageUrl（chat item）                stickerUrl（ticker）
Finger heart    …/assets/finger_heart.png=w640-h640      …/assets/finger_heart.png
Kami            …/assets/kami.png=w640-h640              …/assets/kami.png
Fireworks       …/assets/hanabi.png=w640-h640            …/assets/hanabi.png
Good work       …/assets/goodwork_jp.png=w640-h640       …/assets/goodwork_jp.png
Wotagei (Red)   …/assets/wotagei_red.png=w640-h640       …/assets/wotagei_red.png
Pudding cat     …/assets/pudding_cat.png=w640-h640       …/assets/pudding_cat.png
Matsuri Fan     …/assets/maturi_uchiwa.png=w640-h640     …/assets/maturi_uchiwa.png
Jammin          …/assets/cat_jammin.png=w640-h640        …/assets/cat_jammin.png
```

尺寸後綴 `=w640-h640` 直接附在**最後一段 path**上（不是 query string），且
item 版有、ticker 版沒有。顯示名稱與資產名不是一對一（`Fireworks` → `hanabi`、
`Matsuri Fan` → `maturi_uchiwa`），且同一顯示名稱可能對到兩個不同 Gift 類型 ——
因此**資產名必須以圖檔名為鍵，顯示名稱只能當對照標籤**。

### 既有機制

- `src/commands/worker.ts` 的 `handleActions` 先 `groupBy(actions, "type")`，再
  逐 type 進 switch；各 case 多以 `Model.insertMany(payload, insertOptions)` 寫入，
  外層 catch 對 `MongoBulkWriteError` + `code === 11000` 只記 log 後 `continue`
  （replica > 1 重複寫入靠唯一索引擋下）。
- `src/components/video-stats.ts` 的 `updateStats` 是**增量式**：以
  `lastId`（`_id` 水位）為界 `$match: { _id: { $gt: lastId } }`，`$inc` 累加。
  每份文件只會被計入一次；文件被計入後才變動的欄位不會被補算。
- `messageTypes` 陣列的每個項目以 `calcUsersTotal` / `calcAmount` /
  `calcJpyAmount` 三個旗標決定要跑哪些 cron。`message_total` 固定用
  `labels: { videoId, authorType }`、`purchase_amount_total` 固定用
  `labels: { videoId, authorType, currency }`。
- `src/commands/metrics.ts` 對 `MessageTotal` / `PurchaseAmountTotal` 皆有
  `if (!videoStats.authorType) break;` 守衛 —— 沒有 `authorType` 的統計記錄不會
  匯出到 Prometheus。
- `src/modules/db.ts` 的 `importAllModels()` 掃描 `src/models/` 全部檔案並
  `import`，`getModelByCollectionName()` 再從 `mongoose.models` 反查。**新增
  model 檔案即自動註冊**，webhook change stream 不需要額外登錄。
- `src/modules/webhook/changestream.ts` 的 `handleChangeEvent` 對
  `operationType === "update"` 有 `if (!webhook.followUpdate) continue;`。
  `Webhook.followUpdate` 預設未設定（falsy），因此 track / DM 產出的 webhook
  **只會在 insert 事件觸發**。
- `MAX_HOURS_BEFORE_CLEANUP = METRICS_MAX_ENDED_HOURS + 1 = 2`
  （`src/constants.ts:27-28`）。`src/components/cleanup.ts` 的 `cleanVideos` 會在
  直播結束 2 小時後刪除該影片的全部訊息文件。
- `src/modules/cache.ts` 的 `getCacheInstance` 提供 memory + Redis 雙層快取，
  支援 `ttl` / `refreshThreshold`。

## 架構總覽

```text
worker ── addGiftItemAction ─┐
         addGiftTickerAction ┴─▶ mergeGiftActions（同批次以 id 合併）
                                        │
                                        ├─ parseGiftAssetName(image)
                                        ├─ getGiftPriceTable()  ◀── giftprices（快取）
                                        └─ deriveGiftAmount()
                                                │
                                                ▼
                                  GiftModel.bulkWrite（pipeline upsert）
                                                │
                                  ┌─────────────┼─────────────┐
                                  ▼             ▼             ▼
                          video-stats     webhook          cleanup
                        （message_total  change stream   （2h 後刪除）
                     purchase_amount_total）
                                  ▲
manager ── "gift price rebuild" ──┴─▶ giftprices（純累加，永不刪除）
```

## 資料模型

### `src/models/Gift.ts` → collection `gifts`

| 欄位              | 型別                | required    | 來源                                                        |
| ----------------- | ------------------- | ----------- | ----------------------------------------------------------- |
| `id`              | `string`            | ✓（unique） | item / ticker 共用                                          |
| `timestamp`       | `Date`              | ✓           | `item.timestamp` ?? `ticker.contents.timestamp` ?? 接收時間 |
| `authorName`      | `string`            |             | `item.authorName` / `ticker.contents.authorName`            |
| `authorPhoto`     | `string`            |             | `item.authorPhoto` / `ticker.contents.authorPhoto`          |
| `authorChannelId` | `string`            |             | **只有 ticker 有**                                          |
| `authorType`      | `MessageAuthorType` | ✓           | 固定 `MessageAuthorType.Other`                              |
| `message`         | `string`            |             | `item.message` 原始文字                                     |
| `giftName`        | `string`            |             | `item.giftName` / `ticker.contents.giftName`                |
| `assetName`       | `string`            |             | 由 `image` 推導                                             |
| `image`           | `string`            |             | `item.giftImageUrl` ?? `ticker.contents.stickerUrl`         |
| `jewelCount`      | `number`            |             | action 原始值                                               |
| `comboCount`      | `number`            |             | action 原始值                                               |
| `amount`          | `number`            |             | 推導出的 jewel 金額                                         |
| `currency`        | `string`            | ✓           | 固定 `"JEWEL"`                                              |
| `originVideoId`   | `string`            | ✓（index）  |                                                             |
| `originChannelId` | `string`            | ✓           |                                                             |
| `isReplay`        | `boolean`           |             |                                                             |

索引：

- `id` unique（比照其他訊息 model）
- `{ originVideoId: 1, timestamp: 1 }`（比照 `SuperSticker`）
- 支援價格重建掃描的 partial index：
  `{ assetName: 1 }`，`partialFilterExpression: { assetName: { $exists: true }, jewelCount: { $exists: true }, comboCount: { $exists: true } }`

`authorType` 固定寫 `other` 的理由：Gift action 完全沒有 badge 欄位，無從判斷。
寫入常數值可讓 `video-stats` 的 label、`VideoStats` 的唯一索引、以及
`metrics.ts` 的 `authorType` 守衛全部沿用既有路徑，零框架改動。代價是會員 /
版主 / 台主送的禮物也被歸到 `other` —— 但那本來就無法得知。

`currency` 固定寫 `"JEWEL"` 的理由：`purchase_amount_total` 的 label 含
`currency`，寫入常數比留空更能表達「這筆金額的單位是 Jewels 而非法幣」，也讓
metrics 的 label 集合保持完整。Gift 不進任何 jpy 換算路徑，因此 `"JEWEL"` 不會
被送進 `currencyToJpyAmount` / `getCurrencymapItem`。

### `src/models/GiftPrice.ts` → collection `giftprices`

| 欄位          | 型別     | required    | 說明                                           |
| ------------- | -------- | ----------- | ---------------------------------------------- |
| `assetName`   | `string` | ✓（unique） | 唯一鍵，例如 `finger_heart`                    |
| `price`       | `number` | ✓           | 單價（Jewels）                                 |
| `giftName`    | `string` |             | 最後觀測到的顯示名稱，**僅供對照，不參與查價** |
| `sampleCount` | `number` | ✓           | 最近一次重建時支持此價格的觀測筆數             |

繼承 `TimeStamps`（`createdAt` / `updatedAt`）。

`giftprices` **不被 `cleanup` 清除** —— 它是跨直播累積的知識庫。

## `src/components/gift.ts`（worker 端純函式）

### `parseGiftAssetName(url: string | undefined): string | undefined`

取 URL 最後一段 path → 切掉第一個 `=` 之後的內容 → 去掉副檔名。

```text
…/assets/finger_heart.png=w640-h640  →  finger_heart
…/assets/finger_heart.png            →  finger_heart
```

去副檔名而非保留，是為了讓同一資產若日後改以其他圖檔格式提供時仍收斂到同一個
鍵。`url` 為 undefined、或算出空字串時回傳 undefined。

### `getGiftPriceTable(): Promise<Map<string, number>>`

透過 `getCacheInstance({ ttl: 5 分鐘, refreshThreshold: 1 分鐘 })` 快取整張
`assetName → price` 表（單一 cache key）。資產總數是數百量級，整張載入遠比
逐鍵查詢省往返。5 分鐘 TTL 讓 manager 重建後最多 5 分鐘內生效。

### `deriveGiftAmount(fields, priceTable): number | undefined`

`fields` 為合併後的 `{ hasGiftImageUrl, assetName, jewelCount, comboCount }`。

```text
merged 模式（item 帶 giftImageUrl）—— 這則代表整波
  jewelCount != null  →  jewelCount            // 已結算，整波總額
  否則                 →  priceTable[assetName] // 尚未 combo，代表 1 份

detailed 模式（item 未帶 giftImageUrl）—— 這則恆代表 1 份
  comboCount == null  →  jewelCount            // jewelCount 即單價
  否則                 →  undefined             // 單價不可得，見下
```

detailed 模式的 combo 訊息之所以留空：這類訊息沒有 `giftImageUrl` 就沒有
`assetName`，而低單價禮物又永遠不會有 ticker 補圖，因此**單價在該文件上永遠
不可得**。且形態一（`J = 單價`）與形態二（`J = 單價 × N`）在不知單價時無法區分，
硬取 `jewelCount` 會在形態二上高估數倍。留空是唯一不會系統性放大誤差的選擇。

`amount` 是「這一份文件所代表的 jewel 金額」。merged 模式一筆代表整波，detailed
模式一筆代表 1 份 —— 兩者相加即為該影片的 jewel 合計，不重複計算。

### `mergeGiftActions(items, tickers, ctx): GiftUpsert[]`

同批次內以 `id` 為鍵合併 item 與 ticker，輸出每個 `id` 一筆 upsert 描述。合併
必須在寫入前完成，理由有二：

1. ticker 帶的 `authorChannelId` 能出現在 change stream 的 **insert** 事件上。
   若分兩次寫，item 先到會產生一筆沒有 `authorChannelId` 的 insert，而後續
   ticker 的 update 事件會被 `followUpdate` 守衛擋掉 —— webhook 就永遠不會觸發。
2. 減少一半的 Mongo 往返。

同一批次內同一 `id` 出現多個 item（形態三的重送）時，取 combo 狀態較新者
（見下）。

## 寫入：`GiftModel.bulkWrite(ops, { ordered: false })`

每筆 op 是 **aggregation pipeline update + `upsert: true`**。用 pipeline 而非
`$setOnInsert` + `$set`，是因為兩種語意要在同一次原子更新裡表達：

**互補欄位（填缺不覆蓋，`$ifNull`）**

`timestamp`、`authorName`、`authorPhoto`、`authorChannelId`、`giftName`、
`image`、`assetName`、`authorType`、`currency`、`originVideoId`、
`originChannelId`、`isReplay`。

item 與 ticker 各持有對方沒有的欄位，先到者寫入、後到者補齊。已存在的值不覆蓋。

**combo 狀態群（整組替換）**

`message`、`jewelCount`、`comboCount`、`amount`。

這四個欄位必須**當作一個整體**替換，不能各自填缺。形態二的 `id` 先收到
`sent Heart for 10 Jewels`（`jewelCount=10`，無 `comboCount`），後收到
`comboed x8 Heart for 80 Jewels`（`jewelCount=80, comboCount=8`）；若逐欄填缺，
會留下 `jewelCount=10, comboCount=8` 這個從未存在過的組合。

替換條件：以 `comboCount ?? 1` 較大者勝出；相等時，帶 `jewelCount` 的那版勝出。
ticker 不帶任何 combo 資訊，因此永遠不觸發這組替換。

`amount` 隨 combo 狀態群一起替換，因為它是由 `jewelCount` / `comboCount` /
`giftImageUrl` 三者推導而來，與它們必須保持一致。

replica > 1 的並發 upsert 可能撞出 `code 11000`；`ordered: false` 加上 worker
既有的 `MongoBulkWriteError` catch 已能吞掉，不需新增處理。

## worker 整合

`handleActions` 的 switch 新增：

```ts
case "addGiftItemAction":
case "addGiftTickerAction": {
  // fallthrough：兩個 type 都會進來，但一批只處理一次
}
```

因為外層是「逐 type 迭代」，fallthrough 會讓同一批次進入這個 case 兩次。以
`handleActions` 區域範圍的一次性旗標擋掉第二次，並在區塊內直接讀取
`groupedActions["addGiftItemAction"]` 與 `groupedActions["addGiftTickerAction"]`
兩組（其中一組可能不存在）。

`timestamp` 缺值時的接收時間，在**進入 `handleActions` 時取一次**並沿用整批，
避免同批次文件時間戳散落。

## 價格表重建：`src/components/gift-price.ts`（manager）

Agenda job `"gift price rebuild"`，每 10 分鐘執行：

1. 對 `gifts` 聚合，`$match` 出 `assetName` / `jewelCount` / `comboCount` 皆存在
   且 `comboCount > 0` 的文件（走 partial index），算
   `price = jewelCount / comboCount`。
2. 依 `assetName` 取本次窗口內**出現次數最多**的 price，並記下最後看到的
   `giftName`。
3. **純累加 upsert**（永不 `deleteMany`）：
   - 該 `assetName` 尚無記錄 → 直接寫入。
   - 已有記錄且價格相同 → 更新 `sampleCount` 與 `giftName`。
   - 已有記錄但價格不同 → **僅當本次觀測筆數 ≥ 2 才覆蓋**，並輸出警告 log；
     觀測筆數為 1 時保留舊值（單筆解析雜訊不足以推翻既有價格）。

`readPreference: "secondaryPreferred"`，比照 `video-stats` 的既有做法。

**為何必須純累加**：`MAX_HOURS_BEFORE_CLEANUP = 2`，`gifts` 只留最近兩小時內
有活動的影片資料。若採「全量重算後覆蓋」，任何最近兩小時沒被送出的禮物，其
價格會被整個抹掉。純累加 upsert 讓價格表只增不減。

因為是純累加、且每次都重掃當前窗口，不需要 `_id` 水位或任何額外的狀態文件。
單次窗口漏掉只會延後學到價格，下次該禮物出現時自動補上。

## 統計整合

`src/interfaces.ts` 新增 `MessageType.Gift = "gift"`（與既有
`MembershipGift = "membershipGift"` 不同值，不衝突）。

`src/components/video-stats.ts` 的 `messageTypes` 新增一項：

```ts
{ messageType: MessageType.Gift, model: GiftModel, calcAmount: true }
```

框架**零改動**。因為 Gift doc 固定帶 `authorType = "other"` 與
`currency = "JEWEL"`：

- `message_total` 走既有 `$sum: 1`，labels `{ videoId, authorType }`。
- `purchase_amount_total` 走既有 `$sum: "$amount"`，labels
  `{ videoId, authorType, currency }`。缺 `amount` 的文件在 `$sum` 中視為 0。
- `metrics.ts` 的 `if (!videoStats.authorType) break;` 自然通過，Prometheus 會
  以 `type="gift"` / `authorType="other"` / `currency="JEWEL"` 匯出。

不開 `calcUsersTotal`（`authorChannelId` 大多缺失，統計會嚴重低估且產生大量
無意義記錄）、不開 `calcJpyAmount`（Jewels 不是法幣）、不加入
`recalcVideoHbStats`。

## cleanup 整合

`src/components/cleanup.ts` 的 `cleanVideos` 新增
`await Gift.deleteMany({ originVideoId: { $in: videoIds } });`，位置比照其他
訊息 model（在 `Chat.deleteMany` 之前）。

`giftprices` 不清除。

## webhook / track 整合

`getModelByCollectionName` 由 `importAllModels()` 自動掃描 `src/models/`，新增
`Gift.ts` 即自動可用，**不需要註冊表改動**。

要改的是：

- `src/data/track.ts` —— `chats`、`chatsOtherChannels`、`followedChats` 三個
  preset 的 `colls` 加入 `"gifts"`。
  **`moderatorChats` 不加**：它 match `isModerator: true`，而 Gift 沒有任何
  badge 欄位，永遠不會命中；加了只是白開一條 change stream 並對每筆 gift 做
  無用的 `isMatching`。
  `"gifts"` 不受 `withoutNormalChats` 影響（它不是一般聊天訊息，比照
  `"superchats"` 恆包含）。
- `src/components/youtube-dm-operator.ts` —— `DM_COLLS` 加入 `"gifts"`。
- `src/data/webhook.ts` ——
  - `getMessage()` 新增 `collection === "gifts"` 分支。Gift 的 `message` 欄位
    存在時會先被 `parameters.message` 那條路徑取用（原始英文文字，如
    `"comboed x5 Heart for 17,000 Jewels"`）；`message` 缺失（ticker-only 文件）
    時才走新分支，以 `giftName` 組出顯示文字。
  - `discord-embed-chats` 的 `fields` 新增 Gift 分支，顯示 `${amount} Jewels`
    （`amount` 缺失時只顯示 `giftName`）。
  - `parameters.image` 已是通用處理，禮物圖會自動出現在 embed。

## 已接受的不準確

以下皆為明知且接受的取捨，不再額外投入工程量修正：

- **detailed 模式的 combo 訊息 `amount` 留空**。這類文件永遠拿不到 `assetName`
  （無 `giftImageUrl`、低單價無 ticker），且形態一與形態二在不知單價時無法區分。
  jewel 合計因此系統性低估。
- **新資產上線初期 `amount` 留空且不回填**。價格表由 manager 每 10 分鐘重建，
  首次見到某資產到價格可用之間寫入的文件不會有 `amount`；`updateStats` 是增量式
  （`_id` 水位 + `$inc`），即使日後回填也不會被補算，因此設計上直接不回填。
- **merged 模式一波 combo 只產生一筆文件**，所以 `message_total` 是「gift 訊息
  筆數」而非「禮物件數」。這與其他 `messageType` 的 `message_total` 語意一致
  （皆為文件筆數）。
- **webhook 覆蓋率低**。track / DM 的 preset 都以 `authorChannelId` 過濾，而該
  欄位只有 ticker（單價 ≥ 100 Jewels）才有；加上 `followUpdate` 預設關閉、只有
  insert 事件會觸發，因此只有「ticker 與 item 落在同一批次而被合併」或「ticker
  先於 item 到達」的高單價禮物才會發出 webhook。

## 邊界與失敗情境

- **`GIFT_TEXT_RE` 未命中**（非英文 locale 或 YouTube 改文案）：`giftName` /
  `jewelCount` / `comboCount` 全為 undefined，`message` 仍保留原文。文件照常寫入
  並計入 `message_total`；`amount` 依規則留空。價格表不受污染。
- **`item.timestamp` 缺失**（`id` 不符 `timestampUsecFromChatItemId` 形狀）：
  退回該批次的接收時間。ticker 的 `contents.timestamp` 永遠存在，若同批合併則
  優先採用。
- **價格表為空**（首次部署）：所有 merged 模式未結算文件的 `amount` 留空，直到
  第一次重建跑完。已結算文件（帶 `jewelCount`）不受影響。
- **同一 `assetName` 觀測到兩種價格**：可能是 YouTube 調價，也可能是解析雜訊。
  規則為「本次窗口觀測 ≥ 2 才覆蓋」並記 log，讓調價能生效、單筆雜訊被擋下。
- **replica > 1 並發 upsert**：`ordered: false` + 既有 11000 catch。pipeline
  update 本身是原子的，兩個 replica 送同樣內容不會互相破壞。
- **同批次同 `id` 多筆 item**（形態三重送）：`mergeGiftActions` 先在記憶體內以
  combo 狀態新舊收斂成一筆，再送出單一 upsert。

## 測試重點

- `parseGiftAssetName`：item 版（帶 `=w640-h640`）與 ticker 版（不帶）產生同一
  `assetName`；不同禮物產生不同 `assetName`；undefined / 空字串 / 無副檔名輸入。
- `deriveGiftAmount`：merged 已結算 / merged 未結算（查表命中與未命中）/
  detailed 非 combo / detailed combo（留空）四條路徑各一，且以生產資料的實際
  數值（Heart 10、Star 2、x8/80、x4/8）為測資。
- `mergeGiftActions`：item-only、ticker-only、同批 item+ticker（驗證
  `authorChannelId` 與 `image` 都出現在同一筆輸出）、同批多筆同 `id`（驗證
  combo 狀態取新者）。
- combo 狀態群替換規則：以形態二（`sent … for 10` → `comboed x8 … for 80`）與
  形態三（`sent Star` → `comboed x4 Star for 8`）為測資，斷言四個欄位整組替換、
  不出現 `jewelCount=10, comboCount=8` 這類混合狀態。
- 價格表重建：新資產寫入、同價更新 `sampleCount`、異價單筆不覆蓋、異價雙筆覆蓋
  四種情形；並斷言重建**不會刪除**窗口內未出現的既有資產。
- 依專案慣例，Mongo / Redis 依賴以 `jest.unstable_mockModule` 搭配有狀態的
  fake（非裸 `jest.fn()`），確保 upsert 前後的可觀測狀態變化能被斷言。

## 計畫階段待確認（不臆測）

- `getCacheInstance` 的 `refreshThreshold` 在 cache-manager 目前版本的實際
  semantics（背景 refresh 是否會阻塞讀取），需在 plan 階段以 research subagent
  讀 `node_modules/cache-manager` 確認後再定 TTL 參數。
- Mongoose `bulkWrite` 的 `updateOne` 搭配 aggregation pipeline `update` 與
  `upsert: true` 時，pipeline 在 insert 路徑上對不存在欄位的 `$ifNull` 行為，
  需以 research subagent 讀 `node_modules/mongoose` 與 MongoDB 版本確認。
- `partialFilterExpression` 與既有 `attachIndexWarningListeners`
  （`src/modules/db.ts`）的互動：專案先前有過 partial index 相關設計
  （`2026-05-20-mongo-partial-index-fix-design.md`），需在 plan 階段對照其結論。
