# YouTube PubSubHubbub Subscription Renewal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `crawler youtube pubsub subscribe` 從「每 12 小時全量重訂、途中把整個
crawler process 殺掉」改成「每 10 分鐘續訂少量即將到期的頻道」，並由本 repo 自己
接手 PubSubHubbub 的訂閱請求與通知接收。

**Architecture:** `Channel` 上新增 `pubsubRequestedAt` / `pubsubExpiresAt` 兩個
時間戳，續訂由「即將到期」驅動；訂閱請求走自己的 axios client（可 catch、可分類
限流），通知接收走 fastify 原生 route（自己做 HMAC 驗證與 Atom 解析）。
`youtube-notification` 與 `@fastify/express` 一併移除。

**Tech Stack:** TypeScript (ESM, NodeNext)、fastify 4.26、axios 1.x、
fast-xml-parser、agenda 6.2、mongoose/typegoose、Jest 29（true ESM，
`jest.unstable_mockModule`）。

---

## File Structure

**新增**

| 檔案                                       | 責任                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `src/modules/youtube-pubsub/hub-client.ts` | 組 callback URL 與 token、送出訂閱請求、把失敗分類成 http / timeout / network 與是否限流 |
| `src/modules/youtube-pubsub/atom.ts`       | 把通知 body 解析成 entry 陣列（純函式）                                                  |
| `src/modules/youtube-pubsub/routes.ts`     | fastify plugin：content-type parser、verification GET、通知 POST                         |
| `src/components/pubsub-subscribe.ts`       | 到期驅動的批次續訂（agenda job 的實作）                                                  |

每個新檔案都有相鄰的 `*.spec.ts`。

**修改**

| 檔案                          | 變更                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/constants.ts`            | 新增 8 個常數                                                                                   |
| `src/models/Channel.ts`       | 兩個新欄位、一個複合 index、一個候選查詢 static                                                 |
| `src/modules/youtube.ts`      | `getYoutubeApi()` 加全域 timeout                                                                |
| `src/modules/youtube.spec.ts` | 斷言 client 建立時帶了 timeout                                                                  |
| `src/commands/crawler.ts`     | 移除 `YouTubeNotifier` 與 express 轉接層，改註冊 plugin（在 `app.init()` 之前）、job 改 10 分鐘 |
| `package.json`                | 加 `fast-xml-parser`；移除 `youtube-notification`、`@fastify/express`                           |

**刪除**：`src/types/youtube-notification.d.ts`

---

### Task 1: 安裝 fast-xml-parser

**Files:**

- Modify: `package.json`

- [ ] **Step 1: 確認尚未安裝**

Run:

```bash
grep '"version"' node_modules/fast-xml-parser/package.json 2>/dev/null || echo "NOT INSTALLED"
```

Expected: `NOT INSTALLED`（若印出版本號就跳過 Step 2，直接確認它在
`package.json` 的 `dependencies` 裡）。

- [ ] **Step 2: 安裝為 runtime 依賴**

Run:

```bash
npm install fast-xml-parser
```

crawler 在生產執行期會 import 它，所以必須是 `dependencies`（`npm install`
不帶 `-D` 即為此）。不要指定版本號，讓 npm 寫入它自己的 caret range。

- [ ] **Step 3: 確認落點正確**

Run:

```bash
node -e "const p=require('./package.json'); console.log('dep:', p.dependencies['fast-xml-parser'], 'devDep:', p.devDependencies['fast-xml-parser'])"
```

Expected: `dep:` 有版本字串、`devDep: undefined`。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add fast-xml-parser for pubsub notification parsing"
```

---

### Task 2: 新增常數

**Files:**

- Modify: `src/constants.ts`（附加在檔尾）

- [ ] **Step 1: 附加常數區塊**

在 `src/constants.ts` 檔尾附加：

```ts
// --- YouTube PubSubHubbub subscription renewal ---

// 提前一天續訂，容得下一整天的排程中斷仍不掉訂閱。
export const PUBSUB_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

// 同一頻道的最短重試間隔，同時也是 verification 的接受窗口。刻意大於 10 分鐘的
// 排程間隔，讓候選輪替而不是同一批連續重試。
export const PUBSUB_REQUEST_COOLDOWN_MS = 15 * 60 * 1000;

// 單輪處理的頻道數上限，也就是一次崩潰或限流的損失上限。
export const PUBSUB_RENEW_BATCH_SIZE = 5;

// 單輪內兩個 hub 請求之間的間隔。
export const PUBSUB_REQUEST_SPACING_MS = 250;

// hub 未提供或提供了不合法的 lease_seconds 時的保守預設，確保仍會續訂而不是永不
// 續訂。
export const PUBSUB_DEFAULT_LEASE_MS = 24 * 60 * 60 * 1000;

// lease_seconds 的上界。WebSub 的安全章節建議 hub 使用短 lease（10 天是它給的
// 預設建議值），超過就 clamp，避免一個異常或偽造的值把頻道推到永遠不續訂。
export const PUBSUB_MAX_LEASE_MS = 10 * 24 * 60 * 60 * 1000;

// 單次 hub 請求的逾時。axios 的預設是 timeout: 0（無限等待），不明確設定的話一個
// 掛住的連線會讓整輪永遠不結束。
export const PUBSUB_REQUEST_TIMEOUT_MS = 10 * 1000;

// 所有 YouTube Data API 呼叫的逾時。gaxios 沒有預設逾時（只有在傳入 timeout 時
// 才建立 AbortSignal），所以不設就可能無限掛住。比 hub 請求寬鬆，因為單次呼叫
// 最多帶 50 個 id；仍遠短於 agenda 的 10 分鐘 lockLifetime。
export const YOUTUBE_API_TIMEOUT_MS = 15 * 1000;
```

- [ ] **Step 2: 型別檢查**

Run: `npm run build`
Expected: 無錯誤結束。

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat(constants): add pubsub renewal and youtube api timeout values"
```

---

### Task 3: Atom 通知解析

**Files:**

- Create: `src/modules/youtube-pubsub/atom.ts`
- Test: `src/modules/youtube-pubsub/atom.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

Create `src/modules/youtube-pubsub/atom.spec.ts`:

```ts
/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { parseNotification } from "./atom.js";

function feed(inner: string): string {
  return `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:at="http://purl.org/atompub/tombstones/1.0"
      xmlns="http://www.w3.org/2005/Atom">
  <title>YouTube video feed</title>
  ${inner}
