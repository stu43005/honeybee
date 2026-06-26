# YouTube 帳號綁定 → Discord DM 個人通知 設計

## 目標

讓使用者透過 Discord bot 指令綁定一個或多個**已驗證所有權**的 YouTube
頻道，之後當這些頻道在 YouTube 上發出 superchat / membership 等事件時，由系統
**私訊（DM）**通知該使用者。

監視能力**完全複用既有 webhook 子系統**（change stream → queue →
`processWebhookEvent`）。discord-bot **不得**自行實作 change stream。

## 非目標

- 不儲存任何 OAuth token：驗證僅用於一次性證明頻道所有權並讀出 channelId，完成後
  立即丟棄 token。
- 不提供 per-user 的事件類型開關；綁定後固定監視 superchat/membership 類事件。
- 不做 DM 訊息的後續編輯（`followUpdate` 採預設 `false`）。
- 不處理跨版本部署 / 回滾 / 混版安全（依專案既有慣例不在本設計範圍）。

## 名詞與既有機制（事實基準）

- `chatsOtherChannels + withoutNormalChats` 在 `src/data/track.ts` 的實際產出為
  `colls: ["superchats","superstickers","memberships","milestones","membershipgiftpurchases","membershipgifts"]`
  （`withoutNormalChats` 移除 `"chats"`）。本設計沿用這組 collection。
- `getChannelIdFilter(track, reverse?)`（`src/data/track.ts:307`）將頻道清單轉成
  Mongo filter：單一頻道用純值 / `{$ne}`，多頻道用 `{$in}` / `{$nin}`。
- webhook 子系統由 enabled 的 `Webhook` 文件**動態推導**要監視的 collection 集合
  （meta-stream 監看 `webhooks` collection）。新增 / 刪除 `Webhook` 文件會被自動
  納入 / 移出監視，無需重啟、無額外 change stream。
- `Webhook` 文件的投遞目標在**送出時**才決定：`processWebhookEvent`
  （`src/commands/webhook.ts:369`）依 `checkIsDiscordWebhookUrl(url)` 分派。
- track-operator（`src/components/track-operator.ts`）已是「來源文件 → 衍生
  `Webhook` 文件」的範式：以 `(track, feature)` 為 key upsert，最後 `deleteMany`
  清理不再啟用者；`Track` 每次異動都立即呼叫 `transformTrack(track)`，外加 manager
  每 1 小時 sweep。
- Track 綁定頻道時的 Channel 處理（`src/discord/commands/track/track.ts:233`）：
  `ChannelModel.findByChannelId(id) ?? ChannelModel.create({ id, name: "Unknown channel" })`，
  其餘 metadata 由既有背景 crawl 補；embed 顯示讀 `Channel.name`。
- discord-bot 的 HTTP server 已在運行：`Application` 內建 `HttpServerModule`
  （Fastify，`app.http.server`），`k8s/base/discord-bot.yaml` 已宣告
  `containerPort: 3000` 與 `/healthz` 探針。
- DM 投遞使用 REST-only 路徑即可，無須 gateway `Client`。已驗證版本
  discord.js `14.19.3`、@discordjs/rest `2.5.0`：
  - 建立 DM 頻道：`Routes.userChannels()`（`/users/@me/channels`），body
    `{ recipient_id }`，回應為 `APIChannel`（含 `id`）。
  - 發送訊息：`Routes.channelMessages(dmChannelId)`，body `{ content, embeds }`。
  - 兩者需 `auth: true`，並先 `rest.setToken(DISCORD_TOKEN)`。
  - `username`/`avatar_url` 送到一般 message 端點會被靜默忽略。
- Discord connections（已驗證查證）：讀取使用者連結的 YouTube 帳號必須走 Discord
  OAuth2 `connections` scope；bot token 無法讀取。YouTube connection 物件的 `id`
  即頻道 ID（`UC...`），並含 `verified: boolean`。

## 架構總覽

四個既有 process 各自擴充，職責分離：

