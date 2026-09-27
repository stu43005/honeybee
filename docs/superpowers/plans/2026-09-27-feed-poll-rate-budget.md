# Feed Poll Rate Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the crawler's channel RSS feed poll under the feed backend's per-IP daily request limit (budget ~10,080 requests/day) and end a round early when the backend is refusing requests.

**Architecture:** Lower `YOUTUBE_FEED_POLL_BATCH_SIZE` from 20 to 14 on the unchanged 2-minute agenda schedule. Inside `pollChannelFeeds()`, keep a local count of consecutive failures that came back with an HTTP status. When it reaches `YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES` (3), log one line and return, so the untried channels keep their old `feedCrawledAt` and lead the next round. No state survives between rounds. Stale comments and the original discovery spec are corrected to match.

**Tech Stack:** TypeScript (ESM, NodeNext), axios 1.6.8, agenda, Jest (true ESM, `jest.unstable_mockModule`).

**Verified third-party behavior (axios 1.6.8, read from `node_modules/axios`):**

- For a non-2xx response under the default `validateStatus`, `lib/core/settle.js` rejects with `new AxiosError(msg, code, config, request, response)`, so `error.response` is set.
- For a timeout, `lib/adapters/http.js` rejects with `new AxiosError('timeout of Nms exceeded', ECONNABORTED, config, req)`, so `error.response` is `undefined`.
- For a connection error, `AxiosError.from(err, null, config, req)` is used, so `error.response` is `undefined`.
- `isAxiosError<T, D>(payload: any): payload is AxiosError<T, D>` narrows the type, and `AxiosError.response?: AxiosResponse` is optional.

So "the server answered with a status" is exactly `axios.isAxiosError(error) && error.response !== undefined`.

**Verification commands (run after every task):**

- `npx tsc --noEmit`
- `npm run lint`
- `npm run format:check`
- `npm run test -- src/services/crawler/discovery/feed-poll.spec.ts`

---

## File Structure

| File                                                                           | Change                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `src/constants.ts`                                                             | Batch size 20 → 14. New `YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES`. Corrected comments on the batch size and request spacing. |
| `src/services/crawler/discovery/feed-poll.ts`                                  | Consecutive-HTTP-failure counter and early stop. Corrected comment in the catch block.                                      |
| `src/services/crawler/discovery/feed-poll.spec.ts`                             | Tests for the stop and for each counter rule.                                                                               |
| `src/services/crawler/index.ts`                                                | Corrected schedule and worst-case-duration comments.                                                                        |
| `docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md` | Numbers, thresholds and the error-handling paragraph brought in line with the new budget.                                   |

---

### Task 1: Constants — batch size, abort threshold, corrected comments

**Files:**

- Modify: `src/constants.ts:198-208` (the `YOUTUBE_FEED_POLL_BATCH_SIZE` and `YOUTUBE_DISCOVERY_REQUEST_SPACING_MS` blocks)

This task only changes a constant value, adds a new constant and rewrites comments. No behavior depends on the new constant yet, so there is no new test here. The existing `"asks for one batch of the configured size"` test reads the constant and keeps covering the batch size.

- [ ] **Step 1: Replace the batch-size block and add the abort constant**

Replace this block in `src/constants.ts`:

```ts
// Channels fetched in one feed-poll round. On the 2-minute schedule that is 600
// channels/hour. Discovery latency is one rotation plus the feed's 15-minute
// edge cache, so the one-hour target holds up to 450 subscribed channels; 300
// channels land around 45 minutes. Raise this if the subscription list grows
// past that — the feed costs no quota, only outbound requests.
export const YOUTUBE_FEED_POLL_BATCH_SIZE = 20;
```

with:

