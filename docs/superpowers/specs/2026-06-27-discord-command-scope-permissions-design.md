# Discord 指令可見性、使用範圍與執行權限調整

## 背景與現況

discord-bot 服務（`src/commands/discord-bot.ts`）目前在啟動時，把
`src/discord/commands/index.ts` 匯出的全部命令一次性註冊成 **global**
application commands：

```
await rest.put(Routes.applicationCommands(DISCORD_ID), { body: cmdDatas });
```

現有五個命令的現況：

| 命令          | 檔案                                            | 現況                                                                      |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `crawl`       | `src/discord/commands/mod/crawl.ts`             | 無範圍/權限限制，global 可見                                              |
| `set-channel` | `src/discord/commands/mod/set-channel.ts`       | 無範圍/權限限制，global 可見                                              |
| `set-video`   | `src/discord/commands/mod/set-video.ts`         | 無範圍/權限限制，global 可見                                              |
| `track`       | `src/discord/commands/track/track.ts`           | 已設 `setDefaultMemberPermissions(ManageWebhooks)` + `setContexts(Guild)` |
| `youtube-dm`  | `src/discord/commands/youtube-dm/youtube-dm.ts` | 設 `setContexts(Guild)`（目前只能在伺服器內、DM 不可用）                  |

需求是調整三類命令的可見範圍、使用情境與執行權限，並導入 Discord 的
user-install 安裝模式讓 `youtube-dm` 能在 DM 真正可用。

## 目標

1. **mod 命令**（`crawl`、`set-channel`、`set-video`）：只在指定的開發群組
   （guild）內出現與可用，不檢查使用者權限。
2. **track 命令**：在所有伺服器可用、DM 內禁用，使用者必須具備 `ManageWebhooks`
   權限（現況已符合，明確化即可）。
3. **youtube-dm 命令**：只在 DM 內可用；同時支援 guild-install 與 user-install
   兩種安裝方式；當互動是經由 guild-install 成立時，引導使用者改用
   user-install，避免日後退出伺服器或 bot 被移出伺服器導致 DM 路徑中斷。
4. 研究並結論 track / youtube-dm 採用 user-install 的可行性。

## 研究結論

研究對象為專案實際安裝的 `discord.js@14.26.4`
（搭配 `@discordjs/builders@1.14.1`、`discord-api-types@0.38.49`），以下行為皆來自
`node_modules/` 實際型別定義與原始碼，非記憶推測。

### discord.js / discord-api-types 行為

- `SlashCommandBuilder.setIntegrationTypes(...types)` 接受
  `ApplicationIntegrationType` 列舉：`GuildInstall = 0`、`UserInstall = 1`
  （`discord-api-types/payloads/v10/_interactions/applicationCommands.d.ts`）。
- `SlashCommandBuilder.setContexts(...contexts)` 接受 `InteractionContextType`
  列舉：`Guild = 0`、`BotDM = 1`、`PrivateChannel = 2`（同上來源）。`BotDM`
  代表與本 bot 的一對一 DM；`PrivateChannel` 代表群組 DM 或與其他使用者的 DM。
- `integration_types` 與 `contexts` 僅對 **global 命令**有效；其預設值為
  `integration_types = [GuildInstall]`、
  `contexts = [Guild, BotDM, PrivateChannel]`。兩者需邏輯相容（例如 `[UserInstall]`
  不能搭配只有 `[Guild]` 的 context）。
- `Routes.applicationGuildCommands(applicationId, guildId)`
  存在，支援 `PUT` 全量覆寫該 guild 的命令集；guild 命令**即時生效**（相對 global
  命令最長約 1 小時快取），且 guild 命令**不吃** `integration_types` / `contexts`
  欄位，固定隱含 GuildInstall + Guild context。