```text
使用者(Discord) ──/youtube-dm bind──▶ discord-bot
                                       · 綁定指令 (bind/list/unbind)
                                       · OAuth callback (HTTP, 兩條路徑)
                                       · 驗證後寫入 YoutubeDmBinding，丟棄 token
                                              │ 寫入 + 立即 transform
                                              ▼
                                       YoutubeDmBinding (Mongo)
                                              │ 來源
                                              ▼
                                       manager / youtube-dm-operator
                                       · 異動立即 transform + 每 1h sweep
                                              │ upsert / delete
                                              ▼
                                       Webhook (insertUrl=discord-dm://<userId>)
                                              │ meta-stream 自動接手
                                              ▼
                                       webhook process（既有 change-stream/queue）
                                       · processWebhookEvent → checkIsDiscordDmUrl
                                         → sendDiscordDm()（bot token, REST-only）
                                              │ DM
使用者(Discord) ◀─────────────────────────────┘
```

端到端：

1. 使用者 `/youtube-dm bind method:<google|discord>`，走 OAuth 取得**已驗證的
   channelId**，寫入 `YoutubeDmBinding`，丟棄 token。
2. 寫入時立即 `transformYoutubeDmBinding(binding)`，把該使用者的所有 channelIds
   收斂成**一份** `Webhook` 文件。
3. webhook 子系統 meta-stream 自動納入監視。
4. 符合 match 的 superchat/membership 文件流經既有 change-stream → queue →
   `processWebhookEvent`，最後 `sendDiscordDm` 用 bot token 建立 DM 並發送 embed。

## 資料模型

### 新 model：`YoutubeDmBinding`

檔案 `src/models/YoutubeDmBinding.ts`，collection `youtubeDmBindings`，採
**一個 Discord 使用者一份 document**：

```ts
@modelOptions({ schemaOptions: { collection: "youtubeDmBindings" } })
@index({ discordUserId: 1 }, { unique: true })
export class YoutubeDmBinding extends TimeStamps {
  @prop({ required: true })
  discordUserId!: string;

  @prop({ type: () => [String], default: [] })
  channelIds!: string[];
}
export default getModelForClass(YoutubeDmBinding);
```

設計理由：

- `channelIds` 僅存頻道 ID 字串，`$addToSet` 天然去重，無重複子文件問題。
- channel title 不存在綁定文件，改由 `Channel` model 串接（與 Track 一致）。
- YouTube 頻道僅用於**驗證所有權**，不是綁定主鍵，因此 `channelIds` 不設全域
  unique（允許不同使用者各自綁定；實務上只有真正擁有者能通過 OAuth）。

static helpers 仿 Track：對綁定文件做一次更新後，**在最後 `await
transformYoutubeDmBinding(doc)`**。**不使用交易**；source 與衍生 Webhook 的短暫
不一致由 1 小時 sweep 收斂（明確設計決定）。

- `bindChannels(discordUserId, channelIds: string[])`：
  `findOneAndUpdate({ discordUserId }, { $addToSet: { channelIds: { $each: channelIds } } }, { upsert: true, new: true })`
  後 `await transformYoutubeDmBinding(doc)`。
- `unbindChannel(discordUserId, channelId)`：
  `findOneAndUpdate({ discordUserId }, { $pull: { channelIds: channelId } }, { new: true })`
  後 `await transformYoutubeDmBinding(doc)`（重算 match；channelIds 變空則刪除
  webhook）。
- `unbindAll(discordUserId)`：`$set: { channelIds: [] }` 後
  `await transformYoutubeDmBinding(doc)`（刪除該 Webhook）。

**綁定上限**：在呼叫 `bindChannels` 前（指令端與 helper 開頭）讀目前 `channelIds`，
計算「本次**真正新增**的頻道數」= 請求的 channelIds 扣除已存在於 `channelIds`
者（重複綁同一頻道不計入，避免無謂拒絕），若 `現有數 + 真正新增數 >
YOUTUBE_DM_MAX_CHANNELS_PER_USER` 則整批拒絕並提示。此上限為**軟性濫用防線**、非
正確性不變量：同一使用者的 OAuth 流程本質序列（一次完成一個授權），並行重複綁定
極罕見，即使偶發競爭略為超量也僅讓單份 webhook 的 `$in` 稍大、無功能性危害，故不
以交易強制。

> 失敗模型（明確接受的取捨）：transform 為 `findOneAndUpdate` 後的同步 await，正常
> 情況即時生效。若 transform 拋例外（罕見 DB 錯誤）：
>
> - **bind 端**：source 已寫入、webhook 尚未建立 → callback 回「已儲存，稍後由
>   排程生效」（誠實狀態，非純失敗、非謊稱已生效），1 小時 sweep 會補上 webhook。
> - **unbind 端**：consent 不靠 sweep 時效——即使 stale webhook 暫存，webhook
>   process 的**投遞時 consent 檢查**（見下）會比對當前綁定，已 unbind 的頻道事件
>   一律不送 DM，故不存在「opt-out 後仍收到通知」的視窗。sweep 僅負責最終清掉
>   stale webhook 文件本身（停止無謂的事件匹配）。