```ts
// Channels fetched in one feed-poll round. On the 2-minute schedule that is 420
// channels/hour and about 10080 requests/day, and the daily figure is the one
// that binds: the feed backend stops serving an outbound address after roughly
// 11000 requests in a Pacific-time day and answers 404 or 500 until midnight
// PT. That ceiling was read off production logs rather than any documentation,
// so this keeps about a tenth in hand instead of sitting on it. Discovery
// latency is one rotation plus the feed's 15-minute edge cache, so the one-hour
// target holds up to 315 subscribed channels. Do not raise this to cover more
// channels: past 315 the latency grows, because a bigger batch would cross the
// daily ceiling.
export const YOUTUBE_FEED_POLL_BATCH_SIZE = 14;

// Consecutive http failures that end a feed-poll round early. Outside the
// daily-ceiling window the feed failed zero times across three days of logs, so
// three in a row does not happen by chance, while one channel that genuinely
// answers 404 never takes the count past one. Once the ceiling is hit nearly
// every request fails, so a round then costs three requests instead of a whole
// batch.
export const YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES = 3;
```

- [ ] **Step 2: Correct the request-spacing comment**

Replace:

```ts
// Gap between two outbound requests inside any discovery round. Both endpoints
// served 10 req/s for 10 seconds and 120-concurrent bursts without a single
// 429, so 4 req/s keeps a 2.5x margin below what was actually verified.
export const YOUTUBE_DISCOVERY_REQUEST_SPACING_MS = 250;
```

with:

```ts
// Gap between two outbound requests inside any discovery round. Both endpoints
// served 10 req/s for 10 seconds and 120-concurrent bursts without a single
// 429, so 4 req/s keeps a 2.5x margin below what was actually verified. That
// measurement covers the instantaneous rate only; the feed also has a daily
// request ceiling, which YOUTUBE_FEED_POLL_BATCH_SIZE is budgeted against.
export const YOUTUBE_DISCOVERY_REQUEST_SPACING_MS = 250;
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run format:check && npm run test -- src/services/crawler/discovery/feed-poll.spec.ts`

Expected: tsc and lint report no errors, prettier reports all files formatted, and all existing `pollChannelFeeds` tests PASS.

- [ ] **Step 4: Commit (via the git-master skill)**

Files: `src/constants.ts`

Message:

```text
fix(crawler): budget the feed poll under its daily ceiling

The feed backend refuses an outbound address after about 11000 requests
in a Pacific-time day and answers 404 or 500 until midnight PT; twenty
channels every two minutes spent 14400. Fourteen spends about 10080.
```

---

### Task 2: Stop a feed-poll round after consecutive HTTP failures

**Files:**

- Modify: `src/services/crawler/discovery/feed-poll.ts` (imports, the loop in `pollChannelFeeds`, the catch-block comment)
- Test: `src/services/crawler/discovery/feed-poll.spec.ts` (new helpers, constant import, new `it` blocks inside the existing `describe("pollChannelFeeds")`)

Counter rules this task implements:

- **Counted:** an axios error whose `response` is set, meaning the server answered with a status.
- **Reset:** any 2xx response. This includes a body that is not a feed, and a 2xx after which writing the videos fails.
- **Untouched:** timeouts and connection errors (axios error with no `response`), and errors that are not from axios.

When the count reaches `YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES`:

- The channel that tripped the count has already been stamped.
- One line is logged: `Feed poll: stopping round after 3 consecutive HTTP failures, N channels deferred`.
- The function returns without sleeping.

This also applies when the count trips on the last channel of the batch. The line then reads `0 channels deferred`, so a fully refused batch still leaves its signal in the log.

- [ ] **Step 1: Add the test helpers and the constant import**

In `src/services/crawler/discovery/feed-poll.spec.ts`, extend the constants import:

```ts
const {
  YOUTUBE_FEED_POLL_BATCH_SIZE,
  YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES,
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_FEED_TIMEOUT_MS,
} = await import("#constants.js");
```

Add these helpers directly after the `fakeChannels` function:

