# YouTube 綁定完成 → 即時 DM 確認通知 + 指令回覆可見性調整 設計

## 目標

接續已實作的 `docs/superpowers/specs/2026-06-26-youtube-dm-binding-design.md`，
在其之上補兩項行為：

1. OAuth callback 綁定完成後（**綁定成功** 與 **saved-pending** 兩種結果），由
   discord-bot 立即透過 DM 送出「完成通知 + 使用者目前完整綁定頻道清單」。這封 DM
   同時兼作**私訊可達性測試**：若送不出去（使用者關閉私訊 / 封鎖 bot），在 callback
   的 HTML 結果頁加註提示，讓使用者當下就知道將收不到事件通知。
2. 調整 `/youtube-dm` 指令回覆可見性：`bind` 維持臨時（ephemeral）回覆；`list` /
   `unbind` 的主回覆改為非 ephemeral（在 bot DM 中留存於對話歷史，便於日後翻閱）；
   install-hint 的 followUp 維持 ephemeral。並把保留 ephemeral 的呼叫從已 deprecated
   的 `ephemeral: true` 改為 `flags: MessageFlags.Ephemeral`。

## 非目標

- 不改動 webhook 子系統的事件 DM 投遞路徑（`sendDiscordDm` / consent 檢查 / 重試
  策略）。確認 DM 與事件 DM 是兩條獨立路徑。
- 不為確認 DM 建立 `WebhookResult` 紀錄、不走 consent 檢查（那些是事件投遞的機制）。
- 不重試確認 DM、不對其做後續編輯：一次嘗試，成功或失敗都只反映在 callback 頁面。
- 不調整綁定資料模型、reconcile component、k8s、OAuth 流程本身。
- 不在本次把整個 codebase 的 `ephemeral: true` 遷移到 `flags`；僅遷移本設計實際
  觸及的 `/youtube-dm` 回覆呼叫。
- 不處理跨版本部署 / 回滾（依專案既有慣例不在範圍）。

## 事實基準（已查證，非臆測）

- **discord.js 版本**：實際安裝 `discord.js@14.26.4`、`@discordjs/rest@2.6.1`
  （讀 `node_modules/.../package.json` 確認；前一份設計誤記為 14.19.3，以此為準）。
- **`ephemeral` 已 deprecated**：14.26.4 的 `InteractionReplyOptions.ephemeral?:
boolean` 標記 `@deprecated`，建議改用 `flags: MessageFlags.Ephemeral`（旗標值
  `1 << 6` = 64）。`ephemeral` 仍可運作但首次觸發發 Node deprecation 警告。
- **followUp 的 ephemeral 獨立於初始 reply**（discord.js 原始碼 + Discord 官方
  `discord/discord-api-docs`）：`followUp()` 直接呼叫 webhook send，不繼承初始
  reply 的 ephemeral；Discord 伺服器允許「非 ephemeral 的初始 response → 之後送
  帶 EPHEMERAL flag 的 followup」，每則 followup 的 ephemeral 各自獨立。
  **但但書**：若初始回覆是 `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`（`deferReply()`），
  第一則 followup 會被當成編輯原訊息、**EPHEMERAL flag 被忽略**並沿用 defer 當時
  的狀態。因此「非 ephemeral 主回覆 + ephemeral followUp」成立的前提是初始回覆用
  `reply()` 直接回、**不可用 `deferReply()`**。`/youtube-dm` 全部用 `intr.reply(...)`
  直接回覆，符合此前提。
- **BOT_DM context 只在 bot DM 可用**（Discord 官方文件）：`/youtube-dm` 設
  `.setContexts(InteractionContextType.BotDM)`，故只能在使用者與 bot 的私訊中呼叫，
  不會出現在 guild 頻道 / group DM（與 integration types 無關）。因此 `list` /
  `unbind` 改非 ephemeral**不涉及公開頻道可見性**——訊息僅在使用者自己的 bot DM
  顯示；差別只在 ephemeral（重載後消失、不可翻閱）vs 持久訊息。
- **discord-bot 已有 gateway `Client`**（`src/commands/discord-bot.ts`，
  `intents: [GatewayIntentBits.Guilds]`，已 `client.login(DISCORD_TOKEN)`）。送 DM
  為 REST 動作，不需 privileged intent。
