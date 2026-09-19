# 原始碼佈局重整設計

## 1. 背景

`src/` 目前以 `commands/`、`components/`、`modules/`、`discord/`、`data/`
五個頂層目錄組織程式碼，但這些目錄的定位並未對應任何一致的規則。

以七個 entrypoint（`src/commands/*.ts`）對 368 條相對 import 邊做傳遞閉包，
實測結果如下：

| 只被單一服務可達 | 檔案數 | 實際散落位置                                                                                                                           |
| ---------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------- |
| `crawler`        |     10 | `components/youtube-discovery/`、`modules/youtube-pubsub/`、`modules/holodex.ts`                                                       |
| `discord-bot`    |     14 | `discord/commands/**`、`modules/oauth/`                                                                                                |
| `manager`        |     14 | `components/chats-archive*`、`components/{cleanup,gift-price,video-scaler,video-stats,webhook-prepare}.ts`、`models/VideoUserStats.ts` |
| `worker`         |      8 | `components/gift.ts`、`modules/currency-convert.ts`、`modules/youtube-watch-gate.ts`、`data/currency.ts`、4 個 model                   |
| `webhook`        |      6 | `modules/webhook/`、`modules/matching.ts`                                                                                              |
| `scheduler`      |      0 | 無專屬檔案                                                                                                                             |
| `metrics`        |      0 | 無專屬檔案                                                                                                                             |

被三個以上服務可達的檔案僅 14 個。換言之，`modules/` 底下 22 個檔案中有 15 個
是單一服務專屬的——目前的 `modules/` 並不表達「共用」。

### 1.1 已識別的具體問題

1. **`modules/` 與 `components/` 的界線與「共用／專屬」無關。**
   `modules/holodex.ts`（僅 crawler）、`modules/youtube-watch-gate.ts`（僅
   worker）、`modules/oauth/`（僅 discord-bot）都在 `modules/`；反之
   `components/track-operator.ts` 被 `models/` 直接 import。

2. **層級反轉：`models/` 依賴 `components/`。**
   `models/Track.ts` import `components/track-operator.ts` 的 `transformTrack`，
   `models/YoutubeDmBinding.ts` import `components/youtube-dm-operator.ts` 的
   `transformYoutubeDmBinding`。最底層依賴最上層。

3. **`data/` 名不副實。** 只有 `currency.ts`（1145 行）是靜態表；`track.ts`
   （381 行）與 `webhook.ts`（632 行）都 import model、內含 transform 函式與
   query builder，是 domain logic。

4. **`components/` 混了兩種抽象層級。** 一種是 Agenda job 註冊殼（import
   `modules/schedule` + `modules/application`），一種是純邏輯（`gift.ts`、
   `youtube-discovery/*`、`chats-archive/*` 的 helper）。

5. **目錄與檔案同名並存。** `components/chats-archive.ts` 與
   `components/chats-archive/` 並存，entry 檔在資料夾外。

6. **`modules/action-counter.ts` 是 dead code。** 全專案零引用（含字串與動態
   import），功能已由 `components/video-scaler.ts` 取代。

## 2. 目標與非目標

### 目標

- 讓目錄結構直接表達「這段程式碼屬於哪個服務」或「這是跨服務共用的」
- 修正 `models/` → `components/` 的層級反轉
- 解散定位模糊的 `data/` 與 `components/`
- 以 path alias 表達「跨越服務邊界」的 import，並以 lint 規則阻擋跨服務依賴
- 刪除 dead code

### 非目標／已接受的限制（Non-goals / Accepted limitations）

- **不改變任何執行期行為。** 本次重整是純粹的檔案搬移、模組切分與 import
  路徑改寫；不調整演算法、不改 API、不動資料結構。
- **不拆分過大的檔案。** `commands/worker.ts`（1166 行）、`data/webhook.ts`
  （632 行）等只搬移不拆分，後續另案處理。
- **不引入 barrel file（`index.ts` re-export）。** 只會增加一層無邏輯的間接。
- **不補測試覆蓋率。** 既有測試隨被測檔案一起搬移，不新增也不刪除。

**已接受的限制：跨服務 import 的檢查不涵蓋動態 `import()`**

- **疑慮**：§7.6 的 ESLint 規則只訪問 `ImportDeclaration` /
  `ExportNamedDeclaration` / `ExportAllDeclaration` /
  `TSImportEqualsDeclaration`，因此 `await import("../webhook/x.js")` 這種
  跨服務動態 import 不會被擋下。
