# Wait for Channel Crawl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `/track add`, `/track chat block-moderator`, or `/track chat follow-sender` creates a new channel document with placeholder name "Unknown channel", wait for the crawler to populate real channel info (up to 10 minutes) and edit the reply with the correct name.

**Architecture:** Add a `Channel.waitForCrawl` static method that polls `findByChannelId` with 5s→30s backoff, returning as soon as `crawledAt` is set or after timeout. The 3 affected Discord commands call it after their initial reply and use `editReply` to update the message.

**Tech Stack:** TypeScript, Typegoose/Mongoose, discord.js v14, Jest + ts-jest.

**Spec:** [docs/superpowers/specs/2026-04-06-wait-for-channel-crawl-design.md](docs/superpowers/specs/2026-04-06-wait-for-channel-crawl-design.md)

---

## File Structure

- **Modify:** [src/models/Channel.ts](src/models/Channel.ts) — add `waitForCrawl` static method near the existing finder methods.
- **Create:** [src/models/Channel.spec.ts](src/models/Channel.spec.ts) — unit tests for `waitForCrawl` using jest fake timers + mocked `findByChannelId`.
- **Modify:** [src/discord/commands/track/track.ts](src/discord/commands/track/track.ts) — update `addTrackChannel`, `blockModerator`, `followSender` to edit-reply after the wait.

---

## Task 1: Add `waitForCrawl` static method on Channel model

**Files:**
- Modify: [src/models/Channel.ts](src/models/Channel.ts) — add method just before `//#endregion find methods` (around line 177)

- [ ] **Step 1: Write the failing test**

Create `src/models/Channel.spec.ts`:

```ts
/// <reference types="jest" />
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import ChannelModel from "./Channel";

describe("Channel.waitForCrawl", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("returns document immediately when crawledAt is already set", async () => {
    const doc = { id: "UC123", name: "Real Name", crawledAt: new Date() } as any;
    const spy = jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue(doc);

    const result = await ChannelModel.waitForCrawl("UC123");

    expect(result).toBe(doc);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("polls with backoff until crawledAt appears", async () => {
    const uncrawled = { id: "UC123", name: "Unknown channel", crawledAt: null } as any;
    const crawled = { id: "UC123", name: "Real Name", crawledAt: new Date() } as any;
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValueOnce(uncrawled)
      .mockResolvedValueOnce(uncrawled)
      .mockResolvedValueOnce(crawled);

    const promise = ChannelModel.waitForCrawl("UC123");
    // Poll 1 happens immediately; then wait 5s, poll 2; wait 10s, poll 3 returns crawled
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(10_000);

    const result = await promise;
    expect(result).toBe(crawled);
  });

  it("returns last snapshot with crawledAt null on timeout", async () => {
    const uncrawled = { id: "UC123", name: "Unknown channel", crawledAt: null } as any;
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(uncrawled);

    const promise = ChannelModel.waitForCrawl("UC123", { timeoutMs: 20_000 });
    await jest.advanceTimersByTimeAsync(25_000);

    const result = await promise;
    expect(result).toBe(uncrawled);
    expect(result?.crawledAt).toBeNull();
  });

  it("returns null when document never exists", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(null);

    const promise = ChannelModel.waitForCrawl("UC123", { timeoutMs: 20_000 });
    await jest.advanceTimersByTimeAsync(25_000);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("throws on abort signal", async () => {
    const uncrawled = { id: "UC123", name: "Unknown channel", crawledAt: null } as any;
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(uncrawled);
    const controller = new AbortController();

    const promise = ChannelModel.waitForCrawl("UC123", { signal: controller.signal });
    controller.abort();
    await jest.advanceTimersByTimeAsync(6_000);

    await expect(promise).rejects.toThrow(/abort/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/Channel.spec.ts -v`
Expected: FAIL with `TypeError: ChannelModel.waitForCrawl is not a function` (or similar).

- [ ] **Step 3: Implement `waitForCrawl`**

In [src/models/Channel.ts](src/models/Channel.ts), add this method inside the `Channel` class, just before the `//#endregion find methods` line (around line 177):

```ts
  public static async waitForCrawl(
    this: ReturnModelType<typeof Channel>,
    channelId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<DocumentType<Channel> | null> {
    const timeoutMs = options?.timeoutMs ?? 600_000;
    const signal = options?.signal;
    const deadline = Date.now() + timeoutMs;
    const backoffSchedule = [5_000, 10_000, 15_000, 20_000, 25_000, 30_000];
    let attempt = 0;
    let latest: DocumentType<Channel> | null = null;

    while (true) {
      if (signal?.aborted) {
        throw new Error("waitForCrawl aborted");
      }

      latest = await this.findByChannelId(channelId);
      if (latest?.crawledAt) {
        return latest;
      }

      if (Date.now() >= deadline) {
        return latest;
      }

      const delay = backoffSchedule[Math.min(attempt, backoffSchedule.length - 1)];
      const remaining = deadline - Date.now();
      const waitMs = Math.min(delay, remaining);
      if (waitMs <= 0) {
        return latest;
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, waitMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("waitForCrawl aborted"));
        };
        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      attempt++;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/models/Channel.spec.ts -v`