```ts
// What axios rejects with when the server answered with a non-2xx status: the
// response is attached.
function httpError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

// What axios rejects with when the request timed out: there is no response,
// and the code is ECONNABORTED under axios's default transitional settings.
function timeoutError() {
  return Object.assign(
    new Error(`timeout of ${YOUTUBE_FEED_TIMEOUT_MS}ms exceeded`),
    { isAxiosError: true, code: "ECONNABORTED" }
  );
}

// The channel ids this test's rounds requested, in order.
function requestedChannels(): string[] {
  return mockGet.mock.calls.map(([url]) => url.slice(url.indexOf("=") + 1));
}
```

- [ ] **Step 2: Write the tests**

Add these `it` blocks at the end of `describe("pollChannelFeeds", ...)`, after `"does nothing when no channel is due"`:

```ts
it("stops the round after three http failures in a row", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const stamped = fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  mockGet
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(500))
    .mockRejectedValueOnce(httpError(404))
    .mockResolvedValue({ data: feedXml("UC4", []) });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

  await pollChannelFeeds();

  expect(YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES).toBe(3);
  expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3"]);
  // The three that were tried are stamped like any failure; the two behind
  // them keep their old stamp and so stay at the front of the rotation.
  expect(stamped.map((write) => write.id)).toEqual(["UC1", "UC2", "UC3"]);
  expect(warn.mock.calls).toEqual([
    ["Feed poll failed for [UC1]:", "Request failed with status code 404"],
    ["Feed poll failed for [UC2]:", "Request failed with status code 500"],
    ["Feed poll failed for [UC3]:", "Request failed with status code 404"],
    [
      "Feed poll: stopping round after 3 consecutive HTTP failures, 2 channels deferred",
    ],
  ]);
});

it("does not wait for the spacing once the round is stopped", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4"]);
  mockGet.mockRejectedValue(httpError(404));

  await pollChannelFeeds();

  // One gap after each of the first two requests, none after the third.
  expect(mockSleep.mock.calls).toEqual([
    [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS],
    [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS],
  ]);
});

it("hands the deferred channels to the next round first", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  mockGet
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(404))
    .mockResolvedValue({ data: feedXml("UC4", []) });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

  await pollChannelFeeds();
  mockGet.mockClear();
  await pollChannelFeeds();

  // The fake drops stamped channels, standing in for the real sort putting
  // them last, so the second round sees exactly the two left unstamped.
  expect(requestedChannels()).toEqual(["UC4", "UC5"]);
});

it("neither counts nor clears the run on a timeout", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  mockGet
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(timeoutError())
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(404))
    .mockResolvedValue({ data: feedXml("UC5", []) });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

  await pollChannelFeeds();

  // The timeout left the count at one, so the next two http failures make
  // three and the round stops before UC5.
  expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3", "UC4"]);
});

it("does not count timeouts toward the stop", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const stamped = fakeChannels(["UC1", "UC2", "UC3", "UC4"]);
  mockGet
    .mockRejectedValueOnce(timeoutError())
    .mockRejectedValueOnce(timeoutError())
    .mockRejectedValueOnce(timeoutError())
    .mockResolvedValue({ data: feedXml("UC4", []) });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

  await pollChannelFeeds();

  expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3", "UC4"]);
  expect(stamped.map((write) => write.id)).toEqual([
    "UC1",
    "UC2",
    "UC3",
    "UC4",
  ]);
});

it("clears the run when a feed is served in between", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const stamped = fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  mockGet
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(404))
    .mockResolvedValueOnce({ data: feedXml("UC3", []) })
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(404));
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

  await pollChannelFeeds();

  expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  expect(stamped.map((write) => write.id)).toEqual([
    "UC1",
    "UC2",
    "UC3",
    "UC4",
    "UC5",
  ]);
});

it("clears the run on a 2xx body that is not a feed", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  mockGet
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(404))
    .mockResolvedValueOnce({ data: "<html>nope</html>" })
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(404));

  await pollChannelFeeds();

  expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3", "UC4", "UC5"]);
});

it("clears the run on a 2xx even when writing its videos fails", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  mockGet
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(404))
    .mockResolvedValueOnce({ data: feedXml("UC3", ["v1"]) })
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(404));
  const notice = jest
    .spyOn(VideoModel, "noticeUnknownVideos")
    .mockRejectedValue(new Error("write concern error"));

  await pollChannelFeeds();

  // The write did run and fail; the backend had still served the feed.
  expect(notice.mock.calls.map((call) => call[0].length)).toEqual([1]);
  expect(requestedChannels()).toEqual(["UC1", "UC2", "UC3", "UC4", "UC5"]);
});

it("still logs the stop when the last channel trips it", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3"]);
  mockGet.mockRejectedValue(httpError(404));

  await pollChannelFeeds();

  expect(warn.mock.calls).toEqual([
    ["Feed poll failed for [UC1]:", "Request failed with status code 404"],
    ["Feed poll failed for [UC2]:", "Request failed with status code 404"],
    ["Feed poll failed for [UC3]:", "Request failed with status code 404"],
    [
      "Feed poll: stopping round after 3 consecutive HTTP failures, 0 channels deferred",
    ],
  ]);
});

it("starts every round with a fresh count", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  mockGet
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(404))
    .mockRejectedValueOnce(httpError(404))
    .mockResolvedValue({ data: feedXml("UC5", []) });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);
  // First round: two channels, both refused, so it ends with the count at two.
  jest.spyOn(ChannelModel, "findFeedPollCandidates").mockResolvedValueOnce([
    { id: "UC1", name: "Channel UC1" },
    { id: "UC2", name: "Channel UC2" },
  ] as never);

  await pollChannelFeeds();
  mockGet.mockClear();
  // Second round: one more refusal, then feeds. A count carried over from the
  // first round would reach three here and stop after UC3.
  await pollChannelFeeds();

  expect(requestedChannels()).toEqual(["UC3", "UC4", "UC5"]);
});
```

