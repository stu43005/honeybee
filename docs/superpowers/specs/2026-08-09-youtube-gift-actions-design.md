# YouTube Gift（Jewels）action 收集與統計 設計

## 目標

收集 masterchat 新增的兩種 action —— `addGiftItemAction` 與
`addGiftTickerAction` —— 寫入新的 `gifts` collection，並在 VideoStats 產出兩項
統計：`message_total`（gift 總數）與 `purchase_amount_total`（jewel 合計）。

每送出一份禮物就是一個獨立的 `id`、一份文件，所以 `message_total` 的文件筆數
等同於禮物件數；`amount` 則恆為單價，整波連擊的金額由該波的多個 `id` 各自貢獻
一份自然加總得出。

Gift 是 YouTube 以 **Jewels 虛擬代幣**購買的打賞道具，行為近似 SuperSticker，但
不帶任何金額欄位（大多數情況）、不帶 badge 資訊、也不帶真實貨幣。單價必須由
系統自行推導並維護一份 **Gift 價格總表**。

## Non-goals / Accepted limitations（非目標與已接受的限制）

### 非目標

- 不做 chats-archive 整合：`gifts` 不寫進 `{videoId}.jsonl` 或 video-meta 摘要，
  `docs/data-contract/` 不變動。
- 不做 jpy 換算：不產出 `purchase_amount_jpy_total`，Gift 不進
  `recalcVideoHbStats`。`hbStats.totalGifts` 維持「會籍禮物」語意，不混用。
- 不做 users 統計：不開 `calcUsersTotal`，不寫 `VideoUserStats`。
- 不回填歷史 `amount`：價格表學到新價格後不回頭修正既有文件。
- 不處理跨版本部署 / 回滾 / 混版安全（依專案既有慣例不在本設計範圍）。

### 已接受的限制

以下皆為明知且接受的取捨，不再額外投入工程量修正：

- **無 `giftImageUrl` 又無 ticker 的文件拿不到 `assetName`，`amount` 一律留空**。
  `assetName` 只能從圖片 URL 推導，而約 10% 的 item 不帶 `giftImageUrl`；這些
  文件只有在單價 ≥ 100 Jewels、ticker 補上 `stickerUrl` 時才查得到價。唯一的
  例外是 `sent X for P Jewels`（無 `comboCount`），此時 `P` 就是單價、不需查表。
  其餘一律留空，jewel 合計因此系統性低估。
- **價格未知的資產 `amount` 留空，且寫入後不回填**。價格只能從帶 `comboCount`
  的訊息推導，因此**從未被連擊過的資產可能永久學不到價**，不只是上線初期的
  暖機窗口 —— 而且偏差方向不利：高單價禮物通常一次只送一個，最不容易被連擊，
  卻在 jewel 合計裡權重最大。營運出口是**手動在 `giftprices` 補一筆
  `manual: true` 的價格**，最多 5 分鐘後對新寫入的文件生效；已寫入的舊文件
  不回填。人工價之後仍受自動學習修正，因此 YouTube 調價不會讓它永久錯下去。
- **`purchase_amount_total` 只採計文件首次進入統計水位時的 `amount`，之後不
  補算**。
  - 顧慮：`updateStats` 的增量模式以 `_id > lastId` 為界、用 `$inc` 累加，每份
    文件只會被計入一次；而 gift 的 `amount` 會在寫入後改變 —— 文件首次寫入時
    價格可能還查不到（`amount` 留空、貢獻 0），稍後才由價格表或後續投遞補上。
    那筆差額永遠不會被補算。
  - 決定：沿用既有增量框架，不改用全量重算。
  - 理由：jewel 合計本來就只能靠推導取得，不精確在可接受範圍內。改成全量重算
    要為 gift 在 `crons` 開一條有別於其他統計的專屬路徑，並每次掃過整個
    `gifts` collection，與這項統計的用途不相稱。
- **ticker-only 文件的補收是不均勻的**。item 始終沒到達時（該筆 chat item 已
  不在 masterchat 初始回應的範圍，而它的 ticker 仍掛在 ticker bar 上），該次
  送禮仍會靠 ticker 被記錄並計入統計，但這只可能發生在單價 ≥ 100 Jewels 的
  禮物上 —— 低單價禮物沒有 ticker，同樣情境下就整筆漏掉。
- **webhook 覆蓋率低**。track / DM 的 preset 都以 `authorChannelId` 過濾，而該
  欄位只有 ticker（單價 ≥ 100 Jewels）才有；加上 `followUpdate` 預設關閉、只有
  insert 事件會觸發，因此只有「ticker 與 item 落在同一批次而被合併」或「ticker
  先於 item 到達」的高單價禮物才會發出 webhook。