Expected: all 5 tests PASS.

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/models/Channel.ts src/models/Channel.spec.ts
git commit -m "feat(channel): add waitForCrawl static method with backoff polling"
```

---

## Task 2: Update `addTrackChannel` to edit reply after crawl

**Files:**
- Modify: [src/discord/commands/track/track.ts:236-242](src/discord/commands/track/track.ts#L236-L242)

- [ ] **Step 1: Apply the edit**

Replace the final reply block at the end of `addTrackChannel` (around lines 236-242):

**Before:**
```ts
    await intr.reply({
      embeds: [
        {
          description: `Now tracking ${channel.getHyperlink()} (${channelId}).`,
        },
      ],
    });
  }
```

**After:**
```ts
    await intr.reply({
      embeds: [
        {
          description: `Now tracking ${channel.getHyperlink()} (${channelId}).`,
        },
      ],
    });

    if (!channel.crawledAt) {
      try {
        const updated = await ChannelModel.waitForCrawl(channelId);
        if (updated?.crawledAt) {
          const warning = updated.deleted
            ? " ⚠️ This channel may not exist on YouTube."
            : "";
          await intr.editReply({
            embeds: [
              {
                description: `Now tracking ${updated.getHyperlink()} (${channelId}).${warning}`,
              },
            ],
          });
        }
      } catch (err) {
        console.error("[track add] waitForCrawl/editReply failed:", err);
      }
    }
  }
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/discord/commands/track/track.ts
git commit -m "feat(track): edit reply with real channel name after crawl in /track add"
```

---

## Task 3: Update `blockModerator` to edit reply after crawl

**Files:**
- Modify: [src/discord/commands/track/track.ts:558-564](src/discord/commands/track/track.ts#L558-L564)

- [ ] **Step 1: Apply the edit**

Replace the final reply block at the end of `blockModerator` (around lines 558-564):

**Before:**
```ts
    await intr.reply({
      embeds: [
        {
          description: `Blocked ${channel.getHyperlink()} (${channelId}) from chat.`,
        },
      ],
    });
  }
```

**After:**
```ts
    await intr.reply({
      embeds: [
        {
          description: `Blocked ${channel.getHyperlink()} (${channelId}) from chat.`,
        },
      ],
    });

    if (!channel.crawledAt) {
      try {
        const updated = await ChannelModel.waitForCrawl(channelId);
        if (updated?.crawledAt) {
          const warning = updated.deleted
            ? " ⚠️ This channel may not exist on YouTube."
            : "";
          await intr.editReply({
            embeds: [
              {
                description: `Blocked ${updated.getHyperlink()} (${channelId}) from chat.${warning}`,
              },
            ],
          });
        }
      } catch (err) {
        console.error("[track block-moderator] waitForCrawl/editReply failed:", err);
      }
    }
  }
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/discord/commands/track/track.ts
git commit -m "feat(track): edit reply with real channel name after crawl in block-moderator"
```

---

## Task 4: Update `followSender` to edit reply after crawl

**Files:**
- Modify: [src/discord/commands/track/track.ts:670-676](src/discord/commands/track/track.ts#L670-L676)

- [ ] **Step 1: Apply the edit**

Replace the final reply block at the end of `followSender` (around lines 670-676):

**Before:**
```ts
    await intr.reply({
      embeds: [
        {
          description: `Following ${channel.getHyperlink()} (${channelId}) in chat.`,
        },
      ],
    });
  }
```

**After:**
```ts
    await intr.reply({
      embeds: [
        {
          description: `Following ${channel.getHyperlink()} (${channelId}) in chat.`,
        },
      ],
    });

    if (!channel.crawledAt) {
      try {
        const updated = await ChannelModel.waitForCrawl(channelId);
        if (updated?.crawledAt) {
          const warning = updated.deleted
            ? " ⚠️ This channel may not exist on YouTube."
            : "";
          await intr.editReply({
            embeds: [
              {
                description: `Following ${updated.getHyperlink()} (${channelId}) in chat.${warning}`,
              },
            ],
          });
        }
      } catch (err) {
        console.error("[track follow-sender] waitForCrawl/editReply failed:", err);
      }
    }
  }
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run full test suite**

Run: `npx jest`
Expected: all tests PASS (including the new Channel.spec.ts).

- [ ] **Step 4: Commit**

```bash
git add src/discord/commands/track/track.ts
git commit -m "feat(track): edit reply with real channel name after crawl in follow-sender"
```

---

## Self-Review Checklist (for plan author — already completed)

- **Spec coverage:** ✓ `waitForCrawl` method (Task 1), 3 command updates (Tasks 2-4), timeout behavior 1A (leave reply on timeout — `if (updated?.crawledAt)` guard), deleted warning 2B (⚠️ suffix), editReply error handling (try/catch with log).
- **Placeholders:** none.
- **Type consistency:** `waitForCrawl(channelId, options?)` signature matches across tasks; `updated?.crawledAt` guard used consistently.
