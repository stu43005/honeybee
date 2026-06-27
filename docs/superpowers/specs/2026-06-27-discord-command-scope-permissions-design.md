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
   `partitionCommandsByScope`）獨立可測，回傳兩組命令的 metadata 陣列。
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

註：guild 命令 metadata 不應帶 `integration_types` / `contexts`（Discord 會忽略），
mod 命令的 `SlashCommandBuilder` 維持不呼叫 `setContexts` / `setIntegrationTypes`
即可。

### 3. 各命令 metadata 調整

- **mod（crawl / set-channel / set-video）**：metadata 內容不變，只在 class 上加
  `registration = "devGuild"`。不設權限（依需求不關心權限）。
- **track**：維持 `setDefaultMemberPermissions(ManageWebhooks)` 與
  `setContexts(Guild)`；明確補上 `setIntegrationTypes(ApplicationIntegrationType.GuildInstall)`
  以表達「僅 guild-install」的意圖（值即預設值，行為不變，純為可讀性與防未來誤改）。
- **youtube-dm**：
  - `setContexts(InteractionContextType.BotDM)`（由原本的 `Guild` 改為 `BotDM`）。
  - `setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)`。

### 4. youtube-dm 執行期引導 user-install

`youtube-dm` 的 `execute` 在送出回覆時，檢查
`intr.authorizingIntegrationOwners`：

- 若該 map **含 UserInstall key**（使用者已 user-install）→ 不附加提示。
- 若該 map **只有 GuildInstall key、無 UserInstall key**（此 DM 路徑是靠共享伺服器
  成立的）→ 在回覆內容尾端附加一段提示文字 + user-install 安裝連結，引導使用者把 app
  安裝到自己帳號，使 DM 路徑不再依賴伺服器成員關係。
- `authorizingIntegrationOwners` 可能為 undefined / 缺 key，需防禦性處理（缺
  UserInstall key 即視為「未 user-install」）。

安裝連結需要本應用的 application id（由 `intr.client.application.id` 取得）。連結的
確切格式（`integration_type` 對應值、`scope` 內容）屬 Discord OAuth 授權 URL 慣例而
非 discord.js API，**在實作計畫階段以 research subagent 對 Discord 官方文件查證後才
寫入**，本設計不預先寫死字串。

此引導邏輯抽成一個小工具函式（輸入
`authorizingIntegrationOwners` 與 application id，輸出「是否需要提示」與提示字串），
以便對「有/無 UserInstall key」兩種輸入做單元測試。

### 5. 設定（constants）

`src/constants.ts` 在 DISCORD 相關區塊新增：

```ts
export const DISCORD_DEV_GUILD_ID = process.env.DISCORD_DEV_GUILD_ID;
```

optional；未設時 mod 命令不註冊（見上）。沿用專案「所有設定走環境變數」慣例。

### 6. 部署（k8s）

`k8s/base/discord-bot.yaml` 的 deployment 在 `env` 區塊新增一條，沿用既有
`honeybee-secrets` secret（與 `PUBLIC_BASE_URL` 同來源）：

```yaml
- name: DISCORD_DEV_GUILD_ID
  valueFrom:
    secretKeyRef:
      name: honeybee-secrets
      key: DISCORD_DEV_GUILD_ID
```

secret 實際值（`543454386873958411`）由叢集端 secret 管理，不寫入 repo。

## 錯誤處理與邊界情境

- `DISCORD_DEV_GUILD_ID` 未設：跳過 devGuild 註冊並 warn，mod 命令全域不可見
  （fail-closed）。
- devGuild PUT 失敗（bot 不在該 guild、缺 Manage Server 之類 → 403 / Missing
  Access）：log error 但不中斷啟動，global 命令註冊與其餘流程不受影響。
- global PUT 失敗：維持現有錯誤處理（log error 後 return，不拋出）。
- youtube-dm 在 `authorizingIntegrationOwners` 為 undefined 或缺 UserInstall key
  時：視為未 user-install，附加引導提示；不得因此拋例外。
- 既有 youtube-dm 使用者（先前以 Guild context 註冊）：context 改為 BotDM
  後，伺服器內將不再出現該命令，僅 DM 可用 — 這是預期的行為轉移。

## 註冊冪等性與部署順序

Discord 的命令集是持久化的外部狀態（global 命令集、各 guild 命令集），兩次 `PUT`
皆為全量覆寫。本設計對此狀態的不變式如下，避免「mod 命令意外在非開發 guild 曝光」：

- **冪等**：兩次 `PUT` 都是宣告式全量覆寫，重啟 / 重跑啟動流程會收斂到同一目標狀態，
  無需差異計算或清理步驟。
- **註冊順序**：先執行 devGuild 組 `PUT`（把 mod 註冊進開發 guild），成功後再執行
  global 組 `PUT`（把 mod 移出 global）。如此不會出現「mod 已從 global 移除、但開發
  guild 尚未取得」的空窗；若 devGuild `PUT` 失敗則跳過 global 的 mod 移除前提不成立
  —— 因 mod 本就不在新的 global body 內，global `PUT` 仍會把 mod 移出 global。
- **partial-failure 為 fail-closed**：任一 `PUT` 失敗的最壞結果是「mod 命令暫時在某處
  不可用」，**絕不會**讓 mod 命令出現在開發 guild 以外的地方。亦即失敗只會少曝光、不會
  多曝光，符合本變更「限制可見範圍」的核心目標。
- **回滾的已知限制（刻意接受）**：若叢集回滾到目前這版二進位（會把全部命令註冊成
  global），mod 命令會再次全域曝光。此跨版本回滾 / 混版視窗由專案負責人裁定為不成比例
  的風險、**刻意不在本設計加入版本閘門或 migration**；命令集冪等的特性保證「重新部署
  新版」即可再次收斂回正確狀態。

## 測試

- **命令分組純函式**：輸入混合 `registration` 標記的命令陣列，斷言 global 組與
  devGuild 組成員、順序正確（結構性斷言，非僅呼叫次數）。
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

- 不調整 mod 命令的內部商業邏輯，只調整其註冊範圍。
- 不為 track 開 user-install（研究結論：不可行）。
- 不處理 Discord 端 dev guild secret 的建立 / 輪替（叢集 secret 管理範疇）。
- 既有命令的部署 / 回滾 / 混版相容性不在本設計討論範圍。
