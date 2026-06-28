/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionsBitField,
} from "discord.js";
import type { AppCommand } from "./command.js";
import { CrawlCommand } from "./mod/crawl.js";
import { SetChannelCommand } from "./mod/set-channel.js";
import { SetVideoCommand } from "./mod/set-video.js";
import { TrackCommand } from "./track/track.js";
import { YoutubeDmCommand } from "./youtube-dm/youtube-dm.js";
import {
  isDevGuildCommandAllowed,
  partitionCommandsByScope,
} from "./registration.js";

const commands: AppCommand[] = [
  new CrawlCommand(),
  new SetChannelCommand(),
  new SetVideoCommand(),
  new TrackCommand(),
  new YoutubeDmCommand({ beginAuth: async () => "" }),
].sort((a, b) => (a.metadata.name > b.metadata.name ? 1 : -1));

describe("partitionCommandsByScope", () => {
  it("splits mod commands into devGuild and the rest into global, preserving input order", () => {
    const { global, devGuild } = partitionCommandsByScope(commands);
    // the fixture above is sorted by name; partition preserves that order.
    // Assert exact ordered arrays (no sort) to verify both membership AND order.
    expect(devGuild.map((c) => c.metadata.name)).toEqual([
      "crawl",
      "set-channel",
      "set-video",
    ]);
    expect(global.map((c) => c.metadata.name)).toEqual(["track", "youtube-dm"]);
  });
});

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