- [ ] **Step 3: Run the tests against the unchanged implementation**

Run: `npm run test -- src/services/crawler/discovery/feed-poll.spec.ts`

Expected: FAIL. These four tests fail because every channel in the batch is still requested and stamped:

- `"stops the round after three http failures in a row"`: `requestedChannels()` receives `["UC1","UC2","UC3","UC4","UC5"]` but expected 3 entries, and the warn list lacks the stop line.
- `"does not wait for the spacing once the round is stopped"`: `mockSleep.mock.calls` has 3 entries instead of 2.
- `"hands the deferred channels to the next round first"`: the second round requests `[]`, because all five were stamped.
- `"neither counts nor clears the run on a timeout"`: 5 requests instead of 4.
- `"still logs the stop when the last channel trips it"`: the warn list has 3 entries and lacks the `0 channels deferred` line.

These five tests PASS already, and that is expected:

- `"does not count timeouts toward the stop"`
- `"clears the run when a feed is served in between"`
- `"clears the run on a 2xx body that is not a feed"`
- `"clears the run on a 2xx even when writing its videos fails"`
- `"starts every round with a fresh count"`

They pin the counter rules against implementations that stop too eagerly: counting timeouts, resetting only after a parsed feed or only after a successful write, or keeping the count in module scope so it carries across rounds. The unchanged code never stops a round, so it cannot violate them. Each failure message must point at request counts, stamps or log lines, not at a missing module or a type error. Record the actual failure output in the task report.

- [ ] **Step 4: Implement the counter and the stop**

In `src/services/crawler/discovery/feed-poll.ts`, extend the constants import:

```ts
import {
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES,
  YOUTUBE_FEED_POLL_BATCH_SIZE,
  YOUTUBE_FEED_TIMEOUT_MS,
} from "#constants.js";
```

Append this paragraph to the end of the `pollChannelFeeds` JSDoc, after the "Reuses the pubsub notification parser" paragraph:

