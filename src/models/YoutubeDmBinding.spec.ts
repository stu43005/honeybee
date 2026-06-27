/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import WebhookModel from "./Webhook.js";
import YoutubeDmBindingModel, {
  BindingLimitError,
  BindingTransformPendingError,
} from "./YoutubeDmBinding.js";

describe("YoutubeDmBinding statics", () => {
  afterEach(() => jest.restoreAllMocks());

  it("bindChannels adds genuinely-new ids and runs transform (webhook upserted)", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    const updated = {
      _id: "x",
      discordUserId: "d1",
      channelIds: ["UCa", "UCb"],
    };
    const fou = jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(updated as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findById")
      .mockResolvedValue(updated as any);
    const updateOne = jest
      .spyOn(WebhookModel, "updateOne")
      .mockResolvedValue({} as any);

    const result = await YoutubeDmBindingModel.bindChannels("d1", ["UCb"]);

    expect(fou).toHaveBeenCalledWith(
      { discordUserId: "d1" },
      { $addToSet: { channelIds: { $each: ["UCb"] } } },
      { upsert: true, new: true }
    );
    expect(updateOne).toHaveBeenCalledTimes(1); // transform ran
    expect(result).toBe(updated);
  });

  it("bindChannels throws BindingLimitError when genuinely-new ids exceed the cap", async () => {
    jest.spyOn(YoutubeDmBindingModel, "findOne").mockResolvedValue({
      channelIds: Array.from({ length: 10 }, (_, i) => `UC${i}`),
    } as any);
    const fou = jest.spyOn(YoutubeDmBindingModel, "findOneAndUpdate");
    const updateOne = jest.spyOn(WebhookModel, "updateOne");

    await expect(
      YoutubeDmBindingModel.bindChannels("d1", ["UCnew"])
    ).rejects.toBeInstanceOf(BindingLimitError);
    expect(fou).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("bindChannels ignores already-bound ids against the cap", async () => {
    jest.spyOn(YoutubeDmBindingModel, "findOne").mockResolvedValue({
      channelIds: Array.from({ length: 10 }, (_, i) => `UC${i}`),
    } as any);
    const updated = { _id: "x", discordUserId: "d1", channelIds: ["UC0"] };
    jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(updated as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findById")
      .mockResolvedValue(updated as any);
    jest.spyOn(WebhookModel, "updateOne").mockResolvedValue({} as any);

    await expect(
      YoutubeDmBindingModel.bindChannels("d1", ["UC0"])
    ).resolves.toBe(updated);
  });

  it("reclassifies a post-write transform failure as BindingTransformPendingError", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: [] } as any);
    const updated = { _id: "x", discordUserId: "d1", channelIds: ["UCa"] };
    jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(updated as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findById")
      .mockResolvedValue(updated as any);
    jest
      .spyOn(WebhookModel, "updateOne")
      .mockRejectedValue(new Error("db down"));

    await expect(
      YoutubeDmBindingModel.bindChannels("d1", ["UCa"])
    ).rejects.toBeInstanceOf(BindingTransformPendingError);
  });

  it("lets a pre-write failure propagate as a generic error (transform never runs)", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: [] } as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockRejectedValue(new Error("write failed"));
    const updateOne = jest.spyOn(WebhookModel, "updateOne");

    await expect(
      YoutubeDmBindingModel.bindChannels("d1", ["UCa"])
    ).rejects.toThrow("write failed");
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("unbindChannel is a no-op when no binding exists", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(null as any);
    const findById = jest.spyOn(YoutubeDmBindingModel, "findById");

    const result = await YoutubeDmBindingModel.unbindChannel("d1", "UCa");

    expect(result).toBeNull();
    expect(findById).not.toHaveBeenCalled(); // transform not invoked
  });

  it("unbindChannel pulls the id and runs transform (empty -> webhook deleted)", async () => {
    const updated = { _id: "x", discordUserId: "d1", channelIds: [] };
    const fou = jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(updated as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findById")
      .mockResolvedValue(updated as any);
    const deleteMany = jest
      .spyOn(WebhookModel, "deleteMany")
      .mockResolvedValue({} as any);

    await YoutubeDmBindingModel.unbindChannel("d1", "UCa");

    expect(fou).toHaveBeenCalledWith(
      { discordUserId: "d1" },
      { $pull: { channelIds: "UCa" } },
      { new: true }
    );
    expect(deleteMany).toHaveBeenCalledTimes(1); // empty channelIds -> webhook deleted
  });

  it("unbindAll clears channelIds and deletes the webhook", async () => {
    const updated = { _id: "x", discordUserId: "d1", channelIds: [] };
    const fou = jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(updated as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findById")
      .mockResolvedValue(updated as any);
    const deleteMany = jest
      .spyOn(WebhookModel, "deleteMany")
      .mockResolvedValue({} as any);

    await YoutubeDmBindingModel.unbindAll("d1");

    expect(fou).toHaveBeenCalledWith(
      { discordUserId: "d1" },
      { $set: { channelIds: [] } },
      { new: true }
    );
    expect(deleteMany).toHaveBeenCalledTimes(1); // empty channelIds -> webhook deleted
  });

  it("unbindAll is a no-op when no binding exists", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOneAndUpdate")
      .mockResolvedValue(null as any);
    const findById = jest.spyOn(YoutubeDmBindingModel, "findById");

    await YoutubeDmBindingModel.unbindAll("d1");

    expect(findById).not.toHaveBeenCalled();
  });

  it("de-dupes channels via $addToSet (stateful fake)", async () => {
    const channelIds: string[] = ["UCa"];
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockImplementation((() =>
        Promise.resolve({ channelIds: [...channelIds] })) as any);
    jest.spyOn(YoutubeDmBindingModel, "findOneAndUpdate").mockImplementation(((
      _filter: any,
      update: any
    ) => {
      const each = update.$addToSet.channelIds.$each as string[];
      for (const id of each) {
        if (!channelIds.includes(id)) channelIds.push(id);
      }
      return Promise.resolve({
        _id: "x",
        discordUserId: "d1",
        channelIds: [...channelIds],
      });
    }) as any);
    jest.spyOn(YoutubeDmBindingModel, "findById").mockImplementation((() =>
      Promise.resolve({
        _id: "x",
        discordUserId: "d1",
        channelIds: [...channelIds],
      })) as any);
    jest.spyOn(WebhookModel, "updateOne").mockResolvedValue({} as any);

    await YoutubeDmBindingModel.bindChannels("d1", ["UCa", "UCb"]); // UCa dup, UCb new

    expect(channelIds).toEqual(["UCa", "UCb"]); // no duplicate UCa
  });
});
