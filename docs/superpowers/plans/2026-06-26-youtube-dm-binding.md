# YouTube 帳號綁定 → Discord DM 個人通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者透過 Discord bot 指令綁定已驗證所有權的 YouTube 頻道，當這些頻道在 YouTube 發出 superchat / membership 等事件時，由系統私訊（DM）通知使用者；監視完全複用既有 webhook 子系統。

**Architecture:** 新增 `YoutubeDmBinding` model 為唯一來源；manager 的 `youtube-dm-operator` 仿 `track-operator` 把綁定收斂成一份 `Webhook` 文件（`insertUrl=discord-dm://<userId>`）；webhook process 以 `checkIsDiscordDmUrl` 分派到 `sendDiscordDm`（REST-only bot token，投遞前做 consent 檢查）；discord-bot 提供 `/youtube-dm` 指令與兩條 OAuth callback（Google / Discord connections），驗證後丟棄 token。

**Tech Stack:** TypeScript (ESM/NodeNext), Typegoose + Mongoose, discord.js 14.19 + @discordjs/rest, googleapis 173 (`google.auth.OAuth2`), node-redis v4, Fastify, Agenda, Jest (ts-jest ESM, `jest.spyOn` unit tests — no real Mongo).

**Spec:** `docs/superpowers/specs/2026-06-26-youtube-dm-binding-design.md` (committed). Honour its accepted trade-offs: soft binding limit, non-atomic OAuth state read-then-delete, Google bearer-link model, unbind millisecond residual race; non-goal: no cross-version deploy/rollback handling.

**Conventions (verified against the codebase):**

- Models: named class + default `getModelForClass(...)`; statics typed with `ReturnModelType<typeof X>`.
- Tests: `import { afterEach, describe, expect, it, jest } from "@jest/globals";` + `jest.spyOn(Model, "method").mockResolvedValue(...)`; plain objects `as any`; `afterEach(() => jest.restoreAllMocks())`. No DB connection.
- Run one test: `npm run test -- src/path/file.spec.ts` (add `-t "<name>"` to filter).
- Type-check gate (jest uses `isolatedModules`, so it does NOT type-check): `npm run build`.
- Lint: `npm run lint`.
- ESM: import sibling files with `.js` extension even though sources are `.ts`.
- Redis client (node-redis v4): `redis.set(key, val, { PX: ms })`, `redis.get(key)` → `string | null`, `redis.del(key)`.
- discord.js: `import { REST, Routes } from "discord.js"`; `Routes.userChannels()` → `/users/@me/channels`; `Routes.channelMessages(id)` → `/channels/{id}/messages`; `rest.setToken(token)`; `rest.request({ fullRoute, method, body, auth })`.

**Circular-dependency note:** `YoutubeDmBinding` (model) imports `transformYoutubeDmBinding` from `youtube-dm-operator`, while the operator imports `YoutubeDmBindingModel` and uses the `Webhook.youtubeDmBinding` field — exactly the `Track` ↔ `track-operator` pattern. ESM + tsc tolerate the cycle at runtime/type level, but all three changes must land **together** to compile. Task 3 creates them as one unit.

**After EVERY task** (per `~/.claude/CLAUDE.md`): run `npm run build` (type check), `npm run lint`, and the task's tests; all must pass before committing.

---

## File Structure

**Create:**

- `src/models/YoutubeDmBinding.ts` — binding model + null-safe statics + binding error classes.
- `src/models/YoutubeDmBinding.spec.ts` — model/static unit tests.
- `src/components/youtube-dm-operator.ts` — `transformYoutubeDmBinding` + `transformYoutubeDmBindings` sweep + `youtubeDmOperator(app)`.
- `src/components/youtube-dm-operator.spec.ts` — operator unit tests.
- `src/data/track.spec.ts` — `getChannelIdFilter` tests.
- `src/data/webhook.spec.ts` — `checkIsDiscordDmUrl` tests.
- `src/commands/webhook-dm.spec.ts` — `sendDiscordDm` tests.
- `src/components/webhook-prepare.spec.ts` — DM-skip tests.
- `src/discord/oauth/state.ts` (+ `.spec.ts`) — Redis OAuth state store.
- `src/discord/oauth/google.ts` (+ `.spec.ts`) — Google authorize URL + code→channels.
- `src/discord/oauth/discord.ts` (+ `.spec.ts`) — Discord authorize URL + code→identity/connections.
- `src/discord/oauth/callback.ts` (+ `.spec.ts`) — Fastify callback handlers + shared bind logic.
- `src/discord/commands/youtube-dm/youtube-dm.ts` (+ `.spec.ts`) — `/youtube-dm` command.

**Modify:**

- `src/constants.ts` — new env constants.
- `src/data/track.ts` — export `getChannelIdFilter`, change it to accept `string[]`; update internal callers.
- `src/models/Webhook.ts` — add `youtubeDmBinding` Ref + partial unique index.
- `src/data/webhook.ts` — add `checkIsDiscordDmUrl`.
- `src/commands/webhook.ts` — DM dispatch + `sendDiscordDm` + consent + `setToken`; export for tests.
- `src/components/webhook-prepare.ts` — skip `discord-dm://` rows.
- `src/commands/manager.ts` — wire `youtubeDmOperator(app)`.
- `src/commands/discord-bot.ts` — add `RedisModule`, init OAuth state store, register callback routes, register command.
- `src/discord/commands/index.ts` — register `YoutubeDmCommand`.
- `k8s/base/discord-bot.yaml`, `k8s/base/ingress.yaml`, `k8s/base/webhook.yaml` — Service + ingress path + envs.

---

## Task 1: Add env constants

**Files:**

- Modify: `src/constants.ts`

- [ ] **Step 1: Inspect existing patterns and where DISCORD_TOKEN is declared**

Run:

```bash
grep -n "REDIS_URI\|GOOGLE_API_KEY\|_MS =\|castBool" src/constants.ts | head -20
grep -rn "DISCORD_TOKEN" src/commands/discord-bot.ts src/constants.ts
```

Note how `discord-bot.ts` obtains `DISCORD_TOKEN` (import vs `process.env`). Task 6 reuses the same source; if it is not exported from a module, Task 6 reads `process.env.DISCORD_TOKEN`.

- [ ] **Step 2: Append the new constants at the end of `src/constants.ts`**

```typescript
// YouTube DM personal-notification binding
export const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
export const GOOGLE_OAUTH_CLIENT_SECRET =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET;
export const DISCORD_OAUTH_CLIENT_ID = process.env.DISCORD_OAUTH_CLIENT_ID;
export const DISCORD_OAUTH_CLIENT_SECRET =
  process.env.DISCORD_OAUTH_CLIENT_SECRET;
// Public base URL the OAuth providers redirect back to, e.g. https://honeybee.example.ts.net
export const OAUTH_PUBLIC_BASE_URL = process.env.OAUTH_PUBLIC_BASE_URL;
// OAuth state lifetime: 10 min — enough for one browser consent round-trip, short enough
// to bound the bearer-link replay window for the Google path.
export const OAUTH_STATE_TTL_MS = Number(
  process.env.OAUTH_STATE_TTL_MS ?? 10 * 60 * 1000
);
// Soft per-user channel cap — bounds a single derived webhook's $in size; not enforced atomically.
export const YOUTUBE_DM_MAX_CHANNELS_PER_USER = Number(
  process.env.YOUTUBE_DM_MAX_CHANNELS_PER_USER ?? 10
);
```

- [ ] **Step 3: Type-check + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/constants.ts
git commit -m "feat(constants): add youtube dm binding + oauth env constants"
```

---

## Task 2: Make `getChannelIdFilter` reusable (accept `string[]`, export)

**Files:**

- Modify: `src/data/track.ts`
- Test: `src/data/track.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/data/track.spec.ts`:

```typescript
/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { getChannelIdFilter } from "./track.js";