```ts
 *
 * A run of http failures ends the round early. Once the outbound address has
 * used up the feed's daily allowance every request answers 404 or 500 until
 * midnight Pacific time, and carrying on would only spend the batch and the log
 * on that. The channels left untried keep their old stamp, so the next round
 * starts with them.
```

Replace the body of `pollChannelFeeds` (everything from `const candidates = ...` to the closing brace of the `for` loop) with:

```ts
const candidates = await ChannelModel.findFeedPollCandidates(
  YOUTUBE_FEED_POLL_BATCH_SIZE
);

// Failures in a row that came back with an http status. Only a status says
// the feed backend itself is refusing; a timeout or a dropped connection says
// nothing about it, so those leave the count where it was.
let consecutiveHttpFailures = 0;

for (let index = 0; index < candidates.length; index++) {
  const channel = candidates[index];
  try {
    const response = await axios.get<string>(`${FEED_URL}${channel.id}`, {
      timeout: YOUTUBE_FEED_TIMEOUT_MS,
      // Without this axios would try to guess, and an XML body can come back
      // parsed into an object that the Atom parser cannot read.
      responseType: "text",
    });
    // Any 2xx means the backend is serving us, whatever the body turns out to
    // be and whether or not the write below succeeds.
    consecutiveHttpFailures = 0;
    const entries = parseNotification(response.data);
    if (!entries) {
      console.warn(`Feed poll: body is not a feed for [${channel.id}]`);
    } else {
      const discovered: DiscoveredVideo[] = entries.flatMap((entry) =>
        entry.type === "video"
          ? [
              {
                videoId: entry.videoId,
                title: entry.title,
                channelId: entry.channelId,
                publishedAt: entry.published,
              },
            ]
          : []
      );
      await VideoModel.noticeUnknownVideos(discovered);
    }
  } catch (error) {
    if (axios.isAxiosError(error) && error.response !== undefined) {
      consecutiveHttpFailures++;
    }
    // One channel's failure must not cost the rest of the round theirs.
    //
    // An http failure is reduced to its message. The rejected error carries
    // the config, the request, the socket and the HTML error page Google
    // served — around a hundred lines each — and the status line is all of
    // it that says anything. Such failures arrive in bulk once the outbound
    // address has used up the feed's daily allowance; the early stop below is
    // what keeps that to a few lines per round. Anything else is a bug rather
    // than the network, and its stack is the only way to place it.
    console.warn(
      `Feed poll failed for [${channel.id}]:`,
      axios.isAxiosError(error) ? error.message : error
    );
  }

  // Its own try, for two reasons. It must run even when the block above threw
  // — a channel that always fails would otherwise stay at the head of the
  // rotation and consume a slot every round forever — and its own failure
  // must not escape either, or one rejected write would end the round and
  // skip every channel behind this one.
  try {
    await ChannelModel.updateOne(
      { id: channel.id },
      { $set: { feedCrawledAt: new Date() } }
    );
  } catch (error) {
    console.warn(`Feed poll could not stamp [${channel.id}]:`, error);
  }

  const remaining = candidates.length - index - 1;
  // Checked before the last-channel exit, so a batch that is refused all the
  // way through still says so rather than ending on its per-channel lines.
  if (consecutiveHttpFailures >= YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES) {
    console.warn(
      `Feed poll: stopping round after ${consecutiveHttpFailures} consecutive HTTP failures, ${remaining} channels deferred`
    );
    return;
  }
  if (remaining > 0) {
    await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- src/services/crawler/discovery/feed-poll.spec.ts`

Expected: PASS. That covers all ten new tests and every pre-existing test, including `"logs an http failure as one line, not as the whole error object"`: with one channel the count only reaches one, so its warn list stays a single entry.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run format:check`

Expected: no errors. If prettier reports either file, run `npx prettier --write src/services/crawler/discovery/feed-poll.ts src/services/crawler/discovery/feed-poll.spec.ts` and re-run the tests.

- [ ] **Step 7: Commit (via the git-master skill)**

Files: `src/services/crawler/discovery/feed-poll.ts`, `src/services/crawler/discovery/feed-poll.spec.ts`

Message:

```text
fix(crawler): stop a feed round the backend is refusing

