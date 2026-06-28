# YouTube 綁定完成 → 即時 DM 確認通知 + OAuth 模組化 + 指令可見性 設計

## 目標

接續已實作的 `docs/superpowers/specs/2026-06-26-youtube-dm-binding-design.md`，
在其之上補三項變更：

1. **綁定完成 DM 確認**：OAuth callback 綁定完成後（**綁定成功** 與
   **saved-pending** 兩種結果），由 discord-bot 立即透過 DM 送出「完成通知 + 使用者
   目前完整綁定頻道清單」。這封 DM 同時兼作**私訊可達性測試**：若送不出去（使用者
   關閉私訊 / 封鎖 bot），在 callback 的 HTML 結果頁加註提示，讓使用者當下就知道
   將收不到事件通知。
2. **OAuth 模組化**：把現有散落於 `src/discord/oauth/`（`state.ts` 的全域 client、
   `callback.ts` 的 handler、`discord-bot.ts` 內的路由註冊閉包）的 OAuth 流程**整個
   移到 `src/modules/oauth/` 目錄**，重寫成正規 `Module`，由 `Application` 管理其依賴
   （Redis、HTTP server、discord `Client`）與生命週期。藉此消除：
   - `initOAuthStateStore` 把 Redis client 塞進模組層全域變數的反模式；
   - 在 `discord-bot.ts` 以 `{ ...realDeps, sendBindingDm }` 閉包把 discord client
     逐一注入 callback handler 的接線。
3. **指令可見性**：`/youtube-dm` 的 `bind` 維持臨時（ephemeral）回覆；`list` /
   `unbind` 的主回覆改為非 ephemeral（在 bot DM 中留存於對話歷史，便於日後翻閱）；
   install-hint 的 followUp 維持 ephemeral。並把保留 ephemeral 的呼叫從已 deprecated
   的 `ephemeral: true` 改為 `flags: MessageFlags.Ephemeral`。

## 非目標

- 不改動 webhook 子系統的事件 DM 投遞路徑（`sendDiscordDm` / consent 檢查 / 重試
  策略）。確認 DM 與事件 DM 是兩條獨立路徑。
- 不為確認 DM 建立 `WebhookResult` 紀錄、不走 consent 檢查（那些是事件投遞的機制）。
- 不重試確認 DM、不對其做後續編輯：一次嘗試，成功或失敗都只反映在 callback 頁面。
- 不改動綁定資料模型、reconcile component、k8s、OAuth provider 流程語意本身（只重組
  程式結構，不改 token 交換 / 身分核對 / channel 取得的行為）。
- 不把整個 codebase 的 `ephemeral: true` 遷移到 `flags`；僅遷移本設計觸及的
  `/youtube-dm` 回覆呼叫。
- 不處理跨版本部署 / 回滾（依專案既有慣例不在範圍）。

## 事實基準（已查證，非臆測）

- **discord.js 版本**：實際安裝 `discord.js@14.26.4`、`@discordjs/rest@2.6.1`。
- **`ephemeral` 已 deprecated**：14.26.4 的 `InteractionReplyOptions.ephemeral?:
boolean` 標記 `@deprecated`，建議改用 `flags: MessageFlags.Ephemeral`（旗標值
  `1 << 6` = 64）。
- **followUp 的 ephemeral 獨立於初始 reply**（discord.js 原始碼 + Discord 官方
  docs）：Discord 允許「非 ephemeral 的初始 `reply()` → 之後送帶 EPHEMERAL flag 的
  followUp」，每則 followUp 的 ephemeral 各自獨立。**但但書**：若初始回覆是
  `deferReply()`，第一則 followUp 會被當成編輯原訊息、EPHEMERAL flag 被忽略。
  `/youtube-dm` 全部用 `intr.reply(...)` 直接回覆，符合「非 ephemeral 主回覆 +
  ephemeral followUp」成立的前提；**不得改用 `deferReply()`**。
- **BOT_DM context 只在 bot DM 可用**（Discord 官方 docs）：`/youtube-dm` 設
  `.setContexts(InteractionContextType.BotDM)`，只能在使用者與 bot 的私訊中呼叫，
  不會出現在 guild 頻道 / group DM。故 `list` / `unbind` 改非 ephemeral**不涉及公開
  頻道可見性**——訊息僅在使用者自己的 bot DM 顯示。