- 執行期 `ChatInputCommandInteraction` 上可用：`intr.context`
  （`InteractionContextType | null`，目前互動的情境）、`intr.inGuild()`
  type guard、`intr.guildId`、`intr.authorizingIntegrationOwners`
  （型別 `APIAuthorizingIntegrationOwnersMap = { [ApplicationIntegrationType]?: Snowflake }`，
  指出此互動由哪些安裝情境授權，GuildInstall key 的值為 guild id、UserInstall key
  的值為 user id）。
- user-install 的 app 在 **bot 未加入的 guild** 中互動時，拿不到完整的 guild
  member / channel 物件、無法執行需要 bot guild 權限的操作（例如管理 webhook）。

### track user-install 可行性 → 不可行

`track` 的核心副作用是在目標 guild 頻道建立一個 **incoming webhook**：
`getChannelWebhook()`（`src/discord/commands/track/track.ts`）呼叫
`baseChannel.fetchWebhooks()` 與 `baseChannel.createWebhook(...)`，並以
`webhook.owner?.id === intr.client.user.id` 比對「由本 bot 持有的 webhook」；建立後把
`clientId` + `token` 存入 Track model，webhook 投遞子系統之後就靠這個 **bot
持有的 webhook token** 推送訊息。

`fetchWebhooks()` / `createWebhook()` 是以 **bot token** 對該 guild 頻道發出的
REST 操作，要求 **bot 本身是該 guild 成員且具 `ManageWebhooks` 權限**。在
user-install 情境下（bot 不在該 guild），互動只攜帶「呼叫者使用者的授權」，Discord
**不會**把使用者自身權限轉換為 bot 對該 guild 的 API 存取權，且 user-installed app
在 bot 未加入的 guild 中也拿不到可管理 webhook 的完整頻道物件。

因此 `track` 的 webhook 建立流程無法靠使用者自身權限執行 →
**`track` 維持 guild-install only，不開 user-install**。

### youtube-dm user-install 可行性 → 可行，採用

`youtube-dm` 不需要任何 guild 的 bot 權限，全部互動皆為 ephemeral 回覆與
OAuth 引導，天生契合 user-install + BotDM context：使用者把 app 安裝到自己帳號後，
即可在任何 DM 與 bot 互動，不依賴是否與 bot 共享伺服器。**採用**。

## 設計

### 1. `AppCommand` 新增註冊範圍標記

在 `src/discord/commands/command.ts` 的 `AppCommand` 介面新增一個 optional 欄位：

```ts
registration?: "global" | "devGuild";
```

語意：

- 未設或設為 `"global"`：註冊為 global application command（現有行為）。
- `"devGuild"`：註冊為開發 guild 專屬命令。

mod 三個命令（`crawl`、`set-channel`、`set-video`）在各自 class 上宣告
`public registration = "devGuild" as const;`。其餘命令不設此欄位，沿用 global。

選擇此方案（範圍標記掛在命令定義上）而非「在 index.ts 維護兩個陣列」或「靠目錄/名稱
反推」，是因為範圍語意與命令本身綁定、新增命令時一眼可辨，且分組邏輯可由單一純函式
驅動而便於測試。

### 2. registerCommands 拆分為 global 與 devGuild 兩次註冊

`src/commands/discord-bot.ts` 的 `registerCommands` 改為：

1. 用純函式把傳入的命令依 `registration` 欄位分成 `globalCommands` 與
   `devGuildCommands` 兩組（預設歸 global）。此分組函式（例如
   `partitionCommandsByScope`）獨立可測，回傳兩組命令（`AppCommand[]`）；註冊時各自取
   `cmd.metadata` 組 `PUT` body（回傳命令物件而非僅 metadata，是因守衛、日誌與名稱輸出
   都需要命令物件本身）。
