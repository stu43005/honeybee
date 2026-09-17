# YouTube PubSubHubbub Subscription Renewal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `crawler youtube pubsub subscribe` from "rescan every channel every
12 hours, and kill the whole crawler process halfway through" into "renew a few
soon-to-expire channels every 10 minutes", with this repo owning the
PubSubHubbub subscribe requests and notification handling.

**Architecture:** `Channel` gains two timestamps, `pubsubRequestedAt` and
`pubsubExpiresAt`, and renewal is driven by imminent expiry. Subscribe requests
go through our own axios client, so failures are catchable and classifiable.
Notifications arrive on native fastify routes that do their own HMAC check and
Atom parsing. `youtube-notification` and `@fastify/express` are removed.

**Tech Stack:** TypeScript (ESM, NodeNext), fastify 4.26, axios 1.x,
fast-xml-parser, agenda 6.2, mongoose/typegoose, Jest 29 (true ESM, so module
mocks use `jest.unstable_mockModule`).

---

## File Structure

**New**

| File                                       | Responsibility                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/modules/youtube-pubsub/hub-client.ts` | Build the callback URL and token, send subscribe requests, classify failures as http/timeout/network and whether they are throttling |
| `src/modules/youtube-pubsub/atom.ts`       | Parse a notification body into an array of entries (pure function)                                                                   |
| `src/modules/youtube-pubsub/routes.ts`     | Fastify plugin: content-type parser, verification GET, notification POST                                                             |
| `src/components/pubsub-subscribe.ts`       | The expiry-driven batch renewal, i.e. the agenda job's implementation                                                                |

Each new file gets an adjacent `*.spec.ts`. `hub-client.ts` also gets
`hub-client-misconfig.spec.ts`, because environment variables are frozen at
module-eval time and the broken-configuration case therefore needs its own file.

**Modified**

| File                          | Change                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/constants.ts`            | Eight new constants                                                                                                        |
| `src/models/Channel.ts`       | Two new fields, one compound index, one candidate-query static                                                             |
| `src/modules/youtube.ts`      | `getYoutubeApi()` gets a global timeout                                                                                    |
| `src/modules/youtube.spec.ts` | Assert the client is built with that timeout                                                                               |
| `src/commands/crawler.ts`     | Drop `YouTubeNotifier` and the express adapter, register the plugin before `app.init()`, schedule the job every 10 minutes |
| `package.json`                | Add `fast-xml-parser`; drop `youtube-notification`, `@fastify/express` and the resolution that existed only for them       |

**New documentation:** `docs/runbooks/pubsub-callback-rotation.md`

**Deleted:** `src/types/youtube-notification.d.ts`

---

### Task 1: Install fast-xml-parser

**Files:**

- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Confirm it is not declared as a dependency yet**

Run:

```bash
node -e "const p=require('./package.json'); console.log('dep:', p.dependencies['fast-xml-parser'] ?? 'NOT DECLARED')"
```

Expected: `dep: NOT DECLARED`.

The check is against the `package.json` declaration rather than the presence of
`node_modules/fast-xml-parser`: the package can be sitting in `node_modules` for
unrelated reasons without being a dependency of this project. If a version
string is already printed, skip Step 2.

- [ ] **Step 2: Install as a runtime dependency**

Run:

```bash
npm install fast-xml-parser
```

The crawler imports it at production runtime, so it must land in `dependencies`
(which is what `npm install` without `-D` does). Do not pin a version; let npm
write its own caret range.

- [ ] **Step 3: Confirm where it landed**

Run:

```bash
node -e "const p=require('./package.json'); console.log('dep:', p.dependencies['fast-xml-parser'], 'devDep:', p.devDependencies['fast-xml-parser'])"
```

Expected: `dep:` shows a version string and `devDep: undefined`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add fast-xml-parser for pubsub notification parsing"
```

---

### Task 2: Add the constants

**Files:**

- Modify: `src/constants.ts` (append at the end of the file)

- [ ] **Step 1: Append the constants block**

Append to `src/constants.ts`:

```ts
// --- YouTube PubSubHubbub subscription renewal ---

// Renew a day before the lease ends, so a full day of scheduling outage still
// does not drop a subscription.
export const PUBSUB_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

// Shortest retry interval for one channel, and also the window in which a
// verification is accepted. Deliberately larger than the 10 minute schedule
// interval so candidates rotate instead of the same batch retrying back to back.
export const PUBSUB_REQUEST_COOLDOWN_MS = 15 * 60 * 1000;

// Channels handled per round, which is also the loss ceiling of one crash or
// one throttling response.
export const PUBSUB_RENEW_BATCH_SIZE = 5;

// Gap between two hub requests inside a round.
export const PUBSUB_REQUEST_SPACING_MS = 250;

// Fallback when the hub supplies no lease_seconds, or an invalid one. Keeps the
// channel on a renewal cycle instead of never being renewed again.
export const PUBSUB_DEFAULT_LEASE_MS = 24 * 60 * 60 * 1000;

// Upper bound for lease_seconds. The WebSub security section recommends short
// leases and gives 10 days as a good default; anything above is clamped so a
// bogus or forged value cannot push a channel out of renewal indefinitely.
export const PUBSUB_MAX_LEASE_MS = 10 * 24 * 60 * 60 * 1000;

// Timeout for a single hub request. axios defaults to timeout: 0 (wait
// forever), so without this a hung connection never lets the round finish.
export const PUBSUB_REQUEST_TIMEOUT_MS = 10 * 1000;

// Timeout for every YouTube Data API call. gaxios has no default timeout (it
// only builds an AbortSignal when one is passed), so an unanswered request can
// hang forever. Looser than the hub request because one call carries up to 50
// ids; still far below agenda's 10 minute lockLifetime.
export const YOUTUBE_API_TIMEOUT_MS = 15 * 1000;
```

- [ ] **Step 2: Type check**

Run: `npm run build`
Expected: exits without errors.

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat(constants): add pubsub renewal and youtube api timeout values"
```

---

### Task 3: Atom notification parsing

**Files:**

- Create: `src/modules/youtube-pubsub/atom.ts`
- Test: `src/modules/youtube-pubsub/atom.spec.ts`

