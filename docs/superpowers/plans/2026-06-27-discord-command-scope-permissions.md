# Discord 指令可見性、使用範圍與執行權限調整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 mod 指令只在開發 guild 註冊並只在該 guild 可執行（fail-closed）、track 維持 guild-install + ManageWebhooks、youtube-dm 改為 DM-only 並支援 user-install 且引導使用者安裝，註冊流程改為 fail-fast。

**Architecture:** 在 `AppCommand` 介面加 `registration?: "global" | "devGuild"` 單一標記，同時驅動「註冊範圍」與「執行期 guild 守衛」。`registerCommands` 依標記拆成 devGuild（`applicationGuildCommands`，先）與 global（`applicationCommands`，後）兩次 `PUT`，任一失敗即拋錯中止啟動（既有 `index.ts` 的 `unhandledRejection` handler 會 `process.exit(1)`）。純判斷（分組、守衛、user-install 提示）抽成可單元測試的函式。

**Tech Stack:** TypeScript（ESM, NodeNext，import 帶 `.js`）、discord.js 14.26、Jest（ts-jest ESM）、Typegoose、k8s。

---

## File Structure

- `src/discord/commands/command.ts` — 在 `AppCommand` 介面新增 `registration` 欄位。
- `src/discord/commands/mod/{crawl,set-channel,set-video}.ts` — class 上加 `registration = "devGuild"`。
- `src/discord/commands/registration.ts`（新）— `partitionCommandsByScope()` 與 `isDevGuildCommandAllowed()` 純函式。
- `src/discord/commands/registration.spec.ts`（新）— 分組、守衛、各命令 metadata 斷言。
- `src/discord/commands/track/track.ts` — metadata 補 `setIntegrationTypes(GuildInstall)`。
- `src/discord/commands/youtube-dm/youtube-dm.ts` — metadata 改 `BotDM` + `[GuildInstall, UserInstall]`；`execute()` 末尾附加 user-install 提示。
- `src/discord/commands/youtube-dm/install-hint.ts`（新）— `buildUserInstallHint()` 純函式。
- `src/discord/commands/youtube-dm/install-hint.spec.ts`（新）— 提示函式測試。
- `src/discord/commands/youtube-dm/youtube-dm.spec.ts` — 擴充 fake 並加 execute 層提示測試。
- `src/constants.ts` — 新增 `DISCORD_DEV_GUILD_ID`。
- `src/commands/discord-bot.ts` — `registerCommands` 改寫（分組 + 順序 + fail-fast）、`InteractionCreate` handler 加守衛。
- `k8s/base/discord-bot.yaml` — 新增 `DISCORD_DEV_GUILD_ID` env（`optional: true`）。

---

## Task 1: 在 AppCommand 介面新增 registration 欄位並標記 mod 指令

**Files:**

- Modify: `src/discord/commands/command.ts`
- Modify: `src/discord/commands/mod/crawl.ts`
- Modify: `src/discord/commands/mod/set-channel.ts`
- Modify: `src/discord/commands/mod/set-video.ts`

- [ ] **Step 1: 在 AppCommand 介面加 registration 欄位**

修改 `src/discord/commands/command.ts`，在 `metadata` 後新增欄位：

```ts
export interface AppCommand<
  Intr extends CommandInteraction = CommandInteraction,
  Meta extends RESTPostAPIApplicationCommandsJSONBody =
    RESTPostAPIApplicationCommandsJSONBody,
> {
  metadata: Meta;
  /**
   * Registration / execution scope.
   * - "global" (or unset): registered as a global application command.
   * - "devGuild": registered only to DISCORD_DEV_GUILD_ID and only executable there.
   */
  registration?: "global" | "devGuild";
  execute(intr: Intr): Promise<void>;
  autocomplete?: (intr: AutocompleteInteraction) => Promise<void>;
}
```

- [ ] **Step 2: 標記 CrawlCommand 為 devGuild**

修改 `src/discord/commands/mod/crawl.ts`，在 class body 第一行加入 `registration`：

```ts
export class CrawlCommand implements Command {
  public registration = "devGuild" as const;
  public metadata = new SlashCommandBuilder()
    .setName("crawl")
```