Three http failures in a row end the round: once the daily allowance is
spent every request fails until midnight PT, and carrying on only spent
the batch and filled the log. Untried channels keep their stamp and lead
the next round. Timeouts neither count nor clear the run.
```

---

### Task 3: Crawler schedule comments

**Files:**

- Modify: `src/services/crawler/index.ts:353-365` (the lock comment above the three discovery jobs and the comment above the feed-poll `agenda.every`)

- [ ] **Step 1: Correct the worst-case figure in the lock comment**

Replace:

```ts
// None of these three set a lockLifetime or call job.touch(). Their worst
// cases are 3.4, 4.3 and 1.7 minutes — every request carries a timeout and
// retries are off — which stays well inside agenda's 10 minute default, the
// same reasoning the pubsub renewal job relies on.
```

with:

```ts
// None of these three set a lockLifetime or call job.touch(). Their worst
// cases are 2.4, 4.3 and 1.7 minutes — every request carries a timeout and
// retries are off — which stays well inside agenda's 10 minute default, the
// same reasoning the pubsub renewal job relies on.
```

(2.4 = 14 channels × (10 s timeout + 250 ms spacing) ≈ 143.5 s.)

- [ ] **Step 2: Correct the feed-poll schedule comment**

Replace:

```ts
// Two minutes covers 600 channels an hour, and the feed's own 15 minute edge
// cache means polling any single channel faster than that would return the
// same bytes anyway.
```

with:

```ts
// Two minutes at the feed batch size covers 420 channels an hour, which keeps
// the day's requests under the feed's per-address daily ceiling. The feed's
// own 15 minute edge cache means polling any single channel faster than that
// would return the same bytes anyway.
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run format:check`

Expected: no errors.

- [ ] **Step 4: Commit (via the git-master skill)**

Files: `src/services/crawler/index.ts`

Message:

```text
docs(crawler): restate the feed schedule for the smaller batch
```

---

### Task 4: Bring the original discovery spec in line

**Files:**

- Modify: `docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md`

This is a spec document, so its prose stays in 繁體中文. Each step is one exact replacement.

- [ ] **Step 1: Rate-limit measurement note (near line 93)**

Replace:

```text
- oEmbed 與 feed **全部 200，零 429，無任何速率限制 header**。
```

with:

```text
- oEmbed 與 feed **全部 200，零 429，無任何速率限制 header**。這只驗證了瞬間速率；上線後才觀察到 feed 另有每個出口 IP 約 11000 次/太平洋時間日的上限，超過後回 404/500 直到 PT 午夜。
```

- [ ] **Step 2: Discovery-latency paragraphs (near lines 197–199)**

Replace:

```text
300 個訂閱頻道時：20 筆 × 30 輪/小時 = 600 頻道/小時，週期約 30 分鐘，最壞延遲約 **45 分鐘**。

一小時的目標要求週期 ≤ 45 分鐘，也就是訂閱頻道數 ≤ 600 × 0.75 = **450**。超過 450 之後延遲會線性成長（600 個頻道時約 75 分鐘），此時要維持目標只能提高 `YOUTUBE_FEED_POLL_BATCH_SIZE`——feed 是零配額的，唯一的代價是對外請求量，實測餘裕足以支撐。這個門檻記於「Non-goals / Accepted limitations」。
```

with:

```text
186 個訂閱頻道時：14 筆 × 30 輪/小時 = 420 頻道/小時，週期約 27 分鐘，最壞延遲約 **42 分鐘**。