bind 時 channel 文件處理（對每個 channelId，與 Track 同做法）：
`ChannelModel.findByChannelId(id) ?? ChannelModel.create({ id, name })`。
因 OAuth 已取得 title（Google `snippet.title` / Discord connection `name`），
建立時即 seed `name`，`/youtube-dm list` 可立即顯示；其餘 metadata 仍由既有背景
crawl 補。

### `Webhook` model 微調

`src/models/Webhook.ts` 新增一個對綁定文件的 Ref（仿 `track`，純供 reconcile 對照
與唯一約束）：

```ts
@prop({ ref: "YoutubeDmBinding" })
public youtubeDmBinding?: Ref<YoutubeDmBinding>;
```

```ts
@index(
  { youtubeDmBinding: 1 },
  { unique: true, partialFilterExpression: { youtubeDmBinding: { $type: "objectId" } } }
)
```

- 收件者不另存欄位，由 `insertUrl = discord-dm://<discordUserId>` 攜帶；
  `sendDiscordDm` 從 `insertUrl` 解析。
- partial unique index 僅在 `youtubeDmBinding` 為 objectId 時生效，與既有
  `(track, feature)` index（要求 `track` 為 objectId）互不干擾；DM webhook 無
  `track`/`feature`，track webhook 無 `youtubeDmBinding`。

## Reconcile component：`youtube-dm-operator`

檔案 `src/components/youtube-dm-operator.ts`，由 manager 註冊（仿 `trackOperator`）。

### `transformYoutubeDmBinding(binding)`

```ts
export async function transformYoutubeDmBinding(
  binding: DocumentType<YoutubeDmBinding>
): Promise<void> {
  if (binding.channelIds.length === 0) {
    await WebhookModel.deleteMany({ youtubeDmBinding: binding._id });
    return;
  }
  const insertUrl = `discord-dm://${binding.discordUserId}`;
  const webhook = {
    colls: [
      "superchats",
      "superstickers",
      "memberships",
      "milestones",
      "membershipgiftpurchases",
      "membershipgifts",
    ],
    match: { authorChannelId: getChannelIdFilter(binding.channelIds) },
    templatePreset: "discord-embed-chats",
    insertUrl,
    youtubeDmBinding: binding._id,
    enabled: true,
  };
  await WebhookModel.updateOne(
    { youtubeDmBinding: binding._id },
    { $set: webhook },
    { upsert: true, setDefaultsOnInsert: true }
  );
}
```

- match 僅 `authorChannelId`（依使用者明確要求，**不**加 originChannelId 反向過濾、
  **不**加 isReplay 過濾）。
- `getChannelIdFilter` 需從 `src/data/track.ts` 匯出並改為接受
  `channelIds: string[]`（而非 `track`）；同步更新 `track.ts` 內的呼叫端。此舉
  避免重造等義 helper（符合專案「重用 util、勿重造」慣例）。
- `templatePreset` 直接重用 `discord-embed-chats`，不新增 preset；webhook 專用的
  `username`/`avatar_url` 在 DM 送出時剔除。
- `followUpdate` 不設定（採預設 `false`，insert-only）。

### 週期 sweep + 孤兒清理

仿 `transformTracks`：

```ts
export default function youtubeDmOperator(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");
  agenda.define("transform youtube dm bindings", transformYoutubeDmBindings);
  void agenda.every("1 hour", "transform youtube dm bindings");
}