- **決定**：不實作額外防護。
- **理由**：補這個洞需引入 `dependency-cruiser` 一個新 devDependency 與一個
  獨立於 `npm run lint` 的 CI 步驟（因此進不了編輯器即時提示）。本專案全部
  的動態 import 只有兩處——`src/index.ts` 的 yargs 分派（位於 `src/` 根層，
  本來就不在規則的 `files:` 涵蓋範圍內）與 `db.ts` 的 model 掃描——兩者都不是
  跨服務存取。為一個目前不存在、且需要開發者刻意繞路才會出現的情境增加建置
  機制，與其成本不成比例。

## 3. 三層定位規則

### 3.0 定位維度採部署單元（服務），而非領域

找程式碼的直覺起點是「哪個 process 出問題」或「哪個介面」，因此頂層以服務
（k8s deployment）切分。

**已評估並否決的替代方案：`src/domains/` 領域根。** 實測顯示變更模式有兩種
形狀：`youtube-discovery`、`youtube-pubsub`、`chats-archive`、webhook 分區等
功能只動單一服務；而 `track` 與 `youtube-dm` 兩個功能各自橫跨 discord-bot、
webhook、manager 三個服務。後者一度支持改用領域軸。

否決理由是可發現性：領域軸會把 `/youtube-dm` 這個 Discord 斜線指令從
discord-bot 底下搬到 `domains/youtube-dm/`，但該指令的契約面是 discord.js 的
slash command 註冊、且只有 discord-bot 可達——要找它的人必然先開 discord-bot
資料夾。領域資料夾的凝聚度不值得犧牲這個直覺。跨服務垂直功能的可發現性改以
§3.4 的分佈表解決，不靠目錄結構。

取代目前 `modules/` 與 `components/` 的二分：

| 層                 | 目錄                                                                 | 判定準則                               |
| ------------------ | -------------------------------------------------------------------- | -------------------------------------- |
| 服務私有           | `src/services/<service>/`                                            | 只有一個 entrypoint 可達               |
| 跨服務共用功能     | `src/modules/`                                                       | 兩個以上 entrypoint 可達，且含實際邏輯 |
| 資料契約／基礎型別 | `src/models/`、`src/constants.ts`、`src/interfaces.ts`、`src/utils/` | 不分服務，永遠共用                     |

### 3.1 提升規則

單一消費者的檔案一律放在該服務資料夾內。**當出現第二個服務消費者時，才把它
提升到 `src/modules/`**；不預先猜測未來可能的共用。這條規則寫入 `AGENTS.md`。

### 3.2 `models/` 是明確例外

`models/` 底下有數個檔案目前只有單一服務讀寫（`BannerAction`、`ModeChange`、
`VideoUserStats`、`ErrorLog`、`CurrencyExchange`），但**不依判定準則下放**。
除了「資料庫有哪些 collection」需要單一查詢點之外，更硬的理由見 §6.1。

### 3.3 `modules/` 底下的領域名子資料夾是分組，不是第二條軸

`modules/track/`、`modules/youtube-dm/` 這類以領域命名的子資料夾，其內容仍然
完全由 §3 的 entrypoint 計數決定——它們裝的是某個垂直功能中「兩個以上服務
需要」的那一片，子資料夾只是讓這一片有個名字，避免 `modules/` 變成平坦的
雜物抽屜。

判定順序不因此改變：先數 entrypoint 決定檔案屬於哪一層，再決定要不要在
`modules/` 底下給它一個領域名子資料夾。**不存在「因為屬於某領域所以放進
`modules/`」這種規則**；同一個垂直中只有單一服務可達的部分，照樣留在該服務
資料夾內。

### 3.4 跨服務垂直功能的分佈

`track` 與 `youtube-dm` 兩個垂直功能各自橫跨三個服務。依 §3.0 的決定，它們
不會被收進單一資料夾，因此改以本表作為可發現性的入口：

| 垂直         | 共用片（≥2 服務）                       | Discord 介面                                | 派送側                                         | manager 對帳殼                            | 資料模型                     |
| ------------ | --------------------------------------- | ------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ---------------------------- |
| `track`      | `modules/track/{features,transform}.ts` | `services/discord-bot/commands/track/`      | —                                              | `services/manager/track-operator.ts`      | `models/Track.ts`            |
| `youtube-dm` | `modules/youtube-dm/transform.ts`       | `services/discord-bot/commands/youtube-dm/` | `services/webhook/index.ts` 的 `sendDiscordDm` | `services/manager/youtube-dm-operator.ts` | `models/YoutubeDmBinding.ts` |

