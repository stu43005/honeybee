# YouTube DM 綁定確認 + OAuth 物件導向模組化 + 指令可見性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 OAuth 流程重構成 `src/modules/oauth/` 下的物件導向設計（`OAuthModule` + `GoogleProvider` + `DiscordProvider` + `OAuthStateStore`），在 callback 綁定完成後即時送出確認 DM，並把 `/youtube-dm` 的 `list`/`unbind` 改為非 ephemeral。

**Architecture:** OAuth 內部檔案整批 `git mv` 到 `src/modules/oauth/`（兩處同為 `src/` 深度 2，`../../` 匯入不變）；state 全域改為 `OAuthStateStore` 實例；兩個 provider 改成 class（各自封裝 authUrl / token 交換 / channel 取得）；`OAuthModule(app, client)` 在建構子解析 redis、建好 state store 與 provider、註冊路由，callback 編排與確認 DM 都是它的方法，**用 `this` 取得依賴、不傳 `deps` 物件**。state 沿用原版「讀後即刪」單次使用，罕見邊界刻意不補強。

**Tech Stack:** TypeScript (ESM, NodeNext)、discord.js 14.26.4、Fastify、node-redis v4、Typegoose/Mongoose、Jest (ts-jest ESM)。

設計依據：[docs/superpowers/specs/2026-06-28-youtube-dm-bind-confirmation-dm-design.md](../specs/2026-06-28-youtube-dm-bind-confirmation-dm-design.md)。

執行慣例：

- 測試：`npm run test -- <path>`（可加 `-t "<name>"` 過濾）。型別：`npm run build`。Lint：`npm run lint`。
- ESM：source 匯入帶 `.js` 副檔名。未使用參數以 `_` 前綴（符合既有 ESLint）。
- commit 用具體檔案路徑 `git add`，不用 `-A`。

---

## File Structure

最終 `src/modules/oauth/`（無 index.ts，具名 import）：

- `state-store.ts` — `OAuthStateStore` class + `randomState()` + 型別 `OAuthMethod`/`OAuthState`。
- `provider.ts` — `OAuthChannel` 型別、`OAuthProvider` 介面、`IdentityMismatchError`。
- `google.ts` — `GoogleProvider`（封裝 authUrl / getToken / youtube.channels.list）。
- `discord.ts` — `DiscordProvider`（封裝 authUrl / token 交換 / 身分核對 / verified connections）。
- `oauth.ts` — `OAuthModule`（建構子收 `app`+`client`；route handler、`applyBinding`、`beginAuth`、`sendBindingDm` 皆為方法）。
- 各檔對應 `*.spec.ts`。

其他：

- `src/models/Channel.ts` — 新增 static `renderBoundChannelLines`（`/list` 與確認 DM 共用）。
- 修改：`src/discord/commands/youtube-dm/youtube-dm.ts`、`src/commands/discord-bot.ts`、`src/discord/commands/registration.spec.ts`。
- 刪除：`src/modules/oauth/callback.ts`（編排折入 OAuthModule）、`src/discord/commands/index.ts`。

策略：採 strangler——先整批搬移、再逐檔轉 OO，provider 暫留薄相容函式讓舊 `callback.ts` 與 `youtube-dm.ts` 維持可編譯，最後一次性刪除舊 `callback.ts` 與相容函式。

---

## Task 1: 把 `src/discord/oauth/` 整批搬到 `src/modules/oauth/`

純搬移：兩處同為 `src/` 深度 2，檔案內 `../../constants.js`、`../../models/...` 與同目錄 `./google.js` 等相對匯入**全部不變**；只需修外部匯入端。

**Files:**

- Move: `src/discord/oauth/{state,callback,google,discord}.ts` 及對應 `*.spec.ts` → `src/modules/oauth/`
- Modify: `src/commands/discord-bot.ts`、`src/discord/commands/youtube-dm/youtube-dm.ts`（匯入路徑）

- [ ] **Step 1: 用 git mv 搬移 8 個檔案**

```bash
mkdir -p src/modules/oauth
git mv src/discord/oauth/state.ts         src/modules/oauth/state.ts
git mv src/discord/oauth/state.spec.ts    src/modules/oauth/state.spec.ts
git mv src/discord/oauth/callback.ts      src/modules/oauth/callback.ts
git mv src/discord/oauth/callback.spec.ts src/modules/oauth/callback.spec.ts
git mv src/discord/oauth/google.ts        src/modules/oauth/google.ts
git mv src/discord/oauth/google.spec.ts   src/modules/oauth/google.spec.ts
git mv src/discord/oauth/discord.ts       src/modules/oauth/discord.ts
git mv src/discord/oauth/discord.spec.ts  src/modules/oauth/discord.spec.ts
```

- [ ] **Step 2: 修 `discord-bot.ts` 的兩條匯入路徑**

`src/commands/discord-bot.ts` 把 `../discord/oauth/callback.js` 與 `../discord/oauth/state.js` 改為 `../modules/oauth/callback.js` 與 `../modules/oauth/state.js`。

- [ ] **Step 3: 修 `youtube-dm.ts` 的三條匯入路徑**

`src/discord/commands/youtube-dm/youtube-dm.ts` 把 `../../oauth/discord.js`、`../../oauth/google.js`、`../../oauth/state.js` 三條改為 `../../../modules/oauth/discord.js`、`../../../modules/oauth/google.js`、`../../../modules/oauth/state.js`。

- [ ] **Step 4: 型別檢查 + 全測試（純搬移，行為不變）**