- **送 DM 不需任何 gateway intent**（Discord 官方 docs + discord.js `14.26.4`
  原始碼）：intents 只決定「從 gateway 接收哪些事件」。送 DM 是純 REST 動作
  （`user.send()` → `UserManager.createDM()` `POST /users/@me/channels` →
  `POST /channels/{id}/messages`），discord.js 送 DM 路徑無任何 intents 檢查。
  discord-bot 現有 `intents: [GatewayIntentBits.Guilds]` **足以**送 DM。送 DM 的
  真正前提是使用者的 DM 設定（關閉 → REST 回 `50007` CannotSendMessagesToThisUser）。
- **Module 介面與生命週期**（`src/modules/module.ts`、`application.ts`）：`Module`
  的 `init?` / `close?` / `healthCheck?` 全為選用。`Application.use(module)` 依序
  push；`init()` **forward** 逐一呼叫各 module 的 `init?()`；`close()` **reverse
  (LIFO)** 呼叫 `close?()`。`Application.get<T>(name)` 以 `name` 查找已註冊 module。
- **module-to-module 依賴的既有範式**：兩種——(1) composition root 把上游 module 的
  連線/實例傳入下游建構子（`app.use(new YoutubeWatchGate(redisModule.redis))`）；
  (2) **`src/modules/webhook/` 風格**：下游建構子收 `app: Application`（加選用額外
  參數），以 `this.app.get<RedisModule>("redis")` 取依賴並 guard（未註冊則 throw）。
  本設計 **採風格 (2) 的 `constructor(app, ...)` 形狀**，但因 OAuth 需在建構子註冊
  路由（見下「路由必須在 `listen()` 之前註冊」），故 `app.get("redis")` 與 stateStore
  建立**提前到建構子**（webhook 把它放 `init()` 是因其無 route 時序限制；OAuth 有，
  故提前，徹底避免啟動競態）。
- **路由必須在 `listen()` 之前註冊**：`HttpServerModule` 是 `Application` 建構子內
  第一個 `use` 的 module（`this.http`），其 `init()` 呼叫 `server.listen()`，於
  `app.init()` 時**最先**執行。因此其他 module 的 `init()` 都晚於 listen，無法再加
  路由。**route 必須在 module 建構子註冊**（`Application` 建構子在 `app.http.server`
  上註冊 `/healthz` 即此既有做法）。
- **指令是靜態實例陣列**（`src/discord/commands/index.ts`）：`commands: AppCommand[]`
  在模組載入時建構；`execute(intr)` 只收到 interaction（含 `intr.client`）。
- **`bindChannels` 的 saved-pending 行為**（`src/models/YoutubeDmBinding.ts`）：
  source `findOneAndUpdate({ new: true })` 成功後才呼叫 `transformYoutubeDmBinding`；
  transform 失敗才包成 `BindingTransformPendingError`。故 saved-pending 時 source
  **已寫入**，完整 `channelIds` 可由 `findOne({ discordUserId })` 讀到。
- **OAuth provider 純函式**（現於 `src/discord/oauth/google.ts`、`discord.ts`）：
  `buildGoogleAuthUrl` / `fetchGoogleChannels` 與 `buildDiscordAuthUrl` /
  `exchangeDiscordCode` / `fetchDiscordUserId` / `fetchVerifiedYoutubeChannels`
  皆為讀 `constants` 的純函式，不依賴 Redis / Client，已有測試。本設計**整檔移入
  `src/modules/oauth/`、行為不改**，由 `OAuthModule` 匯入組合。
- **module 目錄無 index.ts**（既有 `src/modules/webhook/` 慣例）：各檔以具名路徑
  直接 import（例：`../modules/webhook/partition.js`）。`src/modules/oauth/` 比照。

## 架構總覽

OAuth 流程收斂為一個 `OAuthModule`（webhook 風格：建構子收 `app` + `client`）；確認
DM 走 discord-bot 自己的 gateway `Client`（與 webhook process 的事件 DM 兩條獨立
路徑）：

```text
runDiscordBot()  ──組合──▶ Application
  · MongodbModule
  · RedisModule（OAuthModule 建構子用 app.get("redis") 取得）
  · new Client(Guilds) ──── 以建構子第二參數傳入 OAuthModule
  · app.http.server ─────── OAuthModule 建構子用它註冊路由（早於 listen）
                             ▼
        new OAuthModule(app, client)
          建構子：app.get("redis") → 建 OAuthStateStore，然後在 app.http.server
                  註冊兩條路由（handler 委派 this.*）；無啟動競態、無需 init()
                        ├─ beginAuth(method,userId) ◀── YoutubeDmCommand.bind
                        ├─ GET /oauth/youtube-dm/google/callback
                        └─ GET /oauth/youtube-dm/discord/callback
                                  │ applyBinding：bindChannels → 讀回完整 channelIds
                                  ▼
                          sendBindingDm（client.users.fetch(id).send）
                          · 成功→true / DM 關閉(50007)→false（永不 throw）
                                  │ delivered
                                  ▼
                          依 (pending?, delivered?) 寫 HTML 頁
使用者 ◀──────── 確認 DM（含完整頻道清單）────────┘
```