兩者共用的下游是 `models/Webhook.ts`：使用者在 Discord 設定 → 投影成 Webhook
文件 → webhook 服務派送 → manager 定期對帳並清理孤兒列。

新增跨服務垂直功能時，必須同步在本表加一列。

## 4. 目標佈局

```
src/
├── index.ts                          # yargs dispatcher
├── constants.ts
├── interfaces.ts
├── utils/
│   ├── common.ts                     # ← src/util.ts
│   └── esm.ts
├── models/                           # 位置與扁平結構不變
│
├── modules/                          # 跨服務共用
│   ├── application.ts  module.ts  http-server.ts
│   ├── db.ts  redis.ts  queue.ts  schedule.ts
│   ├── cache.ts                      # webhook + worker
│   ├── collection-watcher.ts         # scheduler + webhook
│   ├── youtube.ts                    # crawler + worker + discord-bot
│   ├── track/
│   │   ├── features.ts               # ← data/track.ts
│   │   └── transform.ts              # ← components/track-operator.ts 的 transform 部分
│   ├── youtube-dm/
│   │   └── transform.ts              # ← components/youtube-dm-operator.ts 的 transform 部分
│   └── webhook-template.ts           # ← data/webhook.ts（webhook 服務 + manager 共用）
│
├── services/
│   ├── scheduler/index.ts            # ← commands/scheduler.ts
│   ├── metrics/index.ts              # ← commands/metrics.ts
│   │
│   ├── worker/
│   │   ├── index.ts                  # ← commands/worker.ts
│   │   ├── gift.ts                   # ← components/gift.ts
│   │   ├── youtube-watch-gate.ts     # ← modules/youtube-watch-gate.ts
│   │   └── currency/
│   │       ├── convert.ts            # ← modules/currency-convert.ts
│   │       └── currency-map.ts       # ← data/currency.ts
│   │
│   ├── crawler/
│   │   ├── index.ts                  # ← commands/crawler.ts
│   │   ├── holodex.ts                # ← modules/holodex.ts
│   │   ├── atom.ts                   # ← modules/youtube-pubsub/atom.ts
│   │   ├── discovery/                # ← components/youtube-discovery/
│   │   │   ├── feed-poll.ts  members-poll.ts  existence-probe.ts  oembed.ts
│   │   └── pubsub/                   # ← modules/youtube-pubsub/
│   │       ├── youtube-pubsub.ts  routes.ts  renewal.ts  hub-client.ts
│   │
│   ├── webhook/
│   │   ├── index.ts                  # ← commands/webhook.ts
│   │   ├── changestream.ts  claim.ts  partition.ts  queue.ts
│   │   ├── simplify-match.ts         # ← modules/webhook/simplifyMatch.ts
│   │   └── matching.ts               # ← modules/matching.ts
│   │
│   ├── discord-bot/
│   │   ├── index.ts                  # ← commands/discord-bot.ts
│   │   ├── commands/                 # ← discord/commands/**
│   │   └── oauth/                    # ← modules/oauth/
│   │
│   └── manager/
│       ├── index.ts                  # ← commands/manager.ts
│       ├── cleanup.ts  gift-price.ts  video-scaler.ts  video-stats.ts
│       ├── webhook-prepare.ts
│       ├── track-operator.ts         # 只剩 Agenda 註冊殼
│       ├── youtube-dm-operator.ts    # 只剩 Agenda 註冊殼
│       └── chats-archive/
│           ├── index.ts              # ← components/chats-archive.ts
│           └── archive-video.ts  build-video-summary.ts  gen-*.ts  write-data-file.ts
│
└── scripts/
    └── inspect-simplified-match.ts
```

`src/commands/`、`src/components/`、`src/data/`、`src/discord/` 四個目錄消失。
`src/util.ts` 併入 `src/utils/common.ts`——刻意不叫 `index.ts`，因為
`"#utils/*"` alias 會讓它寫成 `#utils/index.js`，既冗贅又會誘使後人把它當成
barrel file 使用（見 §2 非目標）。同理，`modules/webhook-template` 是單一檔案
而非「單檔案資料夾 + `index.ts`」。

`.spec.ts` 檔案一律隨被測檔案移動，維持同目錄相鄰。

### 4.1 邊界案例的處置

以下三個檔案依實測消費者下放到服務資料夾，日後出現第二個消費者再依 §3.1 提升：

| 檔案                                               | 現況消費者 | 去處                                    |
| -------------------------------------------------- | ---------- | --------------------------------------- |
| `modules/youtube-watch-gate.ts`                    | 僅 worker  | `services/worker/youtube-watch-gate.ts` |
| `modules/currency-convert.ts` + `data/currency.ts` | 僅 worker  | `services/worker/currency/`             |
| `modules/matching.ts`                              | 僅 webhook | `services/webhook/matching.ts`          |

