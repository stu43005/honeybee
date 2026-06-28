/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import axios from "axios";
import { DiscordProvider } from "./discord.js";
import { IdentityMismatchError } from "./provider.js";

describe("DiscordProvider", () => {
  afterEach(() => jest.restoreAllMocks());

  it("buildAuthUrl includes scope, state and redirect", () => {
    const u = new URL(new DiscordProvider().buildAuthUrl("st1"));
    expect(u.hostname).toBe("discord.com");
    expect(u.searchParams.get("state")).toBe("st1");
    expect(u.searchParams.get("scope")).toBe("identify connections");
    expect(u.searchParams.get("redirect_uri")).toContain(
      "/oauth/youtube-dm/discord/callback"
    );
  });

  it("listChannels returns verified youtube connections when identity matches", async () => {
    const provider = new DiscordProvider();
    jest
      .spyOn(axios, "post")
      .mockResolvedValue({ data: { access_token: "tok-1" } } as any);
    jest
      .spyOn(axios, "get")
      .mockResolvedValueOnce({ data: { id: "d1" } } as any)
      .mockResolvedValueOnce({
        data: [
          { type: "youtube", id: "UCa", name: "Chan A", verified: true },
          { type: "youtube", id: "UCb", name: "Chan B", verified: false },
          { type: "twitch", id: "tw1", name: "T", verified: true },
        ],
      } as any);

    expect(
      await provider.listChannels("code-1", {
        discordUserId: "d1",
        method: "discord",
      })
    ).toEqual([{ channelId: "UCa", title: "Chan A" }]);
  });

  it("listChannels throws IdentityMismatchError when authorizer != state user", async () => {
    const provider = new DiscordProvider();
    jest
      .spyOn(axios, "post")
      .mockResolvedValue({ data: { access_token: "tok-1" } } as any);
    jest
      .spyOn(axios, "get")
      .mockResolvedValue({ data: { id: "OTHER" } } as any);

    await expect(
      provider.listChannels("code-1", {
        discordUserId: "d1",
        method: "discord",
      })
    ).rejects.toBeInstanceOf(IdentityMismatchError);
  });
});
