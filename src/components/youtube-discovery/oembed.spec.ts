/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";

const mockGet = jest.fn<(url: string, config: unknown) => Promise<unknown>>();

jest.unstable_mockModule("axios", () => ({
  default: { get: mockGet },
}));

const { probeVideo, probePlaylist } = await import("./oembed.js");
const { YOUTUBE_OEMBED_TIMEOUT_MS } = await import("../../constants.js");

describe("oEmbed probing", () => {
  afterEach(() => {
    mockGet.mockReset();
  });

  it("percent-encodes the target url inside the query string", async () => {
    mockGet.mockResolvedValue({ status: 200, data: { title: "x" } });

    await probeVideo("dQw4w9WgXcQ");

    const [url, config] = mockGet.mock.calls[0] as [
      string,
      { timeout: number; validateStatus: (status: number) => boolean },
    ];
    // The inner "?v=" must be encoded, otherwise YouTube sees a truncated url
    // parameter and the probe answers about the wrong thing.
    expect(url).toBe(
      "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json"
    );
    expect(config.timeout).toBe(YOUTUBE_OEMBED_TIMEOUT_MS);
    // Every status resolves, so one place classifies them all.
    expect(config.validateStatus(404)).toBe(true);
  });

  it("builds the playlist url from the playlist id", async () => {
    mockGet.mockResolvedValue({ status: 200, data: { title: "x" } });

    await probePlaylist("UUMOabc");

    expect(mockGet.mock.calls[0]?.[0]).toBe(
      "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fplaylist%3Flist%3DUUMOabc&format=json"
    );
  });

  it("reads 200 as present", async () => {
    mockGet.mockResolvedValue({ status: 200, data: { title: "x" } });

    await expect(probeVideo("abc")).resolves.toEqual({ kind: "present" });
  });

  it("does not read a non-200 success as present", async () => {
    // axios resolves for every 2xx, but only 200 was ever observed from this
    // endpoint and only 200 means the target is really there. Treating a 204 as
    // presence would resurrect a video or grant a seven-day positive verdict on
    // no evidence.
    mockGet.mockResolvedValue({ status: 204, data: "" });

    const result = await probeVideo("abc");

    expect(result.kind).toBe("unknown");
  });

  it("reads 404 as absent", async () => {
    mockGet.mockResolvedValue({ status: 404, data: "Not Found" });

    await expect(probeVideo("abc")).resolves.toEqual({ kind: "absent" });
  });

  it("reads 400 as a separate invalid-id answer, not as absent", async () => {
    mockGet.mockResolvedValue({ status: 400, data: "Bad Request" });

    // 400 means the id itself is malformed. Its two callers need different
    // things from that: the video probe treats it as unreachable, while the
    // membership probe must not turn it into a lasting "no memberships"
    // verdict.
    await expect(probeVideo("!!!")).resolves.toEqual({ kind: "invalid" });
  });

  it("reads any other status as inconclusive rather than absent", async () => {
    mockGet.mockResolvedValue({ status: 503, data: "" });

    const result = await probeVideo("abc");

    expect(result.kind).toBe("unknown");
  });

  it("reads a transport failure as inconclusive", async () => {
    mockGet.mockRejectedValue(new Error("socket hang up"));

    const result = await probeVideo("abc");

    expect(result).toEqual({ kind: "unknown", message: "socket hang up" });
  });

  it("classifies playlist answers on the same four outcomes", async () => {
    mockGet.mockResolvedValue({ status: 200, data: { title: "x" } });
    await expect(probePlaylist("UUMOabc")).resolves.toEqual({
      kind: "present",
    });

    mockGet.mockResolvedValue({ status: 404, data: "Not Found" });
    await expect(probePlaylist("UUMOabc")).resolves.toEqual({
      kind: "absent",
    });

    mockGet.mockResolvedValue({ status: 400, data: "Bad Request" });
    await expect(probePlaylist("UUMOabc")).resolves.toEqual({
      kind: "invalid",
    });
  });
});
