# Feed Poll Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the crawler's channel RSS feed poll retry each channel's HTTP failures (up to 3 requests in all), log only each failed channel's last error, count the early-stop run per channel outcome, renew the agenda lock once a minute, restore the batch to 20, and correct every comment and document that blamed a per-IP daily limit.

**Architecture:** A new module-private `fetchFeed()` in `feed-poll.ts` owns the per-channel retry loop and returns a discriminated result carrying the attempt count. `pollChannelFeeds(job?: Job)` consumes that result, updates the consecutive-failure counter from the channel's final outcome, logs one line per failed channel, and calls `job?.touch()` between channels once `YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS` has passed. The crawler's agenda handler passes its `job` in. Documentation is fixed by reverting the earlier spec-doc commit and layering the corrected facts on top.

**Tech Stack:** TypeScript (ESM, NodeNext), axios 1.6.8, agenda 6.2.4, Jest (true ESM via `jest.unstable_mockModule`, ts-jest transpile-only).

**Verified third-party behavior:**

- **axios 1.6.8** (read from `node_modules/axios`):
  - A non-2xx response under the default `validateStatus` rejects with an `AxiosError` whose `response` is set.
  - A timeout rejects with code `ECONNABORTED` and `response` undefined.
  - A connection error also has `response` undefined.
  - `isAxiosError` is a type guard.
- **agenda 6.2.4** (read from `node_modules/agenda`):
  - `Job#touch(progress?: number): Promise<void>` refreshes `lockedAt` and throws when the job has been cancelled.
  - `defaultLockLifetime` is 10 minutes.
  - The codebase already passes an optional `job?: Job` into long-running work and calls `await job?.touch()` (see `src/services/manager/chats-archive/gen-realtime-file.ts`).

**Verification commands (run after every task):**

- `npx tsc --noEmit`
- `npm run lint`
- `npm run format:check`
- `npm run test -- src/services/crawler/discovery/feed-poll.spec.ts`

---

## File Structure

| File                                                                           | Change                                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/constants.ts`                                                             | Batch 14 → 20. New `YOUTUBE_FEED_POLL_ATTEMPTS` and `YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS`. Rewritten comments with no per-IP-ceiling claim. |
| `src/services/crawler/discovery/feed-poll.ts`                                  | `fetchFeed()` retry loop, per-channel failure logging, counter driven by final outcome, lock renewal, corrected comments.                   |
| `src/services/crawler/discovery/feed-poll.spec.ts`                             | Scripted per-channel answers; failure-path tests rewritten for retries; new retry and lock-renewal tests.                                   |
| `src/services/crawler/index.ts`                                                | Feed-poll handler passes `job`; lock and schedule comments corrected.                                                                       |
| `docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md` | Revert the earlier budget edit, then add the outage-window, retry and lock-renewal facts.                                                   |
| `docs/superpowers/specs/2026-09-27-feed-poll-rate-budget-design.md`            | Superseded notice under the title.                                                                                                          |

---

### Task 1: Constants — batch 20, attempts, touch interval, corrected comments

**Files:**

- Modify: `src/constants.ts` (the four feed/discovery constants after the `// --- YouTube official video discovery` header, currently around lines 198–223)

This task changes constant values and comments and adds two constants. No behavior uses the new constants yet, so there is no new test. The existing `"asks for one batch of the configured size"` test reads the constant.

- [ ] **Step 1: Replace the batch-size and abort-threshold blocks**

Replace this exact text:

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

with:

```ts
// Channels fetched in one feed-poll round. On the 2-minute schedule that is 600
// channels/hour. Discovery latency is one rotation plus the feed's 15-minute
// edge cache, so the one-hour target holds up to 450 subscribed channels; 300
// channels land around 45 minutes. Raise this if the subscription list grows
// past that — the feed costs no quota, only outbound requests. Its outages
// follow the clock, not our volume: every day around 01:00-07:00 UTC its origin
// answers most requests with 404 or 500 whatever address they come from; edge
// cache hits stay reliable. Polling less does not shorten that.
export const YOUTUBE_FEED_POLL_BATCH_SIZE = 20;

// Requests one channel's feed may take in a round, the first one included. Only
// an http failure is tried again: inside the daily outage window a single
// origin fetch succeeded about 27% of the time (12 of 45), so three tries reach
// about 61%. Each extra try is one more request at an origin that is already
// failing, which is why it stops at three.
export const YOUTUBE_FEED_POLL_ATTEMPTS = 3;

// Channels in a row that end a feed-poll round early, each having used every
// attempt and still got an http failure. Outside the outage window the feed
// failed zero times across three days of logs, so this does not trip by chance.
// Inside it about 39% of channels run out of attempts, so a round stops part-way
// about half the time; when the origin refuses everything a round costs three
// channels' attempts, nine requests, instead of a whole batch.
export const YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES = 3;

// How often a feed-poll round renews its agenda lock. It is checked between
// channels, and one channel takes at most three timeouts' worth, about 31
// seconds, so renewals land within about a minute and a half of each other —
// well inside agenda's 10 minute lock, at a cost of a few writes per round.
export const YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS = 60 * 1000;
```

- [ ] **Step 2: Replace the request-spacing comment**

Replace this exact text:

```ts
// Gap between two outbound requests inside any discovery round. Both endpoints
// served 10 req/s for 10 seconds and 120-concurrent bursts without a single
// 429, so 4 req/s keeps a 2.5x margin below what was actually verified. That
// measurement covers the instantaneous rate only; the feed also has a daily
// request ceiling, which YOUTUBE_FEED_POLL_BATCH_SIZE is budgeted against.
export const YOUTUBE_DISCOVERY_REQUEST_SPACING_MS = 250;
```