- [ ] **Step 1: Write the failing test**

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
        `<entry><yt:channelId>UCchannel</yt:channelId><title>No video id</title></entry>` +
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

  it("returns null for malformed xml that still looks like a feed", () => {
    // Unclosed entry: without validation the parser would happily return a
    // plausible-looking result for this.
    expect(
      parseNotification(
        `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>vid1</yt:videoId>`
      )
    ).toBeNull();

    // Mismatched tags.
    expect(
      parseNotification(`<feed><entry><title>First</entry></title></feed>`)
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- src/modules/youtube-pubsub/atom.spec.ts`
Expected: FAIL, because the module `./atom.js` does not exist.

- [ ] **Step 3: Write the implementation**

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

// removeNSPrefix turns yt:videoId / at:deleted-entry into videoId /
// deleted-entry; ignoreAttributes: false is what exposes a link's href;
// parseTagValue: false keeps every text node a string, otherwise a title or id
// like "2026" would arrive as a number.
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  parseTagValue: false,
});

// A repeated element is an array and a single one is an object, so both shapes
// have to go down the same path.
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
 * Parses the body of one PubSubHubbub notification into an array of entries.
 * Returns null when the body is not a feed (or not well-formed XML).
 *
 * Video entries come first, in feed order, and deletions follow: the two are
 * different element names, so their original interleaving cannot be recovered
 * after parsing.
 */
export function parseNotification(xml: string): NotificationEntry[] | null {
  let parsed: unknown;
  try {
    // The second argument is the validation switch. Passing true validates with
    // default options and throws on malformed input; omitting it skips
    // validation entirely, and an unclosed or mismatched document would then be
    // parsed into a plausible-looking result.
    parsed = parser.parse(xml, true);
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
    // Without these three there is no valid video document to write (title is
    // required and an empty string fails the validator), so skipping beats
    // writing a document that can never be saved again.
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

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- src/modules/youtube-pubsub/atom.spec.ts`
Expected: all 8 tests PASS.

- [ ] **Step 5: Type check and lint**

Run: `npm run build && npm run lint`
Expected: both exit without errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube-pubsub/atom.ts src/modules/youtube-pubsub/atom.spec.ts
git commit -m "feat(pubsub): parse a notification body into an entry array"
```

---

### Task 4: Hub client (subscribe requests and failure classification)

**Files:**

- Create: `src/modules/youtube-pubsub/hub-client.ts`
- Test: `src/modules/youtube-pubsub/hub-client.spec.ts`
- Test: `src/modules/youtube-pubsub/hub-client-misconfig.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/youtube-pubsub/hub-client.spec.ts`:

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { AxiosError } from "axios";
import crypto from "node:crypto";

// constants.ts reads the environment at module-eval time, so these must be set
// before anything imports it.
process.env.PUBLIC_BASE_URL = "https://honeybee.example.test/";
process.env.YOUTUBE_PUBSUB_SECRET = "test-secret";

type PostArgs = [
  url: string,
  body: string,
  config: { headers: Record<string, string>; timeout: number },
];

const mockPost = jest.fn<(...args: PostArgs) => Promise<unknown>>();

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
    // Derived independently here, otherwise a wrong derivation would still pass
    // a shape-only check.
    const expected = crypto
      .createHmac("sha256", "test-secret")
      .update("pubsub-callback")
      .digest("hex")
      .slice(0, 32);

    expect(token).toBe(expected);
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
    jest.useRealTimers();
  });

  it("posts the full subscribe form with an explicit timeout", async () => {
    mockPost.mockResolvedValue({ status: 202 });

    const result = await requestSubscription("UCabc");

    expect(result).toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockPost.mock.calls[0];
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

  it("applies the configured timeout to a transport that never answers", async () => {
    jest.useFakeTimers();
    // A transport that only fails once config.timeout has elapsed: this proves
    // the timeout is really handed down, and that expiry ends up classified as
    // a timeout instead of the call hanging forever.
    mockPost.mockImplementation(
      (_url, _body, config) =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                new AxiosError(
                  `timeout of ${config.timeout}ms exceeded`,
                  "ECONNABORTED"
                )
              ),
            config.timeout
          );
        })
    );

    const pending = requestSubscription("UCabc");
    await jest.advanceTimersByTimeAsync(PUBSUB_REQUEST_TIMEOUT_MS);

    expect(await pending).toEqual({
      ok: false,
      kind: "timeout",
      rateLimited: false,
      message: `timeout of ${PUBSUB_REQUEST_TIMEOUT_MS}ms exceeded`,
    });
  });
});
```

- [ ] **Step 2: Write a second test file for the broken-configuration case**

`constants.ts` copies the environment into constants when it is first evaluated,
so mutating `process.env` later in the same jest file changes nothing. The case
"`PUBLIC_BASE_URL` is not a valid URL" therefore needs its own file, since every
test file gets a fresh module registry.

Create `src/modules/youtube-pubsub/hub-client-misconfig.spec.ts`:

```ts
/// <reference types="jest" />
import { describe, expect, it, jest } from "@jest/globals";

// Set before the import below, so constants.ts picks up this broken base URL.
process.env.PUBLIC_BASE_URL = "not-a-url";
process.env.YOUTUBE_PUBSUB_SECRET = "test-secret";

const mockPost = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("axios", () => {
  const isAxiosError = () => false;
  return { default: { post: mockPost, isAxiosError }, isAxiosError };
});

const { requestSubscription } = await import("./hub-client.js");

describe("requestSubscription with an unusable callback url", () => {
  it("returns a failure instead of rejecting", async () => {
    // new URL("./...", "not-a-url") throws TypeError(ERR_INVALID_URL) before any
    // request goes out. It still has to become a return value: an unhandled
    // rejection would take the whole process down.
    const result = await requestSubscription("UCabc");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("network");
      expect(result.rateLimited).toBe(false);
      expect(result.message).toContain("Invalid URL");
    }
    expect(mockPost).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run both test files and watch them fail**

Run: `npm run test -- src/modules/youtube-pubsub/hub-client.spec.ts src/modules/youtube-pubsub/hub-client-misconfig.spec.ts`
Expected: both files FAIL, because the module `./hub-client.js` does not exist.

- [ ] **Step 4: Write the implementation**

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
      /** http: the hub answered with a status; timeout: it did not answer in time; network: unreachable or a non-HTTP throw. */
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
 * The hub's verification GET carries no signature, so the only thing that can
 * authenticate it is something unguessable that we put into the callback URL
 * ourselves and the hub echoes back verbatim. Derived from the existing secret,
 * so this needs no new environment variable.
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
 * Sends one subscribe request. Every failure is caught and classified here, so
 * the caller always gets a value back: an unhandled rejection would be taken by
 * the process-wide unhandledRejection handler, which exits.
 */
export async function requestSubscription(
  channelId: string
): Promise<SubscribeResult> {
  try {
    assert(YOUTUBE_PUBSUB_SECRET, "YOUTUBE_PUBSUB_SECRET should be defined.");
    // Building the form is inside the try as well: getCallbackUrl() throws a
    // TypeError when PUBLIC_BASE_URL is not a valid URL, and that also has to
    // come back as a value rather than propagate.
    const form = new URLSearchParams({
      "hub.callback": getCallbackUrl(),
      "hub.mode": "subscribe",
      "hub.topic": topicForChannel(channelId),
      "hub.secret": YOUTUBE_PUBSUB_SECRET,
    });

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

- [ ] **Step 5: Run both test files and watch them pass**

Run: `npm run test -- src/modules/youtube-pubsub/hub-client.spec.ts src/modules/youtube-pubsub/hub-client-misconfig.spec.ts`
Expected: all 10 tests across the two files PASS.

- [ ] **Step 6: Type check and lint**

Run: `npm run build && npm run lint`
Expected: both exit without errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/youtube-pubsub/hub-client.ts src/modules/youtube-pubsub/hub-client.spec.ts src/modules/youtube-pubsub/hub-client-misconfig.spec.ts
git commit -m "feat(pubsub): send subscribe requests with a timeout and classified failures"
```

---

### Task 5: Renewal state and candidate query on Channel

**Files:**

- Modify: `src/models/Channel.ts`
- Test: `src/models/Channel.spec.ts` (existing file, append one describe)

- [ ] **Step 1: Write the failing test**

Append to `src/models/Channel.spec.ts`:

```ts
describe("Channel.findPubsubRenewalCandidates", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // findSubscribed() returns a mongoose Query whose and/sort/limit/select all
  // return itself, so a query that records its arguments can assert the chain.
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

  it("asks for channels whose lease is near expiry and that are off cooldown", () => {
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

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- src/models/Channel.spec.ts`
Expected: FAIL with `ChannelModel.findPubsubRenewalCandidates is not a function`.

- [ ] **Step 3: Add the fields, the index and the query**

Add the constants to the import block of `src/models/Channel.ts`:

```ts
import {
  HOLODEX_ALL_VTUBERS,
  HOLODEX_FETCH_ORG,
  PUBSUB_RENEW_BEFORE_MS,
  PUBSUB_REQUEST_COOLDOWN_MS,
} from "../constants.js";
```

Add one compound index after the existing `@index(...)` decorators on the class,
so the candidate query's sort can use an index:

```ts
@index({ pubsubExpiresAt: 1, pubsubRequestedAt: 1 })
```

Add two fields after the `holodexCrawledAt` field:

```ts
  /** When we last sent a subscribe request for this channel to the hub. */
  @prop()
  public pubsubRequestedAt?: Date;

  /** When the subscription expires, derived from the lease the verification carried. */
  @prop()
  public pubsubExpiresAt?: Date;
```

Add the static inside `//#region find methods`, before `waitForCrawl`:

```ts
  /**
   * Channels that need their pubsub subscription renewed: the subscription is
   * near expiry (or was never established), and no request went out recently.
   *
   * The sort puts channels without a `pubsubRequestedAt` (never requested)
   * first and otherwise the least recently requested first, so a channel that
   * always fails drops to the back of the queue after each attempt instead of
   * holding the front of it.
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

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- src/models/Channel.spec.ts`
Expected: the existing tests plus the new one all PASS.

- [ ] **Step 5: Type check and lint**

Run: `npm run build && npm run lint`
Expected: both exit without errors.

- [ ] **Step 6: Commit**

```bash
git add src/models/Channel.ts src/models/Channel.spec.ts
git commit -m "feat(channel): track pubsub request and expiry, query renewal candidates"
```

---

### Task 6: Expiry-driven batch renewal

**Files:**

- Create: `src/components/pubsub-subscribe.ts`
- Test: `src/components/pubsub-subscribe.spec.ts`

- [ ] **Step 1: Write the failing test**

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

const mockRequestSubscription =
  jest.fn<(channelId: string) => Promise<SubscribeResult>>();
const mockSleep = jest.fn<(ms: number) => Promise<void>>();

jest.unstable_mockModule("../modules/youtube-pubsub/hub-client.js", () => ({
  requestSubscription: mockRequestSubscription,
}));

// Sleeping for real would only slow the suite down, and the mock also lets the
// spacing be asserted.
jest.unstable_mockModule("node:timers/promises", () => ({
  setTimeout: mockSleep,
}));

const { default: ChannelModel } = await import("../models/Channel.js");
const { renewPubsubSubscriptions } = await import("./pubsub-subscribe.js");
const { PUBSUB_RENEW_BATCH_SIZE, PUBSUB_REQUEST_SPACING_MS } =
  await import("../constants.js");

// A stateful fake channel collection that records the order of writes.
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
    expect(mockRequestSubscription.mock.calls.map((call) => call[0])).toEqual([
      "UC1",
      "UC2",
      "UC3",
    ]);
    // No need to wait after the last one.
    expect(mockSleep.mock.calls).toEqual([
      [PUBSUB_REQUEST_SPACING_MS],
      [PUBSUB_REQUEST_SPACING_MS],
    ]);
  });

  it("waits for a hanging request, classifies it, and still runs the rest", async () => {
    const { writes } = fakeChannels(["UC1", "UC2", "UC3"]);
    // A request that only settles when released, standing in for a hub that
    // does not answer until the client times out.
    let releaseFirst: ((result: SubscribeResult) => void) | undefined;
    mockRequestSubscription.mockImplementationOnce(
      () =>
        new Promise<SubscribeResult>((resolve) => {
          releaseFirst = resolve;
        })
    );

    const round = renewPubsubSubscriptions();

    // Explicit drain point: while the first request is unsettled the loop
    // cannot have moved on, so the other two candidates are untouched.
    await Promise.resolve();
    expect(writes).toEqual(["UC1"]);
    expect(mockRequestSubscription).toHaveBeenCalledTimes(1);

    releaseFirst?.({
      ok: false,
      kind: "timeout",
      rateLimited: false,
      message: "timeout of 10000ms exceeded",
    });
    await round;

    // A timeout is not throttling, so the round runs to completion.
    expect(writes).toEqual(["UC1", "UC2", "UC3"]);
    expect(mockRequestSubscription.mock.calls.map((call) => call[0])).toEqual([
      "UC1",
      "UC2",
      "UC3",
    ]);
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
    // The fourth and fifth never even get their pubsubRequestedAt written.
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

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- src/components/pubsub-subscribe.spec.ts`
Expected: FAIL, because the module `./pubsub-subscribe.js` does not exist.

- [ ] **Step 3: Write the implementation**

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
 * One renewal round: pick the channels whose subscription is near expiry (or
 * was never established) and send a subscribe request for each.
 *
 * The batch size and the per-request timeout together bound the worst-case
 * runtime well below agenda's lockLifetime, which is why this needs no
 * job.touch().
 */
export async function renewPubsubSubscriptions(): Promise<void> {
  const candidates = await ChannelModel.findPubsubRenewalCandidates(
    PUBSUB_RENEW_BATCH_SIZE
  );

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];

    // Stamped before the request goes out: the hub sometimes verifies before it
    // answers the POST, and stamping first is what keeps a legitimate
    // verification inside the accepted window. It is also written regardless of
    // the outcome, so a channel that always fails drops to the back of the
    // queue instead of holding the front of it and starving real renewals.
    await ChannelModel.updateOne(
      { id: channel.id },
      { $set: { pubsubRequestedAt: new Date() } }
    );
    console.log(`Subscribing: [${channel.id}] ${channel.name}`);

    const result = await requestSubscription(channel.id);
    if (!result.ok) {
      if (result.rateLimited) {
        // Throttling is usually global, so continuing would only keep failing.
        // The remaining candidates are left for the next round.
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

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- src/components/pubsub-subscribe.spec.ts`
Expected: all 7 tests PASS.

- [ ] **Step 5: Type check and lint**

Run: `npm run build && npm run lint`
Expected: both exit without errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/pubsub-subscribe.ts src/components/pubsub-subscribe.spec.ts
git commit -m "feat(pubsub): renew expiring subscriptions in small batches"
```

---

### Task 7: Verification GET route

**Files:**

- Create: `src/modules/youtube-pubsub/routes.ts`
- Test: `src/modules/youtube-pubsub/routes.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/youtube-pubsub/routes.spec.ts`:

```ts
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import fastify from "fastify";
import crypto from "node:crypto";

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

/**
 * A stateful channel store whose findOne actually evaluates the filter, so a
 * missing cooldown condition in the implementation makes these tests fail
 * instead of passing by accident.
 */
function fakeChannelStore(stored: { id: string; pubsubRequestedAt?: Date }[]): {
  updates: { id: string; expiresAt: Date }[];
} {
  jest.spyOn(ChannelModel, "findOne").mockImplementation(((filter: {
    id: string;
    pubsubRequestedAt?: { $gte: Date };
  }) => {
    const found = stored.find((channel) => {
      if (channel.id !== filter.id) return false;
      const cutoff = filter.pubsubRequestedAt?.$gte;
      if (!cutoff) return true;
      return !!channel.pubsubRequestedAt && channel.pubsubRequestedAt >= cutoff;
    });
    return Promise.resolve(found ?? null) as never;
  }) as never);

  const updates: { id: string; expiresAt: Date }[] = [];
  jest.spyOn(ChannelModel, "updateOne").mockImplementation(((
    filter: { id: string },
    update: { $set: { pubsubExpiresAt: Date } }
  ) => {
    updates.push({ id: filter.id, expiresAt: update.$set.pubsubExpiresAt });
    return Promise.resolve({ acknowledged: true }) as never;
  }) as never);

  return { updates };
}

/** Lets the handler finish the work it does after answering the request. */
function drainPostResponseWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("verification GET", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("echoes the challenge and stores the expiry for a channel we just asked about", async () => {
    const { updates } = fakeChannelStore([
      { id: "UCabc", pubsubRequestedAt: new Date() },
    ]);
    const app = await buildServer();
    const before = Date.now();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "challenge-value",
        "hub.lease_seconds": "432000",
      }),
    });
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    // A body that is not exactly the challenge makes the hub treat the
    // verification as failed.
    expect(response.body).toBe("challenge-value");
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("UCabc");
    expect(updates[0].expiresAt.getTime() - before).toBeGreaterThan(
      430_000 * 1000
    );
    await app.close();
  });

  it("rejects a wrong token without touching the database", async () => {
    const { updates } = fakeChannelStore([
      { id: "UCabc", pubsubRequestedAt: new Date() },
    ]);
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
    expect(updates).toHaveLength(0);
    await app.close();
  });

  it("rejects a channel whose request is older than the cooldown", async () => {
    const { updates } = fakeChannelStore([
      {
        id: "UCabc",
        // Stamped long before the accepted window.
        pubsubRequestedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    ]);
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
    expect(updates).toHaveLength(0);
    await app.close();
  });

  it("rejects a channel that was never requested", async () => {
    const { updates } = fakeChannelStore([{ id: "UCabc" }]);
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
    expect(updates).toHaveLength(0);
    await app.close();
  });

  it("rejects a channel we do not have at all", async () => {
    const { updates } = fakeChannelStore([]);
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCother"),
        "hub.challenge": "challenge-value",
      }),
    });

    expect(response.statusCode).toBe(404);
    expect(updates).toHaveLength(0);
    await app.close();
  });

  it("answers the challenge before the expiry is written", async () => {
    jest.spyOn(ChannelModel, "findOne").mockResolvedValue({
      id: "UCabc",
      pubsubRequestedAt: new Date(),
    } as never);
    let releaseWrite: (() => void) | undefined;
    let writeStarted = false;
    let writeFinished = false;
    jest.spyOn(ChannelModel, "updateOne").mockImplementation((() => {
      writeStarted = true;
      return new Promise((resolve) => {
        releaseWrite = () => {
          writeFinished = true;
          resolve({ acknowledged: true });
        };
      }) as never;
    }) as never);
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "challenge-value",
      }),
    });

    // The response is complete while the write is still in flight: that
    // ordering is the point. The reverse order would leave an expiry stored for
    // a subscription the hub never established.
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("challenge-value");
    expect(writeStarted).toBe(true);
    expect(writeFinished).toBe(false);

    releaseWrite?.();
    await drainPostResponseWork();
    expect(writeFinished).toBe(true);
    await app.close();
  });

  it("still answers the challenge when the expiry write fails", async () => {
    jest.spyOn(ChannelModel, "findOne").mockResolvedValue({
      id: "UCabc",
      pubsubRequestedAt: new Date(),
    } as never);
    jest
      .spyOn(ChannelModel, "updateOne")
      .mockRejectedValue(new Error("mongo down") as never);
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: verificationUrl({
        "hub.mode": "subscribe",
        "hub.topic": topicForChannel("UCabc"),
        "hub.challenge": "challenge-value",
      }),
    });
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("challenge-value");
    await app.close();
  });

  it.each([
    ["missing", {}, PUBSUB_DEFAULT_LEASE_MS],
    ["not a number", { "hub.lease_seconds": "soon" }, PUBSUB_DEFAULT_LEASE_MS],
    ["zero", { "hub.lease_seconds": "0" }, PUBSUB_DEFAULT_LEASE_MS],
    ["fractional", { "hub.lease_seconds": "1.5" }, PUBSUB_DEFAULT_LEASE_MS],
    ["over the cap", { "hub.lease_seconds": "99999999" }, PUBSUB_MAX_LEASE_MS],
  ])("handles a lease that is %s", async (_label, extra, expectedMs) => {
    const { updates } = fakeChannelStore([
      { id: "UCabc", pubsubRequestedAt: new Date() },
    ]);
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
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    const leaseMs = updates[0].expiresAt.getTime() - before;
    expect(leaseMs).toBeGreaterThanOrEqual(expectedMs - 5_000);
    expect(leaseMs).toBeLessThanOrEqual(expectedMs + 5_000);
    await app.close();
  });

  it("rejects an unsubscribe verification and ignores a denial", async () => {
    const { updates } = fakeChannelStore([
      { id: "UCabc", pubsubRequestedAt: new Date() },
    ]);
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
    expect(updates).toHaveLength(0);
    await app.close();
  });

  it("rejects a topic that is not a youtube feed topic", async () => {
    fakeChannelStore([{ id: "UCabc", pubsubRequestedAt: new Date() }]);
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

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- src/modules/youtube-pubsub/routes.spec.ts`
Expected: FAIL, because the module `./routes.js` does not exist.

- [ ] **Step 3: Write the implementation (GET only)**

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

/**
 * The lease the hub reports is only used once validated: a bogus value must not
 * be able to push a channel out of renewal indefinitely.
 */
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
    // Logged only: pubsubRequestedAt has already been stamped, and the cooldown
    // is the back-off.
    console.warn(`Pubsub subscription denied: ${channelId ?? "unknown topic"}`);
    reply.code(200).type("text/plain").send("ok");
    return;
  }

  // This service never unsubscribes on purpose, so an unsubscribe verification
  // is not something we should confirm.
  if (mode !== "subscribe" || !channelId) {
    console.warn(
      `Pubsub verification rejected (mode=${mode ?? "none"}, topic=${
        request.query["hub.topic"] ?? "none"
      })`
    );
    reply.code(404).type("text/plain").send("not found");
    return;
  }

  // Only channels we really asked about recently are accepted: this GET carries
  // no signature, so the request window is the only thing that correlates it
  // with a subscription we initiated.
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
  // Answer the challenge first, store the expiry after. The other order leaves
  // a stored expiry for a subscription the hub never established whenever the
  // response fails to arrive, and the spec does not require hubs to retry a
  // verification.
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
    // A failed write only means this channel gets renewed once more after the
    // cooldown, which the hub handles idempotently.
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

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- src/modules/youtube-pubsub/routes.spec.ts`
Expected: all 14 tests PASS (`it.each` expands to 5 of them).

- [ ] **Step 5: Type check and lint**

Run: `npm run build && npm run lint`
Expected: both exit without errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube-pubsub/routes.ts src/modules/youtube-pubsub/routes.spec.ts
git commit -m "feat(pubsub): verify hub challenges against a callback token"
```

---

### Task 8: Notification POST route

**Files:**

- Modify: `src/modules/youtube-pubsub/routes.ts`
- Test: `src/modules/youtube-pubsub/routes.spec.ts` (append one describe)

- [ ] **Step 1: Write the failing test**

Append to `src/modules/youtube-pubsub/routes.spec.ts`:

```ts
function signedFeed(
  body: string,
  options?: { secret?: string; algorithm?: "sha1" | "sha256" }
): Record<string, string> {
  const secret = options?.secret ?? "test-secret";
  const algorithm = options?.algorithm ?? "sha1";
  const digest = crypto
    .createHmac(algorithm, secret)
    .update(body)
    .digest("hex");
  return {
    "content-type": "application/atom+xml",
    "x-hub-signature": `${algorithm}=${digest}`,
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

/**
 * A stateful video store with real upsert semantics: a video that is already
 * there reports as modified rather than inserted, which is what proves a replay
 * completes the missing write instead of creating a duplicate.
 */
function fakeVideoStore(options?: { failOnceFor?: string }) {
  const stored = new Map<string, string>();
  let pendingFailure = options?.failOnceFor;
  mockNoticeFromNotification.mockImplementation((async (input: {
    video: { id: string; title: string };
    channel: { id: string };
  }) => {
    if (input.video.id === pendingFailure) {
      pendingFailure = undefined;
      throw new Error("write failed");
    }
    const existed = stored.has(input.video.id);
    stored.set(input.video.id, input.video.title);
    return existed
      ? { upsertedCount: 0, modifiedCount: 1 }
      : { upsertedCount: 1, modifiedCount: 0 };
  }) as never);
  return { stored };
}

describe("notification POST", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockNoticeFromNotification.mockReset();
    mockUpdateVideoFromYoutube.mockReset();
  });

  it("writes a new video and then fetches its metadata", async () => {
    const { stored } = fakeVideoStore();
    mockUpdateVideoFromYoutube.mockResolvedValue([]);
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    expect(mockNoticeFromNotification).toHaveBeenCalledWith({
      video: { id: "vid1", title: "Title vid1" },
      channel: { id: "UCchannel" },
    });
    expect([...stored]).toEqual([["vid1", "Title vid1"]]);
    expect(mockUpdateVideoFromYoutube).toHaveBeenCalledWith(["vid1"]);
    await app.close();
  });

  it("writes every entry of a multi-entry notification", async () => {
    const { stored } = fakeVideoStore();
    mockUpdateVideoFromYoutube.mockResolvedValue([]);
    const app = await buildServer();
    const body = notificationBody("vid1", "vid2");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    expect(
      mockNoticeFromNotification.mock.calls.map((call) => call[0])
    ).toEqual([
      {
        video: { id: "vid1", title: "Title vid1" },
        channel: { id: "UCchannel" },
      },
      {
        video: { id: "vid2", title: "Title vid2" },
        channel: { id: "UCchannel" },
      },
    ]);
    expect([...stored]).toEqual([
      ["vid1", "Title vid1"],
      ["vid2", "Title vid2"],
    ]);
    expect(mockUpdateVideoFromYoutube).toHaveBeenCalledWith(["vid1", "vid2"]);
    await app.close();
  });

  it("returns 500 when a write fails, and a replay then completes it", async () => {
    const { stored } = fakeVideoStore({ failOnceFor: "vid2" });
    mockUpdateVideoFromYoutube.mockResolvedValue([]);
    const app = await buildServer();
    const body = notificationBody("vid1", "vid2");

    const first = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });
    await drainPostResponseWork();

    expect(first.statusCode).toBe(500);
    expect([...stored.keys()]).toEqual(["vid1"]);
    // A failed delivery must not start enrichment.
    expect(mockUpdateVideoFromYoutube).not.toHaveBeenCalled();

    const second = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });
    await drainPostResponseWork();

    expect(second.statusCode).toBe(200);
    expect([...stored.keys()]).toEqual(["vid1", "vid2"]);
    // vid1 was already stored, so only vid2 counts as new on the replay.
    expect(mockUpdateVideoFromYoutube).toHaveBeenCalledWith(["vid2"]);
    await app.close();
  });

  it("still answers 200 when the metadata fetch never resolves", async () => {
    const { stored } = fakeVideoStore();
    // Never resolves: enrichment must not block the writes or the response.
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
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    expect([...stored.keys()]).toEqual(["vid1", "vid2"]);
    await app.close();
  });

  it("returns 200 when the metadata fetch rejects", async () => {
    const { stored } = fakeVideoStore();
    let rejectionObserved = false;
    mockUpdateVideoFromYoutube.mockImplementation(() => {
      rejectionObserved = true;
      return Promise.reject(new Error("quota"));
    });
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body),
      payload: body,
    });
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    expect(rejectionObserved).toBe(true);
    expect([...stored.keys()]).toEqual(["vid1"]);
    await app.close();
  });

  it("accepts a sha256 signature", async () => {
    const { stored } = fakeVideoStore();
    mockUpdateVideoFromYoutube.mockResolvedValue([]);
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body, { algorithm: "sha256" }),
      payload: body,
    });
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    expect([...stored.keys()]).toEqual(["vid1"]);
    await app.close();
  });

  it("ignores a body whose signature does not match, with 200", async () => {
    fakeVideoStore();
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: signedFeed(body, { secret: "wrong-secret" }),
      payload: body,
    });

    // A non-2xx would only make the hub keep retrying the same notification,
    // which can never become valid.
    expect(response.statusCode).toBe(200);
    expect(mockNoticeFromNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a body with an unknown signature algorithm", async () => {
    fakeVideoStore();
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${token}`,
      headers: {
        "content-type": "application/atom+xml",
        "x-hub-signature": "md9=deadbeef",
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(mockNoticeFromNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a body with no signature", async () => {
    fakeVideoStore();
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
    fakeVideoStore();
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
    fakeVideoStore();
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
    const { stored } = fakeVideoStore();
    // Pre-seed so this delivery counts as already seen.
    stored.set("vid1", "Title vid1");
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: "/notifications/youtube",
      headers: signedFeed(body),
      payload: body,
    });
    await drainPostResponseWork();

    expect(response.statusCode).toBe(200);
    expect(mockNoticeFromNotification).toHaveBeenCalledTimes(1);
    // An already-seen video needs no metadata fetch.
    expect(mockUpdateVideoFromYoutube).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a notification whose path token is wrong, because the signature is what matters", async () => {
    const { stored } = fakeVideoStore();
    mockUpdateVideoFromYoutube.mockResolvedValue([]);
    const app = await buildServer();
    const body = notificationBody("vid1");

    const response = await app.inject({
      method: "POST",
      url: `/notifications/youtube/${"0".repeat(32)}`,
      headers: signedFeed(body),
      payload: body,
    });
    await drainPostResponseWork();

    // Deliveries are authenticated by X-Hub-Signature, so the POST handler
    // deliberately does not check the token.
    expect(response.statusCode).toBe(200);
    expect([...stored.keys()]).toEqual(["vid1"]);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the tests and watch the new ones fail**

Run: `npm run test -- src/modules/youtube-pubsub/routes.spec.ts`
Expected: the Task 7 tests still PASS; the new `notification POST` tests FAIL
(the POST paths answer 404, because they are not registered yet).

- [ ] **Step 3: Add the POST handler and the content type parser**

Add to the import block of `src/modules/youtube-pubsub/routes.ts`:

```ts
import VideoModel from "../../models/Video.js";
import { updateVideoFromYoutube } from "../youtube.js";
import { parseNotification } from "./atom.js";
```

And add `YOUTUBE_PUBSUB_SECRET` to the constants import:

```ts
import {
  PUBSUB_DEFAULT_LEASE_MS,
  PUBSUB_MAX_LEASE_MS,
  PUBSUB_REQUEST_COOLDOWN_MS,
  YOUTUBE_PUBSUB_SECRET,
} from "../../constants.js";
```

Add the signature check and the notification handler after
`handleVerification`:

```ts
/**
 * Recomputes the HMAC of the delivered body with hub.secret and compares it
 * with X-Hub-Signature. The algorithm comes from the header (`sha1=` /
 * `sha256=`); an algorithm we cannot construct counts as a mismatch.
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
    // 200 rather than 4xx: a non-2xx only makes the hub retry the same
    // notification up to its own limit (a failed delivery does not unsubscribe
    // us), and an invalid notification can never become valid.
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

  // First phase: touch the database only, and write every video in the body.
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
      // 500 so the hub redelivers. Nothing else rediscovers an ordinary upload
      // that never reached the videos collection: every candidate query needs
      // the document to exist already, and the Holodex polls only cover
      // streams. Redelivery is safe because noticeFromNotification upserts.
      console.error(
        `Pubsub notification write failed for [${entry.videoId}]:`,
        error
      );
      reply.code(500).type("text/plain").send("write failed");
      return;
    }
  }

  reply.code(200).type("text/plain").send("ok");

  // Second phase, after the response: fetch metadata for the new videos. This
  // awaits the YouTube Data API, and inside the loop above one slow call would
  // keep later entries out of the database. It must be caught as well — an
  // unhandled rejection after the response would still exit the process.
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

Change the plugin so it registers the parser and all three routes:

```ts
export const pubsubRoutes: FastifyPluginAsync = async (fastify) => {
  // With parseAs: "string" the parser's second argument is the raw body, and
  // whatever it hands to done() becomes request.body — returning the raw string
  // is exactly what the HMAC has to be computed over, so no separate rawBody is
  // needed. The callback form is used because an async body that never awaits
  // trips @typescript-eslint/require-await. Registered inside the scope that
  // register() creates, so it does not affect any other route.
  fastify.addContentTypeParser<string>(
    ["application/atom+xml", "text/xml"],
    { parseAs: "string" },
    (_request, body, done) => done(null, body)
  );

  fastify.get<{ Params: TokenParams; Querystring: HubQuery }>(
    "/notifications/youtube/:token",
    handleVerification
  );

  fastify.post("/notifications/youtube/:token", handleNotification);

  // The tokenless legacy path. Changing the callback URL makes the hub keep the
  // existing subscriptions alongside the new ones, and keeping this path is
  // what stops their deliveries from breaking the moment this ships. A delivery
  // authenticates itself with its signature, so this handler does not check the
  // token. Removable once every old lease has expired (at most 5 days).
  fastify.post("/notifications/youtube", handleNotification);
};
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm run test -- src/modules/youtube-pubsub/routes.spec.ts`
Expected: all PASS (14 from Task 7 plus 13 from this task).

- [ ] **Step 5: Type check and lint**

Run: `npm run build && npm run lint`
Expected: both exit without errors. Watch the lint step in particular: writing
the content type parser as an async function with no await fails
`@typescript-eslint/require-await`.

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube-pubsub/routes.ts src/modules/youtube-pubsub/routes.spec.ts
git commit -m "feat(pubsub): receive notifications with hmac checks and retryable writes"
```

---

### Task 9: YouTube API timeout

**Files:**

- Modify: `src/modules/youtube.ts:13-24`
- Test: `src/modules/youtube.spec.ts`

- [ ] **Step 1: Make the existing mock record its arguments, and write the failing test**

In `src/modules/youtube.spec.ts`, wrap `youtube` in a `jest.fn` (it is currently
an arrow function, so its arguments cannot be asserted):

```ts
const mockYoutube = jest.fn(() => ({
  videos: { list: mockVideosList },
  channels: { list: mockChannelsList },
}));

jest.unstable_mockModule("googleapis", () => ({
  google: { youtube: mockYoutube },
}));
```

Add the factory function and the constant to the dynamic import block:

```ts
const { getYoutubeApi, updateVideoFromYoutube, updateChannelFromYoutube } =
  await import("./youtube.js");
const { YOUTUBE_API_TIMEOUT_MS } = await import("../constants.js");
```

Append to the end of the file:

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

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- src/modules/youtube.spec.ts`
Expected: the new test FAILS, because the actual call has no `timeout`.

- [ ] **Step 3: Add the timeout**

In `src/modules/youtube.ts`, add the constant to the import block:

```ts
import { GOOGLE_API_KEY, YOUTUBE_API_TIMEOUT_MS } from "../constants.js";
```

(If that file's import already pulls in `GOOGLE_API_KEY`, just add
`YOUTUBE_API_TIMEOUT_MS` to the same braces.)

Change how the client is built:

```ts
youtubeApi = google.youtube({
  version: "v3",
  auth: GOOGLE_API_KEY,
  // gaxios has no default timeout (it only builds an AbortSignal when one
  // is passed), so without this a hung request never lets the job that made
  // it finish. This is the only place a client is built, so one line covers
  // every YouTube API call.
  timeout: YOUTUBE_API_TIMEOUT_MS,
});
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- src/modules/youtube.spec.ts`
Expected: the existing tests plus the new one all PASS.

- [ ] **Step 5: Type check and lint**

Run: `npm run build && npm run lint`
Expected: both exit without errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube.ts src/modules/youtube.spec.ts
git commit -m "fix(youtube): bound every api call with an explicit timeout"
```

---

### Task 10: Rewire the crawler

**Files:**

- Modify: `src/commands/crawler.ts` (import block, the top of `runCrawler`, the pubsub region)

- [ ] **Step 1: Swap the imports**

Remove these two lines:

```ts
import fastifyExpress from "@fastify/express";
import YouTubeNotifier from "youtube-notification";
```

Add these to the existing import block (keeping its alphabetical style):

```ts
import { renewPubsubSubscriptions } from "../components/pubsub-subscribe.js";
import { pubsubRoutes } from "../modules/youtube-pubsub/routes.js";
```

- [ ] **Step 2: Register the plugin before `app.init()`**

Replace this block at the top of `runCrawler`:

```ts
const { server: fastify } = app.http;
await fastify.register(fastifyExpress);

await app.init();
```

with:

```ts
const { server: fastify } = app.http;

// No public address or no secret means no pubsub: the callback URL and the
// signature check both need them.
const enabledYtPubsub = !!PUBLIC_BASE_URL && !!YOUTUBE_PUBSUB_SECRET;
if (enabledYtPubsub) {
  // Routes must be registered before HttpServerModule.init() calls listen():
  // fastify refuses to add routes once it is listening.
  await fastify.register(pubsubRoutes);
  // Deliveries are frequent, and one request log line each would drown out
  // everything else. The match is a prefix, so the tokenized path is covered.
  app.http.addNoLogRoute("/notifications/youtube");
}

await app.init();
```

- [ ] **Step 3: Replace the whole pubsub region**

Replace everything between `//#region youtube pubsub` and
`//#endregion youtube pubsub` (the `YouTubeNotifier` instance, the
`fastify.use(...)` call, the old job and the four event listeners) with:

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
  // Small batches, often: the loss ceiling of one crash or one throttling
  // response is those few channels, and the next round picks up ten minutes
  // later.
  void agenda.every("10 minutes", JOB_YOUTUBE_PUBSUB_SUBSCRIBE);
}

//#endregion youtube pubsub
```

- [ ] **Step 4: Confirm nothing refers to the old pieces**

Run:

```bash
grep -n "YouTubeNotifier\|ytNotifier\|fastifyExpress\|YOUTUBE_PUBSUB_SECRET\|PUBLIC_BASE_URL" src/commands/crawler.ts
```

Expected: only `PUBLIC_BASE_URL` and `YOUTUBE_PUBSUB_SECRET` remain, in the
import block and on the `enabledYtPubsub` line; no `YouTubeNotifier`,
`ytNotifier` or `fastifyExpress` anywhere.

- [ ] **Step 5: Type check and lint**

Run: `npm run build && npm run lint`
Expected: both exit without errors.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: everything PASSES.

- [ ] **Step 7: Commit**

```bash
git add src/commands/crawler.ts
git commit -m "feat(crawler): renew pubsub every ten minutes via native routes"
```

---

### Task 11: Remove the old dependencies and the declaration file

**Files:**

- Delete: `src/types/youtube-notification.d.ts`
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Confirm no source file uses them any more**

Run:

```bash
grep -rn "youtube-notification\|@fastify/express" src/ --exclude=youtube-notification.d.ts || echo "NO REFERENCES"
```

Expected: `NO REFERENCES`.

The declaration file is excluded because it contains
`declare module "youtube-notification"` itself, and it is only deleted in the
next step.

- [ ] **Step 2: Delete the hand-written declaration**

Run:

```bash
git rm src/types/youtube-notification.d.ts
```

- [ ] **Step 3: Remove the dependencies and the resolution that existed for them**

Run:

```bash
npm uninstall youtube-notification @fastify/express
```

Then remove the whole `resolutions` block from `package.json` by hand:

```json
  "resolutions": {
    "youtube-notification/**/axios": "^1.6.8"
  }