- **價格重建停機超過保留窗口時，該期間的觀測永久遺失**。
  - 顧慮：價格只從 `gifts` 的當前窗口學習，而 `cleanup` 在直播結束 2 小時後就
    刪除文件。若 manager 或該 Agenda job 停擺超過保留窗口，那段期間唯一能推導
    價格的 combo 觀測會連同文件一起消失，且既有的 `purchase_amount_total` 也
    不會回頭補算。
  - 決定：不做持久化觀測日誌、不讓 cleanup 等待重建、不延長保留期。
  - 理由：manager 停機超過 2 小時本來就是必須處理的運維事件，影響遠不只價格表
    （所有 Agenda 排程工作都停了）。同一個資產日後再被連擊就會學到價；真的長期
    學不到的，已有 `manual` 補價出口。為此新增一份持久化觀測日誌或讓 cleanup
    與重建產生耦合，與問題規模不相稱。
- **Gift 的 jewel 金額共用 `purchase_amount_total`，以 `currency="JEWEL"` 區分**。
  - 顧慮：該 metric 原本承載的是法幣金額。跨 currency 加總的儀表板或 API
    消費者，會把虛擬代幣數量混進金錢總額。
  - 決定：不另開 metric，沿用 `purchase_amount_total`。
  - 理由：這個 metric 本來就同時裝著多種法幣，跨幣別加總原本就沒有意義（專案
    另有 `purchase_amount_jpy_total` 供此用途），`JEWEL` 只是多一個標籤值。
    Prometheus 匯出時另帶 `type="gift"`，有做類型過濾的查詢完全不受影響，而
    `recalcVideoHbStats` 只彙總 SuperChat / SuperSticker 的 jpy 統計，也不會
    被波及。另開 `VideoStatsType` 要多一條專屬 cron 與一個新 gauge，收益不足。
- **並發首次 upsert 撞 `E11000` 時不重試，失敗方的互補欄位就此遺失**。
  - 顧慮：兩個 replica 若在同一 `id` 的首次 insert 上真正同時站，MongoDB 只讓
    一方建立文件、另一方拿到 `E11000`。既有的 catch 會把它當成一般撞重吞掉，
    失敗方手上的欄位就此遺失。多數情況遺失的是 ticker 專有的
    `authorChannelId`（只影響 webhook）；但**最壞情況會影響 `amount`** ——
    失敗方是 ticker、而勝方是那約 10% 不帶 `giftImageUrl` 的 item 時，
    `stickerUrl` 是該文件取得 `assetName` 的唯一來源，遺失即無從查價，該筆
    對 `purchase_amount_total` 貢獻 0。
  - 決定：不實作重試。
  - 理由：觸發需同時滿足「毫秒級同時的首次 insert」與「兩邊持有的欄位恰好
    不同」。YouTube 通常把 item 與 ticker 放在同一個 continuation response，
    因此各 replica 合併後多半產生完全相同的 payload，第二個條件很難成立；
    晚一步的寫入都會走正常 update 路徑、不會遺失。而上述影響 `amount` 的最壞
    情況還要再疊加「勝方恰好是無圖的那 10%」，機率更低，且其後果與本節其他
    已接受的低估來源同量級。為此在 worker 中新增一條有別於其他 20 個 case 的
    錯誤處理路徑，與問題規模不相稱。

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

### 連擊（combo）在資料裡的實際形狀

**最重要的一條：每送出一份禮物就產生一個獨立的 chat item，各自有唯一的 `id`。**
連擊不會把多份禮物摺成一則訊息 —— 跨多個 `id` 本身就已經表達了整波的份數。

YouTube 另外會**改寫該波其中一則（第一則）的內容**，把它變成
`comboed xN … for J Jewels` 這種整波摘要，用來在 UI 上呈現連擊狀態。所以
`comboCount` / `jewelCount` 是**該波的摘要資訊，不代表這一則文件本身的份數** ——
每一則文件恆為 1 份。

下面三段是實際觀測到的三種面貌，差別只在觀測時機與 `giftImageUrl` 的有無。

**（一）連擊進行中 —— 每一份都是獨立訊息、各自不同 `id`**

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

6 個完全不同的 `id`，每個 `id` 就是一份禮物。第一份寫 `sent`，沒有 `comboed x1`。
`for 10 Jewels` 從頭到尾都是 **10 —— 那是單價不是累計**。

**（二）連擊結束的摘要改寫 —— 第一則的 `id` 被重發，金額變成整波總額**

```text
id ChwKGkNNeThscC1yMXBFREZjRVlyUVlkQmYwWmlB

   13:33:23  收到   sent Heart for 10 Jewels        ← 單價
   14:46:07  收到   comboed x8 Heart for 80 Jewels  ← 8 × 10，同一個 id
```

這波送了 8 份、8 個 `id`；**只有第 1 份的 `id` 被改寫成 x8 摘要，其餘 7 份維持
各自的內容**。因此 `comboed x8 … for 80 Jewels` 這一則仍然只代表 1 份禮物 ——
把它按 80 計入就會重複計算（80 + 7×10 = 150，實際 80）。

**（三）不帶金額的 `sent` 與後續改寫**

`62hbNGH85Po` 的送禮者送 Star（單價 2）：

