/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { GoogleProvider } from "./google.js";

describe("GoogleProvider", () => {
  afterEach(() => jest.restoreAllMocks());

  it("buildAuthUrl includes scope, state, access_type and redirect", () => {
    const u = new URL(new GoogleProvider().buildAuthUrl("st1"));
    expect(u.hostname).toContain("google.com");
    expect(u.searchParams.get("state")).toBe("st1");
    expect(u.searchParams.get("access_type")).toBe("online");
    expect(u.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.readonly"
    );
    expect(decodeURIComponent(u.toString())).toContain(
      "/oauth/youtube-dm/google/callback"
    );
  });

  it("listChannels maps every owned channel, dropping items without an id", async () => {
    const provider = new GoogleProvider();
    jest
      .spyOn(provider, "listOwnedChannels")
      .mockResolvedValue([
        { id: "UCa", snippet: { title: "Chan A" } },
        { snippet: { title: "no id" } },
        { id: "UCb", snippet: {} },
      ] as any);

    expect(
      await provider.listChannels("code-1", {
        discordUserId: "d1",
        method: "google",
      })
    ).toEqual([
      { channelId: "UCa", title: "Chan A" },
      { channelId: "UCb", title: "Unknown channel" },
    ]);
  });
});
