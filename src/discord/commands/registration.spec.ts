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