## 元件變更

### A. 共用頻道清單渲染：`renderBoundChannelLines`

新檔 `src/discord/commands/youtube-dm/render.ts`，匯出：

```ts
export async function renderBoundChannelLines(
  channelIds: string[]
): Promise<string[]>;
```

行為：對每個 id 以 `ChannelModel.findByChannelId(id)` 取 `name`，產出
`` `• ${channel?.name ?? "Unknown channel"} (${id})` ``，順序與輸入一致。

兩處使用、消除重複（符合「重用 util、勿重造」慣例）：`/youtube-dm list` 與確認 DM
內容組裝。此 helper 持有實際邏輯（Channel join + 缺檔 fallback + 格式化），非
logic-free 包裝。

### B. `src/modules/oauth/` 目錄與 `OAuthModule`

目錄佈局（無 index.ts，具名 import）：

- `oauth.ts` — `OAuthModule`（Module 類別）。
- `state-store.ts` — `OAuthStateStore` 類別 + `randomState()` + 型別 `OAuthMethod` /
  `OAuthState`（折入舊 `state.ts`，**移除全域 `let client` 與 `initOAuthStateStore`**）。
- `callback.ts` — callback 編排純函式（`handleGoogleCallback` / `handleDiscordCallback`
  / `applyBinding`），移自 `src/discord/oauth/callback.ts`。
- `google.ts` / `discord.ts` — provider 純函式，移自 `src/discord/oauth/`，行為不改。
- 各檔對應 `*.spec.ts` 一併移入；`src/discord/oauth/` 目錄整個移除。

（`renderBoundChannelLines` 不屬 oauth，留在 `src/discord/commands/youtube-dm/render.ts`
供 `/list` 與本模組的 `sendBindingDm` 共用。）

`OAuthModule implements Module`，`name = "oauth"`。比照 `src/modules/webhook/` 風格，
**建構子收 `app` + `client`**（`client` 非 Module、由 inline discord-bot service 持有，
故比照 webhook 「`app` + 額外參數」形狀作為第二參數）：

```ts
constructor(
  private readonly app: Application,
  private readonly client: Client
) {
  // 在註冊路由「之前」先解析依賴、建好 stateStore，避免 listen 後、init 前的
  // 啟動競態（見下「時序：無啟動競態」）。RedisModule 於本模組之前 app.use，
  // 故建構當下 app.get("redis") 必有值。
  const redisModule = this.app.get<RedisModule>("redis");
  if (!redisModule) {
    throw new Error(
      "OAuthModule: RedisModule must be registered before OAuthModule"
    );
  }
  this.stateStore = new OAuthStateStore(redisModule.redis);

  // 路由必須早於 HttpServerModule.init() 的 listen()，故在建構子註冊；
  // 此時 stateStore 已就緒。
  const server = this.app.http.server;
  server.get("/oauth/youtube-dm/google/callback", (req, reply) =>
    this.handleGoogleCallback(req, reply)
  );
  server.get("/oauth/youtube-dm/discord/callback", (req, reply) =>
    this.handleDiscordCallback(req, reply)
  );
}

private readonly stateStore: OAuthStateStore;
```

- **`OAuthStateStore`**（取代 `state.ts` 的全域 `let client` + `initOAuthStateStore`）：
  持有 `redis`，方法 `put(state, data)` / `get(state)` / `del(state)` 封裝 key
  （`youtube-dm-oauth:<state>`）、`PX: OAUTH_STATE_TTL_MS`、JSON 序列化。建構當下只
  持有 `redis` client 參照；實際連線由 `RedisModule.init()`（在本模組建構之後、且在
  任何 callback 於 runtime 觸發之前）建立，故 runtime 使用時連線必已就緒。
