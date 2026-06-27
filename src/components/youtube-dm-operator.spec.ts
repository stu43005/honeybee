/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mongo } from "mongoose";
import WebhookModel from "../models/Webhook.js";
import YoutubeDmBindingModel from "../models/YoutubeDmBinding.js";
import {
  transformYoutubeDmBinding,
  transformYoutubeDmBindings,
} from "./youtube-dm-operator.js";

describe("transformYoutubeDmBinding", () => {
  afterEach(() => jest.restoreAllMocks());

  it("upserts one webhook with the expected colls/match/insertUrl/ref", async () => {
    const id = new mongo.BSON.ObjectId();
    jest.spyOn(YoutubeDmBindingModel, "findById").mockResolvedValue({
      _id: id,
      discordUserId: "discord-1",
      channelIds: ["UCa", "UCb"],
    } as any);
    const updateOne = jest
      .spyOn(WebhookModel, "updateOne")
      .mockResolvedValue({} as any);
    const deleteMany = jest
      .spyOn(WebhookModel, "deleteMany")
      .mockResolvedValue({} as any);

    await transformYoutubeDmBinding({ _id: id } as any);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = updateOne.mock.calls[0] as any[];
    expect(filter).toEqual({ youtubeDmBinding: id });
    expect(update.$set).toMatchObject({
      colls: [
        "superchats",
        "superstickers",
        "memberships",
        "milestones",
        "membershipgiftpurchases",
        "membershipgifts",
      ],
      match: { authorChannelId: { $in: ["UCa", "UCb"] } },
      templatePreset: "discord-embed-chats",
      insertUrl: "discord-dm://discord-1",
      youtubeDmBinding: id,
      enabled: true,
    });
    expect(options).toMatchObject({ upsert: true });
  });

  it("uses a single id directly (not $in) for one channel", async () => {
    const id = new mongo.BSON.ObjectId();
    jest.spyOn(YoutubeDmBindingModel, "findById").mockResolvedValue({
      _id: id,
      discordUserId: "discord-1",
      channelIds: ["UCa"],
    } as any);
    const updateOne = jest
      .spyOn(WebhookModel, "updateOne")
      .mockResolvedValue({} as any);

    await transformYoutubeDmBinding({ _id: id } as any);

    const [, update] = updateOne.mock.calls[0] as any[];
    expect(update.$set.match).toEqual({ authorChannelId: "UCa" });
  });

  it("deletes the webhook when the binding has no channels", async () => {
    const id = new mongo.BSON.ObjectId();
    jest.spyOn(YoutubeDmBindingModel, "findById").mockResolvedValue({
      _id: id,
      discordUserId: "discord-1",
      channelIds: [],
    } as any);
    const updateOne = jest.spyOn(WebhookModel, "updateOne");
    const deleteMany = jest
      .spyOn(WebhookModel, "deleteMany")
      .mockResolvedValue({} as any);

    await transformYoutubeDmBinding({ _id: id } as any);

    expect(updateOne).not.toHaveBeenCalled();
    expect(deleteMany).toHaveBeenCalledWith({ youtubeDmBinding: id });
  });

  it("deletes the webhook when the binding no longer exists", async () => {
    const id = new mongo.BSON.ObjectId();
    jest
      .spyOn(YoutubeDmBindingModel, "findById")
      .mockResolvedValue(null as any);
    const deleteMany = jest
      .spyOn(WebhookModel, "deleteMany")
      .mockResolvedValue({} as any);

    await transformYoutubeDmBinding({ _id: id } as any);

    expect(deleteMany).toHaveBeenCalledWith({ youtubeDmBinding: id });
  });

  it("converges on the latest binding even when invoked with a stale snapshot", async () => {
    const id = new mongo.BSON.ObjectId();
    // Current DB state already had channel "UCa" removed by a concurrent unbind.
    jest.spyOn(YoutubeDmBindingModel, "findById").mockResolvedValue({
      _id: id,
      discordUserId: "discord-1",
      channelIds: ["UCb"],
    } as any);
    const updateOne = jest
      .spyOn(WebhookModel, "updateOne")
      .mockResolvedValue({} as any);

    // Invoke transform with a STALE snapshot that still lists "UCa".
    await transformYoutubeDmBinding({
      _id: id,
      discordUserId: "discord-1",
      channelIds: ["UCa", "UCb"],
    } as any);

    // The webhook match reflects the re-read current binding (UCb only), not the
    // stale snapshot — the older transform cannot resurrect the removed channel.
    const [, update] = updateOne.mock.calls[0] as any[];
    expect(update.$set.match).toEqual({ authorChannelId: "UCb" });
  });
});

describe("transformYoutubeDmBindings sweep", () => {
  afterEach(() => jest.restoreAllMocks());

  it("orphan cleanup pipeline only selects ObjectId-ref DM webhooks with no binding", async () => {
    const orphanId = new mongo.BSON.ObjectId();
    jest.spyOn(YoutubeDmBindingModel, "find").mockReturnValue([] as any);
    const aggregate = jest
      .spyOn(WebhookModel, "aggregate")
      .mockReturnValue([{ _id: orphanId }] as any);
    const deleteOne = jest
      .spyOn(WebhookModel, "deleteOne")
      .mockResolvedValue({} as any);

    await transformYoutubeDmBindings();

    expect(aggregate.mock.calls[0][0]).toEqual([
      { $match: { youtubeDmBinding: { $type: "objectId" } } },
      {
        $lookup: {
          from: "youtubeDmBindings",
          localField: "youtubeDmBinding",
          foreignField: "_id",
          as: "bindingDoc",
        },
      },
      { $match: { bindingDoc: { $size: 0 } } },
    ]);
    expect(deleteOne).toHaveBeenCalledTimes(1);
    expect(deleteOne).toHaveBeenCalledWith({ _id: orphanId });
  });

  it("does not delete anything when there are no orphans", async () => {
    jest.spyOn(YoutubeDmBindingModel, "find").mockReturnValue([] as any);
    jest.spyOn(WebhookModel, "aggregate").mockReturnValue([] as any);
    const deleteOne = jest.spyOn(WebhookModel, "deleteOne");

    await transformYoutubeDmBindings();

    expect(deleteOne).not.toHaveBeenCalled();
  });

  it("sweep re-derives the webhook for an existing binding (pending recovery)", async () => {
    const id = new mongo.BSON.ObjectId();
    const binding = { _id: id, discordUserId: "d1", channelIds: ["UCa"] };
    jest.spyOn(YoutubeDmBindingModel, "find").mockReturnValue([binding] as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findById")
      .mockResolvedValue(binding as any);
    jest.spyOn(WebhookModel, "aggregate").mockReturnValue([] as any);
    const updateOne = jest
      .spyOn(WebhookModel, "updateOne")
      .mockResolvedValue({} as any);

    await transformYoutubeDmBindings();

    expect(updateOne).toHaveBeenCalledTimes(1);
    expect((updateOne.mock.calls[0] as any[])[0]).toEqual({
      youtubeDmBinding: id,
    });
  });
});