with:

```ts
// Gap between two outbound requests inside any discovery round, and between two
// attempts at the same feed. Both endpoints served 10 req/s for 10 seconds and
// 120-concurrent bursts without a single 429, so 4 req/s keeps a 2.5x margin
// below what was actually verified.
export const YOUTUBE_DISCOVERY_REQUEST_SPACING_MS = 250;
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run format:check && npm run test -- src/services/crawler/discovery/feed-poll.spec.ts`

Expected:

- tsc and lint report no errors.
- prettier reports all files formatted.
- All existing `pollChannelFeeds` tests PASS. They read the batch size from the constant, and none of them depends on its value.

- [ ] **Step 4: Commit (via the git-master skill)**

Files: `src/constants.ts`

Message:

```text
fix(crawler): restore the feed batch and add retry constants

The per-address daily ceiling the batch was cut for does not exist: the
feed's origin fails every day around 01:00-07:00 UTC for any client,
whatever our volume. Back to twenty channels a round, plus the attempt
count and lock-renewal interval the retrying poll will use.
```

---

### Task 2: Retry each channel's HTTP failures and renew the lock

**Files:**

- Modify: `src/services/crawler/discovery/feed-poll.ts` (whole file)
- Test: `src/services/crawler/discovery/feed-poll.spec.ts`

**Behavior this task implements:**

**Retry, per channel:**

- Each channel gets up to `YOUTUBE_FEED_POLL_ATTEMPTS` requests to the same URL.
- Only an HTTP failure (`axios.isAxiosError(e) && e.response !== undefined`) is retried, after `sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS)`.
- A timeout, a connection error or a non-axios error ends the channel at once.
- A 2xx ends it at once, even when the body is not a feed.

**Logging:**

- A failed channel logs exactly one line: `Feed poll failed for [<id>] after <n> attempts:` plus the last error.
- For axios errors the last error is reduced to `error.message`; anything else is logged as the error object.
- A failure after the 2xx (in parsing or in `noticeUnknownVideos`) uses the same line with that channel's attempt count.

**Abort counter, driven by each channel's final outcome:**

- +1 when the channel's last attempt was an HTTP failure.
- Reset to 0 on a 2xx.
- Unchanged otherwise.
- The stop line and the stop behavior are unchanged.

**Lock renewal:**

- Before each channel, if `Date.now()` is at least `YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS` past the last renewal (or the start of the round), the round awaits `job?.touch()` and records the time.
- A rejection from `touch` is not caught, so it rejects the round.

- [ ] **Step 1: Extend the constants import and add the scripting helpers in the spec file**

In `src/services/crawler/discovery/feed-poll.spec.ts`, replace the constants import:

```ts
const {
  YOUTUBE_FEED_POLL_BATCH_SIZE,
  YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES,
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_FEED_TIMEOUT_MS,
} = await import("#constants.js");
```

with:

```ts
const {
  YOUTUBE_FEED_POLL_BATCH_SIZE,
  YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES,
  YOUTUBE_FEED_POLL_ATTEMPTS,
  YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS,
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_FEED_TIMEOUT_MS,
} = await import("#constants.js");
```

Directly after the existing `requestedChannels()` function, add:

```ts
type Answer = Error | { data: string };

// Answers each channel's requests from its own script, one entry per request in
// order; once a script runs out its last entry repeats. Channels are told apart
// by the channel_id in the url, so the script does not depend on the order the
// round visits them in.
function scripted(answers: Record<string, Answer[]>): void {
  const counts = new Map<string, number>();
  mockGet.mockImplementation((url) => {
    const id = url.slice(url.indexOf("=") + 1);
    const script = answers[id];
    if (script === undefined) {
      return Promise.reject(new Error(`no scripted answer for ${id}`));
    }
    const count = counts.get(id) ?? 0;
    counts.set(id, count + 1);
    const answer = script[Math.min(count, script.length - 1)];
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  });
}

// A feed the origin actually served.
function served(channelId: string, videoIds: string[] = []): Answer {
  return { data: feedXml(channelId, videoIds) };
}

// An origin that refuses this channel on every attempt.
const refused: Answer[] = [httpError(404)];

// One channel id repeated once per attempt it is expected to use.
function times(channelId: string, count: number): string[] {
  return Array.from({ length: count }, () => channelId);
}
```

- [ ] **Step 2: Replace the failure-path tests**

In the same file, delete every `it` block from `it("logs an http failure as one line, not as the whole error object", ...` down to and including `it("starts every round with a fresh count", ...`. Keep:

- every block above it;
- the `"skips a body that is not a feed but still stamps the channel"` block;
- the `"keeps going when stamping one channel rejects"` block;
- the `"does nothing when no channel is due"` block.

Those three are interleaved and must stay unchanged. Concretely, delete these blocks:

1. `"logs an http failure as one line, not as the whole error object"`
2. `"keeps the whole error when the failure is not an http one"`
3. `"stops the round after three http failures in a row"`
4. `"does not wait for the spacing once the round is stopped"`
5. `"hands the deferred channels to the next round first"`
6. `"neither counts nor clears the run on a timeout"`
7. `"does not count timeouts toward the stop"`
8. `"clears the run when a feed is served in between"`
9. `"clears the run on a 2xx body that is not a feed"`
10. `"clears the run on a 2xx even when writing its videos fails"`
11. `"still logs the stop when the last channel trips it"`
12. `"starts every round with a fresh count"`

Then add these `it` blocks at the end of `describe("pollChannelFeeds", ...)`:

```ts
it("logs a failed channel as one line carrying only its last error", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1"]);
  // What axios actually rejects with. Handing the object itself to
  // console.warn makes node print all of it: the config, the request, the
  // socket, and the HTML error page YouTube served — around a hundred lines
  // for one 404, of which the daily outage produces hundreds.
  const lastError = Object.assign(
    new Error("Request failed with status code 404"),
    {
      isAxiosError: true,
      config: { url: "https://www.youtube.com/feeds/videos.xml" },
      request: { socket: { _hadError: false } },
      response: {
        status: 404,
        data: "<html><title>Error 404 (Not Found)!!1</title></html>",
      },
    }
  );
  scripted({ UC1: [httpError(404), httpError(500), lastError] });

  await pollChannelFeeds();

  expect(YOUTUBE_FEED_POLL_ATTEMPTS).toBe(3);
  expect(requestedChannels()).toEqual(times("UC1", 3));
  // The two earlier failures leave no trace; only the last one is told.
  expect(warn.mock.calls).toEqual([
    [
      "Feed poll failed for [UC1] after 3 attempts:",
      "Request failed with status code 404",
    ],
  ]);
});

it("keeps the whole error when the failure is not an http one", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1"]);
  // Nothing above the transport knows what this is, so its stack is the only
  // thing that can explain it and must survive. Nor is it worth a retry.
  const bug = new TypeError("entry.published is not a function");
  scripted({ UC1: [bug] });

  await pollChannelFeeds();

  expect(requestedChannels()).toEqual(["UC1"]);
  expect(warn.mock.calls).toEqual([
    ["Feed poll failed for [UC1] after 1 attempts:", bug],
  ]);
});

it("retries an http failure and takes the feed once it is served", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const stamped = fakeChannels(["UC1"]);
  scripted({ UC1: [httpError(404), httpError(500), served("UC1", ["v1"])] });
  const notice = jest
    .spyOn(VideoModel, "noticeUnknownVideos")
    .mockResolvedValue(undefined);

  await pollChannelFeeds();

  expect(requestedChannels()).toEqual(times("UC1", 3));
  expect(
    notice.mock.calls.map((call) => call[0].map((v) => v.videoId))
  ).toEqual([["v1"]]);
  expect(warn.mock.calls).toEqual([]);
  // One gap before each retry; none after the round's only channel.
  expect(mockSleep.mock.calls).toEqual([
    [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS],
    [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS],
  ]);
  expect(stamped.map((write) => write.id)).toEqual(["UC1"]);
});

it("does not retry a timeout", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1"]);
  scripted({ UC1: [timeoutError(), served("UC1")] });

  await pollChannelFeeds();

  expect(requestedChannels()).toEqual(["UC1"]);
  expect(warn.mock.calls).toEqual([
    [
      "Feed poll failed for [UC1] after 1 attempts:",
      `timeout of ${YOUTUBE_FEED_TIMEOUT_MS}ms exceeded`,
    ],
  ]);
});

it("does not retry a 2xx whose body is not a feed", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1"]);
  scripted({ UC1: [{ data: "<html>nope</html>" }, served("UC1")] });

  await pollChannelFeeds();

  expect(requestedChannels()).toEqual(["UC1"]);
  expect(warn.mock.calls).toEqual([
    ["Feed poll: body is not a feed for [UC1]"],
  ]);
});

it("stops retrying at a timeout and does not count that channel", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4"]);
  scripted({
    UC1: [httpError(404), timeoutError()],
    UC2: refused,
    UC3: refused,
    UC4: [served("UC4")],
  });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

  await pollChannelFeeds();

  // UC1 ended on a timeout, so only UC2 and UC3 count: two, not three, and
  // the round reaches UC4.
  expect(requestedChannels()).toEqual([
    ...times("UC1", 2),
    ...times("UC2", 3),
    ...times("UC3", 3),
    "UC4",
  ]);
  expect(warn.mock.calls[0]).toEqual([
    "Feed poll failed for [UC1] after 2 attempts:",
    `timeout of ${YOUTUBE_FEED_TIMEOUT_MS}ms exceeded`,
  ]);
});

it("stops the round after three channels in a row run out of attempts", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const stamped = fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  scripted({
    UC1: refused,
    UC2: [httpError(500)],
    UC3: refused,
    UC4: [served("UC4")],
    UC5: [served("UC5")],
  });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

  await pollChannelFeeds();

  expect(YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES).toBe(3);
  expect(requestedChannels()).toEqual([
    ...times("UC1", 3),
    ...times("UC2", 3),
    ...times("UC3", 3),
  ]);
  // The three that were tried are stamped like any failure; the two behind
  // them keep their old stamp and so stay at the front of the rotation.
  expect(stamped.map((write) => write.id)).toEqual(["UC1", "UC2", "UC3"]);
  expect(warn.mock.calls).toEqual([
    [
      "Feed poll failed for [UC1] after 3 attempts:",
      "Request failed with status code 404",
    ],
    [
      "Feed poll failed for [UC2] after 3 attempts:",
      "Request failed with status code 500",
    ],
    [
      "Feed poll failed for [UC3] after 3 attempts:",
      "Request failed with status code 404",
    ],
    [
      "Feed poll: stopping round after 3 consecutive HTTP failures, 2 channels deferred",
    ],
  ]);
});

it("does not wait for the spacing once the round is stopped", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4"]);
  scripted({ UC1: refused, UC2: refused, UC3: refused, UC4: refused });

  await pollChannelFeeds();

  // UC1 and UC2: two retry gaps and one gap before the next channel each.
  // UC3: its two retry gaps, then the round stops with no further wait.
  expect(mockSleep.mock.calls).toEqual(
    Array.from({ length: 8 }, () => [YOUTUBE_DISCOVERY_REQUEST_SPACING_MS])
  );
});

it("hands the deferred channels to the next round first", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  scripted({
    UC1: refused,
    UC2: refused,
    UC3: refused,
    UC4: [served("UC4")],
    UC5: [served("UC5")],
  });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

  await pollChannelFeeds();
  await pollChannelFeeds();

  // The fake drops stamped channels, standing in for the real sort putting
  // them last, so the second round sees exactly the two left unstamped.
  expect(requestedChannels()).toEqual([
    ...times("UC1", 3),
    ...times("UC2", 3),
    ...times("UC3", 3),
    "UC4",
    "UC5",
  ]);
});

it("neither counts nor clears the run on a timeout", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  scripted({
    UC1: refused,
    UC2: [timeoutError()],
    UC3: refused,
    UC4: refused,
    UC5: [served("UC5")],
  });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

  await pollChannelFeeds();

  // The timeout left the count at one, so the next two failed channels make
  // three and the round stops before UC5.
  expect(requestedChannels()).toEqual([
    ...times("UC1", 3),
    "UC2",
    ...times("UC3", 3),
    ...times("UC4", 3),
  ]);
});

it("does not count timeouts toward the stop", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const stamped = fakeChannels(["UC1", "UC2", "UC3", "UC4"]);
  scripted({
    UC1: [timeoutError()],
    UC2: [timeoutError()],
    UC3: [timeoutError()],
    UC4: [served("UC4")],
  });
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
  scripted({
    UC1: refused,
    UC2: refused,
    UC3: [served("UC3")],
    UC4: refused,
    UC5: refused,
  });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

  await pollChannelFeeds();

  expect(requestedChannels()).toEqual([
    ...times("UC1", 3),
    ...times("UC2", 3),
    "UC3",
    ...times("UC4", 3),
    ...times("UC5", 3),
  ]);
  expect(stamped.map((write) => write.id)).toEqual([
    "UC1",
    "UC2",
    "UC3",
    "UC4",
    "UC5",
  ]);
});

it("clears the run when a channel is served on its last attempt", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  scripted({
    UC1: refused,
    UC2: refused,
    UC3: [httpError(404), httpError(500), served("UC3")],
    UC4: refused,
    UC5: refused,
  });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);

  await pollChannelFeeds();

  expect(requestedChannels()).toEqual([
    ...times("UC1", 3),
    ...times("UC2", 3),
    ...times("UC3", 3),
    ...times("UC4", 3),
    ...times("UC5", 3),
  ]);
});

it("clears the run on a 2xx body that is not a feed", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  scripted({
    UC1: refused,
    UC2: refused,
    UC3: [{ data: "<html>nope</html>" }],
    UC4: refused,
    UC5: refused,
  });

  await pollChannelFeeds();

  expect(requestedChannels()).toEqual([
    ...times("UC1", 3),
    ...times("UC2", 3),
    "UC3",
    ...times("UC4", 3),
    ...times("UC5", 3),
  ]);
});

it("clears the run on a 2xx even when writing its videos fails", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  scripted({
    UC1: refused,
    UC2: refused,
    UC3: [httpError(404), served("UC3", ["v1"])],
    UC4: refused,
    UC5: refused,
  });
  const writeError = new Error("write concern error");
  const notice = jest
    .spyOn(VideoModel, "noticeUnknownVideos")
    .mockRejectedValue(writeError);

  await pollChannelFeeds();

  // The write did run and fail; the origin had still served the feed.
  expect(notice.mock.calls.map((call) => call[0].length)).toEqual([1]);
  expect(requestedChannels()).toEqual([
    ...times("UC1", 3),
    ...times("UC2", 3),
    ...times("UC3", 2),
    ...times("UC4", 3),
    ...times("UC5", 3),
  ]);
  expect(warn.mock.calls[2]).toEqual([
    "Feed poll failed for [UC3] after 2 attempts:",
    writeError,
  ]);
});

it("still logs the stop when the last channel trips it", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3"]);
  scripted({ UC1: refused, UC2: refused, UC3: refused });

  await pollChannelFeeds();

  expect(warn.mock.calls).toEqual([
    [
      "Feed poll failed for [UC1] after 3 attempts:",
      "Request failed with status code 404",
    ],
    [
      "Feed poll failed for [UC2] after 3 attempts:",
      "Request failed with status code 404",
    ],
    [
      "Feed poll failed for [UC3] after 3 attempts:",
      "Request failed with status code 404",
    ],
    [
      "Feed poll: stopping round after 3 consecutive HTTP failures, 0 channels deferred",
    ],
  ]);
});

it("starts every round with a fresh count", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  fakeChannels(["UC1", "UC2", "UC3", "UC4", "UC5"]);
  scripted({
    UC1: refused,
    UC2: refused,
    UC3: refused,
    UC4: [served("UC4")],
    UC5: [served("UC5")],
  });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);
  // First round: two channels, both refused, so it ends with the count at two.
  jest.spyOn(ChannelModel, "findFeedPollCandidates").mockResolvedValueOnce([
    { id: "UC1", name: "Channel UC1" },
    { id: "UC2", name: "Channel UC2" },
  ] as never);

  await pollChannelFeeds();
  mockGet.mockClear();
  // Second round: one more refused channel, then feeds. A count carried over
  // from the first round would reach three here and stop after UC3.
  await pollChannelFeeds();

  expect(requestedChannels()).toEqual([...times("UC3", 3), "UC4", "UC5"]);
});

it("renews the agenda lock once a minute has passed between channels", async () => {
  fakeChannels(["UC1", "UC2", "UC3"]);
  scripted({
    UC1: [served("UC1")],
    UC2: [served("UC2")],
    UC3: [served("UC3")],
  });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);
  // Each request moves the clock 40 seconds on, so the minute is crossed
  // between the second and the third channel and nowhere else.
  let clock = 0;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
  const answer = mockGet.getMockImplementation();
  mockGet.mockImplementation((url, config) => {
    clock += 40 * 1000;
    return answer!(url, config);
  });
  const touch = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

  await pollChannelFeeds({ touch } as never);

  expect(YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS).toBe(60 * 1000);
  const renewedAt = touch.mock.invocationCallOrder;
  expect(renewedAt).toHaveLength(1);
  // Renewed after UC2's request and before UC3's.
  expect(
    mockGet.mock.invocationCallOrder.map((order) => order < renewedAt[0])
  ).toEqual([true, true, false]);
});

it("ends the round when renewing the lock fails", async () => {
  const stamped = fakeChannels(["UC1", "UC2", "UC3"]);
  scripted({
    UC1: [served("UC1")],
    UC2: [served("UC2")],
    UC3: [served("UC3")],
  });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);
  let clock = 0;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
  const answer = mockGet.getMockImplementation();
  mockGet.mockImplementation((url, config) => {
    clock += 40 * 1000;
    return answer!(url, config);
  });
  // What agenda's touch() does once it has cancelled the run.
  const cancelled = new Error("Job was canceled");
  const touch = jest.fn<() => Promise<void>>().mockRejectedValue(cancelled);

  await expect(pollChannelFeeds({ touch } as never)).rejects.toBe(cancelled);

  // UC3 was never fetched or stamped, so it leads the next round.
  expect(requestedChannels()).toEqual(["UC1", "UC2"]);
  expect(stamped.map((write) => write.id)).toEqual(["UC1", "UC2"]);
});

it("counts the candidate query toward the first renewal", async () => {
  fakeChannels(["UC1"]);
  scripted({ UC1: [served("UC1")] });
  jest.spyOn(VideoModel, "noticeUnknownVideos").mockResolvedValue(undefined);
  let clock = 0;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
  // A query slow enough to use up more than a minute of the lock on its own.
  jest.spyOn(ChannelModel, "findFeedPollCandidates").mockImplementation((() => {
    clock += 70 * 1000;
    return Promise.resolve([{ id: "UC1", name: "Channel UC1" }]);
  }) as never);
  const touch = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

  await pollChannelFeeds({ touch } as never);

  const renewedAt = touch.mock.invocationCallOrder;
  expect(renewedAt).toHaveLength(1);
  // Renewed before the first request, not a minute after it.
  expect(
    mockGet.mock.invocationCallOrder.map((order) => order < renewedAt[0])
  ).toEqual([false]);
});
```