- **時序：無啟動競態**。依 `app.use` 次序，`RedisModule` 在 `OAuthModule` 之前註冊，
  故 `OAuthModule` **建構子**（早於 `app.init()`，因此也早於 HttpServer 的 `listen()`）
  即可 `app.get("redis")` 取得 RedisModule 並建好 `stateStore`，**然後**才註冊路由。
  因此「socket 開始 listen」時 `stateStore` 早已是 final 欄位、不可能為 undefined——
  消除了「listen 後、某 init 前」的競態窗口。`OAuthModule` 因此**無需 `init()`**
  （依賴全部在建構子解析；guard 亦在建構子）。`beginAuth` 同理於 runtime 被 `bind`
  呼叫，`stateStore` 必已就緒。
- DM sender 為方法 `sendBindingDm`（用 `this.client`，行為見 C），無需 init。

公開方法（供 `bind` 指令使用，封裝「產生 state + 寫入 + 組授權連結」）：

```ts
async beginAuth(method: OAuthMethod, discordUserId: string): Promise<string>;
```

行為：`randomState()` → `this.stateStore.put(state, { discordUserId, method })` →
`method === "google" ? buildGoogleAuthUrl(state) : buildDiscordAuthUrl(state)` → 回傳
URL。

**生命週期**：依賴全部在建構子解析，故 `OAuthModule` **無 `init()`**；`close()` 為
no-op（或省略）——路由隨 `HttpServerModule.close()` 一併關閉，state store 僅持有
`redis` 參照（連線由 `RedisModule` 擁有），DM sender 隨 `client` 失效。它仍以 Module
形態註冊，取得 `app.get("oauth")` 可發現性、與 LIFO 關閉次序中的正確位置。

**callback 編排的可測試性**：`callback.ts` 的 `handleGoogleCallback` /
`handleDiscordCallback` / `applyBinding` 維持為**可注入 collaborator 的純函式**，
collaborator 包含 state store 的 `get`/`del`、provider 函式（`fetchGoogleChannels` /
`exchangeDiscordCode` / `fetchDiscordUserId` / `fetchVerifiedYoutubeChannels`）、與
`sendBindingDm`。`OAuthModule`（`oauth.ts`）的路由 handler 只負責把**已接線的真實
collaborator** 傳入這些純函式。測試直接呼叫純函式並傳入 fake（沿用既有 `deps()`
風格），不需建構整個 module；client 耦合不外洩到測試。

### C. `sendBindingDm` + `applyBinding` 頁面分支

`sendBindingDm(discordUserId, channelIds): Promise<boolean>`（`OAuthModule` 內，
closure over `client`）：

1. `const lines = await renderBoundChannelLines(channelIds)`。
2. 組純文字內容：標頭 + 清單，例如
   `` `✅ 已完成 YouTube → Discord 私訊綁定。目前綁定的頻道：\n${lines.join("\n")}` ``。
3. `const user = await client.users.fetch(discordUserId); await user.send({ content })`。
4. 成功 → 回 `true`。
5. 失敗 → 回 `false`、**永不 throw**：DM 關閉（`DiscordAPIError.code === 50007`）屬
   預期的可達性失敗；其餘錯誤額外 `console.warn` 後同樣回 `false`（確認 DM 不重試、
   不阻斷 callback 回頁）。

`applyBinding`（純函式，collaborator 含 `sendBindingDm`）流程，沿用 base 設計、僅在其後
接上讀回清單 + 送 DM：

1. **seed Channel 文件**（沿用原版：對每個授權 channelId `findByChannelId ?? create`）。
2. `try { await YoutubeDmBindingModel.bindChannels(...) }`：
   - `BindingLimitError` → `page(400, "超過上限、未綁定。請先解除部分頻道後再試。")`，
     **return**（不送 DM）。
   - `BindingTransformPendingError` → 標記 `pending = true`（source 已寫入，續行）。
   - 其他（pre-write 例外）→ `page(500, "綁定處理失敗，請重新發起。")`，**return**。
   - 無例外 → `pending = false`。
3. 讀回完整清單：`const binding = await YoutubeDmBindingModel.findOne({ discordUserId });
const channelIds = binding?.channelIds ?? [];`
4. `const delivered = await sendBindingDm(discordUserId, channelIds);`（`sendBindingDm`
   永不 throw）。
5. 依 `(pending, delivered)` 寫頁（皆 HTTP 200，綁定本身已成立）：

   | pending | delivered | 頁面訊息                                                                                                        |
   | ------- | --------- | --------------------------------------------------------------------------------------------------------------- |
   | false   | true      | 綁定成功、已生效，已私訊你頻道清單，可關閉此頁。                                                                |
   | false   | false     | 綁定成功、已生效，但目前無法私訊你——請在 Discord 開啟「允許來自伺服器成員的私訊」後重新發起，否則將收不到通知。 |
   | true    | true      | 已儲存，稍後生效，已私訊你頻道清單，可關閉此頁。                                                                |
   | true    | false     | 已儲存，稍後生效；但目前無法私訊你，請開啟私訊權限，否則將收不到通知。                                          |