- **callback 結構**（`src/discord/oauth/callback.ts`）：`applyBinding` 透過
  `CallbackDeps` 注入 seam，依綁定結果（成功 / saved-pending / 上限被拒 / 失敗）
  寫 HTML 頁。`realDeps` 提供跨模組 OAuth 函式；測試以 `deps()` helper 建完整
  `CallbackDeps`。
- **`bindChannels` 的 saved-pending 行為**（`src/models/YoutubeDmBinding.ts`）：
  source `findOneAndUpdate({ new: true })` 成功後才呼叫 `transformYoutubeDmBinding`；
  transform 失敗才包成 `BindingTransformPendingError`。故 saved-pending 時 source
  **已寫入**，使用者當前完整 `channelIds` 可由 `findOne({ discordUserId })` 讀到。

## 架構總覽

確認 DM 走 discord-bot 自己的 gateway `Client`，與事件 DM（webhook process 的
REST-only `sendDiscordDm`）是兩條獨立路徑：

```text
使用者 ──/youtube-dm bind──▶ discord-bot ──OAuth──▶ callback (HTTP)
                                                       │ applyBinding
                                                       │ 1. bindChannels（既有）
                                                       │ 2. 讀回完整 channelIds
                                                       ▼
                                              sendBindingDm(注入)
                                              · client.users.fetch(id).send(...)
                                              · 成功→true / DM 關閉(50007)→false
                                                       │ 回傳 delivered
                                                       ▼
                                              依 (pending?, delivered?) 寫 HTML 頁
使用者 ◀────────── 確認 DM（含完整頻道清單）──────────┘
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

兩處使用、消除重複（符合「重用 util、勿重造」慣例）：

- `/youtube-dm list`（`src/discord/commands/youtube-dm/youtube-dm.ts`）：把目前
  inline 組清單的迴圈改為呼叫此 helper。
- 確認 DM 的內容組裝（見 C 的 `makeBindingDmSender`）。

此 helper 持有實際邏輯（Channel join + 缺檔 fallback + 格式化），非 logic-free
包裝。

### B. `CallbackDeps` 新增 `sendBindingDm`，注入留在 composition root

`src/discord/oauth/callback.ts`：

- `CallbackDeps` 介面新增：

  ```ts
  sendBindingDm: (discordUserId: string, channelIds: string[]) =>
    Promise<boolean>;
  ```

  回傳 `true` = DM 已送達；`false` = 送不出（DM 關閉 / 任何錯誤）。**永不 throw**。

- `realDeps`（callback.ts 模組層）**不**含 `sendBindingDm`——callback.ts 無 Discord
  client，無法在模組層建立真正的 sender。改：`realDeps` 型別為
  `Omit<CallbackDeps, "sendBindingDm">`，僅保留既有 OAuth 函式。
- `handleGoogleCallback` / `handleDiscordCallback` 移除 `deps: CallbackDeps =
realDeps` 預設值，改為**必填** `deps: CallbackDeps`。生產端與測試端一律顯式傳入
  完整 deps（生產端見 C；測試端 `deps()` helper 已是顯式建構）。

### C. 真正的 DM sender + 路由注入（discord-bot.ts）

新檔 `src/discord/oauth/binding-dm.ts`，匯出工廠：

```ts
export function makeBindingDmSender(
  client: Client
): (discordUserId: string, channelIds: string[]) => Promise<boolean>;
```

行為：

1. `const lines = await renderBoundChannelLines(channelIds)`。
2. 組純文字內容：一行標頭 + 清單，例如
   `` `✅ 已完成 YouTube → Discord 私訊綁定。目前綁定的頻道：\n${lines.join("\n")}` ``。
3. `const user = await client.users.fetch(discordUserId); await user.send({ content })`。
4. 成功 → 回 `true`。
5. 失敗 → 回 `false`，**不 throw**：DM 關閉 / 無法私訊（`DiscordAPIError.code ===
50007`，"Cannot send messages to this user"）屬預期的可達性失敗；其餘錯誤額外
   `console.warn` 記一筆後同樣回 `false`（確認 DM 不重試、不阻斷 callback 回頁）。

`src/commands/discord-bot.ts`：在 `client` 建立後，路由註冊改為注入此 sender：

```ts
const sendBindingDm = makeBindingDmSender(client);
fastify.get("/oauth/youtube-dm/google/callback", (req, reply) =>
  handleGoogleCallback(req as any, reply, { ...realDeps, sendBindingDm })
);
fastify.get("/oauth/youtube-dm/discord/callback", (req, reply) =>
  handleDiscordCallback(req as any, reply, { ...realDeps, sendBindingDm })
);
```

Client 耦合僅存在於 `binding-dm.ts` 與 `discord-bot.ts`；`callback.ts` 維持純函式
可測。

> 50007 的確切 `DiscordAPIError` 形狀（`error.code` 為數值 50007）與 `User.send`
> 簽名於計畫階段以 research subagent 對照 `node_modules/discord.js@14.26.4` 確認；
> `GatewayIntentBits.Guilds` 足以送 DM 一併確認。

### D. `applyBinding` 改寫：送 DM 並依結果分支頁面

`applyBinding` 簽名新增 `sendBindingDm`（由 handler 傳 `deps.sendBindingDm`）：

```ts
export async function applyBinding(
  discordUserId: string,
  channels: Channel[],
  reply: FastifyReply,
  sendBindingDm: (
    discordUserId: string,
    channelIds: string[]
  ) => Promise<boolean>
): Promise<void>;
```

流程：

1. seed Channel 文件（既有）。
2. `try { await YoutubeDmBindingModel.bindChannels(...) }` →
   - `BindingLimitError` → `page(400, "超過上限、未綁定。請先解除部分頻道後再試。")`，
     **return**（不送 DM）。
   - `BindingTransformPendingError` → 標記 `pending = true`（source 已寫入，續往
     送 DM）。
   - 其他（pre-write 例外）→ `page(500, "綁定處理失敗，請重新發起。")`，**return**。
   - 無例外 → `pending = false`。
3. （成功或 pending）讀回完整清單：
   `const binding = await YoutubeDmBindingModel.findOne({ discordUserId });`
   `const channelIds = binding?.channelIds ?? [];`
4. `const delivered = await sendBindingDm(discordUserId, channelIds);`
5. 依 `(pending, delivered)` 寫頁（皆 HTTP 200，綁定本身已成立）：

   | pending | delivered | 頁面訊息                                                                                                        |
   | ------- | --------- | --------------------------------------------------------------------------------------------------------------- |
   | false   | true      | 綁定成功、已生效，已私訊你頻道清單，可關閉此頁。                                                                |
   | false   | false     | 綁定成功、已生效，但目前無法私訊你——請在 Discord 開啟「允許來自伺服器成員的私訊」後重新發起，否則將收不到通知。 |
   | true    | true      | 已儲存，稍後生效，已私訊你頻道清單，可關閉此頁。                                                                |
   | true    | false     | 已儲存，稍後生效；但目前無法私訊你，請開啟私訊權限，否則將收不到通知。                                          |

`handleGoogleCallback` / `handleDiscordCallback` 呼叫 `applyBinding(...,
deps.sendBindingDm)`。兩條 callback 路徑共用同一 `applyBinding`，故兩者都會送確認
DM。

### E. `/youtube-dm` 回覆可見性（改用 `flags`）

`src/discord/commands/youtube-dm/youtube-dm.ts`（`import { MessageFlags }
from "discord.js"`）：

- **`bind`**：上限訊息與授權連結兩個 `reply` → `flags: MessageFlags.Ephemeral`
  （取代 `ephemeral: true`）。授權連結敏感且一次性，維持 ephemeral。
- **`list`**：空清單訊息與清單回覆兩個 `reply` → **移除 ephemeral**（不帶 flag）。
  清單組裝改用 `renderBoundChannelLines`。
- **`unbind`**：all / 單一頻道兩個 `reply` → **移除 ephemeral**。
- **install-hint followUp**（`execute()` 末端）→ `flags: MessageFlags.Ephemeral`
  （取代 `ephemeral: true`），維持 ephemeral。
- **約束**：`execute()` 流程維持「先 `intr.reply(...)` → 後 `intr.followUp(...)`」，
  **不得改用 `deferReply()`**；否則非 ephemeral 主回覆後的 ephemeral followUp 會被
  Discord 當成編輯原訊息而忽略 EPHEMERAL flag（見「事實基準」）。

## 失敗與邊界

- **DM 送不出（DM 關閉 / 封鎖 / 無共同伺服器，50007）**：`sendBindingDm` 回 `false`，
  綁定仍成立，頁面顯示「無法私訊你」提示。使用者開啟私訊後重新發起 `bind` 即可重送
  確認 DM（事件 DM 也會在使用者重開私訊後自動恢復，屬既有 webhook 投遞行為）。
- **saved-pending**：source 已寫入，確認 DM 照常送（DM 不依賴 webhook）；頁面反映
  「已儲存，稍後生效」+ DM 達/未達。
- **上限被拒 / pre-write 例外**：不送 DM，頁面訊息與既有一致。
- **`sendBindingDm` 永不 throw**：任何 DM 錯誤都被吞並回 `false`，callback 不因 DM
  失敗而回 500。
- **讀回清單為空**（理論上不會，post-bind 至少含本次頻道）：仍呼叫 `sendBindingDm`；
  內容只有標頭、無清單行；不特別處理。
- **list/unbind 非 ephemeral 的可見性**：僅在使用者自己的 bot DM 顯示（BOT_DM-only），
  非公開；屬已接受的 UX 取捨（持久留存便於翻閱）。

## 測試重點

- **`renderBoundChannelLines`**：多 id 依序 join 出 `name`；缺 Channel 退回
  "Unknown channel"；輸出順序與輸入 id 對應（結構化 `toEqual` 斷言整個陣列）。
- **`applyBinding` × DM 結果矩陣**（stateful fake `sendBindingDm`）：
  - 成功 + delivered=true / false → 兩種頁面字串與 status 200。
  - saved-pending + delivered=true / false → 兩種頁面字串與 status 200。
  - `BindingLimitError` → 400 頁、**`sendBindingDm` 零呼叫**（斷言 mock 未被呼叫）。
  - pre-write 例外 → 500 頁、`sendBindingDm` 零呼叫。
  - DM 清單來源：斷言 `sendBindingDm` 收到的 `channelIds` = 綁定後**完整**清單
    （含先前已綁 + 本次新增），非僅本次授權頻道（stateful fake 綁定資料）。
- **`makeBindingDmSender`**：
  - 正常 → `client.users.fetch` + `user.send` 被呼叫，內容含 `renderBoundChannelLines`
    產出的清單行；回 `true`。
  - `user.send` 拋 `{ code: 50007 }` → 回 `false`、**不 throw**、不 `console.warn`。
  - `user.send` 拋其他錯誤 → 回 `false`、不 throw、有 `console.warn`。
- **callback handlers 注入**：`handleGoogleCallback` / `handleDiscordCallback` 把
  `deps.sendBindingDm` 透傳給 `applyBinding`（以 spy 斷言透傳）。
- **`/youtube-dm` 回覆 flags**（mock interaction，斷言 reply/followUp 收到的選項）：
  - `bind` 兩個 reply 帶 `flags: MessageFlags.Ephemeral`。
  - `list` 空清單與清單 reply **不帶** ephemeral flag。
  - `unbind` all / 單一 reply **不帶** ephemeral flag。
  - install-hint followUp 帶 `flags: MessageFlags.Ephemeral`。
  - `list` 清單內容由 `renderBoundChannelLines` 產出（結構化斷言行內容）。

## 計畫階段待確認（不臆測）

- `client.users.fetch(id)` → `User.send({ content })` 的確切簽名，以及 DM 關閉時
  `DiscordAPIError.code === 50007` 的確切形狀（`node_modules/discord.js@14.26.4`
  原始碼 / 型別）。
- `GatewayIntentBits.Guilds`（現有 intent）是否足以送 DM（送 DM 為 REST，理應不需
  privileged intent）—— 確認後若不足，於計畫補述所需 intent。
- 移除 handler `= realDeps` 預設值後，現有 `callback.spec.ts` 既存案例的最小調整
  （`deps()` helper 補一個 `sendBindingDm` 預設、`applyBinding` 直呼案例補傳
  sender 參數）。