```text
id ChwKGkNPSFA5NFQtLXBJREZRNlZ3Z1FkM09RMTJ3

   15:47:52  收到   sent Star                      ← 沒有金額
   17:26:05  收到   sent Star                      ← 重送，仍無金額
   17:52:46  收到   comboed x4 Star for 8 Jewels   ← 4 × 2，同一個 id
```

同一個 `id` 被投遞三次，三次的訊息時間戳完全相同（都來自該 `id`），變的只有
內容 —— 這是同一份禮物先以 `sent` 出現、最後被改寫成整波摘要。該波的另外 3 份
各有自己的 `id`。

**`giftImageUrl` 的有無決定 `jewelCount` 該怎麼讀：**

|                             | 有 `giftImageUrl`（約 90%）      | 無 `giftImageUrl`（約 10%）                |
| --------------------------- | -------------------------------- | ------------------------------------------ |
| `sent X`                    | 不帶 `jewelCount`                | `for P Jewels`，**P = 單價**               |
| `comboed xN X for J Jewels` | **J = 整波總額**（單價 = J / N） | **J = 單價**（形態一）或整波總額（形態二） |
| 這一則代表的份數            | **恆為 1 份**                    | **恆為 1 份**                              |

這解釋了為何 `price = jewelCount / comboCount` 只在有 `giftImageUrl` 時安全：
有圖時 `sent` 不帶金額，帶金額的一定是整波摘要；無圖時 `J` 可能是單價，除不得。

### 其他實測規則

- ticker 全都帶 `stickerUrl`（即 `giftImageUrl` 的同源資產）；item 約 10% 缺
  `giftImageUrl`。
- `authorChannelId` **只出現在 ticker**。
- ticker **只出現在單價 ≥ 100 Jewels 的禮物上**。低單價禮物（如 Heart 10、
  Star 2）永遠不會有 ticker。
- 去重方式與其他 action 一致：以 `id` 為唯一鍵；item 與 ticker 共用同一個 `id`。
- masterchat 建立連線後的**第一份回應就包含聊天室上既有的項目**。因為重送的是
  同一批 `id`，以 `id` 去重即可，不會重複計數 —— worker 重啟、replica 上線、
  多 replica 併行都適用同一條保證。

### mongoose pipeline update + upsert 的實際行為（已驗證）

版本：mongoose `8.2.1`（`node_modules/mongoose/package.json`），其內嵌的
mongodb driver 為 `6.3.0`（`node_modules/mongoose/node_modules/mongodb/`；
專案根目錄另有一份 `7.1.1` 屬於其他相依，mongoose 不使用它）。MongoDB 伺服器
為 `mongo:5`（[docker-compose.yml](../../../docker-compose.yml)、
[k8s/base/db.yaml](../../../k8s/base/db.yaml)），aggregation pipeline update
自 4.2 起支援。

以下皆為實際讀取 `node_modules/mongoose/` 原始碼取得：

- **允許以陣列（pipeline）當 `bulkWrite` `updateOne` 的 `update`。**
  `lib/helpers/query/castUpdate.js` 對 `Array.isArray(obj)` 的分支只逐 stage
  呼叫 `castPipelineOperator`（僅認得 `$set` / `$unset` / `$project` /
  `$addFields` / `$replaceRoot` / `$replaceWith`）後**直接 return**，跳過其後
  所有的轉型與 strict 處理。
- **schema 預設值不會生效。** `lib/helpers/model/castBulkWrite.js` 會呼叫
  `setDefaultsOnInsert()`，但它是把結果寫成 `pipeline.$setOnInsert = {...}`
  ——**掛在陣列物件上的屬性**。BSON 只序列化陣列的元素、不序列化屬性，因此那些
  預設值在送達 MongoDB 前就被丟棄。版本鍵（`__v`）同理失效。
- **`updatedAt` 會被加上，`createdAt` 不會。**
  `lib/helpers/update/applyTimestampsToUpdate.js` 對陣列 update 的處理是
  `updates.push({ $set: { [updatedAt]: now } })`，只補 `updatedAt`。
- **不跑驗證器、不檢查 `required`。** `castBulkWrite.js` 的 `updateOne` 分支
  沒有 `$validate()` 呼叫（只有 `insertOne` 分支有）。
- **strict mode 不生效**，不在 schema 中的欄位不會被剝除（同第一點的 early
  return）。
- **filter 的等值條件會用來生成新文件**，這是 **MongoDB 伺服器**行為而非
  mongoose —— mongoose 只是把 filter 原樣放進 update statement 的 `q`。因此
  `{ id }` 這個 filter 會讓 upsert 建立的文件自帶 `id`。