兩條 callback 路徑共用同一 `applyBinding`，故都會送確認 DM。

### D. `/youtube-dm` 指令（依賴注入 + 可見性）

`YoutubeDmCommand` 建構子改收一個窄介面依賴（只需 `beginAuth`）：

```ts
constructor(private oauth: { beginAuth(method: OAuthMethod, userId: string): Promise<string> }) {}
```

- **`bind`**：維持上限預檢（讀 `YoutubeDmBindingModel`）；改以
  `const url = await this.oauth.beginAuth(method, discordUserId)` 取得授權連結
  （不再 import 模組層 `putOAuthState` / `randomState` / `buildXAuthUrl`）。上限訊息
  與授權連結兩個 `reply` → `flags: MessageFlags.Ephemeral`。
- **`list`**：空清單訊息與清單回覆 → **移除 ephemeral**；清單組裝改用
  `renderBoundChannelLines`。
- **`unbind`**：all / 單一頻道兩個 `reply` → **移除 ephemeral**。
- **install-hint followUp**（`execute()` 末端）→ `flags: MessageFlags.Ephemeral`。
- **約束**：`execute()` 維持「先 `reply()` → 後 `followUp()`」，**不得改用
  `deferReply()`**（否則 ephemeral followUp 會被忽略）。

## Application 組合與關閉順序（`src/commands/discord-bot.ts`）

`commands` 陣列**移入 `runDiscordBot()`**（在 `OAuthModule` 建立後才能建構，因
`YoutubeDmCommand` 需注入 `oauth`）。`src/discord/commands/index.ts` 的靜態陣列移除。
**取捨**：commands 清單因此不可獨立單元測試——已接受（換取無全域、純建構子注入）。

組合（`app.use` 次序決定 LIFO 關閉）：

```ts
const app = new Application(); // app.http = HttpServerModule（最先、最後關）
app.use(new MongodbModule());
app.use(new RedisModule()); // OAuthModule 建構子以 app.get("redis") 取得
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const oauth = app.use(new OAuthModule(app, client));
const commands: AppCommand[] = [
  new CrawlCommand(),
  new SetChannelCommand(),
  new SetVideoCommand(),
  new TrackCommand(),
  new YoutubeDmCommand(oauth),
];
commands.sort(/* 既有排序 */);
app.use({
  name: "discord-bot",
  async init() {
    await registerCommands(commands);
    await client.login(DISCORD_TOKEN);
  },
  async close() {
    await client.destroy();
  },
});
// 既有 client.on(InteractionCreate, ...) 改用區域 commands
await app.init();
```

- `initOAuthStateStore(...)` 呼叫與 `discord-bot.ts` 內的兩行 `fastify.get(...)` 路由
  註冊**移除**（改由 `OAuthModule` 建構子負責）。
- 關閉次序（LIFO）：discord-bot service（`client.destroy()`）→ OAuth（no-op）→
  Redis → Mongo → HttpServer（最後，路由維持到最末）。`OAuthModule` 註冊於
  `RedisModule` 之後、discord-bot service 之前，符合「消費者先於其依賴關閉」。

## 失敗與邊界

- **DM 送不出（50007）**：`sendBindingDm` 回 `false`，綁定仍成立，頁面顯示「無法
  私訊你」提示；使用者開啟私訊後重新 `bind` 即可重送（事件 DM 亦於使用者重開私訊
  後依既有 webhook 行為恢復）。
- **saved-pending**：source 已寫入，確認 DM 照常送（DM 不依賴 webhook）。
- **上限被拒 / pre-write 例外**：不送 DM，頁面訊息與既有一致。
- **`sendBindingDm` 永不 throw**：任何 DM 錯誤都吞並回 `false`，callback 不因 DM
  失敗而回 500。
- **list/unbind 非 ephemeral 的可見性**：僅在使用者自己的 bot DM 顯示，非公開；屬
  已接受的 UX 取捨。
- **路由註冊時序**：`OAuthModule` 在建構子註冊路由（早於 `HttpServerModule.init()` 的
  `listen()`），並在建構子先解析 redis、建好 `stateStore`，與既有 `/healthz` 註冊
  時機一致——這是把 stateStore 建在建構子的自然位置，非額外補強。