一小時的目標要求週期 ≤ 45 分鐘，也就是訂閱頻道數 ≤ 420 × 0.75 = **315**。超過 315 之後延遲會線性成長。批次大小受 feed 後端對單一出口 IP 約 11000 次/天的上限約束（依太平洋時間午夜重置），不能靠提高 `YOUTUBE_FEED_POLL_BATCH_SIZE` 換延遲。這個門檻記於「Non-goals / Accepted limitations」。
```

- [ ] **Step 3: Constants code block (near lines 397–402)**

Replace:

```text
// Channels fetched in one feed-poll round. On the 2-minute schedule that is 600
// channels/hour. Discovery latency is one rotation plus the feed's 15-minute
// edge cache, so the one-hour target holds up to 450 subscribed channels; 300
// channels land around 45 minutes. Raise this if the subscription list grows
// past that — the feed costs no quota, only outbound requests.
export const YOUTUBE_FEED_POLL_BATCH_SIZE = 20;
```

with the exact two constant blocks from Task 1 Step 1 (the new `YOUTUBE_FEED_POLL_BATCH_SIZE = 14` block followed by the `YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES = 3` block):

```text
// Channels fetched in one feed-poll round. On the 2-minute schedule that is 420
// channels/hour and about 10080 requests/day, and the daily figure is the one
// that binds: the feed backend stops serving an outbound address after roughly
// 11000 requests in a Pacific-time day and answers 404 or 500 until midnight
// PT. That ceiling was read off production logs rather than any documentation,
// so this keeps about a tenth in hand instead of sitting on it. Discovery
// latency is one rotation plus the feed's 15-minute edge cache, so the one-hour
// target holds up to 315 subscribed channels. Do not raise this to cover more
// channels: past 315 the latency grows, because a bigger batch would cross the
// daily ceiling.
export const YOUTUBE_FEED_POLL_BATCH_SIZE = 14;

// Consecutive http failures that end a feed-poll round early. Outside the
// daily-ceiling window the feed failed zero times across three days of logs, so
// three in a row does not happen by chance, while one channel that genuinely
// answers 404 never takes the count past one. Once the ceiling is hit nearly
// every request fails, so a round then costs three requests instead of a whole
// batch.
export const YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES = 3;
```

In the same code block, replace:

```text
// Gap between two outbound requests inside any discovery round. Both endpoints
// served 10 req/s for 10 seconds and 120-concurrent bursts without a single
// 429, so 4 req/s keeps a 2.5x margin below what was actually verified.
export const YOUTUBE_DISCOVERY_REQUEST_SPACING_MS = 250;
```

with:

```text
// Gap between two outbound requests inside any discovery round. Both endpoints
// served 10 req/s for 10 seconds and 120-concurrent bursts without a single
// 429, so 4 req/s keeps a 2.5x margin below what was actually verified. That
// measurement covers the instantaneous rate only; the feed also has a daily
// request ceiling, which YOUTUBE_FEED_POLL_BATCH_SIZE is budgeted against.
export const YOUTUBE_DISCOVERY_REQUEST_SPACING_MS = 250;
```

- [ ] **Step 4: Subsystem spend table (near lines 487–492)**

In the table under 「本子系統的支出」, change the feed row's requests/day cell from `14400` to `10080`, and the total row's requests/day cell from `**18144**` to `**13824**`. Leave every other cell unchanged.

- [ ] **Step 5: `YoutubeWatchGate` paragraph (near line 514)**

Replace `把一輪 20 個頻道從 5 秒拖到 20 秒` with `把一輪 14 個頻道從約 3.5 秒拖到 14 秒`.

- [ ] **Step 6: Error-handling paragraph (near line 522)**

Directly after the paragraph that starts `**單筆失敗不中斷整輪**，唯一例外是配額耗盡。`, insert this new paragraph:

```text
feed 輪詢另有一個中止條件：同一輪連續 3 次 HTTP 失敗（伺服器有回狀態碼；timeout 與連線錯誤不計也不歸零，任何 2xx 歸零）即視為撞上 feed 後端的每日上限，記一行 warn 後中止本輪。已嘗試的頻道照常推進時間戳，其餘不寫時間戳，留給下一輪優先處理。這個判斷不保存跨輪狀態，限流解除後的第一輪自然恢復。
```

- [ ] **Step 7: Timeout table (near line 528)**

Replace the feed row `| feed     | 20       | 10 秒 + 250 ms | 3.4 分   |` with `| feed     | 14       | 10 秒 + 250 ms | 2.4 分   |`.

- [ ] **Step 8: Non-goals section on the one-hour target (near lines 608–612)**

Replace the heading `### 一小時的發現目標以 450 個訂閱頻道為界` and its two paragraphs:

```text
feed 輪詢的吞吐量是常數（600 頻道/小時），而延遲還要加上最多 15 分鐘的快取，所以一小時的目標只在訂閱頻道數 ≤ 450 時成立。超過之後延遲線性成長（600 個頻道約 75 分鐘）。

這不是設計缺陷而是刻意的優先序：批次大小固定正是讓配額與請求量可預測的手段，若改成隨頻道數自動放大，成長就會直接吃掉既有流量的餘裕。頻道真的成長到 450 以上時，調整方式很單純——提高 `YOUTUBE_FEED_POLL_BATCH_SIZE`。feed 是零配額的，唯一的代價是對外請求量，而實測餘裕（10 req/s 持續、120 並發無 429）遠大於調整所需。本設計不自動化這個調整，因為自動化需要的觸發條件與安全上限，會比一個常數複雜得多。
```

with:

```text
### 一小時的發現目標以 315 個訂閱頻道為界

feed 輪詢的吞吐量是常數（420 頻道/小時），而延遲還要加上最多 15 分鐘的快取，所以一小時的目標只在訂閱頻道數 ≤ 315 時成立。超過之後延遲線性成長。

這不是設計缺陷而是刻意的優先序：批次大小固定正是讓請求量可預測的手段。批次大小也不能再往上調——feed 雖然零配額，但後端對單一出口 IP 有約 11000 次/天的上限（依太平洋時間午夜重置，超過後回 404/500），目前的 10080 次/天已貼近它。頻道成長到 315 以上時只能接受延遲變長，或另行設計（例如第二個出口 IP 或其他發現管道）。
```

- [ ] **Step 9: Fixed-batch paragraph (near line 175)**

Replace `頻道從 300 成長到 600，輪詢週期會從 30 分鐘變成 60 分鐘，但配額用量不變。` with `頻道從 300 成長到 600，輪詢週期會從約 43 分鐘變成約 86 分鐘，但配額用量與請求量都不變。`

(300 ÷ 420 channels/hour ≈ 43 minutes; 600 ÷ 420 ≈ 86 minutes.)

- [ ] **Step 10: Average request rate (near line 512)**

Replace `平均 0.244 req/s` with `平均約 0.194 req/s`.

(The same accounting scope, minus the 4320 requests/day the feed no longer makes: 0.244 − 4320 ÷ 86400 = 0.194.)

- [ ] **Step 11: Window-overflow rationale (near line 584)**

Replace `feed 窗口 15 筆、300 個訂閱頻道時週期約 30 分鐘，等於要「30 分鐘內發布 16 支影片」` with `feed 窗口 15 筆、300 個訂閱頻道時週期約 43 分鐘，等於要「43 分鐘內發布 16 支影片」`.

- [ ] **Step 12: Verify**

Run: `npx prettier --check docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md`

Expected: the file is reported as formatted. If it is not, run `npx prettier --write docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md` and check again. (`npm run format:check` only covers `src/`, so it would not see this file.)

Then run:

```bash
grep -n "14400\|18144\|450 個\|≤ 450\|\*\*450\*\*\|3\.4 分\|20 筆\|600 頻道/小時\|0\.244\|30 分鐘變成 60 分鐘\|週期約 30 分鐘" docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md
```

Expected: no output.

- [ ] **Step 13: Commit (via the git-master skill)**

Files: `docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md`

Message:

```text
docs(spec): restate the feed poll budget in the discovery design
```