- [ ] **Step 3: 標記 SetChannelCommand 為 devGuild**

修改 `src/discord/commands/mod/set-channel.ts`：

```ts
export class SetChannelCommand implements Command {
  public registration = "devGuild" as const;
  public metadata = new SlashCommandBuilder()
    .setName("set-channel")
```

- [ ] **Step 4: 標記 SetVideoCommand 為 devGuild**

修改 `src/discord/commands/mod/set-video.ts`：

```ts
export class SetVideoCommand implements Command {
  public registration = "devGuild" as const;
  public metadata = new SlashCommandBuilder()
    .setName("set-video")
```

- [ ] **Step 5: 型別檢查通過**

Run: `npx tsc --noEmit`
Expected: 無錯誤（`registration = "devGuild" as const` 與介面的 `"global" | "devGuild"` 相容）。

- [ ] **Step 6: Commit**

```bash
git add src/discord/commands/command.ts src/discord/commands/mod/crawl.ts src/discord/commands/mod/set-channel.ts src/discord/commands/mod/set-video.ts
git commit -m "feat(discord): add registration scope marker; mark mod commands devGuild"
```

---

## Task 2: partitionCommandsByScope 分組純函式

**Files:**

- Create: `src/discord/commands/registration.ts`
- Test: `src/discord/commands/registration.spec.ts`

- [ ] **Step 1: 寫失敗測試**

建立 `src/discord/commands/registration.spec.ts`：

```ts
/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { commands } from "./index.js";
import { partitionCommandsByScope } from "./registration.js";

describe("partitionCommandsByScope", () => {
  it("splits mod commands into devGuild and the rest into global, preserving input order", () => {
    const { global, devGuild } = partitionCommandsByScope(commands);
    // `commands` is sorted by name in index.ts; partition preserves that order.
    // Assert exact ordered arrays (no sort) to verify both membership AND order.
    expect(devGuild.map((c) => c.metadata.name)).toEqual([
      "crawl",
      "set-channel",
      "set-video",
    ]);
    expect(global.map((c) => c.metadata.name)).toEqual(["track", "youtube-dm"]);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/discord/commands/registration.spec.ts`
Expected: FAIL，找不到模組 `./registration.js`。

- [ ] **Step 3: 實作 partitionCommandsByScope**

建立 `src/discord/commands/registration.ts`：

```ts
import type { AppCommand } from "./command.js";

/**
 * Split commands into the global set and the dev-guild-only set based on each
 * command's `registration` marker (unset / "global" => global).
 */
export function partitionCommandsByScope(commands: AppCommand[]): {
  global: AppCommand[];
  devGuild: AppCommand[];
} {
  const global: AppCommand[] = [];
  const devGuild: AppCommand[] = [];
  for (const command of commands) {
    if (command.registration === "devGuild") {
      devGuild.push(command);
    } else {
      global.push(command);
    }
  }
  return { global, devGuild };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run test -- src/discord/commands/registration.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/discord/commands/registration.ts src/discord/commands/registration.spec.ts
git commit -m "feat(discord): add partitionCommandsByScope helper"
```

---

## Task 3: isDevGuildCommandAllowed 執行期守衛純函式

**Files:**

- Modify: `src/discord/commands/registration.ts`
- Test: `src/discord/commands/registration.spec.ts`

- [ ] **Step 1: 加失敗測試**

在 `src/discord/commands/registration.spec.ts` 的 import 行補上 `isDevGuildCommandAllowed`：

```ts
import {
  isDevGuildCommandAllowed,
  partitionCommandsByScope,
} from "./registration.js";
```

並在檔案末尾新增：