</feed>`;
}

function videoEntry(id: string, title: string): string {
  return `<entry>
    <id>yt:video:${id}</id>
    <yt:videoId>${id}</yt:videoId>
    <yt:channelId>UCchannel</yt:channelId>
    <title>${title}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>
    <author>
      <name>A Channel</name>
      <uri>https://www.youtube.com/channel/UCchannel</uri>
    </author>
    <published>2026-09-17T01:02:03+00:00</published>
    <updated>2026-09-17T01:02:04+00:00</updated>
  </entry>`;
}

describe("parseNotification", () => {
  it("parses a single video entry into one row", () => {
    const result = parseNotification(feed(videoEntry("vid1", "First")));

    expect(result).toEqual([
      {
        type: "video",
        videoId: "vid1",
        channelId: "UCchannel",
        title: "First",
        link: "https://www.youtube.com/watch?v=vid1",
        channelName: "A Channel",
        published: new Date("2026-09-17T01:02:03+00:00"),
        updated: new Date("2026-09-17T01:02:04+00:00"),
      },
    ]);
  });

  it("parses every entry of a multi-entry feed, in document order", () => {
    const result = parseNotification(
      feed(videoEntry("vid1", "First") + videoEntry("vid2", "Second"))
    );

    expect(result).toHaveLength(2);
    expect(result?.map((entry) => entry.type)).toEqual(["video", "video"]);
    expect(
      result?.map((entry) => (entry.type === "video" ? entry.videoId : null))
    ).toEqual(["vid1", "vid2"]);
  });

  it("returns videos first and deletions after them", () => {
    const result = parseNotification(
      feed(
        `<at:deleted-entry ref="yt:video:gone" when="2026-09-17T01:00:00+00:00"/>` +
          videoEntry("vid1", "First")
      )
    );

    expect(result).toEqual([
      expect.objectContaining({ type: "video", videoId: "vid1" }),
      { type: "deleted", videoId: "gone" },
    ]);
  });

  it("keeps a numeric-looking title and id as strings", () => {
    const result = parseNotification(feed(videoEntry("2026", "12345")));

    expect(result).toEqual([
      expect.objectContaining({ videoId: "2026", title: "12345" }),
    ]);
  });

  it("skips an entry missing videoId, channelId or title", () => {
    const result = parseNotification(
      feed(
        `<entry><yt:videoId>novideo</yt:videoId><title>No channel</title></entry>` +
          `<entry><yt:videoId>notitle</yt:videoId><yt:channelId>UCchannel</yt:channelId></entry>` +
          videoEntry("vid1", "First")
      )
    );

    expect(result).toEqual([
      expect.objectContaining({ type: "video", videoId: "vid1" }),
    ]);
  });

  it("returns an empty array for a feed with no entries", () => {
    expect(parseNotification(feed(""))).toEqual([]);
  });

  it("returns null when the body is not a feed", () => {
    expect(parseNotification("<html><body>hi</body></html>")).toBeNull();
    expect(parseNotification("not xml at all <<<")).toBeNull();
    expect(parseNotification("")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `npm run test -- src/modules/youtube-pubsub/atom.spec.ts`
Expected: FAIL，錯誤是找不到模組 `./atom.js`。

- [ ] **Step 3: 寫實作**

Create `src/modules/youtube-pubsub/atom.ts`:

```ts
import { XMLParser } from "fast-xml-parser";

export interface VideoEntry {
  type: "video";
  videoId: string;
  channelId: string;
  title: string;
  link?: string;
  channelName?: string;
  published?: Date;
  updated?: Date;
}

export interface DeletedEntry {
  type: "deleted";
  videoId?: string;
}

export type NotificationEntry = VideoEntry | DeletedEntry;

const DELETED_REF_PREFIX = "yt:video:";

// removeNSPrefix 讓 yt:videoId / at:deleted-entry 變成 videoId / deleted-entry；
// ignoreAttributes: false 才讀得到 link 的 href；parseTagValue: false 讓每個文字
// 節點都保持字串，否則像 "2026" 這種標題或 id 會被轉成 number。
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  parseTagValue: false,
});

// 重複的元素會是陣列、單一的會是物件，兩種都要能走同一條路。
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object" && "#text" in value) {
    return text((value as Record<string, unknown>)["#text"]);
  }
  return undefined;
}

function date(value: unknown): Date | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * 把一筆 PubSubHubbub 通知的 body 解析成 entry 陣列。body 不是 feed（或不是合法
 * XML）時回 null。
 *
 * 影片 entry 依它們在 feed 裡的順序排前面，刪除 entry 全部排在後面：兩者是不同的
 * 元素名，解析後無法還原原本交錯的順序。
 */
export function parseNotification(xml: string): NotificationEntry[] | null {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const feed = (parsed as Record<string, unknown>).feed;
  if (!feed || typeof feed !== "object") return null;
  const feedObject = feed as Record<string, unknown>;

  const entries: NotificationEntry[] = [];

  for (const raw of asArray(feedObject.entry)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const videoId = text(entry.videoId);
    const channelId = text(entry.channelId);
    const title = text(entry.title);
    // 少了這三個就寫不出有效的 video 文件（title 是 required，空字串也過不了
    // validator），所以寧可跳過也不要寫進資料庫。
    if (!videoId || !channelId || !title) continue;
    const author = (entry.author ?? {}) as Record<string, unknown>;
    const link = (asArray(entry.link)[0] ?? {}) as Record<string, unknown>;
    entries.push({
      type: "video",
      videoId,
      channelId,
      title,
      link: text(link["@_href"]),
      channelName: text(author.name),
      published: date(entry.published),
      updated: date(entry.updated),
    });
  }

  for (const raw of asArray(feedObject["deleted-entry"])) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const ref = text(entry["@_ref"]);
    entries.push({
      type: "deleted",
      videoId: ref?.startsWith(DELETED_REF_PREFIX)
        ? ref.slice(DELETED_REF_PREFIX.length)
        : undefined,
    });
  }

  return entries;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- src/modules/youtube-pubsub/atom.spec.ts`
Expected: 7 個測試全部 PASS。

- [ ] **Step 5: 型別檢查與 lint**

Run: `npm run build && npm run lint`
Expected: 兩者都無錯誤結束。

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube-pubsub/atom.ts src/modules/youtube-pubsub/atom.spec.ts
git commit -m "feat(pubsub): parse a notification body into an entry array"
```

---

### Task 4: hub client（訂閱請求與失敗分類）

**Files:**

- Create: `src/modules/youtube-pubsub/hub-client.ts`
- Test: `src/modules/youtube-pubsub/hub-client.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

Create `src/modules/youtube-pubsub/hub-client.spec.ts`:

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { AxiosError } from "axios";

// constants.ts 在 module-eval 時就讀環境變數，所以要在 import 之前設好。
process.env.PUBLIC_BASE_URL = "https://honeybee.example.test/";
process.env.YOUTUBE_PUBSUB_SECRET = "test-secret";

const mockPost = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("axios", () => {
  const isAxiosError = (error: unknown) =>
    !!error && (error as AxiosError).isAxiosError === true;
  return {
    default: { post: mockPost, isAxiosError },
    isAxiosError,
  };
});

const {
  channelIdFromTopic,
  getCallbackToken,
  getCallbackUrl,
  requestSubscription,
  topicForChannel,
} = await import("./hub-client.js");
const { PUBSUB_REQUEST_TIMEOUT_MS } = await import("../../constants.js");

function httpError(status: number): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    "ERR_BAD_REQUEST",
    undefined,
    {},
    { status } as never
  );
}

describe("callback url and topic helpers", () => {
  it("puts a stable 32-char token in the callback path", () => {
    const token = getCallbackToken();

    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(getCallbackToken()).toBe(token);
    expect(getCallbackUrl()).toBe(
      `https://honeybee.example.test/notifications/youtube/${token}`
    );
  });

  it("round-trips a channel id through the topic url", () => {
    const topic = topicForChannel("UCabc");

    expect(topic).toBe(
      "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCabc"
    );
    expect(channelIdFromTopic(topic)).toBe("UCabc");
  });

  it("rejects a topic that is not a youtube feed topic", () => {
    expect(
      channelIdFromTopic("https://evil.example/?channel_id=UCabc")
    ).toBeNull();
    expect(
      channelIdFromTopic(
        "https://www.youtube.com/xml/feeds/videos.xml?channel_id="
      )
    ).toBeNull();
    expect(channelIdFromTopic(undefined)).toBeNull();
  });
});