## 5. transform 邏輯切分

`components/track-operator.ts` 與 `components/youtube-dm-operator.ts` 各自混了
兩種生命週期：被 model static mutator 呼叫的 transform 邏輯（共用），以及
Agenda 定期對帳工作的註冊（manager 專屬）。兩者切開，且兩邊切法對稱。

### 5.1 切分後的歸屬

| 原始位置                            | 符號                                                            | 去處                                      |
| ----------------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| `components/track-operator.ts`      | `transformTrack`、`transformTrackToWebhooks`、`transformTracks` | `modules/track/transform.ts`              |
| `components/track-operator.ts`      | `export default trackOperator(app)`                             | `services/manager/track-operator.ts`      |
| `components/youtube-dm-operator.ts` | `transformYoutubeDmBinding`、`transformYoutubeDmBindings`       | `modules/youtube-dm/transform.ts`         |
| `components/youtube-dm-operator.ts` | `export default youtubeDmOperator(app)`                         | `services/manager/youtube-dm-operator.ts` |

批次版（`transformTracks` / `transformYoutubeDmBindings`，含 orphan cleanup）
與單筆版一同放進 `modules/*/transform.ts`；`services/manager/` 底下只留排程
配線，每個檔案約 8 行：

```ts
import assert from "node:assert";
import { transformTracks } from "#modules/track/transform.js";
import type { Application } from "#modules/application.js";
import type { AgendaModule } from "#modules/schedule.js";

export default function trackOperator(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  agenda.define("transform tracks", transformTracks);
  void agenda.every("1 hour", "transform tracks");
}
```

### 5.2 殘留的循環依賴（已知且不處理）

切分把「`models/` 依賴最上層 `components/`」降級為「`models/` 與 `modules/`
互相依賴」，但並未消除循環：`models/Track.ts` 需要 `transformTrack`，而
`modules/track/transform.ts` 需要 `TrackModel` 與 `WebhookModel`。

**只要 model 的 static mutator 仍然呼叫 transform，任何擺放位置都會產生
循環**，因為 transform 必須寫入 `WebhookModel`，而 `models/Webhook.ts` 已經
import `./Track.js`：

- transform 放在 `modules/track/` → `models/Track.ts ↔ modules/track/transform.ts`
- transform 改放進 `models/Track.ts` → 新增 `Track.ts → Webhook.ts`，與既有的
  `Webhook.ts → Track.ts` 形成 `models/Track ↔ models/Webhook`

唯一能消除的做法是讓 model 不再呼叫 transform、改由每個呼叫端自行負責，那會
失去「改了 Track 就一定會重算對應 Webhook 列」這個由 model 層保證的不變量，
屬於會改變行為的重新設計，不在本次範圍。循環今天就存在，ESM 的 live binding
能正常處理，本次重整不改變它的存在與否，只改變它跨越的目錄。

附帶澄清一條容易誤判為循環的邊：`modules/track/features.ts` 從
`models/Video.ts` 匯入的 `IsShortQuery` / `IsNotShortQuery` 是 value（凍結的
query 物件）而非 type，但 `models/Video.ts` 不 import `models/Track.ts`，因此
`models/Track → modules/track/transform → modules/track/features → models/Video`
這條路徑無環。

## 6. 硬約束

### 6.1 `importAllModels()` 是檔案系統耦合

`src/modules/db.ts` 的 `importAllModels()` 以 `fsp.readdir` 掃描
`path.join(__dirname(import.meta), "../models")` 並逐一動態 import。呼叫者是
webhook 服務與 `scripts/inspect-simplified-match.ts`——webhook 需依執行期字串
`job.coll` 透過 `getModelByCollectionName()` 取得 model，因此必須先註冊全部
model。

這條路徑不經過任何 module resolver，對本次重整構成三個硬約束：

1. **`src/models/` 必須維持單層扁平目錄。** `readdir` 不遞迴且有
   `file.isFile()` 過濾，任何放進子目錄的 model 會被靜默跳過，直到 webhook
   實際派送該 collection 時才失敗。這是 §3.2 不下放 model 的機械理由。
2. **`db.ts` 必須留在 `src/modules/db.ts`**，以維持相對 `../models` 成立。
3. **path alias 對這段無效。** 這是 `fsp.readdir` + `pathToFileURL` 的執行期
   檔案系統操作。`dist/` 的實體佈局必須維持 `modules/` 與 `models/` 同層。

