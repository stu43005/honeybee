/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { commands } from "./index.js";
import {
  isDevGuildCommandAllowed,
  partitionCommandsByScope,
} from "./registration.js";

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