- [ ] **Step 3: Run the tests against the unchanged implementation**

Run: `npm run test -- src/services/crawler/discovery/feed-poll.spec.ts`

Expected: FAIL. Jest compiles transpile-only, so passing a `job` argument to the current zero-parameter `pollChannelFeeds` is not a compile error. Every failure below must be an assertion about request lists, sleeps, warn lines, stamps, touch calls or the promise outcome, not a module or type error.

These tests fail:

- `"logs a failed channel as one line carrying only its last error"`: one request instead of three, and the warn line lacks `after 3 attempts`.
- `"keeps the whole error when the failure is not an http one"`: the warn prefix lacks `after 1 attempts`.
- `"retries an http failure and takes the feed once it is served"`: one request, no write.
- `"does not retry a timeout"`: the warn prefix lacks `after 1 attempts`.
- `"stops retrying at a timeout and does not count that channel"`: each channel is requested once.
- `"stops the round after three channels in a row run out of attempts"`: one request per channel.
- `"does not wait for the spacing once the round is stopped"`: 2 sleeps instead of 8.
- `"hands the deferred channels to the next round first"`: one request per refused channel.
- `"neither counts nor clears the run on a timeout"`: one request per channel.
- `"clears the run when a feed is served in between"`: one request per channel.
- `"clears the run when a channel is served on its last attempt"`: UC3's first 404 already makes three failures in a row, so the round stops after UC3.
- `"clears the run on a 2xx body that is not a feed"`: one request per channel.
- `"clears the run on a 2xx even when writing its videos fails"`: UC3's first 404 makes three failures in a row, so the round stops before the write.
- `"still logs the stop when the last channel trips it"`: the warn lines lack `after 3 attempts`.
- `"starts every round with a fresh count"`: one request for UC3.
- `"renews the agenda lock once a minute has passed between channels"`: `touch` is never called.
- `"ends the round when renewing the lock fails"`: the promise resolves.
- `"counts the candidate query toward the first renewal"`: `touch` is never called.