### 6.2 測試環境下 `importAllModels()` 為 no-op

該函式只收 `.js` 檔，而 Jest 跑的是 `src/**/*.ts`，因此測試環境下掃不到任何
檔案。webhook 的 model 註冊路徑目前無測試覆蓋。此為既有狀況，本次不處理，
僅記錄以免誤判重整造成迴歸。

## 7. Path alias 方案

### 7.1 機制選擇

採用 **Node.js subpath imports**（`package.json` 的 `"imports"` 欄位），不採用
`tsconfig.json` 的 `paths`。

兩者在本專案工具鏈（typescript 6.0.2、jest 29.7.0、ts-jest 29.4.9、ESM +
NodeNext、無 bundler）上的實測差異：

| 項目         | subpath imports                                                                                                                                                                    | tsconfig `paths`                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| tsc 型別檢查 | 成立。`--traceResolution` 顯示 `Using 'imports' subpath ... with target './dist/...'` 後接 `File '.../src/....ts' exists`，走的是 rootDir/outDir 的 dist→src、`.js`→`.ts` fallback | 成立                                                                        |
| tsc emit     | 不改寫 `#` specifier；Node 執行期自行解析，本來就不需改寫                                                                                                                          | **不改寫 bare specifier**，`node dist/index.js` 直接 `ERR_MODULE_NOT_FOUND` |
| 執行期       | Node 原生支援                                                                                                                                                                      | 需額外引入 `tsc-alias` 之類的改寫工具並改 `build` script                    |
| Jest         | `jest-resolve` 原生處理 `#` 開頭 specifier，但缺 dist→src fallback，需補 `moduleNameMapper`                                                                                        | 需 `moduleNameMapper`                                                       |
| 新依賴       | 無                                                                                                                                                                                 | 需新增 devDependency                                                        |

`paths` 唯一的額外注意事項是 `baseUrl` 在 6.0.2 已 deprecated（TS5101，7.0
移除），但只要 `paths` 的值以 `./` 開頭就不需要 `baseUrl`。這不影響結論。

### 7.2 alias 命名空間

只為「服務以外」的東西開 alias。`src/services/` **刻意不給 alias**，使跨服務
import 無法用 alias 表達，必須寫成 `../<other-service>/...`，成為肉眼與 grep
都能發現的訊號。

`package.json`：

```json
{
  "imports": {
    "#constants.js": "./dist/constants.js",
    "#interfaces.js": "./dist/interfaces.js",
    "#models/*": "./dist/models/*",
    "#modules/*": "./dist/modules/*",
    "#utils/*": "./dist/utils/*"
  }
}
```

`jest.config.mjs` 的 `moduleNameMapper` 增加兩條，刻意逐一列出鍵名而非用單一
萬用規則，讓 Jest 與 Node 對「哪些 alias 合法」的認定一致——否則測試會放行一個
在執行期必然失敗的 import：

```js
moduleNameMapper: {
  "^(\\.{1,2}/.*)\\.js$": "$1",
  "^#(models|modules|utils)/(.*)\\.js$": "<rootDir>/src/$1/$2",
  "^#(constants|interfaces)\\.js$": "<rootDir>/src/$1",
},
```

### 7.3 import 撰寫規則

| 來源 → 目標                                                        | 寫法                  |
| ------------------------------------------------------------------ | --------------------- |
| 服務內部 → 同服務其他檔案                                          | 相對路徑 `./` `../`   |
| 服務 → `models` / `modules` / `utils` / `constants` / `interfaces` | alias `#...`          |
| `modules/` → `models` / `utils` / `constants` / `interfaces`       | alias `#...`          |
| `modules/` → 同目錄或子目錄                                        | 相對路徑              |
| `models/` → `modules` / `utils` / `constants` / `interfaces`       | alias `#...`          |
| `models/` → 其他 model                                             | 相對路徑              |
| 任何服務 → 另一個服務                                              | **禁止**（§7.6 強制） |

`.js` 副檔名在 alias 形式下仍然保留（`#models/Video.js`），與 NodeNext 的既有
慣例一致。

### 7.4 唯一的例外

`src/scripts/inspect-simplified-match.ts` 是開發用工具，需要 import
`services/webhook/simplify-match.ts`。由於 `services/` 無 alias，此處使用相對
路徑 `../services/webhook/simplify-match.js`。這是唯一被允許跨進服務內部的
import，因為 `scripts/` 本身不是服務。

### 7.5 `jest.unstable_mockModule` 的遷移成本

