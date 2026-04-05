/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import ChannelModel from "./Channel";

describe("Channel.waitForCrawl", () => {
  const tinySchedule = [1, 1, 1, 1, 1, 1] as const;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns document immediately when crawledAt is already set", async () => {
    const doc = { id: "UC123", name: "Real Name", crawledAt: new Date() } as any;
    const spy = jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue(doc);

    const result = await ChannelModel.waitForCrawl("UC123", {
      backoffSchedule: tinySchedule,
    });

    expect(result).toBe(doc);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("polls with backoff until crawledAt appears", async () => {
    const uncrawled = {
      id: "UC123",
      name: "Unknown channel",
      crawledAt: null,
    } as any;
    const crawled = {
      id: "UC123",
      name: "Real Name",
      crawledAt: new Date(),
    } as any;
    const spy = jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValueOnce(uncrawled)
      .mockResolvedValueOnce(uncrawled)
      .mockResolvedValueOnce(crawled);

    const result = await ChannelModel.waitForCrawl("UC123", {
      backoffSchedule: tinySchedule,
    });

    expect(result).toBe(crawled);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("returns last snapshot with crawledAt null on timeout", async () => {
    const uncrawled = {
      id: "UC123",
      name: "Unknown channel",
      crawledAt: null,
    } as any;
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(uncrawled);

    const result = await ChannelModel.waitForCrawl("UC123", {
      timeoutMs: 20,
      backoffSchedule: tinySchedule,
    });

    expect(result).toBe(uncrawled);
    expect(result?.crawledAt).toBeNull();
  });

  it("returns null when document never exists", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(null);

    const result = await ChannelModel.waitForCrawl("UC123", {
      timeoutMs: 20,
      backoffSchedule: tinySchedule,
    });

    expect(result).toBeNull();
  });

  it("throws on abort signal", async () => {
    const uncrawled = {
      id: "UC123",
      name: "Unknown channel",
      crawledAt: null,
    } as any;
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(uncrawled);
    const controller = new AbortController();

    const promise = ChannelModel.waitForCrawl("UC123", {
      signal: controller.signal,
      backoffSchedule: [1000],
    });
    // Let the first findByChannelId resolve and the sleep begin
    await new Promise((r) => setImmediate(r));
    controller.abort();

    await expect(promise).rejects.toThrow(/abort/i);
  });
});
