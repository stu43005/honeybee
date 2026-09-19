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
- 以 path alias 表達「跨越服務邊界」的 import，使違規可被肉眼與工具識別
- 刪除 dead code

### 非目標

- **不改變任何執行期行為。** 本次重整是純粹的檔案搬移、模組切分與 import
  路徑改寫；不調整演算法、不改 API、不動資料結構。
- **不拆分過大的檔案。** `commands/worker.ts`（1166 行）、`data/webhook.ts`
  （632 行）等只搬移不拆分，後續另案處理。
- **不引入 barrel file（`index.ts` re-export）。** 只會增加一層無邏輯的間接。
- **不補測試覆蓋率。** 既有測試隨被測檔案一起搬移，不新增也不刪除。

## 3. 三層定位規則

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

## 4. 目標佈局

```
src/
├── index.ts                          # yargs dispatcher
├── constants.ts
├── interfaces.ts
├── utils/
│   ├── index.ts                      # ← src/util.ts
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
│   └── webhook-template/
│       └── index.ts                  # ← data/webhook.ts（webhook 服務 + manager 共用）
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
`src/util.ts` 併入 `src/utils/index.ts`。

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

這個循環今天就存在，ESM 的 live binding 能正常處理，本次不動它。要真正消除
必須把 transform 呼叫從 model static 移到呼叫端，那是會改變行為的重新設計，
不在本次範圍。

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

| 來源 → 目標                                                        | 寫法                |
| ------------------------------------------------------------------ | ------------------- |
| 服務內部 → 同服務其他檔案                                          | 相對路徑 `./` `../` |
| 服務 → `models` / `modules` / `utils` / `constants` / `interfaces` | alias `#...`        |
| `modules/` → `models` / `utils` / `constants` / `interfaces`       | alias `#...`        |
| `modules/` → 同目錄或子目錄                                        | 相對路徑            |
| `models/` → `modules` / `utils` / `constants` / `interfaces`       | alias `#...`        |
| `models/` → 其他 model                                             | 相對路徑            |
| 任何服務 → 另一個服務                                              | **禁止**            |

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

## 8. 遷移順序

每一步都是獨立 commit。`npm run build`（tsc）會抓出所有斷掉的 import，
`npm test` 驗證行為未變。

| #   | 內容                                                               | 風險                     |
| --- | ------------------------------------------------------------------ | ------------------------ |
| 1   | 刪除 `modules/action-counter.ts`                                   | 無（零引用已驗證）       |
| 2   | 建立 `modules/track/`、`modules/youtube-dm/`，切分兩個 operator    | 中：唯一有邏輯搬動的一步 |
| 3   | `src/util.ts` 併入 `src/utils/index.ts`                            | 低（11 個 importer）     |
| 4   | 導入 `"imports"` 欄位與 `moduleNameMapper`，現有 import 改為 alias | 中：牽動範圍最廣         |
| 5   | 建立 `services/`，逐服務搬移                                       | 低，但 diff 大           |
| 6   | 解散 `data/`                                                       | 低                       |
| 7   | 對齊 spec 檔名                                                     | 無                       |
| 8   | 更新 `AGENTS.md`、`docs/data-contract/` 的路徑引用                 | 無                       |

第 5 步的服務順序由小到大：`metrics` → `scheduler` → `crawler` →
`discord-bot` → `webhook` → `worker` → `manager`。前兩者無私有檔案，只是搬
entrypoint，可作為 alias 方案的實地驗證。

### 8.1 第 7 步的檔名對齊

| 現況                                         | 改為                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| `modules/youtube-playlist-transport.spec.ts` | 與被測的 `modules/youtube.ts` 同名對齊                  |
| `commands/crawler-candidates.spec.ts`        | 隨 `crawler` 搬移並與被測檔對齊                         |
| `commands/webhook-dm.spec.ts`                | 隨 `webhook` 搬移並與被測檔對齊                         |
| `modules/webhook/simplifyMatch.ts`           | `services/webhook/simplify-match.ts`（統一 kebab-case） |

## 9. 驗證

每一步 commit 前必須全部通過：

1. `npm run build` — tsc 型別檢查，會抓出所有未更新的 import 路徑
2. `npm run lint` — ESLint 走 `tsconfig.eslint.json`（extends 主 tsconfig，
   繼承 `rootDir`/`outDir`），需確認 `#` specifier 在 lint 階段也能解析
3. `npm test` — Jest
4. 第 4 步之後額外確認 `node dist/index.js --help` 能列出七個子命令，證明
   `"imports"` 在實際執行期成立而非只有型別層面成立

第 5 步搬完 `webhook` 之後，額外驗證 `importAllModels()` 仍能在 `dist/` 掃到
全部 model（§6.1），這是 tsc 與 Jest 都抓不到的那一類失敗。

## 10. 風險

| 風險                                 | 緩解                                               |
| ------------------------------------ | -------------------------------------------------- |
| `importAllModels()` 的路徑假設被破壞 | §6.1 列為硬約束；第 9 節列為獨立驗證項             |
| ESLint 在 `#` specifier 上解析失敗   | 第 4 步先只導入 alias 不搬檔，單獨驗證 lint        |
| diff 過大導致 review 失效            | 逐服務 commit；搬移步驟不混入邏輯變更              |
| `models/` ↔ `modules/` 循環依賴      | 既有狀況，§5.2 記錄，不在本次處理                  |
| k8s 部署引用舊路徑                   | 入口仍是 `node dist/index.js <subcommand>`，未改變 |