mock key 是原始碼中的字面 specifier 字串，不是解析後的檔案路徑。因此每個
mock 呼叫的遷移就是把字串換掉，與改 import 敘述同一個機械動作，不需要重構
mock 的結構。

### 7.6 跨服務 import 的強制檢查

alias 命名空間讓跨服務 import **可見**（只能寫成相對路徑），但不會**阻擋**。
這對 §3.1 的提升規則是致命的：當第二個服務需要某個服務私有檔案時，正確做法
是把它提升到 `modules/`，偷懶做法是直接相對 import 過去。沒有檢查，提升規則
必然在有壓力時失效。

採用核心 ESLint 的 `no-restricted-imports`，不引入新依賴。該規則比對的是
**原始 specifier 字串**，不呼叫 resolver，因此模式必須自行涵蓋同一個目標的
所有寫法。需要封住的有兩個方向：

1. 服務 → 另一個服務。除了 `../webhook/x.js` 這種直接寫法，還有先爬到
   `src/` 再走回來的 `../../services/webhook/x.js`、`../../../src/services/webhook/x.js`。
2. 共用層（`modules/`、`models/`、`utils/`）→ 任何服務。這個方向若不封，
   共用層可以 import 服務私有程式碼並把它傳遞暴露給所有其他服務，重整想
   防止的依賴倒置會從這裡回來。

```js
const SERVICES = [
  "scheduler",
  "worker",
  "crawler",
  "manager",
  "webhook",
  "discord-bot",
  "metrics",
];

const SHARED_MESSAGE =
  "Use a #models / #modules / #utils alias, or promote the shared code out of src/services/.";

const crossServiceOverrides = SERVICES.map((service) => ({
  files: [`src/services/${service}/**/*.ts`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: SERVICES.filter((sibling) => sibling !== service).flatMap(
          (sibling) => [
            {
              // Direct sibling reference at any ascent depth:
              // "./webhook/x.js", "../webhook/x.js", "../../webhook/x.js".
              regex: `^\\.\\.?(\\/\\.\\.)*\\/${sibling}(\\/|$)`,
              message: `Cross-service import into "${sibling}" is forbidden. ${SHARED_MESSAGE}`,
            },
            {
              // Any relative spelling that climbs out and names the segment
              // again: "../../services/webhook/x.js",
              // "../../../src/services/webhook/x.js".
              regex: `^\\.\\.?\\/(.*\\/)?services\\/${sibling}(\\/|$)`,
              message: `Cross-service import into "${sibling}" is forbidden. ${SHARED_MESSAGE}`,
            },
          ]
        ),
      },
    ],
  },
}));

const sharedLayerOverride = {
  files: ["src/models/**/*.ts", "src/modules/**/*.ts", "src/utils/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            // Shared code must never reach into a service. Relative-anchored so
            // an unrelated package path such as "some-pkg/services/x" is not hit.
            regex: `^\\.\\.?\\/(.*\\/)?services\\/`,
            message:
              "Shared code must not import service-private modules; that would re-expose one service's internals to every other service.",
          },
        ],
      },
    ],
  },
};
```

**必須用 `regex` 而非 gitignore-style 的 `group` glob。** 實測確認
`group: ["**/webhook/**"]` 會把 alias 形式的 `#modules/webhook/foo.js` 一併
判成違規；錨定在開頭那個點的 `regex` 才能區分「相對路徑跨服務」與「alias
進入同名子目錄」。

實測驗證過的比對結果（規則內部以 `regexMatcher.test(importSource)` 求值）：

| 來源                  | specifier                                                                                      | 結果 |
| --------------------- | ---------------------------------------------------------------------------------------------- | ---- |
| `services/worker/**`  | `./webhook/x.js`、`../webhook/x.js`、`../../../webhook/deep/x.js`                              | 擋下 |
| `services/worker/**`  | `../../services/webhook/x.js`、`../../../src/services/webhook/x.js`、`./services/webhook/x.js` | 擋下 |
| `services/worker/**`  | `../worker/foo.js`、`../webhookish/index.js`、`../../services/webhookish/x.js`                 | 放行 |
| `services/worker/**`  | `#modules/webhook-template.js`、`#models/Webhook.js`、`some-pkg/services/webhook/x.js`         | 放行 |
| `modules/**` 等共用層 | `../services/worker/gift.js`、`../../src/services/worker/gift.js`、`./services/worker/gift.js` | 擋下 |
| `modules/**` 等共用層 | `./cache.js`、`../models/Video.js`、`#models/Video.js`、`mongoose`                             | 放行 |

`src/scripts/**` 不需要例外條款：兩組 override 的 `files:` 都不涵蓋
`scripts/`，§7.4 的例外自動成立。