describe("getChannelIdFilter", () => {
  it("returns null for empty list", () => {
    expect(getChannelIdFilter([])).toBeNull();
  });
  it("returns the single id directly", () => {
    expect(getChannelIdFilter(["UCa"])).toBe("UCa");
  });
  it("returns $ne for a single id reversed", () => {
    expect(getChannelIdFilter(["UCa"], true)).toEqual({ $ne: "UCa" });
  });
  it("returns $in for multiple ids", () => {
    expect(getChannelIdFilter(["UCa", "UCb"])).toEqual({ $in: ["UCa", "UCb"] });
  });
  it("returns $nin for multiple ids reversed", () => {
    expect(getChannelIdFilter(["UCa", "UCb"], true)).toEqual({
      $nin: ["UCa", "UCb"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/data/track.spec.ts`
Expected: FAIL — `getChannelIdFilter` is not exported.

- [ ] **Step 3: Change `getChannelIdFilter` signature and export it**

In `src/data/track.ts`, replace `function getChannelIdFilter(track: Track, reverse = false)` with:

```typescript
export function getChannelIdFilter(channelIds: string[], reverse = false) {
  if (channelIds.length === 0) {
    return null;
  }
  if (channelIds.length === 1) {
    if (reverse) {
      return {
        $ne: channelIds[0],
      };
    }
    return channelIds[0];
  }
  if (reverse) {
    return {
      $nin: channelIds,
    };
  }
  return {
    $in: channelIds,
  };
}
```

- [ ] **Step 4: Update all internal callers in `src/data/track.ts`**

Find every callsite and apply the two replacements (`getChannelIdFilter(track)` → `getChannelIdFilter(track.trackChannels)`, `getChannelIdFilter(track, true)` → `getChannelIdFilter(track.trackChannels, true)`):

```bash
grep -n "getChannelIdFilter(track" src/data/track.ts
```

Edit each hit across the `streams`/`uploads`/`premieres`/`upcoming`/`chats`/`chatsOtherChannels`/`moderatorChats`/`followedChats`/`polls`/`modechanges`/`raids`/`raidsOutgoing` transforms.

- [ ] **Step 5: Run the test + build + lint**

Run: `npm run test -- src/data/track.spec.ts && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data/track.ts src/data/track.spec.ts
git commit -m "refactor(track): export getChannelIdFilter taking channel ids"
```

---

## Task 3: Core — `YoutubeDmBinding` model + `youtube-dm-operator` + Webhook ref

**Files:**

- Create: `src/models/YoutubeDmBinding.ts`
- Create: `src/components/youtube-dm-operator.ts`
- Modify: `src/models/Webhook.ts`
- Test: `src/models/YoutubeDmBinding.spec.ts`
- Test: `src/components/youtube-dm-operator.spec.ts`

> These three changes are mutually dependent (see the Circular-dependency note) and land together so the build is green at task end. Order within the task: (a) add the Webhook field/index, (b) create the operator, (c) create the model, (d) write both specs.

- [ ] **Step 1: Add the `youtubeDmBinding` Ref + partial unique index to the Webhook model**

In `src/models/Webhook.ts`:

- Add the import at the top:

```typescript
import { YoutubeDmBinding } from "./YoutubeDmBinding.js";
```

- Confirm `type Ref` is imported from `@typegoose/typegoose` (`grep -n "type Ref" src/models/Webhook.ts`; add it to that import if missing).
- Add this `@index(...)` alongside the existing class decorators (after the `{ track, feature }` index):

```typescript
@index(
  { youtubeDmBinding: 1 },
  {
    unique: true,
    partialFilterExpression: { youtubeDmBinding: { $type: "objectId" } },
  }
)
```

- Add this field inside the class (next to `track`/`feature`):

```typescript
  @prop({ ref: "YoutubeDmBinding" })
  public youtubeDmBinding?: Ref<YoutubeDmBinding>;
```

- [ ] **Step 2: Create the operator**

Create `src/components/youtube-dm-operator.ts`:

```typescript
import type { DocumentType } from "@typegoose/typegoose";
import assert from "node:assert";
import { getChannelIdFilter } from "../data/track.js";
import WebhookModel from "../models/Webhook.js";
import YoutubeDmBindingModel, {
  type YoutubeDmBinding,
} from "../models/YoutubeDmBinding.js";
import type { Application } from "../modules/application.js";
import type { AgendaModule } from "../modules/schedule.js";

const DM_COLLS = [
  "superchats",
  "superstickers",
  "memberships",
  "milestones",
  "membershipgiftpurchases",
  "membershipgifts",
];

export default function youtubeDmOperator(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  agenda.define("transform youtube dm bindings", transformYoutubeDmBindings);
  void agenda.every("1 hour", "transform youtube dm bindings");
}

// Re-reads the latest binding by _id so concurrent / out-of-order bind+unbind
// transforms converge on the current channelIds instead of an older snapshot.
export async function transformYoutubeDmBinding(
  binding: Pick<DocumentType<YoutubeDmBinding>, "_id">
): Promise<void> {
  const fresh = await YoutubeDmBindingModel.findById(binding._id);
  if (!fresh || fresh.channelIds.length === 0) {
    await WebhookModel.deleteMany({ youtubeDmBinding: binding._id });
    return;
  }
  const webhook = {
    colls: DM_COLLS,
    match: { authorChannelId: getChannelIdFilter(fresh.channelIds) },
    templatePreset: "discord-embed-chats",
    insertUrl: `discord-dm://${fresh.discordUserId}`,
    youtubeDmBinding: fresh._id,
    enabled: true,
  };
  await WebhookModel.updateOne(
    { youtubeDmBinding: fresh._id },
    { $set: webhook },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

// Exported so the orphan-cleanup discriminator can be unit-tested directly.
export async function transformYoutubeDmBindings(): Promise<void> {
  for await (const binding of YoutubeDmBindingModel.find()) {
    await transformYoutubeDmBinding(binding);
  }
  // Orphan cleanup: DM webhooks whose binding doc was deleted.
  // MUST use { $type: "objectId" } (same discriminator as the partial index) —
  // { $ne: null } would also match track/generic webhooks lacking the field and
  // delete them.
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

- [ ] **Step 3: Create the model (fields + error classes + null-safe statics)**

Create `src/models/YoutubeDmBinding.ts`:

```typescript
import {
  getModelForClass,
  index,
  modelOptions,
  prop,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses.js";
import { transformYoutubeDmBinding } from "../components/youtube-dm-operator.js";
import { YOUTUBE_DM_MAX_CHANNELS_PER_USER } from "../constants.js";

// Thrown when the requested bind would exceed the soft per-user cap; nothing is written.
export class BindingLimitError extends Error {}
// Thrown when the source binding WAS written but transformYoutubeDmBinding failed;
// callers may report a truthful "saved, taking effect shortly" state.
export class BindingTransformPendingError extends Error {}

@modelOptions({ schemaOptions: { collection: "youtubeDmBindings" } })
@index({ discordUserId: 1 }, { unique: true })
export class YoutubeDmBinding extends TimeStamps {
  @prop({ required: true })
  public discordUserId!: string;

  @prop({ type: () => [String], default: [] })
  public channelIds!: string[];

  public static async bindChannels(
    this: ReturnModelType<typeof YoutubeDmBinding>,
    discordUserId: string,
    channelIds: string[]
  ) {
    const requested = [...new Set(channelIds)];
    const existing = await this.findOne({ discordUserId });
    const current = existing?.channelIds ?? [];
    const genuinelyNew = requested.filter((id) => !current.includes(id));
    if (
      current.length + genuinelyNew.length >
      YOUTUBE_DM_MAX_CHANNELS_PER_USER
    ) {
      throw new BindingLimitError(
        `binding limit reached (max ${YOUTUBE_DM_MAX_CHANNELS_PER_USER} channels per user)`
      );
    }
    // Pre-write errors (findOneAndUpdate throwing) propagate as-is; only a
    // post-write transform failure is reclassified as BindingTransformPendingError.
    const doc = await this.findOneAndUpdate(
      { discordUserId },
      { $addToSet: { channelIds: { $each: requested } } },
      { upsert: true, new: true }
    );
    try {
      await transformYoutubeDmBinding(doc!);
    } catch (error) {
      throw new BindingTransformPendingError(`${error}`);
    }
    return doc;
  }

  public static async unbindChannel(
    this: ReturnModelType<typeof YoutubeDmBinding>,
    discordUserId: string,
    channelId: string
  ) {
    const doc = await this.findOneAndUpdate(
      { discordUserId },
      { $pull: { channelIds: channelId } },
      { new: true }
    );
    if (!doc) return null;
    await transformYoutubeDmBinding(doc);
    return doc;
  }

  public static async unbindAll(
    this: ReturnModelType<typeof YoutubeDmBinding>,
    discordUserId: string
  ) {
    const doc = await this.findOneAndUpdate(
      { discordUserId },
      { $set: { channelIds: [] } },
      { new: true }
    );
    if (!doc) return null;
    await transformYoutubeDmBinding(doc);
    return doc;
  }
}

export default getModelForClass(YoutubeDmBinding);
```

- [ ] **Step 4: Write the operator tests**

Create `src/components/youtube-dm-operator.spec.ts`:

```typescript
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mongo } from "mongoose";
import WebhookModel from "../models/Webhook.js";
import YoutubeDmBindingModel from "../models/YoutubeDmBinding.js";
import {
  transformYoutubeDmBinding,
  transformYoutubeDmBindings,
} from "./youtube-dm-operator.js";

describe("transformYoutubeDmBinding", () => {
  afterEach(() => jest.restoreAllMocks());

  it("upserts one webhook with the expected colls/match/insertUrl/ref", async () => {
    const id = new mongo.BSON.ObjectId();
    jest.spyOn(YoutubeDmBindingModel, "findById").mockResolvedValue({
      _id: id,
      discordUserId: "discord-1",
      channelIds: ["UCa", "UCb"],
    } as any);
    const updateOne = jest
      .spyOn(WebhookModel, "updateOne")
      .mockResolvedValue({} as any);
    const deleteMany = jest
      .spyOn(WebhookModel, "deleteMany")
      .mockResolvedValue({} as any);

    await transformYoutubeDmBinding({ _id: id } as any);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = updateOne.mock.calls[0] as any[];
    expect(filter).toEqual({ youtubeDmBinding: id });
    expect(update.$set).toMatchObject({
      colls: [
        "superchats",
        "superstickers",
        "memberships",
        "milestones",
        "membershipgiftpurchases",
        "membershipgifts",
      ],
      match: { authorChannelId: { $in: ["UCa", "UCb"] } },
      templatePreset: "discord-embed-chats",
      insertUrl: "discord-dm://discord-1",
      youtubeDmBinding: id,
      enabled: true,
    });
    expect(options).toMatchObject({ upsert: true });
  });

  it("uses a single id directly (not $in) for one channel", async () => {
    const id = new mongo.BSON.ObjectId();
    jest.spyOn(YoutubeDmBindingModel, "findById").mockResolvedValue({
      _id: id,
      discordUserId: "discord-1",
      channelIds: ["UCa"],
    } as any);
    const updateOne = jest
      .spyOn(WebhookModel, "updateOne")
      .mockResolvedValue({} as any);

    await transformYoutubeDmBinding({ _id: id } as any);

    const [, update] = updateOne.mock.calls[0] as any[];
    expect(update.$set.match).toEqual({ authorChannelId: "UCa" });
  });

  it("deletes the webhook when the binding has no channels", async () => {
    const id = new mongo.BSON.ObjectId();
    jest.spyOn(YoutubeDmBindingModel, "findById").mockResolvedValue({
      _id: id,
      discordUserId: "discord-1",
      channelIds: [],
    } as any);
    const updateOne = jest.spyOn(WebhookModel, "updateOne");
    const deleteMany = jest
      .spyOn(WebhookModel, "deleteMany")
      .mockResolvedValue({} as any);

    await transformYoutubeDmBinding({ _id: id } as any);

    expect(updateOne).not.toHaveBeenCalled();
    expect(deleteMany).toHaveBeenCalledWith({ youtubeDmBinding: id });
  });

  it("deletes the webhook when the binding no longer exists", async () => {
    const id = new mongo.BSON.ObjectId();
    jest
      .spyOn(YoutubeDmBindingModel, "findById")
      .mockResolvedValue(null as any);
    const deleteMany = jest
      .spyOn(WebhookModel, "deleteMany")
      .mockResolvedValue({} as any);

    await transformYoutubeDmBinding({ _id: id } as any);

    expect(deleteMany).toHaveBeenCalledWith({ youtubeDmBinding: id });
  });
});

describe("transformYoutubeDmBindings sweep", () => {
  afterEach(() => jest.restoreAllMocks());

  it("orphan cleanup uses the $type:objectId discriminator (never $ne:null)", async () => {
    const orphanId = new mongo.BSON.ObjectId();
    // No bindings to transform.
    jest.spyOn(YoutubeDmBindingModel, "find").mockReturnValue([] as any);
    // aggregate returns one orphan webhook.
    const aggregate = jest
      .spyOn(WebhookModel, "aggregate")
      .mockReturnValue([{ _id: orphanId }] as any);
    const deleteOne = jest
      .spyOn(WebhookModel, "deleteOne")
      .mockResolvedValue({} as any);

    await transformYoutubeDmBindings();

    const pipeline = aggregate.mock.calls[0][0] as any[];
    expect(pipeline[0]).toEqual({
      $match: { youtubeDmBinding: { $type: "objectId" } },
    });
    expect(deleteOne).toHaveBeenCalledWith({ _id: orphanId });
  });
});
```

(`jest.spyOn(Model, "find")`/`"aggregate"` returning an array works because the operator iterates them with `for await`; arrays are async-iterable-compatible under `for await`.)

- [ ] **Step 5: Write the model statics tests**

Create `src/models/YoutubeDmBinding.spec.ts`:

```typescript
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as operator from "../components/youtube-dm-operator.js";
import YoutubeDmBindingModel, {
  BindingLimitError,
  BindingTransformPendingError,
} from "./YoutubeDmBinding.js";

describe("YoutubeDmBinding statics", () => {
  afterEach(() => jest.restoreAllMocks());

  it("bindChannels adds genuinely-new ids and transforms", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    const updated = {
      _id: "x",
      discordUserId: "d1",
      channelIds: ["UCa", "UCb"],
    };
    const fou = jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(updated as any);
    const transform = jest
      .spyOn(operator, "transformYoutubeDmBinding")
      .mockResolvedValue();

    const result = await YoutubeDmBindingModel.bindChannels("d1", ["UCb"]);

    expect(fou).toHaveBeenCalledWith(
      { discordUserId: "d1" },
      { $addToSet: { channelIds: { $each: ["UCb"] } } },
      { upsert: true, new: true }
    );
    expect(transform).toHaveBeenCalledWith(updated);
    expect(result).toBe(updated);
  });

  it("bindChannels throws BindingLimitError when genuinely-new ids exceed the cap", async () => {
    jest.spyOn(YoutubeDmBindingModel, "findOne").mockResolvedValue({
      channelIds: Array.from({ length: 10 }, (_, i) => `UC${i}`),
    } as any);
    const fou = jest.spyOn(YoutubeDmBindingModel, "findOneAndUpdate");

    await expect(
      YoutubeDmBindingModel.bindChannels("d1", ["UCnew"])
    ).rejects.toBeInstanceOf(BindingLimitError);
    expect(fou).not.toHaveBeenCalled();
  });

  it("bindChannels ignores already-bound ids against the cap", async () => {
    jest.spyOn(YoutubeDmBindingModel, "findOne").mockResolvedValue({
      channelIds: Array.from({ length: 10 }, (_, i) => `UC${i}`),
    } as any);
    const updated = { _id: "x", discordUserId: "d1", channelIds: [] };
    jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(updated as any);
    jest.spyOn(operator, "transformYoutubeDmBinding").mockResolvedValue();

    await expect(
      YoutubeDmBindingModel.bindChannels("d1", ["UC0"])
    ).resolves.toBe(updated);
  });

  it("bindChannels reclassifies a post-write transform failure as BindingTransformPendingError", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: [] } as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue({
        _id: "x",
        discordUserId: "d1",
        channelIds: ["UCa"],
      } as any);
    jest
      .spyOn(operator, "transformYoutubeDmBinding")
      .mockRejectedValue(new Error("db down"));

    await expect(
      YoutubeDmBindingModel.bindChannels("d1", ["UCa"])
    ).rejects.toBeInstanceOf(BindingTransformPendingError);
  });

  it("bindChannels lets a pre-write failure propagate as a generic error", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: [] } as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockRejectedValue(new Error("write failed"));
    const transform = jest.spyOn(operator, "transformYoutubeDmBinding");

    await expect(
      YoutubeDmBindingModel.bindChannels("d1", ["UCa"])
    ).rejects.toThrow("write failed");
    // not reclassified, and transform never ran
    expect(transform).not.toHaveBeenCalled();
  });

  it("unbindChannel is a no-op when no binding exists", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(null as any);
    const transform = jest
      .spyOn(operator, "transformYoutubeDmBinding")
      .mockResolvedValue();

    const result = await YoutubeDmBindingModel.unbindChannel("d1", "UCa");

    expect(result).toBeNull();
    expect(transform).not.toHaveBeenCalled();
  });

  it("unbindChannel pulls the id and transforms when binding exists", async () => {
    const updated = { _id: "x", discordUserId: "d1", channelIds: [] };
    const fou = jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(updated as any);
    const transform = jest
      .spyOn(operator, "transformYoutubeDmBinding")
      .mockResolvedValue();

    await YoutubeDmBindingModel.unbindChannel("d1", "UCa");

    expect(fou).toHaveBeenCalledWith(
      { discordUserId: "d1" },
      { $pull: { channelIds: "UCa" } },
      { new: true }
    );
    expect(transform).toHaveBeenCalledWith(updated);
  });

  it("unbindAll is a no-op when no binding exists", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(null as any);
    const transform = jest
      .spyOn(operator, "transformYoutubeDmBinding")
      .mockResolvedValue();

    await YoutubeDmBindingModel.unbindAll("d1");

    expect(transform).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run both specs + build + lint**

Run:

```bash
npm run test -- src/components/youtube-dm-operator.spec.ts
npm run test -- src/models/YoutubeDmBinding.spec.ts
npm run build && npm run lint
```

Expected: all PASS (the three files compile together).

- [ ] **Step 7: Commit**

```bash
git add src/models/YoutubeDmBinding.ts src/models/YoutubeDmBinding.spec.ts src/components/youtube-dm-operator.ts src/components/youtube-dm-operator.spec.ts src/models/Webhook.ts
git commit -m "feat(models): add YoutubeDmBinding model + operator + webhook ref"
```

---

## Task 4: Wire `youtubeDmOperator` into manager

**Files:**

- Modify: `src/commands/manager.ts`

- [ ] **Step 1: Add the import**

```typescript
import youtubeDmOperator from "../components/youtube-dm-operator.js";
```

- [ ] **Step 2: Register it after `app.init()`**

Add next to the other components (after `webhookPrepare(app);`):

```typescript
webhookPrepare(app);
youtubeDmOperator(app);
```

- [ ] **Step 3: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands/manager.ts
git commit -m "feat(manager): register youtube-dm-operator"
```

---

## Task 5: `checkIsDiscordDmUrl` helper

**Files:**

- Modify: `src/data/webhook.ts`
- Test: `src/data/webhook.spec.ts` (create)

> The DM `insertUrl` uses the custom scheme `discord-dm://<userId>` (NOT a real Discord API URL).

- [ ] **Step 1: Write the failing test**

Create `src/data/webhook.spec.ts`:

```typescript
/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { checkIsDiscordDmUrl } from "./webhook.js";

describe("checkIsDiscordDmUrl", () => {
  it("matches the discord-dm scheme", () => {
    expect(checkIsDiscordDmUrl("discord-dm://123456789")).toBe(true);
  });
  it("rejects http(s) webhook urls", () => {
    expect(checkIsDiscordDmUrl("https://discord.com/api/webhooks/1/abc")).toBe(
      false
    );
  });
  it("rejects empty / unrelated strings", () => {
    expect(checkIsDiscordDmUrl("")).toBe(false);
    expect(checkIsDiscordDmUrl("https://example.com")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/data/webhook.spec.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Add the helper next to `checkIsDiscordWebhookUrl`**

```typescript
export function checkIsDiscordDmUrl(url: string): boolean {
  return url.startsWith("discord-dm://");
}
```

- [ ] **Step 4: Run the test + build + lint**

Run: `npm run test -- src/data/webhook.spec.ts && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/webhook.ts src/data/webhook.spec.ts
git commit -m "feat(webhook): add checkIsDiscordDmUrl scheme helper"
```

---

## Task 6: `sendDiscordDm` + consent check + dispatch

**Files:**

- Modify: `src/commands/webhook.ts`
- Test: `src/commands/webhook-dm.spec.ts` (create)

> `discord-embed-chats` renders `{ embeds: [...] }` (no `content`), so the DM payload is `{ embeds, ...(content ? {content} : {}) }`. Consent is read immediately before the REST send. REST-only bot token (no gateway Client). Export `sendDiscordDm`, `dmConsentAllowed`, `dmRest`, `dmChannelCache` for tests.

- [ ] **Step 1: Write the failing tests**

Create `src/commands/webhook-dm.spec.ts`:

```typescript
/// <reference types="jest" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import YoutubeDmBindingModel from "../models/YoutubeDmBinding.js";
import WebhookResultModel from "../models/WebhookResult.js";
import { dmChannelCache, dmRest, sendDiscordDm } from "./webhook.js";

const resultId = { webhookId: "w1", coll: "superchats", docId: "d1" };
const webhook = { followUpdate: false } as any;

function consentReturns(channelIds: string[]) {
  jest.spyOn(YoutubeDmBindingModel, "findOne").mockReturnValue({
    setOptions: () => Promise.resolve({ channelIds }),
  } as any);
}

describe("sendDiscordDm", () => {
  beforeEach(() => {
    jest.spyOn(WebhookResultModel, "updateOne").mockResolvedValue({} as any);
  });
  afterEach(() => jest.restoreAllMocks());

  it("skips send when channel is no longer bound (consent)", async () => {
    consentReturns(["UCb"]);
    const request = jest.spyOn(dmRest, "request");

    await sendDiscordDm(
      "discord-dm://discord-1",
      "UCa",
      { embeds: [{ title: "x" }] },
      webhook,
      resultId
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("creates a DM channel and sends embeds when consented", async () => {
    consentReturns(["UCa"]);
    jest.spyOn(dmChannelCache, "wrap").mockResolvedValue("dm-chan-1");
    const request = jest
      .spyOn(dmRest, "request")
      .mockResolvedValue({ id: "msg-1" } as any);

    await sendDiscordDm(
      "discord-dm://discord-1",
      "UCa",
      { embeds: [{ title: "x" }] },
      webhook,
      resultId
    );

    expect(request).toHaveBeenCalledTimes(1);
    const arg = (request.mock.calls[0] as any)[0];
    expect(arg.method).toBe("POST");
    expect(arg.body).toEqual({ embeds: [{ title: "x" }] });
    expect(arg.auth).toBe(true);
  });

  it("clears the cached DM channel and rebuilds once on a 404 send", async () => {
    consentReturns(["UCa"]);
    jest
      .spyOn(dmChannelCache, "wrap")
      .mockResolvedValueOnce("stale-chan")
      .mockResolvedValueOnce("fresh-chan");
    const del = jest
      .spyOn(dmChannelCache, "del")
      .mockResolvedValue(true as any);
    const request = jest
      .spyOn(dmRest, "request")
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { status: 404 }))
      .mockResolvedValueOnce({ id: "msg-1" } as any);

    await sendDiscordDm(
      "discord-dm://discord-1",
      "UCa",
      { embeds: [{ title: "x" }] },
      webhook,
      resultId
    );

    expect(del).toHaveBeenCalledWith("dm-channel-discord-1");
    expect(request).toHaveBeenCalledTimes(2);
    // second attempt targets the rebuilt channel
    expect((request.mock.calls[1] as any)[0].fullRoute).toContain("fresh-chan");
  });

  it("records error and does NOT throw on 403", async () => {
    consentReturns(["UCa"]);
    jest.spyOn(dmChannelCache, "wrap").mockResolvedValue("dm-chan-1");
    jest
      .spyOn(dmRest, "request")
      .mockRejectedValue(
        Object.assign(new Error("forbidden"), { status: 403 })
      );
    const update = jest.spyOn(WebhookResultModel, "updateOne");

    await expect(
      sendDiscordDm(
        "discord-dm://discord-1",
        "UCa",
        { embeds: [{ title: "x" }] },
        webhook,
        resultId
      )
    ).resolves.toBeUndefined();

    const lastCall = update.mock.calls.at(-1) as any[];
    expect(lastCall[1].$set.statusCode).toBe(403);
  });

  it("rethrows on 5xx so bee-queue retries", async () => {
    consentReturns(["UCa"]);
    jest.spyOn(dmChannelCache, "wrap").mockResolvedValue("dm-chan-1");
    jest
      .spyOn(dmRest, "request")
      .mockRejectedValue(
        Object.assign(new Error("server error"), { status: 502 })
      );

    await expect(
      sendDiscordDm(
        "discord-dm://discord-1",
        "UCa",
        { embeds: [{ title: "x" }] },
        webhook,
        resultId
      )
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/commands/webhook-dm.spec.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Add imports + exported DM machinery to `src/commands/webhook.ts`**

Add imports (merge with existing groups):

```typescript
import { REST, Routes } from "discord.js";
import { checkIsDiscordDmUrl } from "../data/webhook.js";
import YoutubeDmBindingModel from "../models/YoutubeDmBinding.js";
```

`checkIsDiscordWebhookUrl`, `WebhookResultModel`, `documentLog`, `getCacheInstance`, `WEBHOOK_RESULT_FOLLOW_TTL_MS`, `WEBHOOK_RESULT_NON_FOLLOW_TTL_MS`, and the `cache`/`createWebhookResultCacheKey` helpers are already present in this file — reuse them.

Add module-level (next to the existing `discordRest`/`cache`):

```typescript
// Bot-token REST client used only for DM delivery (auth: true). Separate from the
// webhook-delivery `discordRest` (auth: false with self-authenticating URLs).
export const dmRest = new REST();

// Caches the per-user DM channel id so we don't recreate it on every event.
export const dmChannelCache = getCacheInstance({ ttl: 60 * 60 * 1000 });

export async function dmConsentAllowed(
  discordUserId: string,
  authorChannelId: string
): Promise<boolean> {
  const binding = await YoutubeDmBindingModel.findOne({
    discordUserId,
  }).setOptions({ readPreference: "primary" });
  return !!binding && binding.channelIds.includes(authorChannelId);
}

export async function sendDiscordDm(
  url: string,
  authorChannelId: string,
  body: any,
  webhook: Webhook,
  resultIdentifier: WebhookResultIdentifier
) {
  const discordUserId = url.slice("discord-dm://".length);

  // Delivery-time consent: skip if the channel is no longer bound (closes the
  // unbind window down to this read-to-send gap).
  if (!(await dmConsentAllowed(discordUserId, authorChannelId))) {
    documentLog(
      webhook,
      `[dm-consent-skip] ${discordUserId} no longer bound to ${authorChannelId}`
    );
    return;
  }

  const payload: Record<string, unknown> = { embeds: body.embeds };
  if (body.content) payload.content = body.content;

  const ttlMs = webhook.followUpdate
    ? WEBHOOK_RESULT_FOLLOW_TTL_MS
    : WEBHOOK_RESULT_NON_FOLLOW_TTL_MS;

  const sendOnce = async () => {
    const dmChannelId = await dmChannelCache.wrap(
      `dm-channel-${discordUserId}`,
      async () => {
        const dm = (await dmRest.request({
          fullRoute: Routes.userChannels(),
          method: "POST",
          body: { recipient_id: discordUserId },
          auth: true,
        })) as { id: string };
        return dm.id;
      }
    );
    return dmRest.request({
      fullRoute: Routes.channelMessages(dmChannelId),
      method: "POST",
      body: payload,
      auth: true,
    });
  };

  try {
    let response;
    try {
      response = await sendOnce();
    } catch (error) {
      // Cached DM channel may be stale (404) — clear it (awaited) and rebuild once.
      if ((error as { status?: number }).status === 404) {
        await dmChannelCache.del(`dm-channel-${discordUserId}`);
        response = await sendOnce();
      } else {
        throw error;
      }
    }

    const setFields: Record<string, unknown> = {
      method: "POST",
      url,
      body: payload,
      response,
      statusCode: 200,
    };
    const unsetFields: Record<string, unknown> = { error: "" };
    if (ttlMs !== null) {
      setFields.expireAt = new Date(Date.now() + ttlMs);
    } else {
      unsetFields.expireAt = "";
    }
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: setFields,
      $unset: unsetFields,
    });
  } catch (error) {
    const status = (error as { status?: number }).status ?? -1;
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: { statusCode: status, error: `${error}` },
    });
    // Terminal (cannot DM this user) -> swallow so bee-queue marks the job done.
    // Transient (5xx / unknown) -> rethrow so the worker handler retries.
    if (status !== 403 && status !== 404) {
      throw error;
    }
  } finally {
    void cache.del(createWebhookResultCacheKey(resultIdentifier));
  }
}
```

- [ ] **Step 4: Add the dispatch branch in `processWebhookEvent`**

Insert the DM branch in the delivery dispatch:

```typescript
if (checkIsDiscordWebhookUrl(url)) {
  await sendDiscordWebhook(method, url, body, webhook, resultIdentifier);
} else if (checkIsDiscordDmUrl(url)) {
  await sendDiscordDm(
    url,
    data.fullDocument.authorChannelId,
    body,
    webhook,
    resultIdentifier
  );
} else {
  await sendWebhook(method, url, body, webhook, resultIdentifier);
}
```

Extend the existing embed `fixLongText` footer block condition from `if (checkIsDiscordWebhookUrl(url)) {` to:

```typescript
  if (checkIsDiscordWebhookUrl(url) || checkIsDiscordDmUrl(url)) {
```

- [ ] **Step 5: Set the bot token on startup**

In `runWebhook()`, before `app.init()`:

```typescript
if (process.env.DISCORD_TOKEN) {
  dmRest.setToken(process.env.DISCORD_TOKEN);
}
```

(Use the same `DISCORD_TOKEN` source found in Task 1 Step 1 if it is exported from a module; otherwise `process.env.DISCORD_TOKEN` as shown.)

- [ ] **Step 6: Run the test + build + lint**

Run: `npm run test -- src/commands/webhook-dm.spec.ts && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/webhook.ts src/commands/webhook-dm.spec.ts
git commit -m "feat(webhook): deliver DMs via sendDiscordDm with consent check"
```

---

## Task 7: webhook-prepare skips `discord-dm://`

**Files:**

- Modify: `src/components/webhook-prepare.ts`
- Test: `src/components/webhook-prepare.spec.ts` (create)

> Extract the per-webhook body into an exported `prepareWebhook` and skip DM rows entirely (no probe, no timestamp/state mutation, no save).

- [ ] **Step 1: Refactor the loop body into an exported function (complete code)**

Edit `src/components/webhook-prepare.ts`. Add imports:

```typescript
import type { DocumentType } from "@typegoose/typegoose";
import type { AxiosInstance } from "axios";
import { checkIsDiscordDmUrl } from "../data/webhook.js";
import { type Webhook } from "../models/Webhook.js";
```

Replace the `for await (const webhook of WebhookModel.findEnabled()) { ...body... await setTimeout(1000); }` block so the loop calls the new function:

```typescript
for await (const webhook of WebhookModel.findEnabled()) {
  await prepareWebhook(webhook, axiosInstance);
  await setTimeout(1000);
}
```

Add the exported function (module scope, e.g. above `export default function webhookPrepare`):

```typescript
export async function prepareWebhook(
  webhook: DocumentType<Webhook>,
  axiosInstance: AxiosInstance
): Promise<void> {
  // DM webhooks have no HTTP endpoint; skip the whole iteration (no axios.get, no
  // failedAttempts / enabled / lastChecked / lastSuccess mutation, no save).
  if (checkIsDiscordDmUrl(webhook.insertUrl)) {
    return;
  }

  // Check if the webhook is still valid
  webhook.failedAttempts ??= 0;
  try {
    await axiosInstance.get(webhook.insertUrl, {
      timeout: 60_000,
    });
    webhook.lastSuccess = new Date();
    webhook.failedAttempts = 0;
    webhook.enabled = true;
  } catch (error) {
    documentLog(webhook, "<!> [ERROR] Unable to connect to the webhook", error);
    webhook.failedAttempts += 1;

    // Disable webhook after 24 failed attempts to prevent excessive retries.
    if (webhook.failedAttempts >= 24) {
      webhook.enabled = false;
    }
  }
  webhook.lastChecked = new Date();

  // Prepare webhook match
  try {
    if (webhook.matchPreset && matchPresets[webhook.matchPreset]) {
      const match = await matchPresets[webhook.matchPreset](webhook);
      if (JSON.stringify(webhook.match) !== JSON.stringify(match)) {
        documentLog(webhook, "change match");
        webhook.match = match;
      }
    }
  } catch (error) {
    documentLog(webhook, "<!> [ERROR] Unable to prepare webhook", error);
  }

  await webhook.save();
}
```

- [ ] **Step 2: Write the failing test**

Create `src/components/webhook-prepare.spec.ts`:

```typescript
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { prepareWebhook } from "./webhook-prepare.js";

describe("prepareWebhook discord-dm skip", () => {
  afterEach(() => jest.restoreAllMocks());

  it("does not probe or mutate DM webhooks", async () => {
    const axiosInstance = { get: jest.fn() } as any;
    const save = jest.fn();
    const webhook = {
      insertUrl: "discord-dm://discord-1",
      failedAttempts: 0,
      enabled: true,
      save,
    } as any;

    await prepareWebhook(webhook, axiosInstance);

    expect(axiosInstance.get).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(webhook.failedAttempts).toBe(0);
    expect(webhook.enabled).toBe(true);
    expect(webhook.lastChecked).toBeUndefined();
  });

  it("probes and saves a normal HTTP webhook", async () => {
    const axiosInstance = { get: jest.fn(async () => ({})) } as any;
    const save = jest.fn(async () => undefined);
    const webhook = {
      insertUrl: "https://discord.com/api/webhooks/1/abc",
      failedAttempts: 0,
      enabled: true,
      save,
    } as any;

    await prepareWebhook(webhook, axiosInstance);

    expect(axiosInstance.get).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the test + build + lint**

Run: `npm run test -- src/components/webhook-prepare.spec.ts && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/webhook-prepare.ts src/components/webhook-prepare.spec.ts
git commit -m "fix(webhook-prepare): skip discord-dm rows in reachability probe"
```

---

## Task 8: OAuth state store (Redis)

**Files:**

- Create: `src/discord/oauth/state.ts`
- Test: `src/discord/oauth/state.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/discord/oauth/state.spec.ts`:

```typescript
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  delOAuthState,
  getOAuthState,
  initOAuthStateStore,
  putOAuthState,
  randomState,
} from "./state.js";

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return "OK";
    }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
}

describe("oauth state store", () => {
  afterEach(() => jest.restoreAllMocks());

  it("put/get round-trips the payload and uses PX", async () => {
    const redis = fakeRedis();
    initOAuthStateStore(redis as any);

    await putOAuthState("st1", { discordUserId: "d1", method: "google" });
    expect(redis.set).toHaveBeenCalledWith(
      "youtube-dm-oauth:st1",
      JSON.stringify({ discordUserId: "d1", method: "google" }),
      expect.objectContaining({ PX: expect.any(Number) })
    );

    const data = await getOAuthState("st1");
    expect(data).toEqual({ discordUserId: "d1", method: "google" });
  });

  it("get returns null for a missing/expired state", async () => {
    initOAuthStateStore(fakeRedis() as any);
    expect(await getOAuthState("nope")).toBeNull();
  });

  it("del removes the state (subsequent get is null)", async () => {
    const redis = fakeRedis();
    initOAuthStateStore(redis as any);
    await putOAuthState("st2", { discordUserId: "d1", method: "discord" });
    await delOAuthState("st2");
    expect(await getOAuthState("st2")).toBeNull();
  });

  it("randomState returns a long hex string", () => {
    expect(randomState()).toMatch(/^[0-9a-f]{32,}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/discord/oauth/state.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the state store**

Create `src/discord/oauth/state.ts`:

```typescript
import { randomBytes } from "node:crypto";
import type { RedisClientType } from "redis";
import { OAUTH_STATE_TTL_MS } from "../../constants.js";

export type OAuthMethod = "google" | "discord";
export interface OAuthState {
  discordUserId: string;
  method: OAuthMethod;
}

let client: RedisClientType | null = null;

export function initOAuthStateStore(redis: RedisClientType): void {
  client = redis;
}

function getClient(): RedisClientType {
  if (!client) throw new Error("OAuth state store not initialized");
  return client;
}

function key(state: string): string {
  return `youtube-dm-oauth:${state}`;
}

export function randomState(): string {
  return randomBytes(32).toString("hex");
}

export async function putOAuthState(
  state: string,
  data: OAuthState
): Promise<void> {
  await getClient().set(key(state), JSON.stringify(data), {
    PX: OAUTH_STATE_TTL_MS,
  });
}

export async function getOAuthState(state: string): Promise<OAuthState | null> {
  const raw = await getClient().get(key(state));
  return raw ? (JSON.parse(raw) as OAuthState) : null;
}

export async function delOAuthState(state: string): Promise<void> {
  await getClient().del(key(state));
}
```

- [ ] **Step 4: Run the test + build + lint**

Run: `npm run test -- src/discord/oauth/state.spec.ts && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord/oauth/state.ts src/discord/oauth/state.spec.ts
git commit -m "feat(oauth): add redis-backed oauth state store"
```

---

## Task 9: Google OAuth helper

**Files:**

- Create: `src/discord/oauth/google.ts`
- Test: `src/discord/oauth/google.spec.ts`

> `fetchGoogleChannels(code, listFn = listOwnedChannels)` takes the network call as an injectable param so tests can stub it ESM-safely (spying on the module export would not replace the internal lexical binding).

- [ ] **Step 1: Write the failing tests**

Create `src/discord/oauth/google.spec.ts`:

```typescript
/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { buildGoogleAuthUrl, fetchGoogleChannels } from "./google.js";

describe("google oauth helper", () => {
  it("buildGoogleAuthUrl includes scope, state, access_type and redirect", () => {
    const url = buildGoogleAuthUrl("st1");
    const u = new URL(url);
    expect(u.hostname).toContain("google.com");
    expect(u.searchParams.get("state")).toBe("st1");
    expect(u.searchParams.get("access_type")).toBe("online");
    expect(u.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.readonly"
    );
    expect(decodeURIComponent(url)).toContain(
      "/oauth/youtube-dm/google/callback"
    );
  });

  it("fetchGoogleChannels maps all owned channels via the injected list fn", async () => {
    const result = await fetchGoogleChannels(
      "code-1",
      async () =>
        [
          { id: "UCa", snippet: { title: "Chan A" } },
          { id: "UCb", snippet: { title: "Chan B" } },
        ] as any
    );
    expect(result).toEqual([
      { channelId: "UCa", title: "Chan A" },
      { channelId: "UCb", title: "Chan B" },
    ]);
  });

  it("fetchGoogleChannels drops items without an id", async () => {
    const result = await fetchGoogleChannels(
      "code-1",
      async () =>
        [{ snippet: { title: "no id" } }, { id: "UCb", snippet: {} }] as any
    );
    expect(result).toEqual([{ channelId: "UCb", title: "Unknown channel" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/discord/oauth/google.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the Google helper**

Create `src/discord/oauth/google.ts`:

```typescript
import { google as googleapis, type youtube_v3 } from "googleapis";
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  OAUTH_PUBLIC_BASE_URL,
} from "../../constants.js";

const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];

export function googleRedirectUri(): string {
  return `${OAUTH_PUBLIC_BASE_URL}/oauth/youtube-dm/google/callback`;
}

function oauthClient() {
  return new googleapis.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    googleRedirectUri()
  );
}

export function buildGoogleAuthUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "online",
    scope: SCOPES,
    state,
  });
}

export async function listOwnedChannels(
  code: string
): Promise<youtube_v3.Schema$Channel[]> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const youtube = googleapis.youtube({ version: "v3", auth: client });
  const res = await youtube.channels.list({ mine: true, part: ["snippet"] });
  return res.data.items ?? [];
}

export async function fetchGoogleChannels(
  code: string,
  listFn: (
    code: string
  ) => Promise<youtube_v3.Schema$Channel[]> = listOwnedChannels
): Promise<{ channelId: string; title: string }[]> {
  const items = await listFn(code);
  return items
    .filter((i) => !!i.id)
    .map((i) => ({
      channelId: i.id as string,
      title: i.snippet?.title ?? "Unknown channel",
    }));
}
```

- [ ] **Step 4: Run the test + build + lint**

Run: `npm run test -- src/discord/oauth/google.spec.ts && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord/oauth/google.ts src/discord/oauth/google.spec.ts
git commit -m "feat(oauth): add google youtube-readonly oauth helper"
```

---

## Task 10: Discord OAuth helper (connections + identity)

**Files:**

- Create: `src/discord/oauth/discord.ts`
- Test: `src/discord/oauth/discord.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/discord/oauth/discord.spec.ts`:

```typescript
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import axios from "axios";
import {
  buildDiscordAuthUrl,
  exchangeDiscordCode,
  fetchDiscordUserId,
  fetchVerifiedYoutubeChannels,
} from "./discord.js";

describe("discord oauth helper", () => {
  afterEach(() => jest.restoreAllMocks());

  it("buildDiscordAuthUrl includes scope, state and redirect", () => {
    const url = buildDiscordAuthUrl("st1");
    const u = new URL(url);
    expect(u.hostname).toBe("discord.com");
    expect(u.searchParams.get("state")).toBe("st1");
    // URLSearchParams decodes "+" back to a space here.
    expect(u.searchParams.get("scope")).toBe("identify connections");
    expect(u.searchParams.get("redirect_uri")).toContain(
      "/oauth/youtube-dm/discord/callback"
    );
  });

  it("exchangeDiscordCode posts the form and returns the access token", async () => {
    const post = jest
      .spyOn(axios, "post")
      .mockResolvedValue({ data: { access_token: "tok-1" } } as any);

    const token = await exchangeDiscordCode("code-1");
    expect(token).toBe("tok-1");
    expect((post.mock.calls[0] as any)[0]).toContain("/oauth2/token");
  });

  it("fetchDiscordUserId returns the /users/@me id", async () => {
    jest
      .spyOn(axios, "get")
      .mockResolvedValue({ data: { id: "discord-1" } } as any);
    expect(await fetchDiscordUserId("tok-1")).toBe("discord-1");
  });

  it("fetchVerifiedYoutubeChannels keeps only verified youtube connections", async () => {
    jest.spyOn(axios, "get").mockResolvedValue({
      data: [
        { type: "youtube", id: "UCa", name: "Chan A", verified: true },
        { type: "youtube", id: "UCb", name: "Chan B", verified: false },
        { type: "twitch", id: "tw1", name: "T", verified: true },
      ],
    } as any);

    expect(await fetchVerifiedYoutubeChannels("tok-1")).toEqual([
      { channelId: "UCa", title: "Chan A" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/discord/oauth/discord.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the Discord helper**

Create `src/discord/oauth/discord.ts`:

```typescript
import axios from "axios";
import {
  DISCORD_OAUTH_CLIENT_ID,
  DISCORD_OAUTH_CLIENT_SECRET,
  OAUTH_PUBLIC_BASE_URL,
} from "../../constants.js";

const API = "https://discord.com/api";

export function discordRedirectUri(): string {
  return `${OAUTH_PUBLIC_BASE_URL}/oauth/youtube-dm/discord/callback`;
}

export function buildDiscordAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: DISCORD_OAUTH_CLIENT_ID ?? "",
    response_type: "code",
    scope: "identify connections",
    redirect_uri: discordRedirectUri(),
    state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export async function exchangeDiscordCode(code: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: DISCORD_OAUTH_CLIENT_ID ?? "",
    client_secret: DISCORD_OAUTH_CLIENT_SECRET ?? "",
    grant_type: "authorization_code",
    code,
    redirect_uri: discordRedirectUri(),
  });
  const res = await axios.post(`${API}/oauth2/token`, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return res.data.access_token as string;
}

export async function fetchDiscordUserId(accessToken: string): Promise<string> {
  const res = await axios.get(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data.id as string;
}

export async function fetchVerifiedYoutubeChannels(
  accessToken: string
): Promise<{ channelId: string; title: string }[]> {
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
```

- [ ] **Step 4: Run the test + build + lint**

Run: `npm run test -- src/discord/oauth/discord.spec.ts && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord/oauth/discord.ts src/discord/oauth/discord.spec.ts
git commit -m "feat(oauth): add discord connections oauth helper"
```

---

## Task 11: OAuth callback handlers + shared bind logic

**Files:**

- Create: `src/discord/oauth/callback.ts`
- Test: `src/discord/oauth/callback.spec.ts`

> Common flow: require `code` (else error, don't touch state) → read state → validate `method` → delete state → exchange + bind. Discord additionally checks `/users/@me` id equals the state's `discordUserId`. `applyBinding` seeds Channel docs then calls `bindChannels`, mapping the binding error types to honest pages: `BindingLimitError` → reject; `BindingTransformPendingError` → saved-pending; any other error → generic failure (NOT saved-pending).

- [ ] **Step 1: Write the failing tests**

Create `src/discord/oauth/callback.spec.ts`:

```typescript
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import ChannelModel from "../../models/Channel.js";
import YoutubeDmBindingModel, {
  BindingLimitError,
  BindingTransformPendingError,
} from "../../models/YoutubeDmBinding.js";
import * as discord from "./discord.js";
import * as google from "./google.js";
import * as state from "./state.js";
import {
  applyBinding,
  handleDiscordCallback,
  handleGoogleCallback,
} from "./callback.js";

function fakeReply() {
  return {
    code: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as any;
}

describe("oauth callback", () => {
  afterEach(() => jest.restoreAllMocks());

  it("google callback rejects when code is missing without consuming state", async () => {
    const del = jest.spyOn(state, "delOAuthState").mockResolvedValue();
    const reply = fakeReply();
    await handleGoogleCallback({ query: { state: "st1" } } as any, reply);
    expect(del).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(400);
  });

  it("google callback binds all returned channels", async () => {
    jest
      .spyOn(state, "getOAuthState")
      .mockResolvedValue({ discordUserId: "d1", method: "google" });
    jest.spyOn(state, "delOAuthState").mockResolvedValue();
    jest
      .spyOn(google, "fetchGoogleChannels")
      .mockResolvedValue([{ channelId: "UCa", title: "A" }]);
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(null as any);
    jest.spyOn(ChannelModel, "create").mockResolvedValue({} as any);
    const bind = jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockResolvedValue({} as any);
    const reply = fakeReply();

    await handleGoogleCallback(
      { query: { code: "c1", state: "st1" } } as any,
      reply
    );

    expect(bind).toHaveBeenCalledWith("d1", ["UCa"]);
    expect(reply.code).toHaveBeenCalledWith(200);
  });

  it("discord callback rejects when authorizer identity != state user", async () => {
    jest
      .spyOn(state, "getOAuthState")
      .mockResolvedValue({ discordUserId: "d1", method: "discord" });
    jest.spyOn(state, "delOAuthState").mockResolvedValue();
    jest.spyOn(discord, "exchangeDiscordCode").mockResolvedValue("tok");
    jest.spyOn(discord, "fetchDiscordUserId").mockResolvedValue("OTHER");
    const bind = jest.spyOn(YoutubeDmBindingModel, "bindChannels");
    const reply = fakeReply();

    await handleDiscordCallback(
      { query: { code: "c1", state: "st1" } } as any,
      reply
    );

    expect(bind).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("applyBinding maps BindingLimitError to a rejection page", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockRejectedValue(new BindingLimitError("limit"));
    const reply = fakeReply();

    await applyBinding("d1", [{ channelId: "UCa", title: "A" }], reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.stringContaining("超過上限")
    );
  });

  it("applyBinding maps BindingTransformPendingError to a saved-pending page", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockRejectedValue(new BindingTransformPendingError("db down"));
    const reply = fakeReply();

    await applyBinding("d1", [{ channelId: "UCa", title: "A" }], reply);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(expect.stringContaining("已儲存"));
  });

  it("applyBinding maps an unexpected (pre-write) error to a generic failure, NOT saved-pending", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockRejectedValue(new Error("write failed"));
    const reply = fakeReply();

    await applyBinding("d1", [{ channelId: "UCa", title: "A" }], reply);

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).not.toHaveBeenCalledWith(
      expect.stringContaining("已儲存")
    );
  });

  it("applyBinding maps success", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockResolvedValue({} as any);
    const reply = fakeReply();

    await applyBinding("d1", [{ channelId: "UCa", title: "A" }], reply);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.stringContaining("綁定成功")
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/discord/oauth/callback.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the callback module**

Create `src/discord/oauth/callback.ts`:

```typescript
import type { FastifyReply, FastifyRequest } from "fastify";
import ChannelModel from "../../models/Channel.js";
import YoutubeDmBindingModel, {
  BindingLimitError,
  BindingTransformPendingError,
} from "../../models/YoutubeDmBinding.js";
import {
  exchangeDiscordCode,
  fetchDiscordUserId,
  fetchVerifiedYoutubeChannels,
} from "./discord.js";
import { fetchGoogleChannels } from "./google.js";
import { delOAuthState, getOAuthState, type OAuthMethod } from "./state.js";

type Channel = { channelId: string; title: string };
type Query = { code?: string; state?: string };

function page(reply: FastifyReply, status: number, message: string) {
  reply
    .code(status)
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><meta charset="utf-8"><body>${message}</body>`);
}

// Seed Channel docs (so /list shows names immediately) then bind. The three honest
// outcomes are distinguished by the binding error type; the saved-pending string is
// defined here and only here.
export async function applyBinding(
  discordUserId: string,
  channels: Channel[],
  reply: FastifyReply
): Promise<void> {
  for (const { channelId, title } of channels) {
    const existing = await ChannelModel.findByChannelId(channelId);
    if (!existing) {
      await ChannelModel.create({ id: channelId, name: title });
    }
  }
  try {
    await YoutubeDmBindingModel.bindChannels(
      discordUserId,
      channels.map((c) => c.channelId)
    );
    page(reply, 200, "綁定成功、已生效，可關閉此頁。");
  } catch (error) {
    if (error instanceof BindingLimitError) {
      page(reply, 400, "超過上限、未綁定。請先解除部分頻道後再試。");
    } else if (error instanceof BindingTransformPendingError) {
      page(reply, 200, "已儲存，稍後生效，可關閉此頁。");
    } else {
      page(reply, 500, "綁定處理失敗，請重新發起。");
    }
  }
}

async function consumeState(
  query: Query,
  expected: OAuthMethod,
  reply: FastifyReply
): Promise<{ discordUserId: string } | null> {
  if (!query.code || !query.state) {
    page(reply, 400, "缺少授權參數。");
    return null;
  }
  const data = await getOAuthState(query.state);
  if (!data || data.method !== expected) {
    page(reply, 400, "授權連結已失效或不正確，請重新發起。");
    return null;
  }
  await delOAuthState(query.state);
  return { discordUserId: data.discordUserId };
}

export async function handleGoogleCallback(
  request: FastifyRequest<{ Querystring: Query }>,
  reply: FastifyReply
): Promise<void> {
  const ctx = await consumeState(request.query, "google", reply);
  if (!ctx) return;
  try {
    const channels = await fetchGoogleChannels(request.query.code!);
    if (channels.length === 0) {
      page(reply, 400, "找不到可綁定的 YouTube 頻道。");
      return;
    }
    await applyBinding(ctx.discordUserId, channels, reply);
  } catch {
    page(reply, 500, "授權處理失敗，請重新發起。");
  }
}

export async function handleDiscordCallback(
  request: FastifyRequest<{ Querystring: Query }>,
  reply: FastifyReply
): Promise<void> {
  const ctx = await consumeState(request.query, "discord", reply);
  if (!ctx) return;
  try {
    const token = await exchangeDiscordCode(request.query.code!);
    const authorizerId = await fetchDiscordUserId(token);
    if (authorizerId !== ctx.discordUserId) {
      page(reply, 403, "授權者身分與發起者不符，已拒絕綁定。");
      return;
    }
    const channels = await fetchVerifiedYoutubeChannels(token);
    if (channels.length === 0) {
      page(reply, 400, "你的 Discord 沒有已驗證的 YouTube 連結。");
      return;
    }
    await applyBinding(ctx.discordUserId, channels, reply);
  } catch {
    page(reply, 500, "授權處理失敗，請重新發起。");
  }
}
```

- [ ] **Step 4: Run the test + build + lint**

Run: `npm run test -- src/discord/oauth/callback.spec.ts && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord/oauth/callback.ts src/discord/oauth/callback.spec.ts
git commit -m "feat(oauth): add youtube-dm oauth callback handlers"
```

---

## Task 12: `/youtube-dm` command

**Files:**

- Create: `src/discord/commands/youtube-dm/youtube-dm.ts`
- Test: `src/discord/commands/youtube-dm/youtube-dm.spec.ts`
- Modify: `src/discord/commands/index.ts`

> `bind` first checks the current binding count and rejects (without creating state) when already at the cap, then generates state + replies with the authorize link. `list` reads channel names via `ChannelModel.findByChannelId`.

- [ ] **Step 1: Write the failing tests**

Create `src/discord/commands/youtube-dm/youtube-dm.spec.ts`:

```typescript
/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import ChannelModel from "../../../models/Channel.js";
import YoutubeDmBindingModel from "../../../models/YoutubeDmBinding.js";
import * as state from "../../oauth/state.js";
import { YoutubeDmCommand } from "./youtube-dm.js";

function intr(overrides: any) {
  return {
    user: { id: "d1" },
    options: {
      getSubcommand: () => overrides.subcommand,
      getString: (name: string) => overrides.options?.[name] ?? null,
    },
    reply: jest.fn(async () => undefined),
    ...overrides,
  } as any;
}

describe("YoutubeDmCommand", () => {
  afterEach(() => jest.restoreAllMocks());

  it("bind stores state and replies with an auth link", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: [] } as any);
    jest.spyOn(state, "randomState").mockReturnValue("st1");
    const put = jest.spyOn(state, "putOAuthState").mockResolvedValue();
    const cmd = new YoutubeDmCommand();
    const i = intr({ subcommand: "bind", options: { method: "google" } });

    await cmd.execute(i);

    expect(put).toHaveBeenCalledWith("st1", {
      discordUserId: "d1",
      method: "google",
    });
    const arg = (i.reply.mock.calls[0] as any)[0];
    expect(arg.content).toContain("accounts.google.com");
  });

  it("bind at the cap rejects without creating state", async () => {
    jest.spyOn(YoutubeDmBindingModel, "findOne").mockResolvedValue({
      channelIds: Array.from({ length: 10 }, (_, n) => `UC${n}`),
    } as any);
    const put = jest.spyOn(state, "putOAuthState");
    const cmd = new YoutubeDmCommand();
    const i = intr({ subcommand: "bind", options: { method: "google" } });

    await cmd.execute(i);

    expect(put).not.toHaveBeenCalled();
    const arg = (i.reply.mock.calls[0] as any)[0];
    expect(arg.content).toContain("上限");
  });

  it("unbind all clears the user's binding", async () => {
    const unbindAll = jest
      .spyOn(YoutubeDmBindingModel, "unbindAll")
      .mockResolvedValue({} as any);
    const cmd = new YoutubeDmCommand();
    await cmd.execute(
      intr({ subcommand: "unbind", options: { channel: "all" } })
    );
    expect(unbindAll).toHaveBeenCalledWith("d1");
  });

  it("unbind <id> removes one channel", async () => {
    const unbind = jest
      .spyOn(YoutubeDmBindingModel, "unbindChannel")
      .mockResolvedValue({} as any);
    const cmd = new YoutubeDmCommand();
    await cmd.execute(
      intr({ subcommand: "unbind", options: { channel: "UCa" } })
    );
    expect(unbind).toHaveBeenCalledWith("d1", "UCa");
  });

  it("list shows the user's channels with names", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue({ name: "Chan A" } as any);
    const cmd = new YoutubeDmCommand();
    const i = intr({ subcommand: "list" });

    await cmd.execute(i);

    const arg = (i.reply.mock.calls[0] as any)[0];
    expect(arg.content).toContain("Chan A");
    expect(arg.content).toContain("UCa");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/discord/commands/youtube-dm/youtube-dm.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command**

Create `src/discord/commands/youtube-dm/youtube-dm.ts`:

```typescript
import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { YOUTUBE_DM_MAX_CHANNELS_PER_USER } from "../../../constants.js";
import ChannelModel from "../../../models/Channel.js";
import YoutubeDmBindingModel from "../../../models/YoutubeDmBinding.js";
import { buildDiscordAuthUrl } from "../../oauth/discord.js";
import { buildGoogleAuthUrl } from "../../oauth/google.js";
import {
  putOAuthState,
  randomState,
  type OAuthMethod,
} from "../../oauth/state.js";
import type { Command } from "../command.js";

export class YoutubeDmCommand implements Command {
  public metadata = new SlashCommandBuilder()
    .setName("youtube-dm")
    .setDescription("Manage YouTube → Discord DM notifications.")
    .addSubcommand((b) =>
      b
        .setName("bind")
        .setDescription("Bind a YouTube account you own (via OAuth).")
        .addStringOption((o) =>
          o
            .setName("method")
            .setDescription("Verification method")
            .setRequired(true)
            .addChoices(
              { name: "Google", value: "google" },
              { name: "Discord connection", value: "discord" }
            )
        )
    )
    .addSubcommand((b) =>
      b.setName("list").setDescription("List your bound YouTube channels.")
    )
    .addSubcommand((b) =>
      b
        .setName("unbind")
        .setDescription("Unbind a channel (or all).")
        .addStringOption((o) =>
          o
            .setName("channel")
            .setDescription("Channel id, or 'all'")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .setContexts(InteractionContextType.Guild)
    .toJSON();

  public async execute(intr: ChatInputCommandInteraction): Promise<void> {
    const subcommand = intr.options.getSubcommand(true);
    const discordUserId = intr.user.id;
    switch (subcommand) {
      case "bind":
        await this.bind(intr, discordUserId);
        break;
      case "list":
        await this.list(intr, discordUserId);
        break;
      case "unbind":
        await this.unbind(intr, discordUserId);
        break;
    }
  }

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
    const state = randomState();
    await putOAuthState(state, { discordUserId, method });
    const url =
      method === "google"
        ? buildGoogleAuthUrl(state)
        : buildDiscordAuthUrl(state);
    await intr.reply({
      content: `點此完成授權（連結 10 分鐘內有效，請勿轉傳）：\n${url}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async list(
    intr: ChatInputCommandInteraction,
    discordUserId: string
  ): Promise<void> {
    const binding = await YoutubeDmBindingModel.findOne({ discordUserId });
    const ids = binding?.channelIds ?? [];
    if (ids.length === 0) {
      await intr.reply({
        content: "你尚未綁定任何 YouTube 頻道。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = await Promise.all(
      ids.map(async (id) => {
        const channel = await ChannelModel.findByChannelId(id);
        return `• ${channel?.name ?? "Unknown channel"} (${id})`;
      })
    );
    await intr.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async unbind(
    intr: ChatInputCommandInteraction,
    discordUserId: string
  ): Promise<void> {
    const channel = intr.options.getString("channel", true);
    if (channel === "all") {
      await YoutubeDmBindingModel.unbindAll(discordUserId);
      await intr.reply({
        content: "已解除所有綁定。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await YoutubeDmBindingModel.unbindChannel(discordUserId, channel);
    await intr.reply({
      content: `已解除綁定 ${channel}。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  public async autocomplete(intr: AutocompleteInteraction): Promise<void> {
    const focused = intr.options.getFocused(true);
    if (focused.name !== "channel") {
      await intr.respond([]);
      return;
    }
    const binding = await YoutubeDmBindingModel.findOne({
      discordUserId: intr.user.id,
    });
    const ids = (binding?.channelIds ?? []).filter((id) =>
      id.includes(focused.value)
    );
    const options = [
      { name: "All channels", value: "all" },
      ...ids.map((id) => ({ name: id, value: id })),
    ].slice(0, 25);
    await intr.respond(options);
  }
}
```

- [ ] **Step 4: Register the command in the index**

In `src/discord/commands/index.ts`:

```typescript
import { YoutubeDmCommand } from "./youtube-dm/youtube-dm.js";
```

```typescript
export const commands: AppCommand[] = [
  new CrawlCommand(),
  new SetChannelCommand(),
  new SetVideoCommand(),
  new TrackCommand(),
  new YoutubeDmCommand(),
];
```

- [ ] **Step 5: Run the test + build + lint**

Run: `npm run test -- src/discord/commands/youtube-dm/youtube-dm.spec.ts && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/discord/commands/youtube-dm/youtube-dm.ts src/discord/commands/youtube-dm/youtube-dm.spec.ts src/discord/commands/index.ts
git commit -m "feat(discord): add /youtube-dm bind/list/unbind command"
```

---

## Task 13: Wire discord-bot (Redis + state init + callback routes)

**Files:**

- Modify: `src/commands/discord-bot.ts`

- [ ] **Step 1: Add imports**

```typescript
import { RedisModule } from "../modules/redis.js";
import {
  handleDiscordCallback,
  handleGoogleCallback,
} from "../discord/oauth/callback.js";
import { initOAuthStateStore } from "../discord/oauth/state.js";
```

- [ ] **Step 2: Register RedisModule, init the state store, register routes (before `app.init()`)**

In `runDiscordBot`, after `app.use(new MongodbModule());`:

```typescript
const redisModule = app.use(new RedisModule());
initOAuthStateStore(redisModule.redis);

const { server: fastify } = app.http;
fastify.get("/oauth/youtube-dm/google/callback", handleGoogleCallback);
fastify.get("/oauth/youtube-dm/discord/callback", handleDiscordCallback);
```

- [ ] **Step 3: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 4: Import smoke check (no network)**

Run (after `npm run build`):

```bash
node -e "import('./dist/commands/discord-bot.js').then(()=>console.log('import ok'))"
```

Expected: prints `import ok` (module loads without running `runDiscordBot`).

- [ ] **Step 5: Commit**

```bash
git add src/commands/discord-bot.ts
git commit -m "feat(discord-bot): wire redis + oauth state + callback routes"
```

---

## Task 14: k8s — discord-bot Service, ingress path, webhook env

**Files:**

- Modify: `k8s/base/discord-bot.yaml`, `k8s/base/ingress.yaml`, `k8s/base/webhook.yaml`

> All env vars use `secretKeyRef`. New OAuth secrets come from a new secret `discord-oauth-secrets` (creating the secret is a cluster-operator step, out of repo scope).

- [ ] **Step 1: Add the discord-bot Service**

Append to `k8s/base/discord-bot.yaml` (after the Deployment, with a `---` separator):

```yaml
---
apiVersion: v1
kind: Service
metadata:
  name: honeybee-discord-bot
  labels:
    app: discord-bot
    app.kubernetes.io/component: discord-bot
    app.kubernetes.io/name: honeybee
    app.kubernetes.io/version: dev
spec:
  ports:
    - name: http-port
      port: 3000
      targetPort: 3000
  type: ClusterIP
  selector:
    app: discord-bot
```

- [ ] **Step 2: Add OAuth + Redis env to the discord-bot Deployment**

In `k8s/base/discord-bot.yaml`, append to the container `env:` list (after `GOOGLE_API_KEY`):

```yaml
- name: REDIS_URI
  valueFrom:
    secretKeyRef:
      name: honeybee-redis
      key: REDIS_URI
- name: GOOGLE_OAUTH_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: discord-oauth-secrets
      key: GOOGLE_OAUTH_CLIENT_ID
- name: GOOGLE_OAUTH_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: discord-oauth-secrets
      key: GOOGLE_OAUTH_CLIENT_SECRET
- name: DISCORD_OAUTH_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: discord-oauth-secrets
      key: DISCORD_OAUTH_CLIENT_ID
- name: DISCORD_OAUTH_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: discord-oauth-secrets
      key: DISCORD_OAUTH_CLIENT_SECRET
- name: OAUTH_PUBLIC_BASE_URL
  valueFrom:
    secretKeyRef:
      name: discord-oauth-secrets
      key: OAUTH_PUBLIC_BASE_URL
```

- [ ] **Step 3: Add the `/oauth/` ingress path**

In `k8s/base/ingress.yaml`, under `spec.rules[0].http.paths`, after `/notifications/`:

```yaml
- path: /oauth/
  pathType: Prefix
  backend:
    service:
      name: honeybee-discord-bot
      port:
        name: http-port
```

- [ ] **Step 4: Add `DISCORD_TOKEN` to the webhook Deployment**

In `k8s/base/webhook.yaml`, append to the container `env:` list (after `MONGO_URI`):

```yaml
- name: DISCORD_TOKEN
  valueFrom:
    secretKeyRef:
      name: discord-token
      key: DISCORD_TOKEN
```

- [ ] **Step 5: Validate YAML**

Run:

```bash
npx --yes js-yaml k8s/base/discord-bot.yaml >/dev/null && echo "discord-bot ok"
npx --yes js-yaml k8s/base/ingress.yaml >/dev/null && echo "ingress ok"
npx --yes js-yaml k8s/base/webhook.yaml >/dev/null && echo "webhook ok"
```

Expected: all three `ok` lines. If `kustomize` is available: `kustomize build k8s/base >/dev/null && echo "kustomize ok"`.

- [ ] **Step 6: Commit**

```bash
git add k8s/base/discord-bot.yaml k8s/base/ingress.yaml k8s/base/webhook.yaml
git commit -m "feat(k8s): discord-bot service + /oauth ingress + webhook DISCORD_TOKEN"
```

---

## Final verification

- [ ] **Run the whole suite, type-check, and lint**

Run:

```bash
npm run build
npm run lint
npm test
```

Expected: all PASS. (`npm run build` is the authoritative type-check since jest uses `isolatedModules`.)

- [ ] **Confirm end-to-end wiring by reading, not guessing**

Spot-check:

- `src/commands/manager.ts` calls `youtubeDmOperator(app)`.
- `src/discord/commands/index.ts` includes `new YoutubeDmCommand()`.
- `src/commands/webhook.ts` dispatch has the `checkIsDiscordDmUrl` branch and `runWebhook` calls `dmRest.setToken(...)`.
- `src/commands/discord-bot.ts` registers both `/oauth/youtube-dm/*/callback` routes before `app.init()`.

**Deployment note (operator action, out of repo scope):** create the `discord-oauth-secrets` Secret (5 keys: GOOGLE_OAUTH_CLIENT_ID/SECRET, DISCORD_OAUTH_CLIENT_ID/SECRET, OAUTH_PUBLIC_BASE_URL); register both redirect URIs (`<OAUTH_PUBLIC_BASE_URL>/oauth/youtube-dm/google/callback`, `.../discord/callback`) in the Google Cloud Console OAuth client and the Discord application; ensure the `discord-token` secret used by the webhook deployment contains `DISCORD_TOKEN`.
