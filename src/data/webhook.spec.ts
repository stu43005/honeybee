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