Run: `npm run build && npm run test -- src/modules/oauth`
Expected: build 無錯；既有 `state/callback/google/discord` 測試全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/modules/oauth src/commands/discord-bot.ts src/discord/commands/youtube-dm/youtube-dm.ts
git commit -m "refactor(oauth): relocate src/discord/oauth to src/modules/oauth"
```

---

## Task 2: state 全域 → `OAuthStateStore` class（保留暫時相容包裝）

**Files:**

- Move: `src/modules/oauth/state.ts` → `state-store.ts`（含 spec）
- Modify: `src/modules/oauth/callback.ts`、`src/commands/discord-bot.ts`、`src/discord/commands/youtube-dm/youtube-dm.ts`（匯入來源檔名）

- [ ] **Step 1: 改檔名**

```bash
git mv src/modules/oauth/state.ts      src/modules/oauth/state-store.ts
git mv src/modules/oauth/state.spec.ts src/modules/oauth/state-store.spec.ts
```

- [ ] **Step 2: 覆寫 `state-store.spec.ts`（測 class + 相容函式）**

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  OAuthStateStore,
  delOAuthState,
  getOAuthState,
  initOAuthStateStore,
  putOAuthState,
  randomState,
} from "./state-store.js";

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve("OK" as const);
    }),
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    del: jest.fn((k: string) => Promise.resolve(store.delete(k) ? 1 : 0)),
  };
}

describe("OAuthStateStore", () => {
  afterEach(() => jest.restoreAllMocks());

  it("put/get round-trips the payload and uses PX", async () => {
    const redis = fakeRedis();
    const store = new OAuthStateStore(redis as any);
    await store.put("st1", { discordUserId: "d1", method: "google" });
    expect(redis.set).toHaveBeenCalledWith(
      "youtube-dm-oauth:st1",
      JSON.stringify({ discordUserId: "d1", method: "google" }),
      expect.objectContaining({ PX: expect.any(Number) })
    );
    expect(await store.get("st1")).toEqual({
      discordUserId: "d1",
      method: "google",
    });
  });

  it("get returns null for a missing state", async () => {
    expect(
      await new OAuthStateStore(fakeRedis() as any).get("nope")
    ).toBeNull();
  });

  it("del removes the state", async () => {
    const store = new OAuthStateStore(fakeRedis() as any);
    await store.put("st2", { discordUserId: "d1", method: "discord" });
    await store.del("st2");
    expect(await store.get("st2")).toBeNull();
  });

  it("randomState returns a long hex string", () => {
    expect(randomState()).toMatch(/^[0-9a-f]{32,}$/);
  });

  it("legacy module functions delegate to the initialised default instance", async () => {
    const redis = fakeRedis();
    initOAuthStateStore(redis as any);
    await putOAuthState("st3", { discordUserId: "d9", method: "google" });
    expect(await getOAuthState("st3")).toEqual({
      discordUserId: "d9",
      method: "google",
    });
    await delOAuthState("st3");
    expect(await getOAuthState("st3")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- src/modules/oauth/state-store.spec.ts`
Expected: FAIL（`OAuthStateStore` 未匯出）。

- [ ] **Step 4: 覆寫 `state-store.ts`**

```ts
import { randomBytes } from "node:crypto";
import type { RedisClientType } from "redis";
import { OAUTH_STATE_TTL_MS } from "../../constants.js";

export type OAuthMethod = "google" | "discord";
export interface OAuthState {
  discordUserId: string;
  method: OAuthMethod;
}

function key(state: string): string {
  return `youtube-dm-oauth:${state}`;
}

export function randomState(): string {
  return randomBytes(32).toString("hex");
}

export class OAuthStateStore {
  constructor(private readonly redis: RedisClientType) {}

  async put(state: string, data: OAuthState): Promise<void> {
    await this.redis.set(key(state), JSON.stringify(data), {
      PX: OAUTH_STATE_TTL_MS,
    });
  }

  async get(state: string): Promise<OAuthState | null> {
    const raw = await this.redis.get(key(state));
    return raw ? (JSON.parse(raw) as OAuthState) : null;
  }

  async del(state: string): Promise<void> {
    await this.redis.del(key(state));
  }
}

// TEMP back-compat shims so existing consumers compile during the migration;
// removed in the cleanup task once OAuthModule owns the instance.
let _default: OAuthStateStore | null = null;
export function initOAuthStateStore(redis: RedisClientType): void {
  _default = new OAuthStateStore(redis);
}
function def(): OAuthStateStore {
  if (!_default) throw new Error("OAuth state store not initialized");
  return _default;
}
export const putOAuthState = (state: string, data: OAuthState) =>
  def().put(state, data);
export const getOAuthState = (state: string) => def().get(state);
export const delOAuthState = (state: string) => def().del(state);
```

- [ ] **Step 5: 修匯入檔名 `state.js` → `state-store.js`（3 處）**

- `src/modules/oauth/callback.ts`：`from "./state.js"` → `from "./state-store.js"`
- `src/commands/discord-bot.ts`：`from "../modules/oauth/state.js"` → `from "../modules/oauth/state-store.js"`
- `src/discord/commands/youtube-dm/youtube-dm.ts`：`from "../../../modules/oauth/state.js"` → `from "../../../modules/oauth/state-store.js"`

- [ ] **Step 6: Run tests + build**

Run: `npm run test -- src/modules/oauth/state-store.spec.ts && npm run build`
Expected: PASS；build 無錯。

- [ ] **Step 7: Commit**

```bash
git add src/modules/oauth/state-store.ts src/modules/oauth/state-store.spec.ts src/modules/oauth/callback.ts src/commands/discord-bot.ts src/discord/commands/youtube-dm/youtube-dm.ts
git commit -m "refactor(oauth): introduce OAuthStateStore class (legacy shims kept)"
```

---

## Task 3: `Channel.renderBoundChannelLines` static（Channel model 內）

把渲染放進 `Channel` model 作為 static，沿用既有 `findByChannelId` static 風格（`this: ReturnModelType<typeof Channel>`）。`/list` 與確認 DM 都呼叫 `ChannelModel.renderBoundChannelLines(...)`。

**Files:**

- Modify: `src/models/Channel.ts`
- Test: `src/models/Channel.spec.ts`

- [ ] **Step 1: Write the failing test**

在 `src/models/Channel.spec.ts` 既有 `describe` 內（或檔尾新增一個 `describe`）加入：

```ts
describe("renderBoundChannelLines", () => {
  afterEach(() => jest.restoreAllMocks());

  it("joins channel name + id in input order, falling back to Unknown channel", async () => {
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation((id: string) =>
        Promise.resolve(
          id === "UCa" ? ({ name: "Chan A" } as any) : (null as any)
        )
      );
    expect(await ChannelModel.renderBoundChannelLines(["UCa", "UCb"])).toEqual([
      "• Chan A (UCa)",
      "• Unknown channel (UCb)",
    ]);
  });

  it("returns an empty array for no channels", async () => {
    expect(await ChannelModel.renderBoundChannelLines([])).toEqual([]);
  });
});
```