These tests PASS already, and that is expected:

- `"does not retry a 2xx whose body is not a feed"`
- `"does not count timeouts toward the stop"`

The unchanged code makes one request per channel and never retries, so it cannot violate them. They pin that a 2xx, or a timeout, ends a channel after a single request.

Record the actual failure output in the task report.

- [ ] **Step 4: Rewrite `feed-poll.ts`**

Replace the whole content of `src/services/crawler/discovery/feed-poll.ts` with:

```ts
import type { Job } from "agenda";
import axios from "axios";
import { setTimeout as sleep } from "node:timers/promises";
import {
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES,
  YOUTUBE_FEED_POLL_ATTEMPTS,
  YOUTUBE_FEED_POLL_BATCH_SIZE,
  YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS,
  YOUTUBE_FEED_TIMEOUT_MS,
} from "#constants.js";
import ChannelModel from "#models/Channel.js";
import VideoModel, { type DiscoveredVideo } from "#models/Video.js";
import { parseNotification } from "../atom.js";

// Note the missing "/xml" compared with the pubsub topic url: that one is a
// static document describing the hub and carries no entries at all. This is the
// address of the real per-channel feed.
const FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";

/** One channel's feed read, and how many requests it took to get there. */
type FeedFetch =
  | { ok: true; body: string; attempts: number }
  | { ok: false; error: unknown; attempts: number };

// The server answered, and not with a 2xx. A timeout or a dropped connection
// rejects without a response.
function isHttpFailure(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response !== undefined;
}

/**
 * Reads one channel's feed, asking again after an http failure until
 * YOUTUBE_FEED_POLL_ATTEMPTS requests have been made.
 *
 * Every day around 01:00-07:00 UTC the feed's origin answers most requests with
 * 404 or 500, whoever sends them, and it fails request by request rather than
 * channel by channel, so asking again has a fair chance. The url stays as it is:
 * an edge cache hit is the one answer that stays reliable during the outage. A
 * timeout or a dropped connection is not asked again; it may already have taken
 * the whole timeout, and it is not what the outage looks like.
 */
async function fetchFeed(channelId: string): Promise<FeedFetch> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await axios.get<string>(`${FEED_URL}${channelId}`, {
        timeout: YOUTUBE_FEED_TIMEOUT_MS,
        // Without this axios would try to guess, and an XML body can come back
        // parsed into an object that the Atom parser cannot read.
        responseType: "text",
      });
      return { ok: true, body: response.data, attempts: attempt };
    } catch (error) {
      if (attempt >= YOUTUBE_FEED_POLL_ATTEMPTS || !isHttpFailure(error)) {
        return { ok: false, error, attempts: attempt };
      }
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}

// One line per failed channel, for its last attempt only. An http failure is
// reduced to its message: the rejected error carries the config, the request,
// the socket and the HTML error page Google served — around a hundred lines
// each — and the status line is all of it that says anything, while the daily
// outage brings these by the hundred. Anything else is a bug rather than the
// network, and its stack is the only way to place it.
function warnFailure(channelId: string, attempts: number, error: unknown) {
  console.warn(
    `Feed poll failed for [${channelId}] after ${attempts} attempts:`,
    axios.isAxiosError(error) ? error.message : error
  );
}

/**
 * One feed-poll round: take the least recently fetched channels, read each
 * one's RSS feed, and create whatever videos are new.
 *
 * The batch size is a constant rather than a function of how many channels are
 * subscribed. That is what makes the outbound request rate predictable: more
 * channels stretch the rotation instead of widening each round.
 *
 * Reuses the pubsub notification parser — a notification body and this feed are
 * the same Atom document, and every entry carries the videoId, channelId, title
 * and published time a document needs.
 *
 * A run of channels that each used every attempt and still got an http failure
 * ends the round early. When the origin is refusing nearly everything, carrying
 * on would only spend the batch and the log on that. The channels left untried
 * keep their old stamp, so the next round starts with them.
 *
 * Retries make a round's length depend on how quickly failures come back, so
 * when agenda hands its `job` in, the lock is renewed between channels once a
 * minute has passed.
 */
export async function pollChannelFeeds(job?: Job): Promise<void> {
  // Taken before the candidate query: agenda's lock has been running since the
  // job started, and the query's time counts against it too.
  let touchedAt = Date.now();
  const candidates = await ChannelModel.findFeedPollCandidates(
    YOUTUBE_FEED_POLL_BATCH_SIZE
  );

  // Channels in a row whose last attempt came back with an http status. Only a
  // status says the feed's origin itself is refusing; a timeout or a dropped
  // connection says nothing about it, so those leave the count where it was.
  let consecutiveHttpFailures = 0;

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];

    if (Date.now() - touchedAt >= YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS) {
      // Not caught. agenda throws here once it has cancelled this run, and
      // going on would be work done without the lock. Channels already handled
      // are stamped and the rest lead the next round, as after an early stop.
      await job?.touch();
      touchedAt = Date.now();
    }

    const fetched = await fetchFeed(channel.id);
    if (fetched.ok) {
      // Any 2xx means the origin is serving us, whatever the body turns out to
      // be and whether or not the write below succeeds.
      consecutiveHttpFailures = 0;
      // One channel's failure must not cost the rest of the round theirs.
      try {
        const entries = parseNotification(fetched.body);
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
        warnFailure(channel.id, fetched.attempts, error);
      }
    } else {
      if (isHttpFailure(fetched.error)) {
        consecutiveHttpFailures++;
      }
      warnFailure(channel.id, fetched.attempts, fetched.error);
    }

    // Its own try, for two reasons. It must run even when the channel failed —
    // a channel that always fails would otherwise stay at the head of the
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
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- src/services/crawler/discovery/feed-poll.spec.ts`