```ts
describe("isDevGuildCommandAllowed", () => {
  const DEV = "543454386873958411";

  it("allows global commands regardless of guild", () => {
    expect(
      isDevGuildCommandAllowed({
        registration: undefined,
        guildId: null,
        devGuildId: DEV,
      })
    ).toBe(true);
    expect(
      isDevGuildCommandAllowed({
        registration: "global",
        guildId: "other-guild",
        devGuildId: DEV,
      })
    ).toBe(true);
  });

  it("allows a devGuild command only inside the dev guild", () => {
    expect(
      isDevGuildCommandAllowed({
        registration: "devGuild",
        guildId: DEV,
        devGuildId: DEV,
      })
    ).toBe(true);
  });

  it("rejects a devGuild command in another guild", () => {
    expect(
      isDevGuildCommandAllowed({
        registration: "devGuild",
        guildId: "other-guild",
        devGuildId: DEV,
      })
    ).toBe(false);
  });

  it("rejects a devGuild command in DM (guildId null)", () => {
    expect(
      isDevGuildCommandAllowed({
        registration: "devGuild",
        guildId: null,
        devGuildId: DEV,
      })
    ).toBe(false);
  });

  it("fails closed when the dev guild id is unset or empty", () => {
    expect(
      isDevGuildCommandAllowed({
        registration: "devGuild",
        guildId: DEV,
        devGuildId: undefined,
      })
    ).toBe(false);
    expect(
      isDevGuildCommandAllowed({
        registration: "devGuild",
        guildId: DEV,
        devGuildId: "",
      })
    ).toBe(false);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/discord/commands/registration.spec.ts`
Expected: FAIL，`isDevGuildCommandAllowed` 不是匯出（型別/執行期錯誤）。

- [ ] **Step 3: 實作 isDevGuildCommandAllowed**

在 `src/discord/commands/registration.ts` 末尾新增：

```ts
/**
 * Execution-time authorization guard for dev-guild-only commands. Registration
 * scope is only a visibility hint; this guard is the actual boundary, so a stale
 * / cached / failed registration cannot let a mod command run outside the dev
 * guild. Fails closed when the dev guild id is unset.
 */
export function isDevGuildCommandAllowed({
  registration,
  guildId,
  devGuildId,
}: {
  registration: AppCommand["registration"];
  guildId: string | null;
  devGuildId: string | undefined;
}): boolean {
  if (registration !== "devGuild") return true;
  if (!devGuildId) return false;
  return guildId === devGuildId;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run test -- src/discord/commands/registration.spec.ts`
Expected: PASS（兩個 describe 全綠）。

- [ ] **Step 5: Commit**

```bash
git add src/discord/commands/registration.ts src/discord/commands/registration.spec.ts
git commit -m "feat(discord): add isDevGuildCommandAllowed runtime guard"
```

---

## Task 4: track / youtube-dm metadata 調整 + metadata 斷言

**Files:**

- Modify: `src/discord/commands/track/track.ts`
- Modify: `src/discord/commands/youtube-dm/youtube-dm.ts`
- Test: `src/discord/commands/registration.spec.ts`

- [ ] **Step 1: 加 metadata 斷言（失敗測試）**

在 `src/discord/commands/registration.spec.ts` 的 import 區補上 discord.js 列舉：

```ts
import {
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionsBitField,
} from "discord.js";
```

並在檔案末尾新增：

```ts
describe("command metadata", () => {
  function metaOf(name: string) {
    const command = commands.find((c) => c.metadata.name === name);
    if (!command) throw new Error(`command ${name} not found`);
    return command.metadata as Record<string, unknown>;
  }

  it("mod commands carry the devGuild registration marker", () => {
    for (const name of ["crawl", "set-channel", "set-video"]) {
      const command = commands.find((c) => c.metadata.name === name);
      expect(command?.registration).toBe("devGuild");
    }
  });

  it("track requires ManageWebhooks, Guild context, GuildInstall only", () => {
    const meta = metaOf("track");
    expect(meta.contexts).toEqual([InteractionContextType.Guild]);
    expect(meta.integration_types).toEqual([
      ApplicationIntegrationType.GuildInstall,
    ]);
    expect(meta.default_member_permissions).toBe(
      PermissionsBitField.Flags.ManageWebhooks.toString()
    );
  });

  it("youtube-dm is BotDM-only and supports guild + user install", () => {
    const meta = metaOf("youtube-dm");
    expect(meta.contexts).toEqual([InteractionContextType.BotDM]);
    expect(meta.integration_types).toEqual([
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall,
    ]);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/discord/commands/registration.spec.ts -t "command metadata"`
Expected: FAIL —— track 的 `integration_types` 為 `undefined`、youtube-dm 的 `contexts` 為 `[Guild]` 而非 `[BotDM]`（mod marker 那條會通過）。