確認 `Channel.spec.ts` 頂部已有 `import { afterEach, describe, expect, it, jest } from "@jest/globals";` 與 `import ChannelModel from "./Channel.js";`（若缺則補上對應 import）。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/models/Channel.spec.ts -t renderBoundChannelLines`
Expected: FAIL（`renderBoundChannelLines` 不是 ChannelModel 的方法）。

- [ ] **Step 3: Write the implementation**

在 `src/models/Channel.ts` 的 `Channel` class 內、`findByChannelId` static 之後加入：

```ts
  /**
   * Renders one display line per channel id, joining the channel name (falling
   * back to "Unknown channel" when not yet crawled), preserving input order.
   * Shared by `/youtube-dm list` and the binding-confirmation DM.
   */
  public static async renderBoundChannelLines(
    this: ReturnModelType<typeof Channel>,
    channelIds: string[]
  ): Promise<string[]> {
    return Promise.all(
      channelIds.map(async (id) => {
        const channel = await this.findByChannelId(id);
        return `• ${channel?.name ?? "Unknown channel"} (${id})`;
      })
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/models/Channel.spec.ts -t renderBoundChannelLines`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/models/Channel.ts src/models/Channel.spec.ts
git commit -m "feat(channel): add renderBoundChannelLines static for display lines"
```

---

## Task 4: `provider.ts` 介面 + `GoogleProvider` class

把 `google.ts` 改成 `GoogleProvider`；新增 `provider.ts`（`OAuthChannel` / `OAuthProvider` / `IdentityMismatchError`）。暫留 `buildGoogleAuthUrl` / `fetchGoogleChannels` 薄相容函式（委派預設實例），讓 `callback.ts` / `youtube-dm.ts` 維持可編譯，Task 9 移除。

**Files:**

- Create: `src/modules/oauth/provider.ts`
- Modify: `src/modules/oauth/google.ts`（→ class + 相容函式）
- Test: `src/modules/oauth/google.spec.ts`（改測 class）

- [ ] **Step 1: 建 `provider.ts`**

```ts
import type { OAuthMethod, OAuthState } from "./state-store.js";

export interface OAuthChannel {
  channelId: string;
  title: string;
}

export interface OAuthProvider {
  readonly method: OAuthMethod;
  /** User-facing message shown when listChannels returns no bindable channels. */
  readonly emptyMessage: string;
  buildAuthUrl(state: string): string;
  /** Exchanges the code and returns the channels to bind. */
  listChannels(code: string, state: OAuthState): Promise<OAuthChannel[]>;
}

/** Thrown by a provider when the authorizer's identity != the state's user. */
export class IdentityMismatchError extends Error {}
```

- [ ] **Step 2: 覆寫 `google.spec.ts`（測 GoogleProvider）**

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { GoogleProvider } from "./google.js";

describe("GoogleProvider", () => {
  afterEach(() => jest.restoreAllMocks());

  it("buildAuthUrl includes scope, state, access_type and redirect", () => {
    const u = new URL(new GoogleProvider().buildAuthUrl("st1"));
    expect(u.hostname).toContain("google.com");
    expect(u.searchParams.get("state")).toBe("st1");
    expect(u.searchParams.get("access_type")).toBe("online");
    expect(u.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.readonly"
    );
    expect(decodeURIComponent(u.toString())).toContain(
      "/oauth/youtube-dm/google/callback"
    );
  });

  it("listChannels maps every owned channel, dropping items without an id", async () => {
    const provider = new GoogleProvider();
    jest
      .spyOn(provider, "listOwnedChannels")
      .mockResolvedValue([
        { id: "UCa", snippet: { title: "Chan A" } },
        { snippet: { title: "no id" } },
        { id: "UCb", snippet: {} },
      ] as any);

    expect(
      await provider.listChannels("code-1", {
        discordUserId: "d1",
        method: "google",
      })
    ).toEqual([
      { channelId: "UCa", title: "Chan A" },
      { channelId: "UCb", title: "Unknown channel" },
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- src/modules/oauth/google.spec.ts`
Expected: FAIL（`GoogleProvider` 未匯出）。

- [ ] **Step 4: 覆寫 `google.ts`**

```ts
import { google as googleapis, type youtube_v3 } from "googleapis";
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  PUBLIC_BASE_URL,
} from "../../constants.js";
import type { OAuthChannel, OAuthProvider } from "./provider.js";
import type { OAuthState } from "./state-store.js";

const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];

export class GoogleProvider implements OAuthProvider {
  readonly method = "google" as const;
  readonly emptyMessage = "找不到可綁定的 YouTube 頻道。";

  private redirectUri(): string {
    return `${PUBLIC_BASE_URL}/oauth/youtube-dm/google/callback`;
  }

  private oauthClient() {
    return new googleapis.auth.OAuth2({
      clientId: GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: this.redirectUri(),
    });
  }

  buildAuthUrl(state: string): string {
    return this.oauthClient().generateAuthUrl({
      access_type: "online",
      scope: SCOPES,
      state,
    });
  }

  // Page through all owned channels (mine: true). Exposed so tests can stub the
  // googleapis round-trip without hitting the network.
  async listOwnedChannels(code: string): Promise<youtube_v3.Schema$Channel[]> {
    const client = this.oauthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const youtube = googleapis.youtube({ version: "v3", auth: client });
    const items: youtube_v3.Schema$Channel[] = [];
    let pageToken: string | undefined;
    do {
      const res = await youtube.channels.list({
        mine: true,
        part: ["snippet"],
        maxResults: 50,
        pageToken,
      });
      items.push(...(res.data.items ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return items;
  }

  async listChannels(
    code: string,
    _state: OAuthState
  ): Promise<OAuthChannel[]> {
    const items = await this.listOwnedChannels(code);
    return items
      .filter((i) => !!i.id)
      .map((i) => ({
        channelId: i.id as string,
        title: i.snippet?.title ?? "Unknown channel",
      }));
  }
}

// TEMP back-compat (removed in cleanup task) so callback.ts / youtube-dm.ts
// compile until they migrate to OAuthModule.
const _google = new GoogleProvider();
export const buildGoogleAuthUrl = (state: string) =>
  _google.buildAuthUrl(state);
export const fetchGoogleChannels = (code: string) =>
  _google.listChannels(code, { discordUserId: "", method: "google" });
```

- [ ] **Step 5: Run test + build**

Run: `npm run test -- src/modules/oauth/google.spec.ts && npm run build`
Expected: PASS；build 無錯（相容函式讓 `callback.ts` / `youtube-dm.ts` 仍編譯）。

- [ ] **Step 6: Commit**

```bash
git add src/modules/oauth/provider.ts src/modules/oauth/google.ts src/modules/oauth/google.spec.ts
git commit -m "refactor(oauth): convert google helper into GoogleProvider class"
```

---

## Task 5: `DiscordProvider` class

把 `discord.ts` 改成 `DiscordProvider`，`listChannels` 內做身分核對（不符丟 `IdentityMismatchError`）。暫留 `buildDiscordAuthUrl` / `exchangeDiscordCode` / `fetchDiscordUserId` / `fetchVerifiedYoutubeChannels` 相容函式，Task 9 移除。

**Files:**

- Modify: `src/modules/oauth/discord.ts`（→ class + 相容函式）
- Test: `src/modules/oauth/discord.spec.ts`（改測 class）

- [ ] **Step 1: 覆寫 `discord.spec.ts`**

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import axios from "axios";
import { DiscordProvider } from "./discord.js";
import { IdentityMismatchError } from "./provider.js";

describe("DiscordProvider", () => {
  afterEach(() => jest.restoreAllMocks());

  it("buildAuthUrl includes scope, state and redirect", () => {
    const u = new URL(new DiscordProvider().buildAuthUrl("st1"));
    expect(u.hostname).toBe("discord.com");
    expect(u.searchParams.get("state")).toBe("st1");
    expect(u.searchParams.get("scope")).toBe("identify connections");
    expect(u.searchParams.get("redirect_uri")).toContain(
      "/oauth/youtube-dm/discord/callback"
    );
  });

  it("listChannels returns verified youtube connections when identity matches", async () => {
    const provider = new DiscordProvider();
    jest
      .spyOn(axios, "post")
      .mockResolvedValue({ data: { access_token: "tok-1" } } as any);
    jest
      .spyOn(axios, "get")
      .mockResolvedValueOnce({ data: { id: "d1" } } as any)
      .mockResolvedValueOnce({
        data: [
          { type: "youtube", id: "UCa", name: "Chan A", verified: true },
          { type: "youtube", id: "UCb", name: "Chan B", verified: false },
          { type: "twitch", id: "tw1", name: "T", verified: true },
        ],
      } as any);

    expect(
      await provider.listChannels("code-1", {
        discordUserId: "d1",
        method: "discord",
      })
    ).toEqual([{ channelId: "UCa", title: "Chan A" }]);
  });

  it("listChannels throws IdentityMismatchError when authorizer != state user", async () => {
    const provider = new DiscordProvider();
    jest
      .spyOn(axios, "post")
      .mockResolvedValue({ data: { access_token: "tok-1" } } as any);
    jest
      .spyOn(axios, "get")
      .mockResolvedValue({ data: { id: "OTHER" } } as any);

    await expect(
      provider.listChannels("code-1", {
        discordUserId: "d1",
        method: "discord",
      })
    ).rejects.toBeInstanceOf(IdentityMismatchError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/modules/oauth/discord.spec.ts`
Expected: FAIL（`DiscordProvider` 未匯出）。

- [ ] **Step 3: 覆寫 `discord.ts`**

```ts
import axios from "axios";
import {
  DISCORD_OAUTH_CLIENT_ID,
  DISCORD_OAUTH_CLIENT_SECRET,
  PUBLIC_BASE_URL,
} from "../../constants.js";
import {
  IdentityMismatchError,
  type OAuthChannel,
  type OAuthProvider,
} from "./provider.js";
import type { OAuthState } from "./state-store.js";

const API = "https://discord.com/api";

export class DiscordProvider implements OAuthProvider {
  readonly method = "discord" as const;
  readonly emptyMessage = "你的 Discord 沒有已驗證的 YouTube 連結。";

  private redirectUri(): string {
    return `${PUBLIC_BASE_URL}/oauth/youtube-dm/discord/callback`;
  }

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: DISCORD_OAUTH_CLIENT_ID ?? "",
      response_type: "code",
      scope: "identify connections",
      redirect_uri: this.redirectUri(),
      state,
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: DISCORD_OAUTH_CLIENT_ID ?? "",
      client_secret: DISCORD_OAUTH_CLIENT_SECRET ?? "",
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
    });
    const res = await axios.post(`${API}/oauth2/token`, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return res.data.access_token as string;
  }

  async fetchUserId(accessToken: string): Promise<string> {
    const res = await axios.get(`${API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.data.id as string;
  }

  async fetchVerifiedChannels(accessToken: string): Promise<OAuthChannel[]> {
    const res = await axios.get(`${API}/users/@me/connections`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const connections = (res.data ?? []) as {
      type: string;
      id: string;
      name: string;
      verified: boolean;
    }[];
    return connections
      .filter((c) => c.type === "youtube" && c.verified)
      .map((c) => ({ channelId: c.id, title: c.name }));
  }

  async listChannels(code: string, state: OAuthState): Promise<OAuthChannel[]> {
    const token = await this.exchangeCode(code);
    const authorizerId = await this.fetchUserId(token);
    if (authorizerId !== state.discordUserId) {
      throw new IdentityMismatchError();
    }
    return this.fetchVerifiedChannels(token);
  }
}

// TEMP back-compat (removed in cleanup task).
const _discord = new DiscordProvider();
export const buildDiscordAuthUrl = (state: string) =>
  _discord.buildAuthUrl(state);
export const exchangeDiscordCode = (code: string) =>
  _discord.exchangeCode(code);
export const fetchDiscordUserId = (token: string) =>
  _discord.fetchUserId(token);
export const fetchVerifiedYoutubeChannels = (token: string) =>
  _discord.fetchVerifiedChannels(token);
```

- [ ] **Step 4: Run test + build**

Run: `npm run test -- src/modules/oauth/discord.spec.ts && npm run build`
Expected: PASS；build 無錯。

- [ ] **Step 5: Commit**

```bash
git add src/modules/oauth/discord.ts src/modules/oauth/discord.spec.ts
git commit -m "refactor(oauth): convert discord helper into DiscordProvider class"
```

---

## Task 6: `OAuthModule`（`src/modules/oauth/oauth.ts`）

建構子收 `app`+`client`：解析 redis 建 `stateStore`、建 `google`/`discord` provider、註冊兩條路由。route handler、`applyBinding`、`beginAuth`、`sendBindingDm` 都是方法，依賴一律 `this` 取得（無 `deps`）。

**Files:**

- Create: `src/modules/oauth/oauth.ts`
- Test: `src/modules/oauth/oauth.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/oauth/oauth.spec.ts`：

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import ChannelModel from "../../models/Channel.js";
import YoutubeDmBindingModel, {
  BindingLimitError,
} from "../../models/YoutubeDmBinding.js";
import { OAuthModule } from "./oauth.js";
import { IdentityMismatchError } from "./provider.js";

function fakeReply() {
  return {
    code: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as any;
}

function setup(opts: { redisSeed?: [string, string][] } = {}) {
  const store = new Map<string, string>(opts.redisSeed ?? []);
  const redis = {
    set: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve("OK" as const);
    }),
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    del: jest.fn((k: string) => Promise.resolve(store.delete(k) ? 1 : 0)),
  };
  const routes: Record<string, any> = {};
  const app = {
    http: { server: { get: jest.fn((p: string, h: any) => (routes[p] = h)) } },
    get: jest.fn((name: string) => (name === "redis" ? { redis } : undefined)),
  } as any;
  const send = jest.fn(() => Promise.resolve(undefined));
  const client = {
    users: { fetch: jest.fn(() => Promise.resolve({ send })) },
  } as any;
  return { app, client, redis, store, routes, send };
}

const GOOGLE = "/oauth/youtube-dm/google/callback";

describe("OAuthModule", () => {
  afterEach(() => jest.restoreAllMocks());

  it("registers both callback routes in the constructor", () => {
    const { app, client, routes } = setup();
    new OAuthModule(app, client);
    expect(Object.keys(routes).sort()).toEqual([
      "/oauth/youtube-dm/discord/callback",
      GOOGLE,
    ]);
  });

  it("throws in the constructor when RedisModule is missing", () => {
    const { client } = setup();
    const app = {
      http: { server: { get: jest.fn() } },
      get: jest.fn(() => undefined),
    } as any;
    expect(() => new OAuthModule(app, client)).toThrow(/RedisModule/);
  });

  it("beginAuth stores state and returns the provider auth url", async () => {
    const { app, client, redis } = setup();
    const mod = new OAuthModule(app, client);
    const url = await mod.beginAuth("google", "d1");
    const [key, value] = redis.set.mock.calls[0] as [string, string];
    expect(key).toMatch(/^youtube-dm-oauth:/);
    expect(JSON.parse(value)).toEqual({
      discordUserId: "d1",
      method: "google",
    });
    expect(url).toContain("accounts.google.com");
  });

  it("callback rejects when code is missing without consuming state", async () => {
    const { app, client, routes, redis } = setup();
    new OAuthModule(app, client);
    const reply = fakeReply();
    await routes[GOOGLE]({ query: { state: "st1" } }, reply);
    expect(redis.del).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(400);
  });

  it("google callback: success + DM delivered → 200 with full channel list", async () => {
    const { app, client, routes, redis } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "google" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest
      .spyOn(mod.google, "listChannels")
      .mockResolvedValue([{ channelId: "UCa", title: "A" }]);
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCold", "UCa"] } as any);
    const dm = jest.spyOn(mod, "sendBindingDm").mockResolvedValue(true);
    const reply = fakeReply();

    await routes[GOOGLE]({ query: { code: "c1", state: "st1" } }, reply);

    expect(redis.del).toHaveBeenCalledWith("youtube-dm-oauth:st1");
    expect(dm).toHaveBeenCalledWith("d1", ["UCold", "UCa"]);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.stringContaining("已私訊你頻道清單")
    );
  });

  it("google callback: DM undeliverable → 200 with open-DM hint", async () => {
    const { app, client, routes } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "google" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest
      .spyOn(mod.google, "listChannels")
      .mockResolvedValue([{ channelId: "UCa", title: "A" }]);
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    jest.spyOn(mod, "sendBindingDm").mockResolvedValue(false);
    const reply = fakeReply();

    await routes[GOOGLE]({ query: { code: "c1", state: "st1" } }, reply);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.stringContaining("無法私訊你")
    );
  });

  it("google callback: BindingLimitError → 400 and no DM", async () => {
    const { app, client, routes } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "google" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest
      .spyOn(mod.google, "listChannels")
      .mockResolvedValue([{ channelId: "UCa", title: "A" }]);
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockRejectedValue(new BindingLimitError("limit"));
    const dm = jest.spyOn(mod, "sendBindingDm");
    const reply = fakeReply();

    await routes[GOOGLE]({ query: { code: "c1", state: "st1" } }, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(dm).not.toHaveBeenCalled();
  });

  it("google callback: empty channel list → 400 with the provider message", async () => {
    const { app, client, routes } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "google" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest.spyOn(mod.google, "listChannels").mockResolvedValue([]);
    const reply = fakeReply();

    await routes[GOOGLE]({ query: { code: "c1", state: "st1" } }, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.stringContaining("找不到可綁定")
    );
  });

  it("discord callback: identity mismatch → 403", async () => {
    const { app, client, routes } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "discord" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest
      .spyOn(mod.discord, "listChannels")
      .mockRejectedValue(new IdentityMismatchError());
    const reply = fakeReply();

    await routes["/oauth/youtube-dm/discord/callback"](
      { query: { code: "c1", state: "st1" } },
      reply
    );

    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("sendBindingDm returns true on success, false (no warn) on 50007", async () => {
    const { app, client, send } = setup();
    const mod = new OAuthModule(app, client);
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(null as any);

    expect(await mod.sendBindingDm("d1", [])).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);

    send.mockRejectedValueOnce({ code: 50007 });
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    expect(await mod.sendBindingDm("d1", [])).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/modules/oauth/oauth.spec.ts`
Expected: FAIL（`oauth.js` 不存在）。

- [ ] **Step 3: Write `oauth.ts`**

```ts
import { DiscordAPIError, RESTJSONErrorCodes, type Client } from "discord.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import ChannelModel from "../../models/Channel.js";
import YoutubeDmBindingModel, {
  BindingLimitError,
  BindingTransformPendingError,
} from "../../models/YoutubeDmBinding.js";
import type { Application } from "../application.js";
import type { Module } from "../module.js";
import { RedisModule } from "../redis.js";
import { DiscordProvider } from "./discord.js";
import { GoogleProvider } from "./google.js";
import {
  IdentityMismatchError,
  type OAuthChannel,
  type OAuthProvider,
} from "./provider.js";
import {
  OAuthStateStore,
  randomState,
  type OAuthMethod,
} from "./state-store.js";

type Query = { code?: string; state?: string };

function page(reply: FastifyReply, status: number, message: string) {
  reply
    .code(status)
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><meta charset="utf-8"><body>${message}</body>`);
}

export class OAuthModule implements Module {
  public readonly name = "oauth";
  public readonly google = new GoogleProvider();
  public readonly discord = new DiscordProvider();
  private readonly stateStore: OAuthStateStore;

  constructor(
    private readonly app: Application,
    private readonly client: Client
  ) {
    // Resolve redis and build the state store BEFORE registering routes (no
    // startup race). RedisModule is app.use'd before this module.
    const redisModule = this.app.get<RedisModule>("redis");
    if (!redisModule) {
      throw new Error(
        "OAuthModule: RedisModule must be registered before OAuthModule"
      );
    }
    this.stateStore = new OAuthStateStore(redisModule.redis);

    // Routes must register before HttpServerModule.init() calls listen().
    const server = this.app.http.server;
    server.get("/oauth/youtube-dm/google/callback", (req, reply) =>
      this.handleCallback(
        this.google,
        req as FastifyRequest<{ Querystring: Query }>,
        reply
      )
    );
    server.get("/oauth/youtube-dm/discord/callback", (req, reply) =>
      this.handleCallback(
        this.discord,
        req as FastifyRequest<{ Querystring: Query }>,
        reply
      )
    );
  }

  async beginAuth(method: OAuthMethod, discordUserId: string): Promise<string> {
    const provider = method === "google" ? this.google : this.discord;
    const state = randomState();
    await this.stateStore.put(state, { discordUserId, method });
    return provider.buildAuthUrl(state);
  }

  private async handleCallback(
    provider: OAuthProvider,
    request: FastifyRequest<{ Querystring: Query }>,
    reply: FastifyReply
  ): Promise<void> {
    const { code, state } = request.query;
    if (!code || !state) {
      page(reply, 400, "缺少授權參數。");
      return;
    }
    const data = await this.stateStore.get(state);
    if (!data || data.method !== provider.method) {
      page(reply, 400, "授權連結已失效或不正確，請重新發起。");
      return;
    }
    // Single-use: read-then-delete (base design). On any later failure the user
    // simply re-runs /youtube-dm bind for a fresh state.
    await this.stateStore.del(state);
    try {
      const channels = await provider.listChannels(code, data);
      if (channels.length === 0) {
        page(reply, 400, provider.emptyMessage);
        return;
      }
      await this.applyBinding(data.discordUserId, channels, reply);
    } catch (error) {
      if (error instanceof IdentityMismatchError) {
        page(reply, 403, "授權者身分與發起者不符，已拒絕綁定。");
        return;
      }
      page(reply, 500, "授權處理失敗，請重新發起。");
    }
  }

  private async applyBinding(
    discordUserId: string,
    channels: OAuthChannel[],
    reply: FastifyReply
  ): Promise<void> {
    for (const { channelId, title } of channels) {
      const existing = await ChannelModel.findByChannelId(channelId);
      if (!existing) {
        await ChannelModel.create({ id: channelId, name: title });
      }
    }

    let pending = false;
    try {
      await YoutubeDmBindingModel.bindChannels(
        discordUserId,
        channels.map((c) => c.channelId)
      );
    } catch (error) {
      if (error instanceof BindingLimitError) {
        page(reply, 400, "超過上限、未綁定。請先解除部分頻道後再試。");
        return;
      } else if (error instanceof BindingTransformPendingError) {
        pending = true;
      } else {
        page(reply, 500, "綁定處理失敗，請重新發起。");
        return;
      }
    }

    const binding = await YoutubeDmBindingModel.findOne({ discordUserId });
    const channelIds = binding?.channelIds ?? [];
    const delivered = await this.sendBindingDm(discordUserId, channelIds);

    if (pending) {
      page(
        reply,
        200,
        delivered
          ? "已儲存，稍後生效，已私訊你頻道清單，可關閉此頁。"
          : "已儲存，稍後生效；但目前無法私訊你，請開啟私訊權限，否則將收不到通知。"
      );
    } else {
      page(
        reply,
        200,
        delivered
          ? "綁定成功、已生效，已私訊你頻道清單，可關閉此頁。"
          : "綁定成功、已生效，但目前無法私訊你——請在 Discord 開啟「允許來自伺服器成員的私訊」後重新發起，否則將收不到通知。"
      );
    }
  }

  async sendBindingDm(
    discordUserId: string,
    channelIds: string[]
  ): Promise<boolean> {
    try {
      const lines = await ChannelModel.renderBoundChannelLines(channelIds);
      const content = `✅ 已完成 YouTube → Discord 私訊綁定。目前綁定的頻道：\n${lines.join(
        "\n"
      )}`;
      const user = await this.client.users.fetch(discordUserId);
      await user.send({ content });
      return true;
    } catch (error) {
      const code =
        error instanceof DiscordAPIError
          ? error.code
          : (error as { code?: unknown })?.code;
      if (code !== RESTJSONErrorCodes.CannotSendMessagesToThisUser) {
        console.warn(`[oauth] binding DM to ${discordUserId} failed:`, error);
      }
      return false;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- src/modules/oauth/oauth.spec.ts`
Expected: PASS。

> 註：`RESTJSONErrorCodes.CannotSendMessagesToThisUser` 即數值 `50007`（discord.js 既有列舉，`discord-bot.ts` 既有 `IGNORED_ERRORS` 已使用）。

- [ ] **Step 5: Commit**

```bash
git add src/modules/oauth/oauth.ts src/modules/oauth/oauth.spec.ts
git commit -m "feat(oauth): add Application-managed OAuthModule (OO callback + DM)"
```

---

## Task 7: `YoutubeDmCommand` 改建構子注入 + ephemeral→flags

**Files:**

- Modify: `src/discord/commands/youtube-dm/youtube-dm.ts`
- Test: `src/discord/commands/youtube-dm/youtube-dm.spec.ts`

- [ ] **Step 1: 覆寫 `youtube-dm.spec.ts`**

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { ApplicationIntegrationType, MessageFlags } from "discord.js";
import ChannelModel from "../../../models/Channel.js";
import YoutubeDmBindingModel from "../../../models/YoutubeDmBinding.js";
import { YoutubeDmCommand } from "./youtube-dm.js";

function fakeOAuth() {
  return {
    beginAuth: jest.fn(() =>
      Promise.resolve("https://accounts.google.com/o/oauth2/v2/auth?state=x")
    ),
  };
}

function intr(opts: {
  subcommand: string;
  optionValues?: Record<string, string>;
  owners?: Partial<Record<ApplicationIntegrationType, string>>;
}) {
  return {
    id: "i1",
    user: { id: "d1" },
    client: { application: { id: "app123" } },
    authorizingIntegrationOwners: opts.owners ?? {
      [ApplicationIntegrationType.UserInstall]: "d1",
    },
    options: {
      getSubcommand: () => opts.subcommand,
      getString: (name: string) => opts.optionValues?.[name] ?? null,
    },
    reply: jest.fn(() => Promise.resolve(undefined)),
    followUp: jest.fn(() => Promise.resolve(undefined)),
  } as any;
}

describe("YoutubeDmCommand", () => {
  afterEach(() => jest.restoreAllMocks());

  it("bind calls beginAuth and replies ephemerally with the auth link", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: [] } as any);
    const oauth = fakeOAuth();
    const i = intr({ subcommand: "bind", optionValues: { method: "google" } });
    await new YoutubeDmCommand(oauth).execute(i);
    expect(oauth.beginAuth).toHaveBeenCalledWith("google", "d1");
    const arg = i.reply.mock.calls[0][0];
    expect(arg.content).toContain("accounts.google.com");
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
  });

  it("bind at the cap rejects ephemerally without calling beginAuth", async () => {
    jest.spyOn(YoutubeDmBindingModel, "findOne").mockResolvedValue({
      channelIds: Array.from({ length: 10 }, (_, n) => `UC${n}`),
    } as any);
    const oauth = fakeOAuth();
    const i = intr({ subcommand: "bind", optionValues: { method: "google" } });
    await new YoutubeDmCommand(oauth).execute(i);
    expect(oauth.beginAuth).not.toHaveBeenCalled();
    expect(i.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    expect(i.reply.mock.calls[0][0].content).toContain("上限");
  });

  it("list replies NON-ephemerally with channel names", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue({ name: "Chan A" } as any);
    const i = intr({ subcommand: "list" });
    await new YoutubeDmCommand(fakeOAuth()).execute(i);
    const arg = i.reply.mock.calls[0][0];
    expect(arg.content).toContain("Chan A");
    expect(arg.content).toContain("UCa");
    expect(arg.flags).toBeUndefined();
  });

  it("unbind all replies NON-ephemerally and clears the binding", async () => {
    const unbindAll = jest
      .spyOn(YoutubeDmBindingModel, "unbindAll")
      .mockResolvedValue({} as any);
    const i = intr({ subcommand: "unbind", optionValues: { channel: "all" } });
    await new YoutubeDmCommand(fakeOAuth()).execute(i);
    expect(unbindAll).toHaveBeenCalledWith("d1");
    expect(i.reply.mock.calls[0][0].flags).toBeUndefined();
  });

  it("the install hint followUp stays ephemeral via flags", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue({ name: "Chan A" } as any);
    const i = intr({
      subcommand: "list",
      owners: { [ApplicationIntegrationType.GuildInstall]: "g1" },
    });
    await new YoutubeDmCommand(fakeOAuth()).execute(i);
    expect(i.followUp).toHaveBeenCalledTimes(1);
    const arg = i.followUp.mock.calls[0][0];
    expect(arg.content).toContain("integration_type=1");
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/discord/commands/youtube-dm/youtube-dm.spec.ts`
Expected: FAIL（建構子尚不收 oauth；回覆仍用 `ephemeral`）。

- [ ] **Step 3: 改寫 `youtube-dm.ts`**

1. import 區改為（移除舊 provider/state 函式，保留 `ChannelModel`，加 `MessageFlags`、`OAuthMethod`）：

```ts
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { YOUTUBE_DM_MAX_CHANNELS_PER_USER } from "../../../constants.js";
import ChannelModel from "../../../models/Channel.js";
import YoutubeDmBindingModel from "../../../models/YoutubeDmBinding.js";
import type { OAuthMethod } from "../../../modules/oauth/state-store.js";
import type { Command } from "../command.js";
import { buildUserInstallHint } from "./install-hint.js";
```

2. 在 `metadata` 之後、`execute` 之前加建構子：

```ts
  constructor(
    private readonly oauth: {
      beginAuth(method: OAuthMethod, discordUserId: string): Promise<string>;
    }
  ) {}
```

3. `execute` 末端 hint：`await intr.followUp({ content: hint, flags: MessageFlags.Ephemeral });`

4. `bind`：

```ts
  private async bind(
    intr: ChatInputCommandInteraction,
    discordUserId: string
  ): Promise<void> {
    const binding = await YoutubeDmBindingModel.findOne({ discordUserId });
    if ((binding?.channelIds.length ?? 0) >= YOUTUBE_DM_MAX_CHANNELS_PER_USER) {
      await intr.reply({
        content: `你已達綁定上限（${YOUTUBE_DM_MAX_CHANNELS_PER_USER}）。請先用 /youtube-dm unbind 解除部分頻道。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const method = intr.options.getString("method", true) as OAuthMethod;
    const url = await this.oauth.beginAuth(method, discordUserId);
    await intr.reply({
      content: `點此完成授權（連結 10 分鐘內有效，請勿轉傳）：\n${url}`,
      flags: MessageFlags.Ephemeral,
    });
  }
```

5. `list`：

```ts
  private async list(
    intr: ChatInputCommandInteraction,
    discordUserId: string
  ): Promise<void> {
    const binding = await YoutubeDmBindingModel.findOne({ discordUserId });
    const ids = binding?.channelIds ?? [];
    if (ids.length === 0) {
      await intr.reply({ content: "你尚未綁定任何 YouTube 頻道。" });
      return;
    }
    const lines = await ChannelModel.renderBoundChannelLines(ids);
    await intr.reply({ content: lines.join("\n") });
  }
```

6. `unbind`：

```ts
  private async unbind(
    intr: ChatInputCommandInteraction,
    discordUserId: string
  ): Promise<void> {
    const channel = intr.options.getString("channel", true);
    if (channel === "all") {
      await YoutubeDmBindingModel.unbindAll(discordUserId);
      await intr.reply({ content: "已解除所有綁定。" });
      return;
    }
    await YoutubeDmBindingModel.unbindChannel(discordUserId, channel);
    await intr.reply({ content: `已解除綁定 ${channel}。` });
  }
```

（`autocomplete` 不變。）

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- src/discord/commands/youtube-dm/youtube-dm.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/discord/commands/youtube-dm/youtube-dm.ts src/discord/commands/youtube-dm/youtube-dm.spec.ts
git commit -m "feat(youtube-dm): inject oauth.beginAuth; non-ephemeral list/unbind via flags"
```

---

## Task 8: `discord-bot.ts` 接線 OAuthModule + 命令陣列內聯 + 移除 index.ts

**Files:**

- Modify: `src/commands/discord-bot.ts`
- Delete: `src/discord/commands/index.ts`
- Modify: `src/discord/commands/registration.spec.ts`

- [ ] **Step 1: `registration.spec.ts` 改用本地 fixture**

把開頭 `import { commands } from "./index.js";` 改為自建已排序 fixture：

```ts
import type { AppCommand } from "./command.js";
import { CrawlCommand } from "./mod/crawl.js";
import { SetChannelCommand } from "./mod/set-channel.js";
import { SetVideoCommand } from "./mod/set-video.js";
import { TrackCommand } from "./track/track.js";
import { YoutubeDmCommand } from "./youtube-dm/youtube-dm.js";

const commands: AppCommand[] = [
  new CrawlCommand(),
  new SetChannelCommand(),
  new SetVideoCommand(),
  new TrackCommand(),
  new YoutubeDmCommand({ beginAuth: async () => "" }),
].sort((a, b) => (a.metadata.name > b.metadata.name ? 1 : -1));
```

（其餘斷言不變。）

- [ ] **Step 2: 刪除 `index.ts`**

```bash
git rm src/discord/commands/index.ts
```

- [ ] **Step 3: 改 `discord-bot.ts`**

1. 移除這幾行 import：

```ts
import { commands } from "../discord/commands/index.js";
import {
  handleDiscordCallback,
  handleGoogleCallback,
} from "../modules/oauth/callback.js";
import { initOAuthStateStore } from "../modules/oauth/state-store.js";
```

2. 新增 import：

```ts
import { CrawlCommand } from "../discord/commands/mod/crawl.js";
import { SetChannelCommand } from "../discord/commands/mod/set-channel.js";
import { SetVideoCommand } from "../discord/commands/mod/set-video.js";
import { TrackCommand } from "../discord/commands/track/track.js";
import { YoutubeDmCommand } from "../discord/commands/youtube-dm/youtube-dm.js";
import { OAuthModule } from "../modules/oauth/oauth.js";
```

3. 把組裝段

```ts
const app = new Application();
app.use(new MongodbModule());
const redisModule = app.use(new RedisModule());
initOAuthStateStore(redisModule.redis);

const { server: fastify } = app.http;
fastify.get("/oauth/youtube-dm/google/callback", handleGoogleCallback);
fastify.get("/oauth/youtube-dm/discord/callback", handleDiscordCallback);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});
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
```

改為

```ts
const app = new Application();
app.use(new MongodbModule());
app.use(new RedisModule());

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});
const oauth = app.use(new OAuthModule(app, client));

const commands: AppCommand[] = [
  new CrawlCommand(),
  new SetChannelCommand(),
  new SetVideoCommand(),
  new TrackCommand(),
  new YoutubeDmCommand(oauth),
];
commands.sort((a, b) => (a.metadata.name > b.metadata.name ? 1 : -1));

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
```

（`AppCommand` 型別已在 `discord-bot.ts` 既有 import；`InteractionCreate` 內 `commands.find(...)` 現引用此區域 `commands`。）

- [ ] **Step 4: 型別檢查 + registration 測試**

Run: `npm run build && npm run test -- src/discord/commands/registration.spec.ts`
Expected: build 無錯；PASS。

- [ ] **Step 5: Commit**

```bash
git add src/commands/discord-bot.ts src/discord/commands/registration.spec.ts
git rm src/discord/commands/index.ts
git commit -m "refactor(discord-bot): wire OAuthModule; inline command list with injected oauth"
```

---

## Task 9: 刪除舊 `callback.ts` + 移除相容包裝 + 全量驗證

`OAuthModule` 已接管 callback 與 state；舊 `callback.ts`、provider 相容函式、state-store 相容包裝都不再被引用，移除以收斂回 OO 設計（無全域、無純函式編排）。

**Files:**

- Delete: `src/modules/oauth/callback.ts`、`src/modules/oauth/callback.spec.ts`
- Modify: `src/modules/oauth/google.ts`、`src/modules/oauth/discord.ts`、`src/modules/oauth/state-store.ts`（移除相容區段）
- Modify: `src/modules/oauth/state-store.spec.ts`（移除相容案例）

- [ ] **Step 1: 確認沒有生產碼還引用待移除符號**

Run: `grep -rn "from \"./callback\|/oauth/callback\|initOAuthStateStore\|putOAuthState\|getOAuthState\|delOAuthState\|buildGoogleAuthUrl\|fetchGoogleChannels\|buildDiscordAuthUrl\|exchangeDiscordCode\|fetchDiscordUserId\|fetchVerifiedYoutubeChannels" src --include=*.ts | grep -v ".spec.ts" | grep -vE "src/modules/oauth/(google|discord|state-store)\.ts"`
Expected: 無輸出。若有，回到對應 Task 修正後再續。

- [ ] **Step 2: 刪除舊 callback 檔**

```bash
git rm src/modules/oauth/callback.ts src/modules/oauth/callback.spec.ts
```

- [ ] **Step 3: 移除 provider 相容函式**

- `src/modules/oauth/google.ts`：刪掉檔尾「TEMP back-compat」整段（`_google` 與 `buildGoogleAuthUrl` / `fetchGoogleChannels`）。
- `src/modules/oauth/discord.ts`：刪掉檔尾「TEMP back-compat」整段（`_discord` 與四個 export）。

- [ ] **Step 4: 移除 state-store 相容包裝**

刪掉 `src/modules/oauth/state-store.ts` 檔尾「TEMP back-compat shims」整段（`_default` / `initOAuthStateStore` / `def` / `putOAuthState` / `getOAuthState` / `delOAuthState`），只保留 `randomState`、型別與 `OAuthStateStore`。並刪除 `state-store.spec.ts` 的 `"legacy module functions delegate…"` 案例與其對相容函式的 import（只留 `OAuthStateStore` 與 `randomState`）。

- [ ] **Step 5: 全量型別檢查 + 全測試 + lint**

Run: `npm run build && npm run test && npm run lint`
Expected: 全部 PASS、無 lint 錯誤。

- [ ] **Step 6: 確認舊目錄已清空**

Run: `ls src/discord/oauth 2>/dev/null; echo "exit=$?"`
Expected: 目錄不存在（`exit` 非 0）。

- [ ] **Step 7: Commit**

```bash
git add src/modules/oauth/state-store.ts src/modules/oauth/state-store.spec.ts src/modules/oauth/google.ts src/modules/oauth/discord.ts
git rm src/modules/oauth/callback.ts src/modules/oauth/callback.spec.ts
git commit -m "refactor(oauth): drop legacy callback pure-functions and migration shims"
```

---

## 完成準則

- `src/modules/oauth/`：`oauth.ts`（OAuthModule，OO 編排 + DM）、`state-store.ts`（class，無全域）、`provider.ts`（介面 + `IdentityMismatchError`）、`google.ts`/`discord.ts`（`GoogleProvider`/`DiscordProvider`）+ 各 spec。無 `callback.ts`、無 `deps` 注入。
- `Channel.renderBoundChannelLines` static 由 `/list` 與確認 DM 共用。
- `/youtube-dm`：`bind` ephemeral（`flags`）、`list`/`unbind` 非 ephemeral、install-hint followUp ephemeral（`flags`）。
- `discord-bot.ts`：`app.use(new OAuthModule(app, client))`、命令陣列內聯注入 oauth、無 `initOAuthStateStore`、無手寫 `fastify.get` 路由。
- `src/discord/oauth/` 與 `src/discord/commands/index.ts` 已刪除。
- `npm run build && npm run test && npm run lint` 全綠。