Expected: PASS. That covers all 20 new tests and the nine kept tests:

- `"requests the real channel feed url with a timeout"`
- `"asks for one batch of the configured size"`
- `"hands every parsed entry to the discovery write path"`
- `"never spends quota: no Data API client is ever built"`
- `"spaces the requests and does not wait after the last one"`
- `"stamps a failing channel anyway so it cannot hold the front of the queue"` (its `socket hang up` is a plain `Error`, not retried)
- `"skips a body that is not a feed but still stamps the channel"`
- `"keeps going when stamping one channel rejects"`
- `"does nothing when no channel is due"`

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run format:check`

Expected: no errors. If prettier reports either file, run `npx prettier --write src/services/crawler/discovery/feed-poll.ts src/services/crawler/discovery/feed-poll.spec.ts`, then re-run the tests.

- [ ] **Step 7: Commit (via the git-master skill)**

Files: `src/services/crawler/discovery/feed-poll.ts`, `src/services/crawler/discovery/feed-poll.spec.ts`

Message:

```text
fix(crawler): retry a refused feed and log only its last failure

Every day around 01:00-07:00 UTC the feed's origin fails most requests
for any client, request by request, so each channel now gets up to
three tries at an http failure. A failed channel logs one line, for
its last attempt. The early stop counts channels that ran out of tries,
and the round renews its agenda lock once a minute since retries make
its length depend on how fast failures come back.
```

---

### Task 3: Crawler wiring and schedule comments

**Files:**

- Modify: `src/services/crawler/index.ts` (the lock comment above the three discovery jobs, the feed-poll `agenda.define`, and the comment above its `agenda.every`, around lines 353–366)

- [ ] **Step 1: Replace the lock comment, the handler and the schedule comment**

Replace this exact text:

```ts
// None of these three set a lockLifetime or call job.touch(). Their worst
// cases are 2.4, 4.3 and 1.7 minutes — every request carries a timeout and
// retries are off — which stays well inside agenda's 10 minute default, the
// same reasoning the pubsub renewal job relies on.