describe("requestSubscription", () => {
  afterEach(() => {
    mockPost.mockReset();
  });

  it("posts the full subscribe form with an explicit timeout", async () => {
    mockPost.mockResolvedValue({ status: 202 });

    const result = await requestSubscription("UCabc");

    expect(result).toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockPost.mock.calls[0] as [
      string,
      string,
      { headers: Record<string, string>; timeout: number },
    ];
    expect(url).toBe("https://pubsubhubbub.appspot.com/subscribe");
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      "hub.callback": getCallbackUrl(),
      "hub.mode": "subscribe",
      "hub.topic": topicForChannel("UCabc"),
      "hub.secret": "test-secret",
    });
    expect(config.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(config.timeout).toBe(PUBSUB_REQUEST_TIMEOUT_MS);
  });

  it("marks 429 and 503 as rate limited", async () => {
    mockPost.mockRejectedValueOnce(httpError(429));
    expect(await requestSubscription("UCabc")).toEqual({
      ok: false,
      kind: "http",
      rateLimited: true,
      status: 429,
      message: "Request failed with status code 429",
    });

    mockPost.mockRejectedValueOnce(httpError(503));
    expect(await requestSubscription("UCabc")).toEqual({
      ok: false,
      kind: "http",
      rateLimited: true,
      status: 503,
      message: "Request failed with status code 503",
    });
  });

  it("marks other http failures as not rate limited", async () => {
    mockPost.mockRejectedValueOnce(httpError(400));

    expect(await requestSubscription("UCabc")).toEqual({
      ok: false,
      kind: "http",
      rateLimited: false,
      status: 400,
      message: "Request failed with status code 400",
    });
  });

  it("reports a timeout distinctly from an http failure", async () => {
    mockPost.mockRejectedValueOnce(
      new AxiosError("timeout of 10000ms exceeded", "ECONNABORTED")
    );

    expect(await requestSubscription("UCabc")).toEqual({
      ok: false,
      kind: "timeout",
      rateLimited: false,
      message: "timeout of 10000ms exceeded",
    });
  });

  it("reports a connection failure as a network failure", async () => {
    mockPost.mockRejectedValueOnce(
      new AxiosError("connect ECONNREFUSED", "ECONNREFUSED")
    );

    expect(await requestSubscription("UCabc")).toEqual({
      ok: false,
      kind: "network",
      rateLimited: false,
      message: "connect ECONNREFUSED",
    });
  });

  it("never rejects, even for a non-axios throw", async () => {
    mockPost.mockRejectedValueOnce(new Error("boom"));

    expect(await requestSubscription("UCabc")).toEqual({
      ok: false,
      kind: "network",
      rateLimited: false,
      message: "boom",
    });
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `npm run test -- src/modules/youtube-pubsub/hub-client.spec.ts`
Expected: FAIL，錯誤是找不到模組 `./hub-client.js`。

- [ ] **Step 3: 寫實作**

Create `src/modules/youtube-pubsub/hub-client.ts`:

```ts
import axios from "axios";
import assert from "node:assert";
import crypto from "node:crypto";
import {
  PUBLIC_BASE_URL,
  PUBSUB_REQUEST_TIMEOUT_MS,
  YOUTUBE_PUBSUB_SECRET,
} from "../../constants.js";

const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const TOPIC_PREFIX = "https://www.youtube.com/xml/feeds/videos.xml?channel_id=";

export type SubscribeResult =
  | { ok: true }
  | {
      ok: false;
      /** http：hub 回了狀態碼；timeout：逾時；network：連不上或非 HTTP 錯誤。 */
      kind: "http" | "timeout" | "network";
      rateLimited: boolean;
      status?: number;
      message: string;
    };

export function topicForChannel(channelId: string): string {
  return `${TOPIC_PREFIX}${channelId}`;
}

export function channelIdFromTopic(topic: string | undefined): string | null {
  if (!topic || !topic.startsWith(TOPIC_PREFIX)) return null;
  const channelId = topic.slice(TOPIC_PREFIX.length);
  return channelId.length > 0 ? channelId : null;
}

/**
 * hub 用來確認訂閱的那個 GET 不帶任何簽章，所以唯一能認證它的東西，是我們自己
 * 放進 callback URL、而 hub 每次都會原樣帶回來的一段不可猜測字串。這裡從既有的
 * secret 衍生，不需要新的環境變數。
 */
export function getCallbackToken(): string {
  assert(YOUTUBE_PUBSUB_SECRET, "YOUTUBE_PUBSUB_SECRET should be defined.");
  return crypto
    .createHmac("sha256", YOUTUBE_PUBSUB_SECRET)
    .update("pubsub-callback")
    .digest("hex")
    .slice(0, 32);
}

export function getCallbackUrl(): string {
  assert(PUBLIC_BASE_URL, "PUBLIC_BASE_URL should be defined.");
  return new URL(
    `./notifications/youtube/${getCallbackToken()}`,
    PUBLIC_BASE_URL
  ).toString();
}

/**
 * 送出一次訂閱請求。所有失敗都在這裡被 catch 並分類，呼叫端永遠拿到回傳值——
 * 一個沒人接的 rejection 會讓整個 process 被 unhandledRejection handler 殺掉。
 */
export async function requestSubscription(
  channelId: string
): Promise<SubscribeResult> {
  assert(YOUTUBE_PUBSUB_SECRET, "YOUTUBE_PUBSUB_SECRET should be defined.");
  const form = new URLSearchParams({
    "hub.callback": getCallbackUrl(),
    "hub.mode": "subscribe",
    "hub.topic": topicForChannel(channelId),
    "hub.secret": YOUTUBE_PUBSUB_SECRET,
  });

  try {
    await axios.post(HUB_URL, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: PUBSUB_REQUEST_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        return {
          ok: false,
          kind: "timeout",
          rateLimited: false,
          message: error.message,
        };
      }
      const status = error.response?.status;
      if (status === undefined) {
        return {
          ok: false,
          kind: "network",
          rateLimited: false,
          message: error.message,
        };
      }
      return {
        ok: false,
        kind: "http",
        rateLimited: status === 429 || status === 503,
        status,
        message: error.message,
      };
    }
    return {
      ok: false,
      kind: "network",
      rateLimited: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- src/modules/youtube-pubsub/hub-client.spec.ts`
Expected: 9 個測試全部 PASS。

- [ ] **Step 5: 型別檢查與 lint**

Run: `npm run build && npm run lint`
Expected: 兩者都無錯誤結束。

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube-pubsub/hub-client.ts src/modules/youtube-pubsub/hub-client.spec.ts
git commit -m "feat(pubsub): send subscribe requests with a timeout and classified failures"
```

---

### Task 5: Channel 的續訂狀態與候選查詢

**Files:**

- Modify: `src/models/Channel.ts`
- Test: `src/models/Channel.spec.ts`（既有檔案，附加一個 describe）

- [ ] **Step 1: 寫失敗的測試**

在 `src/models/Channel.spec.ts` 檔尾附加：

```ts
describe("Channel.findPubsubRenewalCandidates", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // findSubscribed() 回傳的是一個 mongoose Query，鏈上的 and/sort/limit/select
  // 都回傳自己，所以用一個記錄呼叫參數的假 query 就能斷言整條鏈。
  function fakeQuery() {
    const calls: Record<string, unknown[]> = {};
    const query: Record<string, unknown> = {};
    for (const method of ["and", "sort", "limit", "select"]) {
      query[method] = jest.fn((...args: unknown[]) => {
        calls[method] = args;
        return query;
      });
    }
    return { query, calls };
  }

  it("asks for channels whose lease is near expiry and that are off cooldown", async () => {
    const { query, calls } = fakeQuery();
    jest.spyOn(ChannelModel, "findSubscribed").mockReturnValue(query as never);
    const now = new Date("2026-09-17T00:00:00.000Z");

    const result = ChannelModel.findPubsubRenewalCandidates(5, now);

    expect(result).toBe(query);
    expect(calls.and).toEqual([
      [
        {
          $or: [
            { pubsubExpiresAt: null },
            { pubsubExpiresAt: { $lt: new Date("2026-09-18T00:00:00.000Z") } },
          ],
        },
        {
          $or: [
            { pubsubRequestedAt: null },
            {
              pubsubRequestedAt: {
                $lt: new Date("2026-09-16T23:45:00.000Z"),
              },
            },
          ],
        },
      ],
    ]);
    expect(calls.sort).toEqual([{ pubsubRequestedAt: 1 }]);
    expect(calls.limit).toEqual([5]);
    expect(calls.select).toEqual(["id name"]);
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `npm run test -- src/models/Channel.spec.ts`
Expected: FAIL，`ChannelModel.findPubsubRenewalCandidates is not a function`。

- [ ] **Step 3: 加欄位、index 與查詢**

在 `src/models/Channel.ts` 的 import 區加入常數：

```ts
import {
  HOLODEX_ALL_VTUBERS,
  HOLODEX_FETCH_ORG,
  PUBSUB_RENEW_BEFORE_MS,
  PUBSUB_REQUEST_COOLDOWN_MS,
} from "../constants.js";
```

在 class 上既有的 `@index(...)` 之後加一個複合 index（讓候選查詢的排序走 index）：

```ts
@index({ pubsubExpiresAt: 1, pubsubRequestedAt: 1 })
```

在 `holodexCrawledAt` 欄位之後加兩個欄位：

```ts
  /** 我們上次向 hub 送出訂閱請求的時間。 */
  @prop()
  public pubsubRequestedAt?: Date;

  /** verification 帶回的 lease 換算出的訂閱到期時間。 */
  @prop()
  public pubsubExpiresAt?: Date;
```

在 `//#region find methods` 內、`waitForCrawl` 之前加入 static：

```ts
  /**
   * 需要續訂 pubsub 的頻道：訂閱即將到期（或從未成功訂閱），且最近沒有送過請求。
   *
   * 排序讓沒有 `pubsubRequestedAt` 的（從未請求過）排最前面，其餘最久沒請求的
   * 優先，所以一個永遠失敗的頻道在請求後會落到隊尾，不會一直霸佔隊首。
   */
  public static findPubsubRenewalCandidates(
    this: ReturnModelType<typeof Channel>,
    limit: number,
    now: Date = new Date()
  ) {
    return this.findSubscribed()
      .and([
        {
          $or: [
            { pubsubExpiresAt: null },
            {
              pubsubExpiresAt: {
                $lt: new Date(now.getTime() + PUBSUB_RENEW_BEFORE_MS),
              },
            },
          ],
        },
        {
          $or: [
            { pubsubRequestedAt: null },
            {
              pubsubRequestedAt: {
                $lt: new Date(now.getTime() - PUBSUB_REQUEST_COOLDOWN_MS),
              },
            },
          ],
        },
      ])
      .sort({ pubsubRequestedAt: 1 })
      .limit(limit)
      .select("id name");
  }
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- src/models/Channel.spec.ts`
Expected: 既有測試與新加的 1 個測試全部 PASS。

- [ ] **Step 5: 型別檢查與 lint**

Run: `npm run build && npm run lint`
Expected: 兩者都無錯誤結束。

- [ ] **Step 6: Commit**

```bash
git add src/models/Channel.ts src/models/Channel.spec.ts
git commit -m "feat(channel): track pubsub request and expiry, query renewal candidates"
```

---

### Task 6: 到期驅動的批次續訂

**Files:**

- Create: `src/components/pubsub-subscribe.ts`
- Test: `src/components/pubsub-subscribe.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

Create `src/components/pubsub-subscribe.spec.ts`:

```ts
/// <reference types="jest" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

process.env.PUBLIC_BASE_URL = "https://honeybee.example.test/";
process.env.YOUTUBE_PUBSUB_SECRET = "test-secret";

type SubscribeResult = Awaited<
  ReturnType<
    typeof import("../modules/youtube-pubsub/hub-client.js").requestSubscription
  >
>;

const mockRequestSubscription = jest.fn<() => Promise<SubscribeResult>>();
const mockSleep = jest.fn<() => Promise<void>>();

jest.unstable_mockModule("../modules/youtube-pubsub/hub-client.js", () => ({
  requestSubscription: mockRequestSubscription,
}));

// 真的 sleep 會讓測試變慢，而且我們要斷言間隔被套用的次數。
jest.unstable_mockModule("node:timers/promises", () => ({
  setTimeout: mockSleep,
}));

const { default: ChannelModel } = await import("../models/Channel.js");
const { renewPubsubSubscriptions } = await import("./pubsub-subscribe.js");
const { PUBSUB_RENEW_BATCH_SIZE } = await import("../constants.js");

// 一個會記錄寫入順序的 stateful 假 Channel collection。
function fakeChannels(ids: string[]) {
  const writes: string[] = [];
  const candidates = ids.map((id) => ({ id, name: `Channel ${id}` }));
  const findSpy = jest
    .spyOn(ChannelModel, "findPubsubRenewalCandidates")
    .mockResolvedValue(candidates as never);
  const updateSpy = jest
    .spyOn(ChannelModel, "updateOne")
    .mockImplementation(((filter: { id: string }) => {
      writes.push(filter.id);
      return Promise.resolve({ acknowledged: true }) as never;
    }) as never);
  return { writes, findSpy, updateSpy };
}

describe("renewPubsubSubscriptions", () => {
  beforeEach(() => {
    mockSleep.mockResolvedValue(undefined);
    mockRequestSubscription.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockRequestSubscription.mockReset();
    mockSleep.mockReset();
  });

  it("asks for at most one batch", async () => {
    const { findSpy } = fakeChannels(["UC1"]);

    await renewPubsubSubscriptions();

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(findSpy.mock.calls[0][0]).toBe(PUBSUB_RENEW_BATCH_SIZE);
  });

  it("stamps the request time before sending the request", async () => {
    const order: string[] = [];
    const candidates = [{ id: "UC1", name: "One" }];
    jest
      .spyOn(ChannelModel, "findPubsubRenewalCandidates")
      .mockResolvedValue(candidates as never);
    jest.spyOn(ChannelModel, "updateOne").mockImplementation(((
      _filter: unknown,
      update: { $set: { pubsubRequestedAt: Date } }
    ) => {
      order.push("write");
      expect(update.$set.pubsubRequestedAt).toBeInstanceOf(Date);
      return Promise.resolve({ acknowledged: true }) as never;
    }) as never);
    mockRequestSubscription.mockImplementation(async () => {
      order.push("request");
      return { ok: true };
    });

    await renewPubsubSubscriptions();

    expect(order).toEqual(["write", "request"]);
  });

  it("processes every candidate and spaces the requests", async () => {
    const { writes } = fakeChannels(["UC1", "UC2", "UC3"]);

    await renewPubsubSubscriptions();

    expect(writes).toEqual(["UC1", "UC2", "UC3"]);
    expect(mockRequestSubscription).toHaveBeenCalledTimes(3);
    // 最後一個之後不需要再等。
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it("stops the round as soon as the hub rate limits", async () => {
    const { writes } = fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
    mockRequestSubscription
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        kind: "http",
        rateLimited: true,
        status: 503,
        message: "Request failed with status code 503",
      });

    await renewPubsubSubscriptions();

    expect(mockRequestSubscription).toHaveBeenCalledTimes(3);
    // 第四、第五個連 pubsubRequestedAt 都還沒被寫。
    expect(writes).toEqual(["UC1", "UC2", "UC3"]);
  });

  it("keeps going after a non-rate-limit failure, including a timeout", async () => {
    const { writes } = fakeChannels(["UC1", "UC2", "UC3"]);
    mockRequestSubscription
      .mockResolvedValueOnce({
        ok: false,
        kind: "timeout",
        rateLimited: false,
        message: "timeout of 10000ms exceeded",
      })
      .mockResolvedValueOnce({
        ok: false,
        kind: "http",
        rateLimited: false,
        status: 400,
        message: "Request failed with status code 400",
      })
      .mockResolvedValueOnce({ ok: true });

    await renewPubsubSubscriptions();

    expect(mockRequestSubscription).toHaveBeenCalledTimes(3);
    expect(writes).toEqual(["UC1", "UC2", "UC3"]);
  });

  it("does nothing when there is no candidate", async () => {
    fakeChannels([]);

    await renewPubsubSubscriptions();

    expect(mockRequestSubscription).not.toHaveBeenCalled();
    expect(mockSleep).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `npm run test -- src/components/pubsub-subscribe.spec.ts`
Expected: FAIL，錯誤是找不到模組 `./pubsub-subscribe.js`。

- [ ] **Step 3: 寫實作**

Create `src/components/pubsub-subscribe.ts`:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import {
  PUBSUB_RENEW_BATCH_SIZE,
  PUBSUB_REQUEST_SPACING_MS,
} from "../constants.js";
import ChannelModel from "../models/Channel.js";
import { requestSubscription } from "../modules/youtube-pubsub/hub-client.js";

/**
 * 一輪續訂：挑出訂閱即將到期（或從未成功）的頻道，逐一向 hub 送出訂閱請求。
 *
 * 單輪的頻道數與逐項逾時把最壞情況的執行時間封在 agenda 的 lockLifetime 以內，
 * 所以這裡不需要 job.touch()。
 */
export async function renewPubsubSubscriptions(): Promise<void> {
  const candidates = await ChannelModel.findPubsubRenewalCandidates(
    PUBSUB_RENEW_BATCH_SIZE
  );

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];

    // 先寫再送請求：hub 有時會在回應 POST 之前就先來 verification，先寫才不會讓
    // 合法的 verification 被時間窗擋掉。而且不論請求成敗都寫，一個永遠失敗的
    // 頻道才會落到隊尾，不會固定霸佔隊首、擠掉正常的續訂。
    await ChannelModel.updateOne(
      { id: channel.id },
      { $set: { pubsubRequestedAt: new Date() } }
    );
    console.log(`Subscribing: [${channel.id}] ${channel.name}`);

    const result = await requestSubscription(channel.id);
    if (!result.ok) {
      if (result.rateLimited) {
        // 限流通常是全域的，繼續打只會繼續失敗。剩下的候選留給下一輪。
        console.warn(
          `Pubsub subscribe throttled at [${channel.id}] (status=${result.status}); stopping this round`
        );
        return;
      }
      console.warn(
        `Pubsub subscribe failed for [${channel.id}] (${result.kind}): ${result.message}`
      );
      continue;
    }

    if (index < candidates.length - 1) {
      await sleep(PUBSUB_REQUEST_SPACING_MS);
    }
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- src/components/pubsub-subscribe.spec.ts`
Expected: 6 個測試全部 PASS。

- [ ] **Step 5: 型別檢查與 lint**

Run: `npm run build && npm run lint`
Expected: 兩者都無錯誤結束。

- [ ] **Step 6: Commit**

```bash
git add src/components/pubsub-subscribe.ts src/components/pubsub-subscribe.spec.ts
git commit -m "feat(pubsub): renew expiring subscriptions in small batches"
```

---

### Task 7: verification GET route

**Files:**

- Create: `src/modules/youtube-pubsub/routes.ts`
- Test: `src/modules/youtube-pubsub/routes.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

Create `src/modules/youtube-pubsub/routes.spec.ts`:

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import fastify from "fastify";

process.env.PUBLIC_BASE_URL = "https://honeybee.example.test/";
process.env.YOUTUBE_PUBSUB_SECRET = "test-secret";

const mockNoticeFromNotification = jest.fn<() => Promise<unknown>>();
const mockUpdateVideoFromYoutube = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("../../models/Video.js", () => ({
  default: { noticeFromNotification: mockNoticeFromNotification },
}));

jest.unstable_mockModule("../youtube.js", () => ({
  updateVideoFromYoutube: mockUpdateVideoFromYoutube,
}));

const { default: ChannelModel } = await import("../../models/Channel.js");
const { pubsubRoutes } = await import("./routes.js");
const { getCallbackToken, topicForChannel } = await import("./hub-client.js");
const { PUBSUB_DEFAULT_LEASE_MS, PUBSUB_MAX_LEASE_MS } =
  await import("../../constants.js");

async function buildServer() {
  const app = fastify();
  await app.register(pubsubRoutes);
  return app;
}

const token = getCallbackToken();

function verificationUrl(params: Record<string, string>, path = token): string {
  return `/notifications/youtube/${path}?${new URLSearchParams(params)}`;
}

describe("verification GET", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("echoes the challenge and stores the expiry for a channel we just asked about", async () => {
    const requestedAt = new Date("2026-09-17T00:00:00.000Z");
    const findSpy = jest.spyOn(ChannelModel, "findOne").mockResolvedValue({
      id: "UCabc",
      pubsubRequestedAt: requestedAt,
    } as never);
    const updateSpy = jest
      .spyOn(ChannelModel, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "challenge-value",
        "hub.lease_seconds": "432000",
      }),
    });

    expect(response.statusCode).toBe(200);
    // body 不等於 challenge 的話 hub 會判定驗證失敗，所以必須完全相等。
    expect(response.body).toBe("challenge-value");
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [filter, update] = updateSpy.mock.calls[0] as [
      { id: string },
      { $set: { pubsubExpiresAt: Date } },
    ];
    expect(filter).toEqual({ id: "UCabc" });
    expect(update.$set.pubsubExpiresAt.getTime()).toBeGreaterThan(Date.now());
    await app.close();
  });

  it("rejects a wrong token without touching the database", async () => {
    const findSpy = jest.spyOn(ChannelModel, "findOne");
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl(
        {
          "hub.mode": "subscribe",
          "hub.topic": topicForChannel("UCabc"),
          "hub.challenge": "challenge-value",
        },
        "0".repeat(32)
      ),
    });

    expect(response.statusCode).toBe(404);
    expect(findSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a channel we did not recently ask about", async () => {
    jest.spyOn(ChannelModel, "findOne").mockResolvedValue(null as never);
    const updateSpy = jest.spyOn(ChannelModel, "updateOne");
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "challenge-value",
      }),
    });

    expect(response.statusCode).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["missing", {}, PUBSUB_DEFAULT_LEASE_MS],
    ["not a number", { "hub.lease_seconds": "soon" }, PUBSUB_DEFAULT_LEASE_MS],
    ["zero", { "hub.lease_seconds": "0" }, PUBSUB_DEFAULT_LEASE_MS],
    ["over the cap", { "hub.lease_seconds": "99999999" }, PUBSUB_MAX_LEASE_MS],
  ])("handles a lease that is %s", async (_label, extra, expectedMs) => {
    jest
      .spyOn(ChannelModel, "findOne")
      .mockResolvedValue({ id: "UCabc" } as never);
    const updateSpy = jest
      .spyOn(ChannelModel, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);
    const app = await buildServer();
    const before = Date.now();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "c",
        ...(extra as Record<string, string>),
      }),
    });

    expect(response.statusCode).toBe(200);
    const [, update] = updateSpy.mock.calls[0] as [
      unknown,
      { $set: { pubsubExpiresAt: Date } },
    ];
    const leaseMs = update.$set.pubsubExpiresAt.getTime() - before;
    expect(leaseMs).toBeGreaterThanOrEqual(expectedMs - 5_000);
    expect(leaseMs).toBeLessThanOrEqual(expectedMs + 5_000);
    await app.close();
  });

  it("rejects an unsubscribe verification and ignores a denial", async () => {
    const updateSpy = jest.spyOn(ChannelModel, "updateOne");
    const app = await buildServer();

    const unsubscribed = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "unsubscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "c",
      }),
    });
    const denied = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "denied",
        "hub.topic": topicForChannel("UCabc"),
      }),
    });

    expect(unsubscribed.statusCode).toBe(404);
    expect(denied.statusCode).toBe(200);
    expect(updateSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a topic that is not a youtube feed topic", async () => {
    const findSpy = jest.spyOn(ChannelModel, "findOne");
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": "https://evil.example/?channel_id=UCabc",
        "hub.challenge": "c",
      }),
    });

    expect(response.statusCode).toBe(404);
    expect(findSpy).not.toHaveBeenCalled();
    await app.close();
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `npm run test -- src/modules/youtube-pubsub/routes.spec.ts`
Expected: FAIL，錯誤是找不到模組 `./routes.js`。