async function transformYoutubeDmBindings() {
  for await (const binding of YoutubeDmBindingModel.find()) {
    await transformYoutubeDmBinding(binding);
  }
  // 孤兒清理：youtubeDmBinding 指向已刪除綁定文件的 webhook。
  // 必須用 { $type: "objectId" }（與 partial index 同 discriminator），不可用
  // { $ne: null }——後者在 MongoDB 會連「欄位不存在」的 track / 一般 webhook 也
  // 一併命中，$lookup 無對應綁定 → 被誤判為孤兒刪除，造成既有監視大規模損毀。
  for await (const webhook of WebhookModel.aggregate([
    { $match: { youtubeDmBinding: { $type: "objectId" } } },
    {
      $lookup: {
        from: "youtubeDmBindings",
        localField: "youtubeDmBinding",
        foreignField: "_id",
        as: "bindingDoc",
      },
    },
    { $match: { bindingDoc: { $size: 0 } } },
  ])) {
    await WebhookModel.deleteOne({ _id: webhook._id });
  }
}
```

異動立即生效：綁定 static helpers 在每次 `$addToSet` / `$pull` / 清空後立即呼叫
`transformYoutubeDmBinding`，因此監視幾乎零延遲；1 小時 sweep 僅作為一致性與孤兒
清理保險（與 track-operator 對等）。

## Discord bot：綁定指令 + OAuth

### 指令 `/youtube-dm`

新檔 `src/discord/commands/youtube-dm/`（仿 `TrackCommand`，加入 `commands/index.ts`）：

- `bind method:<google|discord>` — 產生 OAuth 授權連結，ephemeral 回覆「點此授權」。
  先檢查該使用者目前 `channelIds.length` 是否已達
  `YOUTUBE_DM_MAX_CHANNELS_PER_USER`。
- `list` — 列出 `channelIds`，逐一以 `ChannelModel.findByChannelId` 取 `name` 顯示。
- `unbind channel:<channelId|all>` — `channel` 以 autocomplete 從已綁定清單提供。

### OAuth 流程（兩條路徑共用基礎設施）

1. `bind` 產生隨機 `state`，存 Redis：key `youtube-dm-oauth:<state>` →
   `{ discordUserId, method }`，TTL `OAUTH_STATE_TTL_MS`（`SET PX`）。discord-bot
   新增 `RedisModule`。
2. 回覆 ephemeral 授權連結：
   - Google：`https://accounts.google.com/o/oauth2/v2/auth`，scope
     `https://www.googleapis.com/auth/youtube.readonly`，帶 `state` 與
     `redirect_uri = <OAUTH_PUBLIC_BASE_URL>/oauth/youtube-dm/google/callback`。
   - Discord：`https://discord.com/oauth2/authorize`，scope
     `identify connections`（`identify` 用於下方身分核對），帶 `state` 與
     `redirect_uri = <OAUTH_PUBLIC_BASE_URL>/oauth/youtube-dm/discord/callback`。
3. Callback HTTP endpoint（discord-bot 在 `app.init()` 前以 `app.http.server`
   註冊 Fastify 路由）：
   - 共同：以 `state` 從 Redis 取回 `{ discordUserId, method }`；缺失 / 過期 →
     回錯誤頁。**用後立即刪除 `state`（單次使用、防重放）**，並驗證 callback 的
     `method` 與 state 記錄一致。
   - Google：`GET /oauth/youtube-dm/google/callback?code&state` → 用 code 換 token
     → `youtube.channels.list({ mine: true, part: ["snippet"] })`。一個 Google
     帳號可擁有**多個**頻道（品牌帳號），故取回傳清單中**所有** channelId + title
     → `bindChannels(discordUserId, ids)` 並 seed 各 Channel（受寫入路徑上限約束，
     超量則整批拒絕並回提示頁）→ **丟棄 token** → 回成功頁。
   - Discord：`GET /oauth/youtube-dm/discord/callback?code&state` → 用 code 換 token
     （`POST https://discord.com/api/oauth2/token`）→ **先** `GET /users/@me` 取得
     完成授權的 Discord user id，**要求其等於 state 內的 `discordUserId`，不符即
     拒絕並回錯誤頁**（防止外洩的授權連結把他人頻道綁到本使用者 DM）→
     `GET /users/@me/connections` → 取 `type === "youtube" && verified === true`
     的 `id`/`name`（可多個）→ `bindChannels(discordUserId, ids)` 並 seed 各 Channel
     → **丟棄 token** → 回成功頁。
4. `bindChannels` 內最後立即 transform → Webhook 立即生效。callback 依結果**誠實
   回報**，三種狀態分明：
   - **上限被拒**：未寫入任何綁定 → 回「超過上限、未綁定」。
   - **transform 成功**：回「綁定成功、已生效」。
   - **source 已寫入但 transform 罕見拋例外**：source 已存在、稍後由 1 小時 sweep
     建立 webhook → 回「**已儲存，稍後由排程自動生效**」（不謊稱已生效，也**不**回
     純失敗——因為事實上綁定已存在且終將生效，回純失敗會與後續實際收到 DM 矛盾）。