**這套模式封住的是「順手寫出來」的跨界寫法，不是刻意規避。** 由於規則比對
字串而非解析後路徑，`../worker/../webhook/x.js` 這類繞路寫法仍會通過。要真正
以正規化路徑判定必須改用 resolver 型工具（`dependency-cruiser` 比對解析後
路徑、且涵蓋動態 `import()`），代價是一個新 devDependency 與一個獨立於
`npm run lint` 的 CI 步驟。威脅模型是「開發者走捷徑」而非「開發者刻意繞過
檢查」，因此先採字串規則；若日後實際出現繞路案例，再評估升級。

此規則的另一個盲點（動態 `import()` 不被訪問）已列入 §2 的已接受限制。

## 8. 遷移順序

每一步都是獨立 commit。`npm run build`（tsc）會抓出所有斷掉的 import，
`npm test` 驗證行為未變。

| #   | 內容                                                               | 風險                     |
| --- | ------------------------------------------------------------------ | ------------------------ |
| 1   | 刪除 `modules/action-counter.ts`                                   | 無（零引用已驗證）       |
| 2   | 建立 `modules/track/`、`modules/youtube-dm/`，切分兩個 operator    | 中：唯一有邏輯搬動的一步 |
| 3   | `src/util.ts` 併入 `src/utils/common.ts`                           | 低（11 個 importer）     |
| 4   | 導入 `"imports"` 欄位與 `moduleNameMapper`，現有 import 改為 alias | 中：牽動範圍最廣         |
| 5   | 建立 `services/`，逐服務搬移                                       | 低，但 diff 大           |
| 6   | 解散 `data/`                                                       | 低                       |
| 7   | 加入 §7.6 的 `no-restricted-imports` override                      | 低                       |
| 8   | 對齊 spec 檔名                                                     | 無                       |
| 9   | 更新 `AGENTS.md`、`docs/data-contract/` 的路徑引用                 | 無                       |

第 5 步的服務順序由小到大：`metrics` → `scheduler` → `crawler` →
`discord-bot` → `webhook` → `worker` → `manager`。前兩者無私有檔案，只是搬
entrypoint，可作為 alias 方案的實地驗證。

第 7 步必須排在第 5、6 步之後——規則的 `files:` glob 指向
`src/services/<X>/**`，在 `services/` 建立且所有檔案就位前，該規則涵蓋不到
任何檔案，通過 lint 不代表規則有效。加入後應以一個刻意寫錯的跨服務 import
確認規則真的會報錯，再把該行還原。

第 9 步的 `AGENTS.md` 更新必須包含 §3.1 的提升規則與 §3.4 的分佈表維護義務，
否則規則只存在於本文件，不會進入日常開發的視野。

### 8.1 第 8 步的檔名對齊

| 現況                                         | 改為                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| `modules/youtube-playlist-transport.spec.ts` | `modules/youtube.transport.spec.ts`                     |
| `commands/crawler-candidates.spec.ts`        | `services/crawler/index.candidates.spec.ts`             |
| `commands/webhook-dm.spec.ts`                | `services/webhook/index.dm.spec.ts`                     |
| `modules/webhook/simplifyMatch.ts`           | `services/webhook/simplify-match.ts`（統一 kebab-case） |

這三個 spec 檔都是**同一個被測檔的第二套測試**，不能直接改成
`<被測檔>.spec.ts`——`modules/youtube.spec.ts`、`services/crawler/index.spec.ts`
之類的名稱已經（或將會）被主測試檔佔用。因此採 `<被測檔>.<主題>.spec.ts` 形式：
前綴標明被測對象，中綴保留原本的主題區分，兩套測試並存且都仍被
`jest.config.mjs` 的 `**/?(*.)+(spec|test).ts?(x)` 樣式收錄。

## 9. 驗證

每一步 commit 前必須全部通過：

1. `npm run build` — tsc 型別檢查，會抓出所有未更新的 import 路徑
2. `npm run lint` — ESLint 走 `tsconfig.eslint.json`（extends 主 tsconfig，
   繼承 `rootDir`/`outDir`），需確認 `#` specifier 在 lint 階段也能解析
3. `npm test` — Jest

### 9.1 執行期冒煙檢查（第 4 步起每一步都要跑）

tsc 與 Jest 都證明不了 `"imports"` 在實際執行期成立：tsc 走的是
dist→src fallback，Jest 走的是自己的 `moduleNameMapper`，**兩者都不經過 Node
的 imports map**。必須在編譯產物上另外驗。

