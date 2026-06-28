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
