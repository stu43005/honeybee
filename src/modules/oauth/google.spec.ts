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
    const result = await fetchGoogleChannels("code-1", () =>
      Promise.resolve([
        { id: "UCa", snippet: { title: "Chan A" } },
        { id: "UCb", snippet: { title: "Chan B" } },
      ] as any)
    );
    expect(result).toEqual([
      { channelId: "UCa", title: "Chan A" },
      { channelId: "UCb", title: "Chan B" },
    ]);
  });

  it("fetchGoogleChannels drops items without an id", async () => {
    const result = await fetchGoogleChannels("code-1", () =>
      Promise.resolve([
        { snippet: { title: "no id" } },
        { id: "UCb", snippet: {} },
      ] as any)
    );
    expect(result).toEqual([{ channelId: "UCb", title: "Unknown channel" }]);
  });
});