- [ ] **Step 3: 寫實作（只含 GET）**

Create `src/modules/youtube-pubsub/routes.ts`:

```ts
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import {
  PUBSUB_DEFAULT_LEASE_MS,
  PUBSUB_MAX_LEASE_MS,
  PUBSUB_REQUEST_COOLDOWN_MS,
} from "../../constants.js";
import ChannelModel from "../../models/Channel.js";
import { channelIdFromTopic, getCallbackToken } from "./hub-client.js";

type TokenParams = { token: string };

type HubQuery = {
  "hub.mode"?: string;
  "hub.topic"?: string;
  "hub.challenge"?: string;
  "hub.lease_seconds"?: string;
};

function tokenMatches(candidate: string): boolean {
  const expected = Buffer.from(getCallbackToken());
  const actual = Buffer.from(candidate ?? "");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/** hub 給的 lease 只有驗證過才採用，異常值不能把頻道推到永遠不續訂。 */
function leaseMsFrom(raw: string | undefined): number {
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return PUBSUB_DEFAULT_LEASE_MS;
  }
  return Math.min(seconds * 1000, PUBSUB_MAX_LEASE_MS);
}

async function handleVerification(
  request: FastifyRequest<{ Params: TokenParams; Querystring: HubQuery }>,
  reply: FastifyReply
): Promise<void> {
  if (!tokenMatches(request.params.token)) {
    console.warn("Pubsub verification with an unknown callback token");
    reply.code(404).type("text/plain").send("not found");
    return;
  }

  const mode = request.query["hub.mode"];
  const channelId = channelIdFromTopic(request.query["hub.topic"]);

  if (mode === "denied") {
    // 只記錄：pubsubRequestedAt 已經更新過，冷卻本身就是退避。
    console.warn(`Pubsub subscription denied: ${channelId ?? "unknown topic"}`);
    reply.code(200).type("text/plain").send("ok");
    return;
  }

  // 本服務沒有主動退訂的流程，所以不接受 unsubscribe 的驗證。
  if (mode !== "subscribe" || !channelId) {
    console.warn(
      `Pubsub verification rejected (mode=${mode ?? "none"}, topic=${
        request.query["hub.topic"] ?? "none"
      })`
    );
    reply.code(404).type("text/plain").send("not found");
    return;
  }

  // 只接受我們最近真的請求過的頻道：這個 GET 沒有簽章，時間窗是唯一的關聯依據。
  const channel = await ChannelModel.findOne({
    id: channelId,
    pubsubRequestedAt: {
      $gte: new Date(Date.now() - PUBSUB_REQUEST_COOLDOWN_MS),
    },
  });
  if (!channel) {
    console.warn(
      `Pubsub verification for an unrequested channel: ${channelId}`
    );
    reply.code(404).type("text/plain").send("not found");
    return;
  }

  const challenge = request.query["hub.challenge"] ?? "";
  // 先回 challenge、再寫到期時間。反過來的話，一個沒送達的回應會留下「我們以為
  // 訂閱成功、hub 其實沒建立」的狀態，而規範沒有規定 hub 會重試 verification。
  reply.code(200).type("text/plain").send(challenge);

  const expiresAt = new Date(
    Date.now() + leaseMsFrom(request.query["hub.lease_seconds"])
  );
  try {
    await ChannelModel.updateOne(
      { id: channelId },
      { $set: { pubsubExpiresAt: expiresAt } }
    );
    console.log(
      `Subscribed: ${channelId} (expires=${expiresAt.toISOString()})`
    );
  } catch (error) {
    // 寫不進去只會讓這個頻道在冷卻後被重訂一次，hub 端是冪等的。
    console.warn(`Pubsub expiry write failed for ${channelId}:`, error);
  }
}

export const pubsubRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: TokenParams; Querystring: HubQuery }>(
    "/notifications/youtube/:token",
    handleVerification
  );
};
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- src/modules/youtube-pubsub/routes.spec.ts`
Expected: 9 個測試全部 PASS（`it.each` 展開成 4 個）。