const JOB_YOUTUBE_FEED_POLL = "crawler youtube feed poll";
agenda.define(JOB_YOUTUBE_FEED_POLL, async (_job: Job): Promise<void> => {
  await pollChannelFeeds();
});
// Two minutes at the feed batch size covers 420 channels an hour, which keeps
// the day's requests under the feed's per-address daily ceiling. The feed's
// own 15 minute edge cache means polling any single channel faster than that
// would return the same bytes anyway.
void agenda.every("2 minutes", JOB_YOUTUBE_FEED_POLL);
```

with:

```ts
// The members poll and the existence probe set no lockLifetime and never
// call job.touch(). Their worst cases are 4.3 and 1.7 minutes — every request
// carries a timeout and retries are off — which stays well inside agenda's 10
// minute default, the same reasoning the pubsub renewal job relies on. The
// feed poll is different: it retries http failures, so its length depends on
// how quickly they come back. About 3.6 minutes when they come back fast, as
// observed, but nothing bounds that, so it renews its own lock once a minute,
// checked between channels.

const JOB_YOUTUBE_FEED_POLL = "crawler youtube feed poll";
agenda.define(JOB_YOUTUBE_FEED_POLL, async (job: Job): Promise<void> => {
  await pollChannelFeeds(job);
});
// Two minutes covers 600 channels an hour, and the feed's own 15 minute edge
// cache means polling any single channel faster than that would return the
// same bytes anyway.
void agenda.every("2 minutes", JOB_YOUTUBE_FEED_POLL);
```

(3.6 minutes = 20 channels × (10 s timeout + 2 × 250 ms retry gaps + 250 ms spacing) ≈ 215 s.)

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run format:check && npm run test -- src/services/crawler/discovery/feed-poll.spec.ts`

Expected: no errors. All feed-poll tests PASS.

- [ ] **Step 3: Commit (via the git-master skill)**

Files: `src/services/crawler/index.ts`

Message:

```text
fix(crawler): hand the feed poll its job so it can renew the lock
```

---

### Task 4: Correct the two earlier design documents

**Files:**

- Modify: `docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md`
- Modify: `docs/superpowers/specs/2026-09-27-feed-poll-rate-budget-design.md`

These are spec documents, so the prose stays in 繁體中文.

Commit `7cc82d4` is the most recent change to the 09-18 document, it touched only that file, and it carried the wrong per-IP-ceiling figures. Revert it first, then layer the corrected facts on top.

- [ ] **Step 1: Revert the budget edit without committing**

Run: `git revert --no-commit 7cc82d4`

Expected: no conflicts. `git status --short` shows exactly `M  docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md`.

After this the document reads 20 筆 / 600 頻道/小時 / 450 / 14400 / 18144 / 0.244 / 3.4 分 / 唯一例外是配額耗盡 again.

- [ ] **Step 2: Rate-limit measurement note (near line 93)**

Replace:

```text
- oEmbed 與 feed **全部 200，零 429，無任何速率限制 header**。
```

with:

```text
- oEmbed 與 feed **全部 200，零 429，無任何速率限制 header**。這只驗證了瞬間速率。上線後觀察到 feed 源站每天約 01:00–07:00 UTC 對任何來源 IP 都大量回 404/500（逐次請求隨機失敗、與請求量無關），這段時間回源只偶爾成功（實測約 27%），edge 快取命中則穩定可用。
```

- [ ] **Step 3: Constants code block (near lines 397–407)**

Replace:

```text
// Channels fetched in one feed-poll round. On the 2-minute schedule that is 600
// channels/hour. Discovery latency is one rotation plus the feed's 15-minute
// edge cache, so the one-hour target holds up to 450 subscribed channels; 300
// channels land around 45 minutes. Raise this if the subscription list grows
// past that — the feed costs no quota, only outbound requests.
export const YOUTUBE_FEED_POLL_BATCH_SIZE = 20;

// Gap between two outbound requests inside any discovery round. Both endpoints
// served 10 req/s for 10 seconds and 120-concurrent bursts without a single
// 429, so 4 req/s keeps a 2.5x margin below what was actually verified.
export const YOUTUBE_DISCOVERY_REQUEST_SPACING_MS = 250;
```

with the four blocks from Task 1 Step 1 followed by the block from Task 1 Step 2, verbatim:

```text
// Channels fetched in one feed-poll round. On the 2-minute schedule that is 600
// channels/hour. Discovery latency is one rotation plus the feed's 15-minute
// edge cache, so the one-hour target holds up to 450 subscribed channels; 300
// channels land around 45 minutes. Raise this if the subscription list grows
// past that — the feed costs no quota, only outbound requests. Its outages
// follow the clock, not our volume: every day around 01:00-07:00 UTC its origin
// answers most requests with 404 or 500 whatever address they come from; edge
// cache hits stay reliable. Polling less does not shorten that.
export const YOUTUBE_FEED_POLL_BATCH_SIZE = 20;

// Requests one channel's feed may take in a round, the first one included. Only
// an http failure is tried again: inside the daily outage window a single
// origin fetch succeeded about 27% of the time (12 of 45), so three tries reach
// about 61%. Each extra try is one more request at an origin that is already
// failing, which is why it stops at three.
export const YOUTUBE_FEED_POLL_ATTEMPTS = 3;

// Channels in a row that end a feed-poll round early, each having used every
// attempt and still got an http failure. Outside the outage window the feed
// failed zero times across three days of logs, so this does not trip by chance.
// Inside it about 39% of channels run out of attempts, so a round stops part-way
// about half the time; when the origin refuses everything a round costs three
// channels' attempts, nine requests, instead of a whole batch.
export const YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES = 3;

// How often a feed-poll round renews its agenda lock. It is checked between
// channels, and one channel takes at most three timeouts' worth, about 31
// seconds, so renewals land within about a minute and a half of each other —
// well inside agenda's 10 minute lock, at a cost of a few writes per round.
export const YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS = 60 * 1000;

// Gap between two outbound requests inside any discovery round, and between two
// attempts at the same feed. Both endpoints served 10 req/s for 10 seconds and
// 120-concurrent bursts without a single 429, so 4 req/s keeps a 2.5x margin
// below what was actually verified.
export const YOUTUBE_DISCOVERY_REQUEST_SPACING_MS = 250;
```

- [ ] **Step 4: Error-handling paragraph (near line 522)**

In the paragraph that starts `**單筆失敗不中斷整輪**，唯一例外是配額耗盡。`, replace that opening sentence with `**單筆失敗不中斷整輪**，例外有二，第一個是配額耗盡。` and leave the rest of the paragraph unchanged.

Directly after that paragraph (separated by a blank line), insert:

```text
第二個例外屬於 feed 輪詢。每個頻道最多請求 3 次，只有 HTTP 失敗（伺服器有回狀態碼）才重試，重試前等 250 ms；timeout、連線錯誤與 2xx 都不重試。失敗的頻道只記一行，內容是最後一次的錯誤。以頻道的最終結果計數：用完嘗試仍以 HTTP 失敗結束 +1，任何 2xx 歸零，其他不變；連續 3 個頻道 +1 即中止本輪，記一行 warn。已處理的頻道照常推進時間戳，其餘不寫時間戳，留給下一輪優先處理。這個判斷不保存跨輪狀態。
```

- [ ] **Step 5: Timeout table and lock paragraph (near lines 526–536)**

Replace `**逾時與 agenda lock。** 每輪最壞耗時（每筆一次請求，因為關掉了重試）：` with `**逾時與 agenda lock。** 每輪最壞耗時（UUMO 與復活探測每筆一次請求，因為關掉了重試；feed 會重試 HTTP 失敗）：`.

Replace the feed row `| feed     | 20       | 10 秒 + 250 ms | 3.4 分   |` with `| feed     | 20       | 10 秒 + 3 × 250 ms | 3.6 分（HTTP 失敗回得快時的估計） |`.

Replace `這張表建立在 `retry: false` 之上。` with `UUMO 與復活探測兩列建立在 `retry: false` 之上。` (only this sentence; the rest of that paragraph stays).

In the paragraph that starts `feed 的週期是 2 分鐘`, replace its last sentence `agenda 的 `lockLifetime` 預設值與重疊時的實際行為屬第三方套件行為，實作計畫階段須以 research 確認後再決定是否需要顯式設定，本設計不對其做假設。` with:

```text
agenda 6.2.4 的 `lockLifetime` 預設為 10 分鐘。feed 的耗時取決於 HTTP 失敗回來的速度，沒有硬上限，因此執行期間在頻道與頻道之間每分鐘呼叫一次 `job.touch()` 維持 lock。
```

- [ ] **Step 6: Superseded notice on the 09-27 document**

In `docs/superpowers/specs/2026-09-27-feed-poll-rate-budget-design.md`, directly after the first line `# feed 輪詢每日請求預算與限流中止` and its following blank line, insert this paragraph followed by a blank line:

```text
> **本文件的根因假設已被推翻（2026-10-03）。** 「每個出口 IP 每日約 11000 次上限」不成立：降頻後失敗視窗沒有延後，跨國、跨 ASN 的 IP 在視窗內同樣大量失敗。實際是 feed 源站每天約 01:00–07:00 UTC 的時段性故障，與請求量無關。降頻已撤回，改為重試，見 `2026-10-03-feed-poll-retry-design.md`。以下內容保留作為歷史紀錄。
```

- [ ] **Step 7: Verify**

Run: `npx prettier --check docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md docs/superpowers/specs/2026-09-27-feed-poll-rate-budget-design.md`

Expected: both formatted. If not, run `npx prettier --write` on them and check again. (`npm run format:check` only covers `src/`.)

Then run:

```bash
grep -n "11000 次\|315 個\|10080\|14 筆\|2\.4 分\|420 頻道\|per-address\|daily ceiling" docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md
```

Expected: no output.

- [ ] **Step 8: Commit (via the git-master skill)**

Files: `docs/superpowers/specs/2026-09-18-youtube-official-video-discovery-design.md`, `docs/superpowers/specs/2026-09-27-feed-poll-rate-budget-design.md`. Both carry the same correction of one wrong root cause, so they go in one commit.

Message:

```text
docs(spec): replace the feed ceiling with the daily outage window
```