- [ ] **Step 3: track metadata 補 GuildInstall**

修改 `src/discord/commands/track/track.ts`。先在 discord.js import 區（現有 `import { ... } from "discord.js";`）加入 `ApplicationIntegrationType`，再於 metadata builder 鏈 `.setContexts(InteractionContextType.Guild)` 之後、`.toJSON()` 之前插入一行：

```ts
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageWebhooks)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .toJSON();
```

- [ ] **Step 4: youtube-dm metadata 改 BotDM + 雙 integration type**

修改 `src/discord/commands/youtube-dm/youtube-dm.ts`。在 discord.js import 區（現有含 `InteractionContextType`、`SlashCommandBuilder`）加入 `ApplicationIntegrationType`，並把 metadata 結尾的 `.setContexts(InteractionContextType.Guild)` 改為：

```ts
    .setContexts(InteractionContextType.BotDM)
    .setIntegrationTypes(
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall
    )
    .toJSON();
```

- [ ] **Step 5: 執行測試確認通過**

Run: `npm run test -- src/discord/commands/registration.spec.ts`
Expected: PASS（三個 describe 全綠）。

- [ ] **Step 6: Commit**

```bash
git add src/discord/commands/track/track.ts src/discord/commands/youtube-dm/youtube-dm.ts src/discord/commands/registration.spec.ts
git commit -m "feat(discord): track GuildInstall-only; youtube-dm BotDM + user-install metadata"
```

---

## Task 5: 新增 DISCORD_DEV_GUILD_ID 常數

**Files:**

- Modify: `src/constants.ts`

- [ ] **Step 1: 新增常數**

在 `src/constants.ts` 的 `DISCORD_OAUTH_CLIENT_SECRET`（約第 142 行）之後新增：

```ts
// Discord guild that the mod-only slash commands (crawl / set-channel / set-video)
// are registered to and allowed to execute in. Optional: when unset, those commands
// are not registered anywhere and the runtime guard rejects them (fail-closed).
export const DISCORD_DEV_GUILD_ID = process.env.DISCORD_DEV_GUILD_ID;
```

- [ ] **Step 2: 型別檢查通過**