OAuth client（Google `OAuth2`、Discord token 交換）一律包成 helper，token 僅存在
於 callback 處理函式的區域變數，處理完即離開作用域，不寫入任何儲存。

> 信任邊界：`state` 由初始指令產生、僅以 ephemeral 回覆給發起者，且單次使用 +
> `OAUTH_STATE_TTL_MS` 短時效（作為 CSRF / replay 保護）。Discord 路徑另以
> `/users/@me` 強制核對授權者身分 = state 內 `discordUserId`。
>
> **Google 路徑的收件人信任模型（明確接受的設計決定）**：Google 回應不含 Discord
> 身分，無法在伺服器端證明「完成授權者 = 收件人」。本設計**刻意接受 bearer-link
> 信任模型**：以 state 的單次使用 + 短 TTL + 僅 ephemeral 遞送給發起者作為收件人
> 綁定依據，不額外加 Discord 確認步驟。已知殘餘風險：若發起者於 TTL 內外洩自己的
> ephemeral 授權連結，他人可用自己的 Google 帳號完成授權，把其頻道綁到發起者的
> DM（後果為發起者收到非自選頻道的 DM 騷擾，可自行 `/youtube-dm unbind` 解除；
> 非資料外洩）。此為功能可用性與流程簡單性的取捨，已由產品決策接受。

## webhook process：`sendDiscordDm`

`src/commands/webhook.ts` 送出分派新增一支（置於既有兩支之間）：

```ts
if (checkIsDiscordWebhookUrl(url)) {
  /* 既有 */
} else if (checkIsDiscordDmUrl(url)) {
  await sendDiscordDm(
    url,
    data.fullDocument.authorChannelId,
    body,
    webhook,
    resultIdentifier
  );
} else {
  /* 既有 sendWebhook */
}
```

- `checkIsDiscordDmUrl(url)`：判斷 `discord-dm://` scheme（與既有
  `checkIsDiscordWebhookUrl` 同風格，置於 `src/data/webhook.ts`）。
- 既有「embed footer `fixLongText`」分支條件擴成
  `checkIsDiscordWebhookUrl(url) || checkIsDiscordDmUrl(url)` 都套用。

`sendDiscordDm(url, authorChannelId, body, webhook, resultIdentifier)`
（`authorChannelId` 取自 `data.fullDocument.authorChannelId`，由 DM 分派處傳入）：

1. 從 `url` 解析出 `discordUserId`（`discord-dm://<id>`，以字串前綴移除取得）。
2. **投遞時 consent 檢查（fail-closed，關閉 unbind 視窗）**：直接讀
   `YoutubeDmBinding.findOne({ discordUserId })`（**不經 app 層快取**，使用
   `readPreference: "primary"` 避免複本延遲；DM 事件量低，每事件多一次 indexed
   讀取可接受）。若綁定不存在、或 `authorChannelId` 不在 `binding.channelIds`
   內 → **直接 return、不送 DM**（`documentLog` 記一筆 consent-skip）。此檢查使
   「使用者已 unbind 但 stale webhook 因 transform 罕見失敗尚未移除」期間的事件
   一律不投遞，與 sweep 何時收斂無關。
3. 取投遞 payload `{ content: body.content, embeds: body.embeds }`。
4. 用 bot token REST（`runWebhook` 啟動時 `discordRest.setToken(DISCORD_TOKEN)`）：
   - DM channel id 以既有 `cache` 快取，key `dm-channel-<discordUserId>`；未命中時
     `Routes.userChannels()` + body `{ recipient_id }` + `auth: true` 建立並快取
     回應 `id`。
   - `Routes.channelMessages(dmChannelId)` + body `{ content, embeds }` +
     `auth: true` 發送。
5. 記錄 `WebhookResult`（成功寫 method/url/body/response/statusCode 200；失敗寫
   statusCode/error），與 `sendDiscordWebhook` 一致；走既有 `claimWebhookResult`
   冪等層。
6. 錯誤策略（投遞失敗視為該事件終結、綁定保持啟用）：
   - `403`（DM 關閉 / 封鎖 / 無共同伺服器）、`404`：記錄 error、**不 throw** →
     bee-queue 視為完成、不重試；綁定保留，使用者重開 DM 後自動恢復。
   - 已快取的 DM channel 發送遇 `404`（channel 失效）：清 `dm-channel-<id>` 快取後
     重建一次再發；仍失敗則依上述終結。
   - `5xx` / 其他暫時性：**throw** → worker handler rethrow → bee-queue 重試。
     `429` 由 @discordjs/rest 內部自動退避，通常不會浮現。