2. **先**處理 devGuild 組（先讓 mod 在開發 guild 就位，再從 global 移除，避免空窗，
   詳見「註冊冪等性與部署順序」）：
   - 若 `DISCORD_DEV_GUILD_ID` 有設，執行
     `rest.put(Routes.applicationGuildCommands(DISCORD_ID, DISCORD_DEV_GUILD_ID), { body: devGuildBody })`。
   - 若 `DISCORD_DEV_GUILD_ID` 未設，**跳過 devGuild 註冊並輸出 warn log**，mod
     命令在任何地方都不可見（fail-closed，比誤註冊成 global 安全）。
3. **再**對 global 組執行
   `rest.put(Routes.applicationCommands(DISCORD_ID), { body: globalBody })`。
   因為 PUT 是全量覆寫，把 mod 命令移出 global body 後，下次部署 Discord 會自動把
   mod 從 global 命令集移除。
4. **失敗即中止啟動（fail-fast）**：上述任一 `PUT`（devGuild 或 global）失敗時，
   `registerCommands` 不再吞錯續行，而是**讓錯誤往外拋**，使 `app.init()` reject、
   process 以非零碼結束。如此啟動失敗會反映為 pod crashloop / rollout 卡住的可見訊號，
   而非靜默 log。實作須確保拋出的錯誤確實終止 process（非僅被 catch 後 return）。
   注意：`DISCORD_DEV_GUILD_ID` **未設**屬刻意跳過（warn + 略過 devGuild 註冊），
   **不視為失敗**、不觸發退出。

這取代了原本「log error 後 return、不中斷啟動」的行為。對應的效益：若 Developer Portal
未啟用 User Install 導致 global `PUT` 整批驗證失敗，新 pod 會啟動失敗、rollout 停在舊
版本（mod 仍如舊版全域可見），操作者由失敗的 rollout 立即察覺並修正，而不是新版上線後
靜默 fail-open。

註：guild 命令 metadata 不應帶 `integration_types` / `contexts`（Discord 會忽略），
mod 命令的 `SlashCommandBuilder` 維持不呼叫 `setContexts` / `setIntegrationTypes`
即可。

### 3. mod 命令執行期 guild 守衛（fail-closed 授權邊界）

guild 註冊只決定**可見性**；為避免註冊狀態 stale / 快取延遲 / `PUT` 失敗 / 回滾時
mod 命令在開發 guild 以外被執行，於共用 dispatcher 加一道**執行期授權守衛**，與
`registration` 標記共用單一真相來源：

- 在 `src/commands/discord-bot.ts` 的 `InteractionCreate` handler 中，找到對應命令後、
  呼叫 `execute` / `autocomplete` 前，若該命令的 `registration === "devGuild"`，檢查
  `intr.guildId === DISCORD_DEV_GUILD_ID`：
  - 相符 → 照常執行。
  - 不相符（含 DM 時 `guildId` 為 null、或在其他 guild）→ **不執行**。對
    ApplicationCommand 互動回 ephemeral 拒絕訊息；對 Autocomplete 互動回空建議
    （不洩漏命令存在）。
- **fail-closed**：`DISCORD_DEV_GUILD_ID` 未設 / 為空字串時，守衛對所有 `devGuild`
  命令一律拒絕（與「未設則不註冊」相互佐證）。
- 此守衛是「範圍授權」而非「使用者權限」檢查，符合 mod「不關心使用者權限、只限制在開發
  群組」的需求；註冊範圍維持為可見性邊界，執行授權由此守衛把關。
- 守衛抽成可單元測試的純判斷（輸入 `registration`、`intr.guildId`、
  `DISCORD_DEV_GUILD_ID`，輸出 allow / reject），dispatcher 依結果決定是否執行。

### 4. 各命令 metadata 調整

- **mod（crawl / set-channel / set-video）**：metadata 內容不變，只在 class 上加
  `registration = "devGuild"`。不設使用者權限（依需求不關心權限）；範圍由 guild 註冊
  ＋執行期 guild 守衛把關（見上節）。
- **track**：維持 `setDefaultMemberPermissions(ManageWebhooks)` 與
  `setContexts(Guild)`；明確補上 `setIntegrationTypes(ApplicationIntegrationType.GuildInstall)`
  以表達「僅 guild-install」的意圖（值即預設值，行為不變，純為可讀性與防未來誤改）。
