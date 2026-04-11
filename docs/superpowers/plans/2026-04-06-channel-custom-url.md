# Channel Custom URL (@handle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add YouTube `@handle` (customUrl) support to Channel model, populate it from YouTube API, use it in `findByName` search, and unify raid `sourceName`/`originName` to use `@handle`.

**Architecture:** Add a `customUrl` string field to Channel, populate via `snippet.customUrl` in the existing `updateChannelFromYoutube` flow, expand `findByName` search, and swap `channelName` for `customUrl ?? channelName` in worker raid handlers.

**Tech Stack:** TypeScript, Typegoose/Mongoose, googleapis v134

---

### Task 1: Add `customUrl` prop to Channel model

**Files:**
- Modify: `src/models/Channel.ts:40-55` (add prop after `englishName`)

- [ ] **Step 1: Add the `customUrl` property**

In `src/models/Channel.ts`, add after the `englishName` prop (line 48):

```typescript
@prop()
public customUrl?: string;
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS, no errors

- [ ] **Step 3: Commit**

```bash
git add src/models/Channel.ts
git commit -m "feat(channel): add customUrl prop for YouTube @handle"
```

---

### Task 2: Populate `customUrl` from YouTube API

**Files:**
- Modify: `src/modules/youtube.ts:207-223` (add customUrl extraction)

- [ ] **Step 1: Add `customUrl` extraction in `updateChannelFromYoutube`**

In `src/modules/youtube.ts`, inside the `if (ytInfo)` block (after line 208), add:

```typescript
      if (ytInfo.snippet?.customUrl)
        channel.customUrl = ytInfo.snippet.customUrl;
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/modules/youtube.ts
git commit -m "feat(youtube): populate customUrl from snippet.customUrl"
```

---

### Task 3: Add `customUrl` to `findByName` search

**Files:**
- Modify: `src/models/Channel.ts:140-146` (add customUrl to `$or` array)

- [ ] **Step 1: Add `customUrl` to the `$or` search conditions**

In `src/models/Channel.ts`, inside `findByName`'s `$or` array (after the `id` regex on line 145), add:

```typescript
            { customUrl: { $regex: name, $options: "i" } },
```

The full `$or` array becomes:

```typescript
          $or: [
            { name: { $regex: name, $options: "i" } },
            { englishName: { $regex: name, $options: "i" } },
            { organization: { $regex: name, $options: "i" } },
            { group: { $regex: name, $options: "i" } },
            { id: { $regex: name, $options: "i" } },
            { customUrl: { $regex: name, $options: "i" } },
          ],
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/models/Channel.ts
git commit -m "feat(channel): include customUrl in findByName search"
```

---

### Task 4: Use `@handle` in raid handlers

**Files:**
- Modify: `src/commands/worker.ts:131` (destructure `customUrl`)
- Modify: `src/commands/worker.ts:710` (IncomingRaid `originName`)
- Modify: `src/commands/worker.ts:737` (OutgoingRaid `sourceName`)

- [ ] **Step 1: Destructure `customUrl` from channel**

In `src/commands/worker.ts`, change line 131 from:

```typescript
  const { name: channelName, avatarUrl: channelAvatarUrl } =
    await video.getChannel();
```

to:

```typescript
  const { name: channelName, avatarUrl: channelAvatarUrl, customUrl: channelHandle } =
    await video.getChannel();
```

- [ ] **Step 2: Update IncomingRaid `originName`**

In `src/commands/worker.ts`, change line 710 from:

```typescript
                originName: channelName,
```

to:

```typescript
                originName: channelHandle ?? channelName,
```

- [ ] **Step 3: Update OutgoingRaid `sourceName`**

In `src/commands/worker.ts`, change line 737 from:

```typescript
                sourceName: channelName,
```

to:

```typescript
                sourceName: channelHandle ?? channelName,
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Run lint**

Run: `npx eslint src/commands/worker.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/commands/worker.ts
git commit -m "fix(worker): use channel @handle in raid sourceName/originName"
```