- **OAuth state / callback 的極罕見邊界，刻意不補強（已接受的取捨）**：state 沿用原版
  「讀後即刪」單次使用；任何失敗（token 交換 / fetch / pre-write 例外 / 啟動瞬間
  連線未就緒 / 並行踩同一新 Channel / post-commit 罕見失敗）一律走「`page(500)`、
  使用者重跑 `/youtube-dm bind`」這條簡單路徑——綁定的唯一 durable commit 點是
  `bindChannels`，失敗前無 partial、重跑為冪等。**這些只在極極少數例外才觸發的情況
  不值得為其增加大量補強程式碼**（與 deploy/rollback 同類判斷）；殘餘風險（如 orphan
  Channel 參考文件、罕見重複確認 DM）無害且由既有 crawl / TTL 收斂。

## 測試重點

- **`renderBoundChannelLines`**：多 id 依序 join 出 `name`；缺 Channel 退回
  "Unknown channel"；輸出順序與輸入對應（`toEqual` 整陣列）。
- **`OAuthStateStore`**：`put` 後 `get` 取回同物件（stateful fake redis）、`del` 後
  `get` 回 `null`；`put` 用 `PX: OAUTH_STATE_TTL_MS`（斷言 set 選項）。
- **`beginAuth`**：寫入 state（斷言 `stateStore.put` 收到 `{ discordUserId, method }`）
  並回傳對應 provider 的授權 URL（含 `state`）。
- **`applyBinding` × DM 結果矩陣**（fake `sendBindingDm`）：成功 / saved-pending ×
  delivered true/false → 四種頁面字串與 status 200；`BindingLimitError` → 400 頁、
  **`sendBindingDm` 零呼叫**；pre-write 例外 → 500 頁、零呼叫；DM 收到的 `channelIds`
  = 綁定後**完整**清單（含先前已綁 + 本次新增）。
- **Channel seed**：成功 / saved-pending → 對授權 channelId 呼叫 `findByChannelId ??
create`（已存在則不重建）。（不為 orphan / 並行等極罕見邊界寫補強測試。）
- **`sendBindingDm`**：正常 → `client.users.fetch` + `user.send` 被呼叫、內容含
  `renderBoundChannelLines` 行、回 `true`；`user.send` 拋 `{ code: 50007 }` → 回
  `false`、不 throw、不 `console.warn`；拋其他錯誤 → 回 `false`、不 throw、有
  `console.warn`。
- **callback 純函式注入**：`handleGoogleCallback` / `handleDiscordCallback` 把接線的
  `sendBindingDm` 與 provider 函式傳入 `applyBinding`（spy 斷言透傳）；缺 `code` 的
  prefetch 不碰 state；Discord 授權者 id 與 state 不符時拒絕。
- **`OAuthModule` 建構**：以 fake `app`（`app.http.server` = spy fastify、
  `app.get("redis")` 回 fake RedisModule）建構 → 斷言建構子建好 `stateStore` 並在 spy
  fastify 註冊兩條 `GET` 路由於正確路徑（不需 listen）；`app.get("redis")` 回
  `undefined` 時建構子 throw（guard）。
- **`/youtube-dm` 回覆 flags**（mock interaction）：`bind` 兩個 reply 帶
  `flags: MessageFlags.Ephemeral`；`list` 空清單與清單 reply、`unbind` 兩個 reply
  **不帶** ephemeral flag；install-hint followUp 帶 `flags: MessageFlags.Ephemeral`；
  `bind` 透過注入的 `beginAuth` 取得 URL（spy 斷言呼叫參數）；`list` 內容由
  `renderBoundChannelLines` 產出。

## 計畫階段待確認（不臆測）

- `client.users.fetch(id)` → `User.send({ content })` 的確切簽名，以及 DM 關閉時
  `DiscordAPIError.code === 50007` 的確切形狀（`node_modules/discord.js@14.26.4`
  原始碼 / 型別）。
- `OAuthStateStore` 對 node-redis v4 `set` 的 `PX` 選項與 `get`/`del` 回傳型別的
  確切用法（讀 `node_modules/@redis/client` 確認，沿用移入前 `state.ts` 既有用法）。
- `FastifyInstance.get` 在建構子階段（`listen()` 之前）註冊路由的型別與既有
  `app.http.server.get` 用法一致性（讀 `src/modules/http-server.ts` 與 `application.ts`
  的 `/healthz` 註冊確認）。