- **youtube-dm**：
  - `setContexts(InteractionContextType.BotDM)`（由原本的 `Guild` 改為 `BotDM`）。
  - `setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)`。

### 5. youtube-dm 執行期引導 user-install

`youtube-dm` 的 `execute` 在送出回覆時，檢查
`intr.authorizingIntegrationOwners`：

- 若該 map **含 UserInstall key**（使用者已 user-install）→ 不附加提示。
- 若該 map **只有 GuildInstall key、無 UserInstall key**（此 DM 路徑是靠共享伺服器
  成立的）→ 在主要回覆**之後**送出一則 user-install 引導（提示文字 + 安裝連結），引導
  使用者把 app 安裝到自己帳號，使 DM 路徑不再依賴伺服器成員關係。送出方式採**獨立的
  ephemeral follow-up 訊息**（`intr.followUp({ ephemeral: true, ... })`）而非串接進每個
  subcommand 的 reply 內容：execute() 的 bind / list / unbind 各有多個 reply 出口，集中
  在 switch 之後送一則 follow-up 可單點處理、不污染 6 個 reply 點，UX 上等價於「在回覆
  之後附帶提示」。
- `authorizingIntegrationOwners` 可能為 undefined / 空物件 `{}` / 缺 key，需防禦性處理
  （缺 UserInstall key 即視為「未 user-install」）。

安裝連結需要本應用的 application id（由 `intr.client.application.id` 取得）。已查證
Discord 官方文件（developer docs OAuth2 / Application），user-install 的安裝連結
（install link，純安裝命令、不需 token 交換，故不帶 `response_type` / `redirect_uri`）
格式為：

```text
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&integration_type=1&scope=applications.commands
```

其中 `integration_type=1` 對應 user-install、`scope=applications.commands` 為命令安裝
所需 scope。

**Application 端前置設定（部署前置條件）**：須在 Discord Developer Portal →
Installation 啟用 **User Install** installation context，並設定 Default Install
Settings 的 scope 含 `applications.commands`。若 application 層未啟用 user-install，
則命令 metadata 設 `integration_types: [..., UserInstall]` 在 `PUT` 註冊時會**驗證
失敗**（Discord 限制：`integration_types` 只能包含 application 層已支援的 context）。
此 portal 設定屬叢集 / Discord app 管理操作，列為部署前置條件（見「部署」與「範圍外」）。

此引導邏輯抽成一個小工具函式（輸入
`authorizingIntegrationOwners` 與 application id，輸出「是否需要提示」與提示字串），
以便對「有/無 UserInstall key」兩種輸入做單元測試。

### 6. 設定（constants）

`src/constants.ts` 在 DISCORD 相關區塊新增：

```ts
export const DISCORD_DEV_GUILD_ID = process.env.DISCORD_DEV_GUILD_ID;
```

optional；未設時 mod 命令不註冊（見上）。沿用專案「所有設定走環境變數」慣例。

### 7. 部署（k8s）

`k8s/base/discord-bot.yaml` 的 deployment 在 `env` 區塊新增一條，沿用既有
`honeybee-secrets` secret（與 `PUBLIC_BASE_URL` 同來源）。**必須帶
`optional: true`**：因 `DISCORD_DEV_GUILD_ID` 設計為 optional，若 secret 尚未加入此
key（例如 staging / prod 還沒設），`optional: true` 會讓該 env 單純不存在、pod 正常
啟動並走「未設 → 跳過 devGuild 註冊」路徑；若不帶 `optional: true`，缺 key 會使
Kubernetes **阻擋整個 pod 啟動**，把一個 scoped 的 optional 設定變成整個 discord-bot
服務中斷（連 global 命令註冊都不會跑），與本設計的 fail-closed 意圖矛盾。