```

That resolution existed for one reason only: to pull the old axios inside the
`youtube-notification` dependency tree up to 1.x. With the package gone it does
nothing.

- [ ] **Step 4: Full verification**

Run: `npm run build && npm run lint && npm test`
Expected: all three exit without errors and every test PASSES.

- [ ] **Step 5: Confirm they are gone from the dependency tree**

Run:

```bash
node -e "const p=require('./package.json'); console.log('yt-notification:', p.dependencies['youtube-notification'], '@fastify/express:', p.dependencies['@fastify/express'], 'resolutions:', JSON.stringify(p.resolutions))"
grep -c '"node_modules/youtube-notification"\|"node_modules/@fastify/express"\|"node_modules/express"' package-lock.json || echo "0 lock entries"
```

Expected: the first line shows `undefined` for all three; the second prints
`0 lock entries` (or `0`).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: drop youtube-notification and the express adapter"
```

The deletion of `src/types/youtube-notification.d.ts` is already staged by the
`git rm` in Step 2, so it does not need a second `git add`.

---

### Task 12: Runbook for configuration changes

**Files:**

- Create: `docs/runbooks/pubsub-callback-rotation.md`

- [ ] **Step 1: Write the runbook**

This procedure cannot live only in the design document: it is what someone will
actually follow later, and doing the steps in the wrong order silently stops
deliveries for a channel.