- [ ] **Step 5: 型別檢查與 lint**

Run: `npm run build && npm run lint`
Expected: 兩者都無錯誤結束。

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube-pubsub/routes.ts src/modules/youtube-pubsub/routes.spec.ts
git commit -m "feat(pubsub): verify hub challenges against a callback token"
```

---

### Task 8: 通知 POST route

**Files:**

- Modify: `src/modules/youtube-pubsub/routes.ts`
- Test: `src/modules/youtube-pubsub/routes.spec.ts`（附加一個 describe）

- [ ] **Step 1: 寫失敗的測試**

在 `src/modules/youtube-pubsub/routes.spec.ts` 檔尾附加：

```ts
function signedFeed(
  body: string,
  secret = "test-secret"
): Record<string, string> {
  const digest = crypto.createHmac("sha1", secret).update(body).digest("hex");
  return {
    "content-type": "application/atom+xml",
    "x-hub-signature": `sha1=${digest}`,
  };
}

function notificationBody(...ids: string[]): string {
  const entries = ids
    .map(
      (id) => `<entry>
        <yt:videoId>${id}</yt:videoId>
        <yt:channelId>UCchannel</yt:channelId>
        <title>Title ${id}</title>
        <link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>
        <author><name>A Channel</name><uri>https://www.youtube.com/channel/UCchannel</uri></author>
      </entry>`
    )
    .join("");
  return `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:at="http://purl.org/atompub/tombstones/1.0"
      xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
}

describe("notification POST", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockNoticeFromNotification.mockReset();
    mockUpdateVideoFromYoutube.mockReset();
  });

  it("writes a new video and then fetches its metadata", async () => {
    mockNoticeFromNotification.mockResolvedValue({
      upsertedCount: 1,
      modifiedCount: 0,
    });
    mockUpdateVideoFromYoutube.mockResolvedValue([]);
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(mockNoticeFromNotification).toHaveBeenCalledWith({
      video: { id: "vid1", title: "Title vid1" },
      channel: { id: "UCchannel" },
    });
    expect(mockUpdateVideoFromYoutube).toHaveBeenCalledWith(["vid1"]);
    await app.close();
  });

  it("writes every entry of a multi-entry notification", async () => {
    mockNoticeFromNotification.mockResolvedValue({
      upsertedCount: 1,
      modifiedCount: 0,
    });
    mockUpdateVideoFromYoutube.mockResolvedValue([]);
    const app = await buildServer();
    const body = notificationBody("vid1", "vid2");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(
      mockNoticeFromNotification.mock.calls.map(
        (call) => (call[0] as { video: { id: string } }).video.id
      )
    ).toEqual(["vid1", "vid2"]);
    expect(mockUpdateVideoFromYoutube).toHaveBeenCalledWith(["vid1", "vid2"]);
    await app.close();
  });

  it("returns 500 when a write fails, and a replay then completes it", async () => {
    // stateful fake：第一次第二筆失敗，重送時兩筆都成功寫入。
    const written = new Set<string>();
    let failNext = true;
    mockNoticeFromNotification.mockImplementation((async (input: {
      video: { id: string };
    }) => {
      if (input.video.id === "vid2" && failNext) {
        failNext = false;
        throw new Error("write failed");
      }
      written.add(input.video.id);
      return { upsertedCount: 1, modifiedCount: 0 };
    }) as never);
    mockUpdateVideoFromYoutube.mockResolvedValue([]);
    const app = await buildServer();
    const body = notificationBody("vid1", "vid2");

    const first = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });
    expect(first.statusCode).toBe(500);
    expect([...written]).toEqual(["vid1"]);

    const second = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });
    expect(second.statusCode).toBe(200);
    expect([...written].sort()).toEqual(["vid1", "vid2"]);
    await app.close();
  });

  it("still answers 200 when the metadata fetch never resolves", async () => {
    mockNoticeFromNotification.mockResolvedValue({
      upsertedCount: 1,
      modifiedCount: 0,
    });
    // 永遠不 resolve：enrichment 不能擋住寫入或回應。
    mockUpdateVideoFromYoutube.mockImplementation(
      () => new Promise<never>(() => {})
    );
    const app = await buildServer();
    const body = notificationBody("vid1", "vid2");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(mockNoticeFromNotification).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("returns 200 when the metadata fetch rejects", async () => {
    mockNoticeFromNotification.mockResolvedValue({
      upsertedCount: 1,
      modifiedCount: 0,
    });
    mockUpdateVideoFromYoutube.mockRejectedValue(new Error("quota"));
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("ignores a body whose signature does not match, with 200", async () => {
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body, "wrong-secret"),
      payload: body,
    });

    // 非 2xx 只會讓 hub 反覆重送同一筆永遠不會變有效的通知。
    expect(response.statusCode).toBe(200);
    expect(mockNoticeFromNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a body with no signature", async () => {
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: { "content-type": "application/atom+xml" },
      payload: body,
    });

    expect(response.statusCode).toBe(403);
    expect(mockNoticeFromNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("acknowledges a deletion feed without writing anything", async () => {
    const app = await buildServer();
    const body = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:at="http://purl.org/atompub/tombstones/1.0" xmlns="http://www.w3.org/2005/Atom">
  <at:deleted-entry ref="yt:video:gone" when="2026-09-17T01:00:00+00:00"/>
</feed>`;

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(mockNoticeFromNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("acknowledges a body that is not a feed", async () => {
    const app = await buildServer();
    const body = "<html><body>nope</body></html>";

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(mockNoticeFromNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a notification on the tokenless legacy path", async () => {
    mockNoticeFromNotification.mockResolvedValue({
      upsertedCount: 0,
      modifiedCount: 1,
    });
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: "/notifications/youtube",
      headers: signedFeed(body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(mockNoticeFromNotification).toHaveBeenCalledTimes(1);
    // 已經看過的影片不需要再抓一次 metadata。
    expect(mockUpdateVideoFromYoutube).not.toHaveBeenCalled();
    await app.close();
  });
});
```

同時把測試檔頂端的 import 補上 `crypto`（在既有的 `import fastify from "fastify";`
之後）：

```ts
import crypto from "node:crypto";
```

- [ ] **Step 2: 跑測試確認新測試失敗**

Run: `npm run test -- src/modules/youtube-pubsub/routes.spec.ts`
Expected: Task 7 的測試仍 PASS；新的 `notification POST` 測試 FAIL（POST 路徑
回 404，因為還沒註冊）。

- [ ] **Step 3: 加入 POST handler 與 content type parser**

在 `src/modules/youtube-pubsub/routes.ts` 的 import 區補上：

```ts
import VideoModel from "../../models/Video.js";
import { updateVideoFromYoutube } from "../youtube.js";
import { parseNotification } from "./atom.js";
```

並在 import 區的 constants 補上 `YOUTUBE_PUBSUB_SECRET`：

```ts
import {
  PUBSUB_DEFAULT_LEASE_MS,
  PUBSUB_MAX_LEASE_MS,
  PUBSUB_REQUEST_COOLDOWN_MS,
  YOUTUBE_PUBSUB_SECRET,
} from "../../constants.js";
```

在 `handleVerification` 之後加入簽章驗證與通知 handler：

```ts
/**
 * 用 hub.secret 重算投遞 body 的 HMAC 並比對 X-Hub-Signature。演算法由 header
 * 指定（`sha1=` / `sha256=`），不認識的演算法一律視為不符。
 */
function signatureMatches(header: string, body: string): boolean {
  if (!YOUTUBE_PUBSUB_SECRET) return false;
  const separator = header.indexOf("=");
  if (separator <= 0) return false;
  const algorithm = header.slice(0, separator).toLowerCase();
  const signature = header.slice(separator + 1).toLowerCase();

  let digest: string;
  try {
    digest = crypto
      .createHmac(algorithm, YOUTUBE_PUBSUB_SECRET)
      .update(body)
      .digest("hex");
  } catch {
    return false;
  }

  const expected = Buffer.from(digest, "hex");
  const actual = Buffer.from(signature, "hex");
  if (actual.length === 0 || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

async function handleNotification(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const body = typeof request.body === "string" ? request.body : "";
  const signature = request.headers["x-hub-signature"];

  if (typeof signature !== "string" || signature.length === 0) {
    console.warn("Pubsub notification without a signature");
    reply.code(403).type("text/plain").send("forbidden");
    return;
  }
  if (!signatureMatches(signature, body)) {
    // 回 200 而不是 4xx：非 2xx 只會讓 hub 在它自己的上限內反覆重送同一筆永遠不會
    // 變有效的通知（重送失敗不會導致退訂）。
    console.warn("Pubsub notification signature mismatch");
    reply.code(200).type("text/plain").send("ok");
    return;
  }

  const entries = parseNotification(body);
  if (!entries) {
    console.warn("Pubsub notification body is not a feed");
    reply.code(200).type("text/plain").send("ok");
    return;
  }

  // 第一階段：只碰資料庫，把每一筆影片都寫進去。
  const newVideoIds: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "video") continue;
    try {
      const result = await VideoModel.noticeFromNotification({
        video: { id: entry.videoId, title: entry.title },
        channel: { id: entry.channelId },
      });
      const channelLabel = entry.channelName
        ? `${entry.channelName} (${entry.channelId})`
        : entry.channelId;
      if (result.upsertedCount > 0) {
        console.log(
          `Pubsub: ${channelLabel} new video: [${entry.videoId}] ${entry.title}`
        );
        newVideoIds.push(entry.videoId);
      } else if (result.modifiedCount > 0) {
        console.log(
          `Pubsub: ${channelLabel} already seen this video: [${entry.videoId}] ${entry.title}`
        );
      }
    } catch (error) {
      // 回 500 讓 hub 重送：影片文件進不了資料庫的話，沒有任何其他機制會重新發現
      // 一個普通上傳（候選查詢都要求文件已存在，Holodex 輪詢只涵蓋直播）。重送是
      // 安全的，noticeFromNotification 是 upsert。
      console.error(
        `Pubsub notification write failed for [${entry.videoId}]:`,
        error
      );
      reply.code(500).type("text/plain").send("write failed");
      return;
    }
  }

  reply.code(200).type("text/plain").send("ok");

  // 第二階段：回應之後才補 metadata。這個呼叫會 await YouTube Data API，夾在上面
  // 的迴圈裡的話，一次慢回應就會把後面的 entry 擋在資料庫外面。必須 catch——回應
  // 之後未處理的 rejection 會讓整個 process 退出。
  if (newVideoIds.length > 0) {
    try {
      await updateVideoFromYoutube(newVideoIds);
    } catch (error) {
      console.warn(
        `Pubsub metadata fetch failed for [${newVideoIds.join(", ")}]:`,
        error
      );
    }
  }
}
```

把 plugin 改成註冊 parser 與三條 route：

```ts
export const pubsubRoutes: FastifyPluginAsync = async (fastify) => {
  // parseAs: "string" 時 parser 的第二個參數就是原始 body，而它的回傳值會成為
  // request.body——直接回傳原字串，HMAC 要簽的就是它，不需要另外掛 rawBody。
  // 這個 parser 註冊在 register() 建立的 scope 內，不會影響其他 route。
  fastify.addContentTypeParser(
    ["application/atom+xml", "text/xml"],
    { parseAs: "string" },
    async (_request, body) => body
  );

  fastify.get<{ Params: TokenParams; Querystring: HubQuery }>(
    "/notifications/youtube/:token",
    handleVerification
  );

  fastify.post("/notifications/youtube/:token", handleNotification);

  // 無 token 的舊路徑：改變 callback URL 會讓 hub 端既有訂閱與新訂閱並存，保留
  // 這條路徑，既有訂閱的通知在上線瞬間才不會中斷。投遞本身有簽章可驗，所以這裡
  // 不驗 token。舊訂閱的 lease 全部過期後（最長 5 天）就可以移除。
  fastify.post("/notifications/youtube", handleNotification);
};
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- src/modules/youtube-pubsub/routes.spec.ts`
Expected: 全部 PASS（Task 7 的 9 個 + 本 Task 的 10 個）。

- [ ] **Step 5: 型別檢查與 lint**

Run: `npm run build && npm run lint`
Expected: 兩者都無錯誤結束。

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube-pubsub/routes.ts src/modules/youtube-pubsub/routes.spec.ts
git commit -m "feat(pubsub): receive notifications with hmac checks and retryable writes"
```

---

### Task 9: YouTube API 逾時

**Files:**

- Modify: `src/modules/youtube.ts:13-24`
- Test: `src/modules/youtube.spec.ts`

- [ ] **Step 1: 讓既有的 mock 記錄呼叫參數，並寫失敗的測試**

在 `src/modules/youtube.spec.ts` 中，把 `googleapis` 的 mock 改成用 `jest.fn`
包住 `youtube`（原本是箭頭函式，無法斷言參數）：

```ts
const mockYoutube = jest.fn(() => ({
  videos: { list: mockVideosList },
  channels: { list: mockChannelsList },
}));

jest.unstable_mockModule("googleapis", () => ({
  google: { youtube: mockYoutube },
}));
```

在動態 import 區補上要斷言的常數與工廠函式：

```ts
const { getYoutubeApi, updateVideoFromYoutube, updateChannelFromYoutube } =
  await import("./youtube.js");
const { YOUTUBE_API_TIMEOUT_MS } = await import("../constants.js");
```

在檔尾附加：

```ts
describe("getYoutubeApi", () => {
  it("builds the client with an explicit request timeout", () => {
    getYoutubeApi();

    expect(mockYoutube).toHaveBeenCalledWith({
      version: "v3",
      auth: "test-key",
      timeout: YOUTUBE_API_TIMEOUT_MS,
    });
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `npm run test -- src/modules/youtube.spec.ts`
Expected: 新測試 FAIL —— 實際呼叫參數缺少 `timeout`。

- [ ] **Step 3: 加上 timeout**

`src/modules/youtube.ts`：import 區加入常數

```ts
import { GOOGLE_API_KEY, YOUTUBE_API_TIMEOUT_MS } from "../constants.js";
```

（若該檔的 import 已有 `GOOGLE_API_KEY`，只要把 `YOUTUBE_API_TIMEOUT_MS`
加進同一個 import 的大括號即可。）

把 client 的建立改成：

```ts
youtubeApi = google.youtube({
  version: "v3",
  auth: GOOGLE_API_KEY,
  // gaxios 沒有預設逾時（只有傳入 timeout 時才會建立 AbortSignal），不設的話
  // 一個掛住的請求會讓呼叫它的 job 永遠不結束。這是唯一建立 client 的地方，
  // 所以這一行涵蓋所有 YouTube API 呼叫。
  timeout: YOUTUBE_API_TIMEOUT_MS,
});
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- src/modules/youtube.spec.ts`
Expected: 既有測試與新測試全部 PASS。

- [ ] **Step 5: 型別檢查與 lint**

Run: `npm run build && npm run lint`
Expected: 兩者都無錯誤結束。

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube.ts src/modules/youtube.spec.ts
git commit -m "fix(youtube): bound every api call with an explicit timeout"
```

---

### Task 10: crawler 改組裝

**Files:**

- Modify: `src/commands/crawler.ts`（import 區、`runCrawler` 開頭、pubsub region）

- [ ] **Step 1: 換掉 import**

移除這兩行：

```ts
import fastifyExpress from "@fastify/express";
import YouTubeNotifier from "youtube-notification";
```

在既有 import 區加入（維持原本的字母順序風格）：

```ts
import { renewPubsubSubscriptions } from "../components/pubsub-subscribe.js";
import { pubsubRoutes } from "../modules/youtube-pubsub/routes.js";
```

- [ ] **Step 2: 在 `app.init()` 之前註冊 plugin**

把 `runCrawler` 開頭這段：

```ts
const { server: fastify } = app.http;
await fastify.register(fastifyExpress);

await app.init();
```

改成：

```ts
const { server: fastify } = app.http;

// 沒有公開位址或沒有 secret 就不啟用 pubsub：callback URL 與簽章驗證都需要它們。
const enabledYtPubsub = !!PUBLIC_BASE_URL && !!YOUTUBE_PUBSUB_SECRET;
if (enabledYtPubsub) {
  // Routes must be registered before HttpServerModule.init() calls listen():
  // fastify refuses to add routes once it is listening.
  await fastify.register(pubsubRoutes);
  // 通知量很大，每筆都印一行 request log 會淹掉其他訊息。比對是 startsWith，
  // 所以帶 token 的路徑也涵蓋在內。
  app.http.addNoLogRoute("/notifications/youtube");
}

await app.init();
```

- [ ] **Step 3: 換掉整個 pubsub region**

把 `//#region youtube pubsub` 到 `//#endregion youtube pubsub` 之間的全部內容
（`YouTubeNotifier` 實例、`fastify.use(...)`、舊的 job、四個事件監聽器）換成：

```ts
//#region youtube pubsub

if (enabledYtPubsub) {
  const JOB_YOUTUBE_PUBSUB_SUBSCRIBE = "crawler youtube pubsub subscribe";
  agenda.define(
    JOB_YOUTUBE_PUBSUB_SUBSCRIBE,
    async (_job: Job): Promise<void> => {
      await renewPubsubSubscriptions();
    }
  );
  // 高頻小批次：一輪只處理少數即將到期的頻道，所以一次崩潰或限流的損失上限就是
  // 那幾個頻道，而且十分鐘後的下一輪就會接上。
  void agenda.every("10 minutes", JOB_YOUTUBE_PUBSUB_SUBSCRIBE);
}

//#endregion youtube pubsub
```

- [ ] **Step 4: 確認沒有殘留的參照**

Run:

```bash
grep -n "YouTubeNotifier\|ytNotifier\|fastifyExpress\|YOUTUBE_PUBSUB_SECRET\|PUBLIC_BASE_URL" src/commands/crawler.ts
```

Expected: 只剩 `PUBLIC_BASE_URL` 與 `YOUTUBE_PUBSUB_SECRET` 出現在 import 區與
`enabledYtPubsub` 那一行；沒有任何 `YouTubeNotifier` / `ytNotifier` /
`fastifyExpress`。

- [ ] **Step 5: 型別檢查與 lint**

Run: `npm run build && npm run lint`
Expected: 兩者都無錯誤結束。

- [ ] **Step 6: 跑全部測試**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/commands/crawler.ts
git commit -m "feat(crawler): renew pubsub every ten minutes via native routes"
```

---

### Task 11: 移除舊依賴與型別宣告

**Files:**

- Delete: `src/types/youtube-notification.d.ts`
- Modify: `package.json`

- [ ] **Step 1: 確認沒有任何地方還在用它們**

Run:

```bash
grep -rn "youtube-notification\|@fastify/express" src/ || echo "NO REFERENCES"
```

Expected: `NO REFERENCES`。

- [ ] **Step 2: 刪除手寫的型別宣告**

Run:

```bash
git rm src/types/youtube-notification.d.ts
```

- [ ] **Step 3: 移除依賴**

Run:

```bash
npm uninstall youtube-notification @fastify/express
```

- [ ] **Step 4: 完整驗證**

Run: `npm run build && npm run lint && npm test`
Expected: 三者都無錯誤結束、測試全部 PASS。

- [ ] **Step 5: 確認 express 與舊 axios 已離開 crawler 的依賴樹**

Run:

```bash
node -e "const p=require('./package.json'); console.log('youtube-notification:', p.dependencies['youtube-notification'], '@fastify/express:', p.dependencies['@fastify/express'])"
```

Expected: 兩者都是 `undefined`。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/types/youtube-notification.d.ts
git commit -m "chore: drop youtube-notification and the express adapter"
```

---

## 上線後的檢查

部署後（不屬於任何 Task，但是這次變更是否成功的判準）：

1. `[crawler youtube pubsub subscribe] starting` / `successed` 每 10 分鐘一對，
   且 `successed` 真的出現——舊行為是 starting 之後再也沒有 successed。
2. log 出現 `Subscribing:` 與對應的 `Subscribed: <channelId> (expires=...)`。
3. `db.agendaJobs.findOne({ name: "crawler youtube pubsub subscribe" })` 的
   `lastFinishedAt` 開始跟著 `lastRunAt` 前進。
4. 約 6 小時後，`db.channels.countDocuments({ pubsubExpiresAt: null })` 在
   subscribed 頻道中趨近 0。
5. `CLI got unhandledRejection` 不再出現。
