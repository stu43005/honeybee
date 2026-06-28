/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import ChannelModel from "../../models/Channel.js";
import YoutubeDmBindingModel, {
  BindingLimitError,
  BindingTransformPendingError,
} from "../../models/YoutubeDmBinding.js";
import {
  applyBinding,
  handleDiscordCallback,
  handleGoogleCallback,
  type CallbackDeps,
} from "./callback.js";

function fakeReply() {
  return {
    code: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as any;
}

function deps(overrides: Partial<CallbackDeps> = {}): CallbackDeps {
  return {
    getOAuthState: jest.fn(() => Promise.resolve(null)),
    delOAuthState: jest.fn(() => Promise.resolve(undefined)),
    fetchGoogleChannels: jest.fn(() => Promise.resolve([])),
    exchangeDiscordCode: jest.fn(() => Promise.resolve("tok")),
    fetchDiscordUserId: jest.fn(() => Promise.resolve("d1")),
    fetchVerifiedYoutubeChannels: jest.fn(() => Promise.resolve([])),
    ...overrides,
  };
}

describe("oauth callback", () => {
  afterEach(() => jest.restoreAllMocks());

  it("google callback rejects when code is missing without consuming state", async () => {
    const d = deps();
    const reply = fakeReply();
    await handleGoogleCallback({ query: { state: "st1" } } as any, reply, d);
    expect(d.delOAuthState).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(400);
  });

  it("google callback binds all returned channels", async () => {
    const d = deps({
      getOAuthState: jest.fn(() =>
        Promise.resolve({
          discordUserId: "d1",
          method: "google" as const,
        })
      ),
      fetchGoogleChannels: jest.fn(() =>
        Promise.resolve([{ channelId: "UCa", title: "A" }])
      ),
    });
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(null as any);
    jest.spyOn(ChannelModel, "create").mockResolvedValue({} as any);
    const bind = jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockResolvedValue({} as any);
    const reply = fakeReply();

    await handleGoogleCallback(
      { query: { code: "c1", state: "st1" } } as any,
      reply,
      d
    );

    expect(d.delOAuthState).toHaveBeenCalledWith("st1");
    expect(bind).toHaveBeenCalledWith("d1", ["UCa"]);
    expect(reply.code).toHaveBeenCalledWith(200);
  });

  it("discord callback rejects when authorizer identity != state user", async () => {
    const d = deps({
      getOAuthState: jest.fn(() =>
        Promise.resolve({
          discordUserId: "d1",
          method: "discord" as const,
        })
      ),
      exchangeDiscordCode: jest.fn(() => Promise.resolve("tok")),
      fetchDiscordUserId: jest.fn(() => Promise.resolve("OTHER")),
    });
    const bind = jest.spyOn(YoutubeDmBindingModel, "bindChannels");
    const reply = fakeReply();

    await handleDiscordCallback(
      { query: { code: "c1", state: "st1" } } as any,
      reply,
      d
    );

    expect(bind).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("applyBinding maps BindingLimitError to a rejection page", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockRejectedValue(new BindingLimitError("limit"));
    const reply = fakeReply();

    await applyBinding("d1", [{ channelId: "UCa", title: "A" }], reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.stringContaining("超過上限")
    );
  });

  it("applyBinding maps BindingTransformPendingError to a saved-pending page", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockRejectedValue(new BindingTransformPendingError("db down"));
    const reply = fakeReply();

    await applyBinding("d1", [{ channelId: "UCa", title: "A" }], reply);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(expect.stringContaining("已儲存"));
  });

  it("applyBinding maps an unexpected (pre-write) error to a generic failure, NOT saved-pending", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockRejectedValue(new Error("write failed"));
    const reply = fakeReply();

    await applyBinding("d1", [{ channelId: "UCa", title: "A" }], reply);

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).not.toHaveBeenCalledWith(
      expect.stringContaining("已儲存")
    );
  });

  it("applyBinding maps success", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockResolvedValue({} as any);
    const reply = fakeReply();

    await applyBinding("d1", [{ channelId: "UCa", title: "A" }], reply);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.stringContaining("綁定成功")
    );
  });
});
