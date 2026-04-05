/// <reference types="jest" />
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import ChannelModel from "./Channel";

describe("Channel.waitForCrawl", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("returns document immediately when crawledAt is already set", async () => {
    const doc = { id: "UC123", name: "Real Name", crawledAt: new Date() } as any;
    const spy = jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue(doc);

    const result = await ChannelModel.waitForCrawl("UC123");

    expect(result).toBe(doc);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("polls with backoff until crawledAt appears", async () => {
    const uncrawled = { id: "UC123", name: "Unknown channel", crawledAt: null } as any;
    const crawled = { id: "UC123", name: "Real Name", crawledAt: new Date() } as any;
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValueOnce(uncrawled)
      .mockResolvedValueOnce(uncrawled)
      .mockResolvedValueOnce(crawled);

    const promise = ChannelModel.waitForCrawl("UC123");
    // Poll 1 happens immediately; then wait 5s, poll 2; wait 10s, poll 3 returns crawled
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(10_000);

    const result = await promise;
    expect(result).toBe(crawled);
  });

  it("returns last snapshot with crawledAt null on timeout", async () => {
    const uncrawled = { id: "UC123", name: "Unknown channel", crawledAt: null } as any;
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(uncrawled);

    const promise = ChannelModel.waitForCrawl("UC123", { timeoutMs: 20_000 });
    await jest.advanceTimersByTimeAsync(25_000);

    const result = await promise;
    expect(result).toBe(uncrawled);
    expect(result?.crawledAt).toBeNull();
  });

  it("returns null when document never exists", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(null);

    const promise = ChannelModel.waitForCrawl("UC123", { timeoutMs: 20_000 });
    await jest.advanceTimersByTimeAsync(25_000);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("throws on abort signal", async () => {
    const uncrawled = { id: "UC123", name: "Unknown channel", crawledAt: null } as any;
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(uncrawled);
    const controller = new AbortController();

    const promise = ChannelModel.waitForCrawl("UC123", { signal: controller.signal });
    controller.abort();
    await jest.advanceTimersByTimeAsync(6_000);

    await expect(promise).rejects.toThrow(/abort/i);
  });
});