Create `docs/runbooks/pubsub-callback-rotation.md`:

````markdown
# Changing YOUTUBE_PUBSUB_SECRET or PUBLIC_BASE_URL

A PubSubHubbub subscription is keyed by `(topic, callback URL)`, and the
crawler's callback URL carries a token derived from `YOUTUBE_PUBSUB_SECRET`.
Changing either setting therefore invalidates every existing subscription on the
hub side (the signature no longer verifies, or the callback address no longer
points at us), while `channels.pubsubExpiresAt` in MongoDB still looks valid.
Those channels would be skipped by renewal for up to about four days.

## Order (there is only one correct order)

1. Apply the new configuration and redeploy the crawler.
2. Wait for the rollout to finish and the old pods to terminate:

   ```bash
   kubectl rollout status deploy/crawler -n honeybee
   ```

3. Clear every stored expiry, so all channels become renewal candidates again:

   ```js
   db.channels.updateMany({}, { $unset: { pubsubExpiresAt: "" } });
   ```

Nothing else is needed afterwards. Renewal refills the whole set in roughly six
hours (five channels every ten minutes).

## Why clearing first and deploying second is wrong

While a process with the old configuration is still alive, a verification for a
request it already sent can arrive _after_ the clear. That handler only checks
the `pubsubRequestedAt` window and has no idea the configuration changed, so it
writes back a `pubsubExpiresAt` describing the old callback, and the channel
drops out of renewal again. Clearing after the old pods are gone leaves no
writer that can pollute the reset state (the crawler runs `replicas: 1`).