```yaml
- name: DISCORD_DEV_GUILD_ID
  valueFrom:
    secretKeyRef:
      name: honeybee-secrets
      key: DISCORD_DEV_GUILD_ID
      optional: true
```

secret 實際值（`543454386873958411`）由叢集端 secret 管理，不寫入 repo。

## 錯誤處理與邊界情境

- `DISCORD_DEV_GUILD_ID` 未設：跳過 devGuild 註冊並 warn（**非失敗、不退出**），mod
  命令全域不可見（fail-closed）。
- devGuild PUT 失敗（bot 不在該 guild、缺 Manage Server 之類 → 403 / Missing
  Access）：**fail-fast** —— 拋錯中止啟動、process 非零退出，global `PUT` 不再執行。
- global PUT 失敗：**fail-fast** —— 拋錯中止啟動、process 非零退出（取代原本「log
  error 後 return」）。
- **portal 未啟用 User Install 導致 global PUT 整批失敗（耦合風險，硬性前置條件）**：
  global `PUT` 是 all-or-nothing 全量覆寫，且同一批 body 同時包含「youtube-dm 帶
  `[GuildInstall, UserInstall]`」與「mod 已移出 global」。若 Developer Portal 尚未啟用
  User Install context，Discord 會因 `integration_types` 含未支援的 context 而**整批
  拒絕**此 `PUT` → 連帶「mod 移出 global」也不會生效。在 fail-fast 下，新 pod 會啟動
  失敗、rollout 停在舊版本（mod 仍如舊版全域可見），操作者由「失敗的 rollout /
  crashloop + 啟動 error log」立即察覺，而非新版靜默 fail-open。因此**在部署本變更前，
  必須先在 Developer Portal 啟用 User Install context**（列為硬性部署前置條件，見
  「部署」與「範圍外」）；fail-fast 已提供可見失敗訊號，故不另加 preflight / 版本閘門
  程式碼，修正 portal 設定後重新部署即收斂。
- youtube-dm 在 `authorizingIntegrationOwners` 為 undefined 或缺 UserInstall key
  時：視為未 user-install，附加引導提示；不得因此拋例外。
- 既有 youtube-dm 使用者（先前以 Guild context 註冊）：context 改為 BotDM
  後，伺服器內將不再出現該命令，僅 DM 可用 — 這是預期的行為轉移。

## 註冊冪等性與部署順序

Discord 的命令集是持久化的外部狀態（global 命令集、各 guild 命令集），兩次 `PUT`
皆為全量覆寫（last-writer-wins）。本設計對此狀態的行為如下：

- **單一寫入者**：discord-bot deployment 為 `replicas: 1`（見
  `k8s/base/discord-bot.yaml`），且註冊只在該唯一 pod 啟動時執行，正常運作下不存在多
  pod 並發 `PUT` 互相覆寫的情形。本設計不額外引入分散式鎖 / leader election —— 前提
  是維持 `replicas: 1`；若未來把 discord-bot 擴成多副本，需另行加入單一寫入者保證
  （列為該擴充的前置條件，不在本設計範圍）。
- **冪等**：兩次 `PUT` 都是宣告式全量覆寫，重啟 / 重跑啟動流程會收斂到同一目標狀態，
  無需差異計算或清理步驟。任何一次部分失敗，都會在「下次成功啟動」時被重新覆寫修正。
- **註冊順序 + fail-fast**：先執行 devGuild 組 `PUT`（把 mod 註冊進開發 guild），成功
  後再執行 global 組 `PUT`（把 mod 移出 global）；任一 `PUT` 失敗即中止啟動。因 fail-fast
  在 devGuild 失敗時不會繼續動 global，「mod 已從 global 移除、但尚未進開發 guild」的
  交叉空窗**不會發生**。
