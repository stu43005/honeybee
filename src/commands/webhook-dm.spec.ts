/// <reference types="jest" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import YoutubeDmBindingModel from "../models/YoutubeDmBinding.js";
import WebhookResultModel from "../models/WebhookResult.js";
import { dmChannelCache, dmRest, sendDiscordDm } from "./webhook.js";

const resultId = { webhookId: "w1", coll: "superchats", docId: "d1" };
const webhook = { followUpdate: false } as any;

function consentReturns(channelIds: string[]) {
  jest.spyOn(YoutubeDmBindingModel, "findOne").mockReturnValue({
    setOptions: () => Promise.resolve({ channelIds }),
  } as any);
}

describe("sendDiscordDm", () => {
  beforeEach(() => {
    jest.spyOn(WebhookResultModel, "updateOne").mockResolvedValue({} as any);
  });
  afterEach(() => jest.restoreAllMocks());

  it("skips send when channel is no longer bound (consent)", async () => {
    consentReturns(["UCb"]);
    const request = jest.spyOn(dmRest, "request");

    await sendDiscordDm(
      "discord-dm://discord-1",
      "UCa",
      { embeds: [{ title: "x" }] },
      webhook,
      resultId
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("creates a DM channel and sends embeds when consented", async () => {
    consentReturns(["UCa"]);
    jest.spyOn(dmChannelCache, "wrap").mockResolvedValue("dm-chan-1");
    const request = jest
      .spyOn(dmRest, "request")
      .mockResolvedValue({ id: "msg-1" } as any);

    await sendDiscordDm(
      "discord-dm://discord-1",
      "UCa",
      { embeds: [{ title: "x" }] },
      webhook,
      resultId
    );

    expect(request).toHaveBeenCalledTimes(1);
    const arg = (request.mock.calls[0] as any)[0];
    expect(arg.method).toBe("POST");
    expect(arg.body).toEqual({ embeds: [{ title: "x" }] });
    expect(arg.auth).toBe(true);
  });

  it("clears the cached DM channel and rebuilds once on a 404 send", async () => {
    consentReturns(["UCa"]);
    jest
      .spyOn(dmChannelCache, "wrap")
      .mockResolvedValueOnce("stale-chan")
      .mockResolvedValueOnce("fresh-chan");
    const del = jest
      .spyOn(dmChannelCache, "del")
      .mockResolvedValue(true as any);
    const request = jest
      .spyOn(dmRest, "request")
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { status: 404 }))
      .mockResolvedValueOnce({ id: "msg-1" } as any);

    await sendDiscordDm(
      "discord-dm://discord-1",
      "UCa",
      { embeds: [{ title: "x" }] },
      webhook,
      resultId
    );

    expect(del).toHaveBeenCalledWith("dm-channel-discord-1");
    expect(request).toHaveBeenCalledTimes(2);
    // second attempt targets the rebuilt channel
    expect((request.mock.calls[1] as any)[0].fullRoute).toContain("fresh-chan");
  });

  it("records error and does NOT throw on 403", async () => {
    consentReturns(["UCa"]);
    jest.spyOn(dmChannelCache, "wrap").mockResolvedValue("dm-chan-1");
    jest
      .spyOn(dmRest, "request")
      .mockRejectedValue(
        Object.assign(new Error("forbidden"), { status: 403 })
      );
    const update = jest.spyOn(WebhookResultModel, "updateOne");

    await expect(
      sendDiscordDm(
        "discord-dm://discord-1",
        "UCa",
        { embeds: [{ title: "x" }] },
        webhook,
        resultId
      )
    ).resolves.toBeUndefined();

    const lastCall = update.mock.calls.at(-1) as any[];
    expect(lastCall[1].$set.statusCode).toBe(403);
  });

  it("rethrows on 5xx so bee-queue retries", async () => {
    consentReturns(["UCa"]);
    jest.spyOn(dmChannelCache, "wrap").mockResolvedValue("dm-chan-1");
    jest
      .spyOn(dmRest, "request")
      .mockRejectedValue(
        Object.assign(new Error("server error"), { status: 502 })
      );

    await expect(
      sendDiscordDm(
        "discord-dm://discord-1",
        "UCa",
        { embeds: [{ title: "x" }] },
        webhook,
        resultId
      )
    ).rejects.toThrow();
  });
});