Run: `npx tsc --noEmit`
Expected: 無錯誤。

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat(config): add DISCORD_DEV_GUILD_ID env constant"
```

---

## Task 6: registerCommands 改寫（分組 + 順序 + fail-fast）並接上執行期守衛

**Files:**

- Modify: `src/commands/discord-bot.ts`

- [ ] **Step 1: 補 import**

修改 `src/commands/discord-bot.ts`。在 import 區新增（與既有 import 風格一致）：

```ts
import { DISCORD_DEV_GUILD_ID } from "../constants.js";
import {
  isDevGuildCommandAllowed,
  partitionCommandsByScope,
} from "../discord/commands/registration.js";
```

- [ ] **Step 2: 改寫 registerCommands（devGuild 先、global 後、fail-fast）**

把現有 `registerCommands`（約第 38–59 行整個函式）替換為：

```ts
async function registerCommands(commands: AppCommand[]): Promise<void> {
  const { global, devGuild } = partitionCommandsByScope(commands);
  const rest = new REST({ version: "9" }).setToken(DISCORD_TOKEN);

  // Dev-guild commands first: land mod commands in the dev guild before the
  // global PUT removes them from the global set, so there is no cross-state gap.
  if (devGuild.length > 0) {
    if (DISCORD_DEV_GUILD_ID) {
      console.log(
        `Registering dev-guild commands [${DISCORD_DEV_GUILD_ID}]: ${devGuild
          .map((cmd) => `'${cmd.metadata.name}'`)
          .join(", ")}.`
      );
      await rest.put(
        Routes.applicationGuildCommands(DISCORD_ID, DISCORD_DEV_GUILD_ID),
        { body: devGuild.map((cmd) => cmd.metadata) }
      );
    } else {
      console.warn(
        `DISCORD_DEV_GUILD_ID is not set; skipping dev-guild registration. ` +
          `These commands will be unavailable everywhere: ${devGuild
            .map((cmd) => `'${cmd.metadata.name}'`)
            .join(", ")}.`
      );
    }
  }

  console.log(
    `Registering global commands: ${global
      .map((cmd) => `'${cmd.metadata.name}'`)
      .join(", ")}.`
  );
  await rest.put(Routes.applicationCommands(DISCORD_ID), {
    body: global.map((cmd) => cmd.metadata),
  });

  console.log(`Commands registered.`);
}
```

注意：刻意**移除**原本的 `try/catch ... return`。任一 `rest.put` 失敗會往外拋 → `app.init()` reject → `runDiscordBot()` reject → `src/index.ts` 的 `unhandledRejection` handler `process.exit(1)`（fail-fast，pod crashloop）。`RESTPutAPIApplicationCommandsJSONBody` 型別匯入若不再被用到，移除該 import 以免 lint 報未使用。

- [ ] **Step 3: 在 InteractionCreate handler 接上守衛**

在 `src/commands/discord-bot.ts` 的 handler 中，找到命令後（現有 `const command = commands.find(...)` 與 `if (!command) { ... return; }` 之後）、進入 `try { ... execute/autocomplete }` 之前，插入：

```ts
// Scope guard: dev-guild-only commands may only run in the configured
// dev guild. Registration is visibility; this is the authorization edge.
if (
  !isDevGuildCommandAllowed({
    registration: command.registration,
    guildId: intr.guildId,
    devGuildId: DISCORD_DEV_GUILD_ID,
  })
) {
  console.warn(
    `[${intr.id}] Rejected dev-guild command '${command.metadata.name}' from guild '${intr.guildId}'.`
  );
  if (intr.isAutocomplete()) {
    await intr.respond([]);
  } else if (intr.isRepliable()) {
    await intr.reply({
      content: "This command is not available here.",
      ephemeral: true,
    });
  }
  return;
}
```

- [ ] **Step 4: 型別檢查與 lint 通過**

Run: `npx tsc --noEmit && npm run lint`
Expected: 無錯誤、無未使用 import 警告（若 `RESTPutAPIApplicationCommandsJSONBody` 已不用須移除）。

- [ ] **Step 5: 既有測試仍綠（回歸）**

Run: `npm run test -- src/discord/commands/registration.spec.ts`
Expected: PASS（分組函式行為與此處接線一致）。

- [ ] **Step 6: Commit**

```bash
git add src/commands/discord-bot.ts
git commit -m "feat(discord): split command registration (devGuild-first, fail-fast) + runtime guard"
```

---

## Task 7: buildUserInstallHint user-install 提示純函式

**Files:**

- Create: `src/discord/commands/youtube-dm/install-hint.ts`
- Test: `src/discord/commands/youtube-dm/install-hint.spec.ts`

- [ ] **Step 1: 寫失敗測試**

建立 `src/discord/commands/youtube-dm/install-hint.spec.ts`：

```ts
/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { ApplicationIntegrationType } from "discord.js";
import { buildUserInstallHint } from "./install-hint.js";