- **partial-failure 的實際狀態（fail-fast 下）**：
  - **devGuild `PUT` 失敗**：立即拋錯中止，global `PUT` 不執行 → global 命令集維持
    **舊狀態**（與本變更前相同，仍含 mod）；pod crashloop、rollout 停住。無交叉空窗。
  - **global `PUT` 失敗（devGuild 已成功）**：mod 已就位於開發 guild；global 因失敗保留
    **舊集**（仍含 mod）→ mod 暫時同時在開發 guild 與 global 可見；pod crashloop、
    rollout 停住。這是本變更生效前的既有 global 曝光延續，並非新引入，操作者修正後重新
    部署、global `PUT` 成功即收斂消除。此處明確**不**宣稱「failure 絕不會曝光 mod」，但
    失敗一律以 crashloop / rollout 中止呈現，不會靜默 fail-open。
- **執行期 guild 守衛兜底**：上述任何「mod 在開發 guild 以外仍可見」的失敗 / 過渡狀態
  下，執行期 guild 守衛（見「mod 命令執行期 guild 守衛」）仍會在 `execute` 前以
  `intr.guildId === DISCORD_DEV_GUILD_ID` 把關 —— mod 即使可見也**不會在開發 guild 以外
  被執行**。可見性可能短暫不準，但授權邊界不依賴註冊狀態。
- **回滾 / 混版（刻意接受、不在本設計處理）**：若叢集回滾到先前會把全部命令註冊成
  global 的舊二進位，mod 命令會再次全域**可見**。此跨版本回滾 / 混版視窗由專案負責人
  先前裁定為不成比例的風險、刻意不加入版本閘門 / migration job / 部署鎖；命令集冪等保證
  「重新部署新版」即可再次收斂回正確狀態。註：舊二進位不含執行期 guild 守衛，故回滾期間
  守衛兜底亦失效 —— 這同屬已接受的回滾風險。詳見「範圍外」。

## 測試

- **命令分組純函式**：輸入混合 `registration` 標記的命令陣列，斷言 global 組與
  devGuild 組成員、順序正確（結構性斷言，非僅呼叫次數）。
- **執行期 guild 守衛純函式**：對 `(registration, guildId, DISCORD_DEV_GUILD_ID)`
  各組合斷言 allow / reject：`devGuild` 命令在相符 guild → allow；在他 guild → reject；
  在 DM（`guildId` null）→ reject；`DISCORD_DEV_GUILD_ID` 未設 / 空 → 一律 reject
  （fail-closed）；`global` 命令不受守衛影響 → allow。
- **youtube-dm 引導邏輯**：對引導工具函式分別餵入「含 UserInstall key」「只含
  GuildInstall key」「空 / undefined」三種
  `authorizingIntegrationOwners`，斷言是否附加提示與提示內容（沿用並擴充既有
  `src/discord/commands/youtube-dm/youtube-dm.spec.ts`）。
- **metadata 斷言**：
  - mod 三命令的 class 帶 `registration === "devGuild"`。
  - track metadata 帶 `ManageWebhooks` 預設權限、Guild context、僅 GuildInstall
    integration type。
  - youtube-dm metadata 帶 BotDM context、`[GuildInstall, UserInstall]` integration
    types。

## 範圍外

- 不調整 mod 命令的內部商業邏輯，只調整其註冊範圍並於 dispatcher 加執行期 guild
  守衛（不動各 mod 命令 `execute` 內部邏輯）。
- 不為 track 開 user-install（研究結論：不可行）。
- 不處理 Discord 端 dev guild secret、以及 Developer Portal 啟用 User Install
  context 的設定（屬叢集 / Discord app 管理操作，列為部署前置條件）。
- **不為跨版本回滾 / 混版的命令曝光加入額外保證程式碼（版本閘門、migration job、
  部署鎖等）**。理由：更版部署在短時間內即完成，回滾 / 混版視窗極短，專案負責人已
  明確接受此風險；命令集為冪等全量覆寫，重新部署新版即收斂回正確狀態。後續 review
  不應再就此議題要求加碼。