**對本設計的結論**：worker 的 gift upsert 可以用 pipeline，但**必須把每一個
required 欄位都在 pipeline 裡明確寫出**，不得倚賴任何 schema `default` 或
`createdAt`。而價格重建**不使用 pipeline**（見該節），以保留 mongoose 的一般
語意。

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
manager ── "gift price rebuild" ──┴─▶ giftprices（只增不減，永不刪除）
```

## 資料模型

### `src/models/Gift.ts` → collection `gifts`

| 欄位              | 型別                | required    | 來源                                                         |
| ----------------- | ------------------- | ----------- | ------------------------------------------------------------ |
| `id`              | `string`            | ✓（unique） | item / ticker 共用                                           |
| `timestamp`       | `Date`              | ✓           | `item.timestamp` ?? `ticker.contents.timestamp` ?? 接收時間  |
| `authorName`      | `string`            |             | `item.authorName` / `ticker.contents.authorName`             |
| `authorPhoto`     | `string`            |             | `item.authorPhoto` / `ticker.contents.authorPhoto`           |
| `authorChannelId` | `string`            |             | **只有 ticker 有**                                           |
| `authorType`      | `MessageAuthorType` | ✓           | 固定 `MessageAuthorType.Other`                               |
| `message`         | `string`            |             | `item.message` 原始文字                                      |
| `giftName`        | `string`            |             | `item.giftName` / `ticker.contents.giftName`                 |
| `assetName`       | `string`            |             | 由 `image` 推導                                              |
| `image`           | `string`            |             | `item.giftImageUrl` ?? `ticker.contents.stickerUrl`          |
| `jewelCount`      | `number`            |             | action 原始值，**僅供價格推導**                              |
| `comboCount`      | `number`            |             | action 原始值，**僅供價格推導**                              |
| `hasGiftImageUrl` | `boolean`           |             | item 是否帶 `giftImageUrl`；**僅供價格推導**；ticker-only 無 |
| `amount`          | `number`            |             | 推導出的 jewel 金額，恆為**單價**                            |
| `currency`        | `string`            | ✓           | 固定 `"JEWEL"`                                               |
| `originVideoId`   | `string`            | ✓（index）  |                                                              |
| `originChannelId` | `string`            | ✓           |                                                              |
| `isReplay`        | `boolean`           |             |                                                              |

索引：

- `id` unique（比照其他訊息 model）
- `{ originVideoId: 1, timestamp: 1 }`（比照 `SuperSticker`）
- 支援價格重建掃描的 partial index：
  `{ assetName: 1 }`，`partialFilterExpression: { hasGiftImageUrl: true, assetName: { $exists: true }, jewelCount: { $exists: true }, comboCount: { $exists: true } }`

`jewelCount` / `comboCount` / `hasGiftImageUrl` **只是價格推導的原料**，不參與
`amount` 的計算。持久化它們是因為價格重建跑在 manager，讀不到 worker 當下手上
的 action。

`hasGiftImageUrl` 尤其是**價格推導的安全前提**。`assetName` 由 `image` 推導，
而 `image` 可能來自 ticker 的 `stickerUrl` —— 也就是說一筆 item 無
`giftImageUrl` 的文件，只要單價 ≥ 100 Jewels 而有 ticker 補圖，就會帶有
`assetName`。這類文件的 `jewelCount` 可能是單價而非整波總額（形態一），若被
價格重建採用，會算出 `單價 / comboCount` 這種偏低的錯價，並經由快取擴散到
後續所有文件的 `amount`。持久化這個旗標，才能讓重建只採信「有 `giftImageUrl`」
的觀測。

`authorType` 固定寫 `other` 的理由：Gift action 完全沒有 badge 欄位，無從判斷。
寫入常數值可讓 `video-stats` 的 label、`VideoStats` 的唯一索引、以及
`metrics.ts` 的 `authorType` 守衛全部沿用既有路徑，零框架改動。代價是會員 /
版主 / 台主送的禮物也被歸到 `other` —— 但那本來就無法得知。

`currency` 固定寫 `"JEWEL"` 的理由：`purchase_amount_total` 的 label 含
`currency`，寫入常數比留空更能表達「這筆金額的單位是 Jewels 而非法幣」，也讓
metrics 的 label 集合保持完整。Gift 不進任何 jpy 換算路徑，因此 `"JEWEL"` 不會
被送進 `currencyToJpyAmount` / `getCurrencymapItem`。

### `src/models/GiftPrice.ts` → collection `giftprices`

| 欄位          | 型別      | required         | 說明                                           |
| ------------- | --------- | ---------------- | ---------------------------------------------- |
| `assetName`   | `string`  | ✓（unique）      | 唯一鍵，例如 `finger_heart`                    |
| `price`       | `number`  | ✓                | 單價（Jewels）                                 |
| `giftName`    | `string`  |                  | 最後觀測到的顯示名稱，**僅供對照，不參與查價** |
| `manual`      | `boolean` |                  | 此價格由人工填入；**不阻擋自動學習**           |
| `sampleCount` | `number`  | ✓（default `0`） | 支持**目前這個** `price` 的單次最大觀測筆數    |

繼承 `TimeStamps`（`createdAt` / `updatedAt`）。

`giftprices` **不被 `cleanup` 清除** —— 它是跨直播累積的知識庫。

`sampleCount` 的語意是**歷來單次重建中，同時支持目前這個 `price` 的最大觀測
筆數**，以 `$max` 更新（價格被覆蓋時重設為當次筆數）。

用 `$max` 而非累加，是因為重建每次都重掃同一個窗口（見下），**同一筆 gift 文件
會在多次重建中被重複看到**。若採累加，`sampleCount` 會隨重跑次數自己膨脹，一筆
壞觀測或一筆人工種子只要在窗口裡待滿幾輪就會「升級」成高可信度，反而更難被
修正 —— 恰好與這個欄位的用途相反。`$max` 讓重建對未變動的資料完全冪等。

它同時也是這筆價格的可信度指標，覆蓋門檻直接依它分級（見下），因此不需要額外的
provisional 旗標。人工補價的預設值 `0` 讓它自然落在「未經觀測背書」那一級。

`manual` 是**營運用的補價出口**。價格只能從帶 `comboCount` 的訊息推導，因此
從未被連擊過的資產（高單價禮物尤其容易如此）可能長期學不到價。這種情況直接在
`giftprices` 手動插入一筆 `{ assetName, price, manual: true }` 即可立刻生效 ——
worker 的價格表快取一視同仁地讀取，最多 5 分鐘後套用。`sampleCount` 給預設值
`0`，讓手動插入只需要 `assetName` / `price` / `manual` 三個欄位。

`manual` **只是種子值，不是鎖**。重建 job 對它套用與自動學習值完全相同的覆蓋
規則（見下）；一旦累積到足夠的真實觀測，人工值就會被取代並清除旗標。若讓人工
值永久免疫覆寫，YouTube 調整貼圖價格後那筆補價會永遠是錯的，而且沒有任何自動
機制能發現 —— 補洞的價值不足以換取這個風險。旗標本身只用於稽核（看得出這個價
是人填的、還沒被觀測驗證過）。

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

`fields` 為合併後的 `{ assetName, jewelCount, comboCount }`。

因為**每一份文件恆代表 1 份禮物**，`amount` 永遠是單價。整波的金額由該波的多個
`id` 各自貢獻一份自然加總得出，不需要（也不可以）在任何一則上乘以 `comboCount`。

```text
comboCount == null && jewelCount != null  →  jewelCount            // 直接觀測到的單價
否則                                        →  priceTable[assetName] // 查表
```

第一條只在無 `giftImageUrl` 的 `sent X for P Jewels` 上成立，此時 `P` 就是單價，
是最可靠的來源，直接採用。

其餘一律查表。**帶 `comboCount` 的訊息絕對不能直接取 `jewelCount`** —— 那是該波
的摘要金額（有圖時是整波總額，無圖時可能是單價也可能是整波總額），拿來當這一則
的金額會重複計算整波。

ticker-only 文件同樣走查表：ticker 對應的也是一個 `id`、也就是一份禮物，而
ticker 一定帶 `stickerUrl`，所以 `assetName` 必定可得。

查表落空（價格未知）即 `amount` 留空，jewel 合計就此低估 —— 這是接受的取捨，
營運可用 `manual` 補價。

`hasGiftImageUrl` **不參與 `amount` 推導**，它只服務價格重建（見下）。

### `mergeGiftActions(items, tickers, ctx): GiftUpsert[]`

同批次內以 `id` 為鍵合併 item 與 ticker，輸出每個 `id` 一筆 upsert 描述。合併
必須在寫入前完成，理由有二：

1. ticker 帶的 `authorChannelId` 能出現在 change stream 的 **insert** 事件上。
   若分兩次寫，item 先到會產生一筆沒有 `authorChannelId` 的 insert，而後續
   ticker 的 update 事件會被 `followUpdate` 守衛擋掉 —— webhook 就永遠不會觸發。
2. 減少一半的 Mongo 往返。

同一批次內同一 `id` 出現多個 item（形態三的重送）時，取 combo 狀態較新者
（見下）。

**ticker-only 輸出是合法的。** 這批只有 ticker、沒有對應 item 時照樣輸出一筆
upsert，不等待 item。理由是 ticker 代表一次真實發生的送禮，丟掉它只會少收
資料；而共用 `id` 保證了它與日後到達的 item 收斂成同一份文件，不會重複計數。
這類文件缺 `message` / `jewelCount` / `comboCount` / `hasGiftImageUrl`（整個
combo 狀態群），但 `amount` 仍可由 `stickerUrl` 推出的 `assetName` 查表得到。

## 寫入：`GiftModel.bulkWrite(ops, { ordered: false })`

每筆 op 是 **aggregation pipeline update + `upsert: true`**。用 pipeline 而非
`$setOnInsert` + `$set`，是因為三種語意要在同一次原子更新裡表達：

**前提（已驗證，見「事實基準」）**：pipeline update 會繞過 mongoose 的 schema
預設值、`createdAt`、strict mode 與驗證器。因此這裡的 pipeline **必須把每一個
required 欄位都明確寫出** —— `timestamp`、`authorType`、`currency`、
`originVideoId`、`originChannelId` 都在下列互補欄位中，不倚賴任何 schema
`default`。`id` 由 filter `{ id }` 的等值條件在 upsert 時由 MongoDB 伺服器帶入
新文件。Gift model 不繼承 `TimeStamps`，因此不受 `createdAt` 不生效的影響。

**互補欄位（填缺不覆蓋，`$ifNull`）**

`timestamp`、`authorName`、`authorPhoto`、`authorChannelId`、`giftName`、
`image`、`assetName`、`authorType`、`currency`、`originVideoId`、
`originChannelId`、`isReplay`。

item 與 ticker 各持有對方沒有的欄位，先到者寫入、後到者補齊。已存在的值不覆蓋。

**`amount`（算得出來就覆蓋，算不出來就保留）**

`$ifNull: [<本次算出的 amount>, "$amount"]`。

每次寫入都以當下手上的欄位與價格表重算一次。算得出來就寫，算不出來（價格未知）
就保留既有值。這讓「先以 ticker-only 寫入、後來 item 才補上直接觀測到的單價」
與「先寫入時價格未知、稍後 item 帶來 `sent X for P Jewels`」兩種順序都能收斂到
比較好的值，而不會被後來一次算不出來的寫入抹掉。

**combo 狀態群（整組替換）**

`message`、`jewelCount`、`comboCount`、`hasGiftImageUrl`。

這四個欄位是**價格重建的輸入**，必須當作一個整體替換，不能各自填缺。形態二的
`id` 先收到 `sent Heart for 10 Jewels`（`jewelCount=10`，無 `comboCount`），後
收到 `comboed x8 Heart for 80 Jewels`（`jewelCount=80, comboCount=8`）；若逐欄
填缺，會留下 `jewelCount=10, comboCount=8` 這個從未存在過的組合，而價格重建會
據此算出 `1.25` 這個錯價並經快取擴散。

替換條件：以 `comboCount ?? 1` 較大者勝出；相等時，帶 `jewelCount` 的那版勝出。
ticker 不帶任何 combo 資訊，因此永遠不觸發這組替換 —— 這也是
`hasGiftImageUrl` 必須留在這一群的原因：它描述的是「該版 `jewelCount` 該怎麼
讀」，只能隨產生那些欄位的 item 一起變動，不能被 ticker 或另一版 item 拆開。

replica > 1 的並發 upsert 可能撞出 `code 11000`；`ordered: false` 加上 worker
既有的 `MongoBulkWriteError` catch 會吞掉。撞重的失敗方**不重試**，其手上的互補
欄位就此遺失 —— 這是明確接受的限制，理由見「Non-goals / Accepted
limitations」。

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

1. 對 `gifts` 聚合，`$match` 出 `hasGiftImageUrl: true` 且 `assetName` /
   `jewelCount` / `comboCount` 皆存在、`comboCount > 0` 的文件（走 partial
   index），算 `price = jewelCount / comboCount`。
   `hasGiftImageUrl: true` 這個條件不可省略：少了它，item 無 `giftImageUrl` 但
   有 ticker 補圖的高單價文件也會通過過濾，而它們的 `jewelCount` 可能是單價，會算出偏低
   的錯價。
2. 依 `assetName` 取本次窗口內**出現次數最多**的 price，並記下最後看到的
   `giftName`。
3. **讀出整張 `giftprices`**（數百列，就是 worker 快取的同一份資料），在應用層
   決定每個 `assetName` 的去向，再以**一般 update 運算子**（`$set` /
   `$setOnInsert` / `$unset`）`bulkWrite` 回去。

   這裡刻意**不使用 aggregation pipeline update** —— pipeline 會繞過 mongoose
   的 schema 預設值與 `createdAt`（見「事實基準」）。價格重建沒有併發對手
   （Agenda 的 `lockLifetime` 保證單一實例），讀後寫完全安全，用一般語意即可
   保留 mongoose 的正常行為。分級判斷也因此寫在 JS 裡，比塞進 `$cond` 好讀。

4. **只增不減**（永不 `deleteMany`）：
   - 該 `assetName` 尚無記錄 → 直接寫入，`sampleCount` = 本次觀測筆數。
   - 已有記錄且價格相同 → `sampleCount = max(既有, 本次觀測筆數)`，更新
     `giftName`，並清除 `manual` 旗標（這個價格已由真實觀測背書）。
   - 已有記錄但價格不同 → 依既有記錄的 `sampleCount` 分級決定：
     - 既有 `sampleCount >= 2`（已被多筆觀測背書）→ **本次觀測筆數 ≥ 2 才覆蓋**
     - 既有 `sampleCount < 2`（單筆種子或人工補價）→ **本次任一筆觀測即可覆蓋**

     覆蓋時 `sampleCount` 重設為本次觀測筆數、清除 `manual` 旗標，並輸出警告
     log。

   比較 `sampleCount` 時一律以 `existing.sampleCount ?? 0` 取值。手動補價可能
   是直接在 DB 插入的，不會經過 mongoose 的 `default`，該欄位有可能不存在。

   **整個步驟 4 對未變動的 `gifts` 是冪等的**：`sampleCount` 取 `max`、價格與
   旗標的判定都只依賴「既有狀態」與「本次窗口算出的值」，重跑同一個窗口不會
   改變任何欄位。這一點是必要的 —— 重建每 10 分鐘重掃同一批文件，若 `sampleCount`
   採累加，一筆觀測會隨重跑次數不斷放大，讓錯價或人工種子憑「待得夠久」就升級
   成高可信度，與這個欄位的用途完全相反。

   分級的用意是讓**新資產的第一筆觀測不會被永久釘死**。首筆觀測仍然立刻生效
   （有價可用勝過沒有），但它只是「未經背書的種子」，任何一筆不同的觀測就能
   推翻它；要等某一次重建同時看到 2 筆一致的觀測，才升級為需要同等證據才能
   推翻的可信價格。若首筆觀測就直接享有 ≥ 2 的保護，一次異常解析就會污染該
   資產之後的每一筆 `amount`，而且 `giftprices` 從不清除 —— 對很少被連擊的
   資產，那個錯價可能永遠等不到修正。

   `manual: true` 的記錄**走的是同一條規則，沒有任何豁免**（預設 `sampleCount`
   為 `0`，因此落在「單筆種子」那一級）。它在「還沒有任何觀測」時提供價格，
   一旦有真實觀測給出不同的價（例如 YouTube 調價），就會被自動修正。這是刻意
   的：永久免疫覆寫的人工值一旦過時，沒有任何機制能自動發現。

`readPreference: "secondaryPreferred"`，比照 `video-stats` 的既有做法。

**為何必須只增不減**：`MAX_HOURS_BEFORE_CLEANUP = 2`，`gifts` 只留最近兩小時內
有活動的影片資料。若採「全量重算後覆蓋」，任何最近兩小時沒被送出的禮物，其
價格會被整個抹掉。只增不減的 upsert 讓價格表不會遺忘。

因為每次都重掃當前窗口、且步驟 3 是冪等的，不需要 `_id` 水位或任何額外的狀態
文件。`_id` 水位在這裡反而會出錯：文件先以無 combo 的形式 insert、稍後才被改寫
成帶 `comboCount` 的摘要，水位早已越過它，那筆觀測就永遠學不到。單次窗口漏掉只
會延後學到價格，下次該禮物出現時自動補上。

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

### ticker-only 文件的計數契約

ticker-only 文件（缺整個 combo 狀態群）**照常計入兩項統計**。不額外加旗標、
不從統計中排除。它的 `amount` 由 `stickerUrl` 推出的 `assetName` 查表取得，
與其他文件並無二致。

它不會造成重複計數：item 與 ticker 共用同一個 `id`，upsert 後永遠是同一份
文件，`$sum: 1` 只會算到一次。無論兩者同批合併、分批先後到達、或 item 始終
沒到，該次送禮在 `message_total` 裡都恰好是 1。

而 item 始終沒到的那種文件，代表的仍是**一次真實發生的送禮**，只是我們沒收到
它的 chat item。中途啟動不太會造成這種情況 —— masterchat 的第一份回應本來就
包含聊天室既有的項目，item 與 ticker 通常會一起補齊；只有當該筆 chat item 已
不在初始回應的範圍、而它的 ticker 仍掛在 ticker bar 上時才會落單。把這種文件
排除掉是少收資料，不是修正誤差。已知的偏差是這種補收只會發生在單價
≥ 100 Jewels 的禮物上（低單價沒有 ticker），因此覆蓋是不均勻的 —— 記在
「Non-goals / Accepted limitations」。

### 增量模式的影響

兩項統計都沿用 `updateStats` 的增量模式（`_id > lastId` 水位 + `$inc`），因此
**只採計文件首次進入水位時的欄位值**。`message_total` 不受影響（文件只被
insert 一次）；`purchase_amount_total` 則會漏掉文件寫入後才發生的 `amount`
變化 —— 這是明確接受的限制，理由見「Non-goals / Accepted limitations」。

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

## 邊界與失敗情境

- **`GIFT_TEXT_RE` 未命中**（非英文 locale 或 YouTube 改文案）：`giftName` /
  `jewelCount` / `comboCount` 全為 undefined，`message` 仍保留原文。文件照常寫入
  並計入 `message_total`；`amount` 依規則留空。價格表不受污染。
- **`item.timestamp` 缺失**（`id` 不符 `timestampUsecFromChatItemId` 形狀）：
  依模型表的單一優先序 `item.timestamp` → `ticker.contents.timestamp` →
  該批次接收時間逐級退回。同批合併時 item 的值優先 —— 兩者本就源自同一個 `id`
  的 `timestampUsec`，而 ticker 只在單價 ≥ 100 Jewels 時存在，不能當成主要來源。
- **價格表為空**（首次部署）：所有需要查表的文件 `amount` 留空，直到第一次重建
  跑完。唯一不受影響的是 `sent X for P Jewels`（無 `comboCount`）—— 它直接觀測
  到單價，不查表。
- **同一 `assetName` 觀測到兩種價格**：可能是 YouTube 調價，也可能是解析雜訊。
  依既有記錄的 `sampleCount` 分級覆蓋並記 log —— 已被多筆背書的價格需要同等
  證據才推翻，只有單筆種子（含人工補價）的則從善如流。
- **replica > 1 並發 upsert**：`ordered: false` + 既有 11000 catch。pipeline
  update 本身是原子的，兩個 replica 送同樣內容不會互相破壞。首次 insert 撞重時
  失敗方不重試（見「Non-goals / Accepted limitations」）。
- **同批次同 `id` 多筆 item**（形態三重送）：`mergeGiftActions` 先在記憶體內以
  combo 狀態新舊收斂成一筆，再送出單一 upsert。

## 測試重點

- `parseGiftAssetName`：item 版（帶 `=w640-h640`）與 ticker 版（不帶）產生同一
  `assetName`；不同禮物產生不同 `assetName`；undefined / 空字串 / 無副檔名輸入。
- `deriveGiftAmount`：以生產資料的實際數值為測資，涵蓋
  `sent Heart for 10 Jewels`（無 combo → 直接取 10）、
  `comboed x8 Heart for 80 Jewels`（**必須是單價 10，不是 80**）、
  `comboed x4 Star for 8 Jewels`（**必須是單價 2，不是 8**）、
  `sent Star`（無金額 → 查表得 2）、ticker-only（查表得單價）、
  以及查表未命中一律 `undefined`。
- `mergeGiftActions`：item-only、ticker-only（斷言仍輸出一筆 upsert、combo
  狀態群缺席、但 `amount` 已由查表填入）、同批 item+ticker（驗證
  `authorChannelId` 與 `image` 都出現在同一筆輸出）、同批多筆同 `id`（驗證
  combo 狀態取新者）。
- ticker-only 後續補上 item：先以 ticker-only 寫入一筆，再送出帶 combo 狀態的
  item，斷言收斂成**同一份文件**（不是兩筆）、combo 狀態群被完整填入、且
  ticker 帶來的 `authorChannelId` 未被覆寫。
- combo 狀態群替換規則：以形態二（`sent … for 10` → `comboed x8 … for 80`）與
  形態三（`sent Star` → `comboed x4 Star for 8`）為測資，斷言四個欄位整組替換、
  不出現 `jewelCount=10, comboCount=8` 這類混合狀態。
- `amount` 的「算得出來就覆蓋」規則：先寫入一筆價格未知的文件（`amount` 缺），
  再以價格已知的寫入補上，斷言 `amount` 被填入；反向順序（先有值、後一次算
  不出來）則斷言既有值不被抹除。
- 價格表重建：新資產寫入（`sampleCount` 等於本次觀測筆數）、同價時
  `sampleCount` 取 `max`（既有 3、本次 1 → 仍是 3）、以及重建**不會刪除**窗口內
  未出現的既有資產。
- **重建冪等性**：對完全未變動的 `gifts` 連續跑兩次，斷言 `giftprices` 的
  `price` / `sampleCount` / `manual` 三個欄位皆與第一次後完全相同。
- 覆蓋門檻分級：既有 `sampleCount = 1` 時單筆異價即覆蓋；既有
  `sampleCount >= 2` 時單筆異價不覆蓋、雙筆才覆蓋。覆蓋後斷言 `sampleCount`
  被重設為本次觀測筆數。
- 人工價格的三種歸宿：`manual: true` 且本次窗口無任何觀測時，斷言 `price` 維持
  不變；`manual: true`（`sampleCount = 0`）遇到單筆異價觀測時，斷言 `price` 被
  覆蓋且 `manual` 旗標被清除；`manual: true` 遇到同價觀測時，斷言 `manual` 旗標
  同樣被清除、`sampleCount` 升為本次觀測筆數。
- 價格表重建的排除條件：造一筆 `hasGiftImageUrl: false` 但由 ticker 補上
  `assetName`、且帶 `jewelCount` / `comboCount` 的文件（例如
  `comboed x2 Heart for 10 Jewels`），斷言它**不會**被納入價格推導 —— 否則會
  寫入 `10 / 2 = 5` 這個錯價。
- gift upsert 的 pipeline **必須明確寫出每個 required 欄位**：斷言首次 upsert
  產生的文件同時具備 `timestamp` / `authorType` / `currency` / `originVideoId`
  / `originChannelId`，不倚賴 schema `default`（pipeline update 下不會生效）。
- 依專案慣例，Mongo / Redis 依賴以 `jest.unstable_mockModule` 搭配有狀態的
  fake（非裸 `jest.fn()`），確保 upsert 前後的可觀測狀態變化能被斷言。

## 計畫階段待確認（不臆測）

- `getCacheInstance` 的 `refreshThreshold` 在 cache-manager 目前版本的實際
  semantics（背景 refresh 是否會阻塞讀取），需在 plan 階段以 research subagent
  讀 `node_modules/cache-manager` 確認後再定 TTL 參數。
- `partialFilterExpression` 與既有 `attachIndexWarningListeners`
  （`src/modules/db.ts`）的互動：專案先前有過 partial index 相關設計
  （`2026-05-20-mongo-partial-index-fix-design.md`），需在 plan 階段對照其結論。