`node dist/index.js --help` **不足以當這個驗證**：`src/index.ts` 只在各個
yargs command handler 內部才 lazy-import 服務模組，`--help` 印完用法就結束，
一個服務模組都不會被載入（Docker 映像檔的預設 `CMD` 正是 `--help`，同樣證明
不了任何事）。

改為在乾淨 build 後，逐一於獨立行程載入每個編譯後的服務入口，但不呼叫其
runner：

```bash
for s in scheduler worker crawler manager webhook discord-bot metrics; do
  node --input-type=module -e "
    const t = setTimeout(() => {
      console.error('TIMEOUT: module did not finish loading');
      process.exit(2);
    }, 20000);
    await import('./dist/services/$s/index.js');
    clearTimeout(t);
    process.exit(0);
  " || exit 1
done
```

入口路徑依步驟而異：第 4 步時 `services/` 尚未建立，路徑是
`./dist/commands/$s.js`；第 5 步逐服務搬移完成後才變成
`./dist/services/$s/index.js`。搬移進行中的那幾個 commit，兩種路徑並存，
檢查腳本需按當時實際位置取用。

**`process.exit(0)` 不可省略。** 部分服務入口有 module-level 副作用會讓
event loop 不退出——`webhook` 的入口在 module 層呼叫 `getCacheInstance()`，
在 `REDIS_URI` 有值時會建立 Redis 連線與 `CacheableMemory` 的 `checkInterval`
計時器。若以「行程是否自然結束」當成功判準，`webhook` 會永遠掛住而被誤判成
失敗。判準是「`import()` 有沒有 resolve」，不是行程有沒有自己退出。

同理，`setTimeout` 的自我設限不可省略：沒有它，一個真的卡在 module 層的入口
會讓檢查無限等待而不是回報失敗。

### 9.2 各步驟的額外驗證

- **第 5 步搬完 `webhook` 之後**：驗證 `importAllModels()` 仍能在 `dist/`
  掃到全部 model（§6.1）。這是 tsc 與 Jest 都抓不到的那一類失敗。
- **第 7 步**：必須做一次**否定測試**——在任一服務內加一行跨服務相對
  import，確認 `npm run lint` 報錯，再還原該行；並對 `modules/` 底下的檔案
  加一行 `../services/<x>/...` 重複一次。只跑「lint 通過」無法區分「規則
  有效」與「規則的 `files:` glob 打錯、涵蓋不到任何檔案」。
- **第 4 步**：確認 `"imports"` 欄位在產品映像檔中仍然生效。現行
  `Dockerfile` 以 `COPY package*.json /app/` 與
  `COPY --from=build /app/dist /app/dist` 組出 `/app/package.json` 與
  `/app/dist/`，entry 為 `node dist/index.js`，往上找到的最近 `package.json`
  即帶有 imports map，因此**目前成立**。但這是個容易被日後改動 Dockerfile
  的人無聲破壞的不變量：只要 `package.json` 不再與 `dist/` 同層，所有 `#`
  specifier 會在容器啟動時才失敗。此依賴關係記於 §10。

## 10. 風險

| 風險                                                                                                 | 緩解                                                                     |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `importAllModels()` 的路徑假設被破壞                                                                 | §6.1 列為硬約束；§9.2 列為獨立驗證項                                     |
| ESLint 在 `#` specifier 上解析失敗                                                                   | 第 4 步先只導入 alias 不搬檔，單獨驗證 lint                              |
| diff 過大導致 review 失效                                                                            | 逐服務 commit；搬移步驟不混入邏輯變更                                    |
| `models/` ↔ `modules/` 循環依賴                                                                      | 既有狀況，§5.2 記錄成因與為何無法在本次消除                              |
| §3.1 提升規則被繞過（直接跨服務 import）                                                             | §7.6 的 ESLint 規則機械阻擋；盲點見 §2 已接受限制                        |
| §3.4 分佈表隨時間失準                                                                                | 第 9 步把維護義務寫入 `AGENTS.md`                                        |
| k8s 部署引用舊路徑                                                                                   | 入口仍是 `node dist/index.js <subcommand>`，未改變                       |
| 日後改動 `Dockerfile` 使 `package.json` 不再與 `dist/` 同層，令所有 `#` specifier 在容器啟動時才失敗 | §9.2 記錄此不變量；映像檔內 `package.json` 與 `dist/` 的相對位置不得更動 |
| 共用層反向 import 服務私有程式碼，把單一服務的內部傳遞暴露給所有服務                                 | §7.6 的共用層 override 機械阻擋；第 7 步的否定測試涵蓋此方向             |