## Known trade-off

Uploads published during the rebuild window (about six hours) can be missed: the
old subscriptions are already invalid, the new ones do not exist yet, and the
Holodex polls only cover streams, not ordinary uploads. This is a deliberately
accepted limitation, so prefer a low-activity window for this change.
````

- [ ] **Step 2: Check the formatting**

Run: `npx prettier --check docs/runbooks/pubsub-callback-rotation.md`
Expected: `All matched files use Prettier code style!` (if it fails, run
`npx prettier --write` on the file and check again).

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/pubsub-callback-rotation.md
git commit -m "docs(runbook): order the pubsub callback rotation procedure"
```

---

## Post-deployment checks

After deploying (not part of any task, but this is how to tell the change
worked):

1. `[crawler youtube pubsub subscribe] starting` and `successed` appear as a
   pair every 10 minutes, and `successed` really shows up — the old behaviour
   was a `starting` that never came back.
2. The log shows `Subscribing:` lines with matching
   `Subscribed: <channelId> (expires=...)` lines.
3. In `db.agendaJobs.findOne({ name: "crawler youtube pubsub subscribe" })`,
   `lastFinishedAt` starts moving forward with `lastRunAt`.
4. After roughly six hours, `db.channels.countDocuments({ pubsubExpiresAt: null })`
   approaches zero among subscribed channels.
5. `CLI got unhandledRejection` no longer appears.