webhook process 不加 gateway `Client`，沿用 REST-only（與既有發 Discord webhook
同源）。

## webhook-prepare 相容性（`discord-dm://` scheme）

`src/components/webhook-prepare.ts`（manager 每 1 小時）會對**每個 enabled
webhook** 做 `axiosInstance.get(webhook.insertUrl)` 的可達性探測；連續失敗累積到
`failedAttempts >= 24` 會將 `enabled` 設為 `false`。`discord-dm://<userId>` 不是
HTTP URL，若不特殊處理，探測必然丟例外 → 約 24 小時後 DM 訂閱被自動停用。

處理方式：在迴圈本體開頭，對 `checkIsDiscordDmUrl(webhook.insertUrl)` 為真者直接
`continue`，**整個 iteration 跳過**——不執行 `axios.get`、不動 `failedAttempts` /
`enabled`、不更新 `lastChecked` / `lastSuccess`、不 `save`（既然沒做任何檢查，就不
更新檢查時間戳）。DM 的實際可投遞性改由**每事件**的 `WebhookResult`
（`sendDiscordDm` 的 403/404/5xx 記錄）反映，而非 URL 探測。DM webhook 不設
`matchPreset`，本來就無需 matchPreset 準備。

## 設定（`src/constants.ts`）

新增 env（命名與既有風格一致；時間常數以 `_MS` 命名、毫秒、配 Redis `SET PX`）：

- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`
- `DISCORD_OAUTH_CLIENT_ID` / `DISCORD_OAUTH_CLIENT_SECRET`（Discord application
  id / secret）
- `OAUTH_PUBLIC_BASE_URL`（對外可達 base，redirect_uri 由此組出）
- `OAUTH_STATE_TTL_MS`（預設 `600_000`：10 分鐘，足夠完成一次瀏覽器授權往返，過期
  即失效以限制重放窗口）
- `YOUTUBE_DM_MAX_CHANNELS_PER_USER`（預設 `10`：限制單一使用者綁定數，避免單份
  Webhook 的 `$in` 過大與濫用）
- `DISCORD_TOKEN` 已存在；webhook process 需可讀取此 env。

## Application 組合與關閉順序

- discord-bot：`app.use(MongodbModule)` → `app.use(RedisModule)` →
  `app.use(discord-bot service)`；在 `app.init()` 前以 `app.http.server` 註冊兩個
  OAuth 路由。LIFO 關閉下 discord-bot service 先關、Redis 與 Mongo 後關（消費者
  在其依賴的連線之前關閉）。
- manager：新增 `youtubeDmOperator(app)`（需 `AgendaModule`，與 `trackOperator`
  同位置註冊）。
- webhook：`runWebhook` 啟動時 `discordRest.setToken(DISCORD_TOKEN)`；無新增
  module。

## k8s 變更

- `k8s/base/discord-bot.yaml`：新增 `Service: honeybee-discord-bot`（port 3000 →
  `http-port`，selector `app: discord-bot`），照 `honeybee-crawler` 樣板；補上
  `GOOGLE_OAUTH_*`、`DISCORD_OAUTH_*`、`OAUTH_PUBLIC_BASE_URL`、`REDIS_URL`（若尚未
  注入）等 env。
- `k8s/base/ingress.yaml`：新增 path rule
  `path: /oauth/`、`pathType: Prefix`、backend `honeybee-discord-bot:http-port`
  （與既有 `/notifications/` → `honeybee-crawler` 並列）。`OAUTH_PUBLIC_BASE_URL`
  即此 ingress 對外 host。
- `k8s/base/webhook.yaml`：補 `DISCORD_TOKEN` env（發 DM 用）。

## 邊界與失敗情境

- DM 送不出（403/404）：視為該事件終結，綁定保留（見上）。
- 使用者解除所有綁定：`channelIds` 清空 → transform 刪除其 Webhook → meta-stream
  移出監視；即使 webhook 暫存，投遞時 consent 檢查也不會再送 DM。
- 同一頻道被不同使用者綁定：允許（頻道僅作所有權驗證，非全域唯一）；各自收到 DM。
- OAuth `state` 過期 / 不存在 / 重複使用：callback 回錯誤頁、不建立綁定。
- Discord 授權者身分不符 state（`/users/@me` id ≠ `discordUserId`）：拒絕、不綁定。
- channel metadata 未即時齊全：`/list` 退回顯示 `name`（可能為 seed 值或 "Unknown
  channel"），embed 依既有 `getChannel` join 行為，後續 crawl 補齊。
- 綁定上限：`bindChannels` 前以 `現有 + 新增 > 上限` 判斷整批拒絕。屬軟性濫用
  防線，不以交易強制；同一使用者 OAuth 序列進行，偶發競爭即使略超量亦無功能危害。
- 部分失敗（不使用交易的已接受取捨）：transform 為更新後的同步 await，正常即時
  生效；若 transform 拋例外，指令 / callback 回報失敗、不宣稱成功，source 與
  webhook 的暫時不一致由 1 小時 sweep（+ 孤兒清理）收斂。**consent 不靠 sweep
  時效**：投遞時 consent 檢查確保已 unbind 的頻道事件一律不送 DM，無 opt-out 後仍
  收到通知的視窗（stale webhook 僅造成無謂的事件匹配，sweep 後消失）。

## 測試重點

- `YoutubeDmBinding` statics：`$addToSet` 去重、`$pull`、清空（stateful fake，
  `$addToSet` 後 `find` 可觀察去重結果）。
- **綁定上限（軟性）**：`現有 + 新增 > 上限` 的批次被拒、不寫入；上限內正常綁定。
- **transform 失敗 → 即時回報**：transform 拋例外時，指令 / callback 回報失敗、
  不宣稱成功（source 可能已異動，由 sweep 收斂——這是已接受的設計取捨）。
- `transformYoutubeDmBinding`：channelIds 非空 → upsert 出正確 `colls` / `match`
  形狀（含單一 vs 多頻道的 filter 差異）/ `insertUrl` / Ref；channelIds 空 →
  刪除。
- **孤兒清理 discriminator 回歸測試**：sweep 後，**無 `youtubeDmBinding` 欄位的
  track / 一般 webhook 必須存活**（驗證 `$type: "objectId"` 不誤刪 missing-field
  文件）；指向已刪除綁定的 DM webhook 被移除（stateful fake）。
- `getChannelIdFilter` 改為吃 `string[]` 後，track.ts 既有行為不變（單/多/反向）。
- `checkIsDiscordDmUrl`：scheme 判斷正負例。
- **webhook-prepare 跳過 `discord-dm://`**：DM webhook 完全不被觸碰——無
  `axios.get`，`failedAttempts` / `enabled` / `lastChecked` / `lastSuccess` 皆不變、
  不 `save`；HTTP webhook 的既有探測行為不變。
- **投遞時 consent 檢查**：綁定不存在 / `authorChannelId` 不在 `channelIds` →
  `sendDiscordDm` 直接 return、**不建 DM channel、不發訊息**（stateful fake REST
  斷言零呼叫）；綁定含該頻道 → 正常發送。模擬「webhook 仍在但綁定已移除該頻道」→
  不送 DM。
- `sendDiscordDm`：stateful fake REST（建 DM channel → 回 id → 快取；發訊息）；
  403/404 終結（不 throw、寫 error）vs 5xx throw；快取 DM channel 遇 404 清快取重建。
- OAuth callback：`state` 驗證 / 過期 / 單次使用（重放被拒）；Discord 授權者 id 與
  state 不符時拒絕；Discord connections 過濾 `verified === true`；Google 多頻道一次
  全綁；token 不被寫入任何儲存（驗證後即離開作用域）。

## 計畫階段待確認（不臆測）

- `HttpServerModule` 註冊自訂 Fastify 路由的確切 API（`app.http.server` 的型別與
  在 `app.init()` 前註冊的時機），讀 `src/modules/http-server.ts` 確認。
- `getChannelIdFilter` 匯出後對 `track.ts` 既有呼叫端的最小變更。
- discord-bot 取得 `RedisModule` 連線的注入方式（與 webhook 等服務一致）。
- Google / Discord token 交換的確切呼叫：Google 走 `googleapis` 的
  `google.auth.OAuth2`，Discord 走 `POST /api/oauth2/token`；plan 階段以
  research subagent 對照實際安裝版本確認簽名。