describe("buildUserInstallHint", () => {
  it("returns null when the user already user-installed the app", () => {
    const owners = { [ApplicationIntegrationType.UserInstall]: "u1" };
    expect(buildUserInstallHint(owners, "app123")).toBeNull();
  });

  it("returns an install hint with the user-install link when only guild-installed", () => {
    const owners = { [ApplicationIntegrationType.GuildInstall]: "g1" };
    const hint = buildUserInstallHint(owners, "app123");
    expect(hint).not.toBeNull();
    expect(hint).toContain(
      "https://discord.com/oauth2/authorize?client_id=app123"
    );
    expect(hint).toContain("integration_type=1");
    expect(hint).toContain("scope=applications.commands");
  });

  it("returns a hint when owners is undefined (defensive)", () => {
    const hint = buildUserInstallHint(undefined, "app123");
    expect(hint).toContain("integration_type=1");
  });

  it("returns a hint when owners is an empty map (no UserInstall key)", () => {
    const hint = buildUserInstallHint({}, "app123");
    expect(hint).toContain("integration_type=1");
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/discord/commands/youtube-dm/install-hint.spec.ts`
Expected: FAIL，找不到模組 `./install-hint.js`。

- [ ] **Step 3: 實作 buildUserInstallHint**

建立 `src/discord/commands/youtube-dm/install-hint.ts`：

```ts
import { ApplicationIntegrationType } from "discord.js";

/**
 * Build a user-install nudge for the youtube-dm command. Returns null when the
 * invoking interaction was already authorized via user install. Otherwise (only
 * guild-installed, or owners missing) returns a hint plus the user-install link
 * so the DM path survives leaving the shared guild / the bot being removed.
 *
 * Link form (Discord install link, command-only, no token exchange):
 *   integration_type=1 => user install; scope=applications.commands => commands.
 */
export function buildUserInstallHint(
  owners: Partial<Record<ApplicationIntegrationType, string>> | undefined,
  applicationId: string
): string | null {
  const hasUserInstall =
    owners != null &&
    owners[ApplicationIntegrationType.UserInstall] !== undefined;
  if (hasUserInstall) return null;

  const url = `https://discord.com/oauth2/authorize?client_id=${applicationId}&integration_type=1&scope=applications.commands`;
  return (
    "💡 將本 App 安裝到你的帳號，即可在任何 DM 使用本指令（不受退出伺服器或移除 Bot 影響）：\n" +
    url
  );
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run test -- src/discord/commands/youtube-dm/install-hint.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/discord/commands/youtube-dm/install-hint.ts src/discord/commands/youtube-dm/install-hint.spec.ts
git commit -m "feat(youtube-dm): add buildUserInstallHint helper"
```

---

## Task 8: 在 youtube-dm execute() 接上提示並擴充既有測試

**Files:**

- Modify: `src/discord/commands/youtube-dm/youtube-dm.ts`
- Test: `src/discord/commands/youtube-dm/youtube-dm.spec.ts`

- [ ] **Step 1: 擴充 fake 並寫失敗測試**

修改 `src/discord/commands/youtube-dm/youtube-dm.spec.ts`。

(a) 在 import 區新增：

```ts
import { ApplicationIntegrationType } from "discord.js";
import { YoutubeDmCommand } from "./youtube-dm.js";
```

（若 `YoutubeDmCommand` 已 import 則不重複；新增 `ApplicationIntegrationType`。）

(b) 把 `intr()` fake 改為提供 `client.application.id`、`authorizingIntegrationOwners`、`followUp`，並允許覆寫 owners（預設為已 user-install，使既有測試不觸發提示）：

```ts
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
```

(c) 在 `describe("YoutubeDmCommand", ...)` 內新增兩個測試：

```ts
it("appends a user-install hint followUp when only guild-installed", async () => {
  jest
    .spyOn(YoutubeDmBindingModel, "findOne")
    .mockResolvedValue({ channelIds: ["UCa"] } as any);
  jest
    .spyOn(ChannelModel, "findByChannelId")
    .mockResolvedValue({ name: "Chan A" } as any);
  const cmd = new YoutubeDmCommand();
  const i = intr({
    subcommand: "list",
    owners: { [ApplicationIntegrationType.GuildInstall]: "g1" },
  });

  await cmd.execute(i);

  expect(i.followUp).toHaveBeenCalledTimes(1);
  const arg = i.followUp.mock.calls[0][0];
  expect(arg.content).toContain("integration_type=1");
  expect(arg.ephemeral).toBe(true);
});

it("does not append a hint when already user-installed", async () => {
  jest
    .spyOn(YoutubeDmBindingModel, "findOne")
    .mockResolvedValue({ channelIds: ["UCa"] } as any);
  jest
    .spyOn(ChannelModel, "findByChannelId")
    .mockResolvedValue({ name: "Chan A" } as any);
  const cmd = new YoutubeDmCommand();
  const i = intr({
    subcommand: "list",
    owners: { [ApplicationIntegrationType.UserInstall]: "d1" },
  });

  await cmd.execute(i);

  expect(i.followUp).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 執行測試確認新案例失敗**

Run: `npm run test -- src/discord/commands/youtube-dm/youtube-dm.spec.ts`
Expected: 新增的兩個案例 FAIL（`execute` 尚未呼叫 `followUp`）；既有案例仍 PASS（fake 已擴充、預設 owners 為 user-install 不觸發提示）。

- [ ] **Step 3: 在 execute() 末尾接上提示**

修改 `src/discord/commands/youtube-dm/youtube-dm.ts`。在 import 區新增：

```ts
import { buildUserInstallHint } from "./install-hint.js";
```

把 `execute` 的 switch 之後補上提示送出（switch 內各分支維持原樣）：

```ts
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

    // Every subcommand has already replied (ephemerally) above; nudge guild-install
    // users toward user-install so the DM path is not tied to shared-guild membership.
    const hint = buildUserInstallHint(
      intr.authorizingIntegrationOwners,
      intr.client.application.id
    );
    if (hint) {
      await intr.followUp({ content: hint, ephemeral: true });
    }
  }
```

- [ ] **Step 4: 執行測試確認全部通過**

Run: `npm run test -- src/discord/commands/youtube-dm/youtube-dm.spec.ts`
Expected: PASS（既有 5 個 + 新增 2 個全綠）。

- [ ] **Step 5: 型別檢查與 lint 通過**

Run: `npx tsc --noEmit && npm run lint`
Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/discord/commands/youtube-dm/youtube-dm.ts src/discord/commands/youtube-dm/youtube-dm.spec.ts
git commit -m "feat(youtube-dm): nudge guild-install users toward user-install"
```

---

## Task 9: k8s 部署新增 DISCORD_DEV_GUILD_ID env

**Files:**

- Modify: `k8s/base/discord-bot.yaml`

- [ ] **Step 1: 新增 env（optional: true）**

修改 `k8s/base/discord-bot.yaml`。在 `PUBLIC_BASE_URL` env 區塊（現有最後一條，約 82–86 行）之後、`resources: {}` 之前，新增：

```yaml
- name: DISCORD_DEV_GUILD_ID
  valueFrom:
    secretKeyRef:
      name: honeybee-secrets
      key: DISCORD_DEV_GUILD_ID
      optional: true
```

`optional: true` 是必要的：`DISCORD_DEV_GUILD_ID` 設計為 optional，若 secret 尚未含此 key，`optional: true` 讓 env 單純不存在、pod 正常啟動並走 fail-closed 路徑；若省略，缺 key 會擋住整個 pod 啟動。

- [ ] **Step 2: 驗證 YAML 結構**

Run: `node -e "const y=require('js-yaml'); const fs=require('fs'); const docs=fs.readFileSync('k8s/base/discord-bot.yaml','utf8').split(/^---$/m).map(d=>y.load(d)); const dep=docs.find(d=>d&&d.kind==='Deployment'); if(dep.spec.replicas!==1) throw new Error('replicas must stay 1 (single-writer premise for command registration)'); const env=dep.spec.template.spec.containers[0].env; const e=env.find(x=>x.name==='DISCORD_DEV_GUILD_ID'); if(!e) throw new Error('env missing'); if(e.valueFrom.secretKeyRef.optional!==true) throw new Error('optional must be true'); console.log('OK replicas=1', JSON.stringify(e));"`
Expected: 印出 `OK replicas=1 {...}`（確認 `replicas: 1` 仍成立——這是命令註冊單一寫入者前提——且 env 存在並帶 `optional: true`）。若 `js-yaml` 不可用，直接 `Read` 該檔目視確認 `replicas: 1`、env 結構與縮排正確。

- [ ] **Step 3: Commit**

```bash
git add k8s/base/discord-bot.yaml
git commit -m "feat(k8s): inject optional DISCORD_DEV_GUILD_ID into discord-bot"
```

---

## 最終整體驗證

- [ ] **Step 1: 全量型別檢查 + lint + 測試**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: 全部通過。

- [ ] **Step 2: 部署前置條件提醒（非程式碼）**

提醒操作者於正式部署前：(a) 在 Discord Developer Portal → Installation 啟用 **User Install** context 且 Default Install Settings 的 scope 含 `applications.commands`（否則含 `[UserInstall]` 的 global `PUT` 會驗證失敗、fail-fast 導致 rollout 卡住）；(b) 在 `honeybee-secrets` 加入 `DISCORD_DEV_GUILD_ID=543454386873958411`（未加則 mod 指令不註冊且守衛全拒）。
