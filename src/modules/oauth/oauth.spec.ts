/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import ChannelModel from "../../models/Channel.js";
import YoutubeDmBindingModel, {
  BindingLimitError,
  BindingTransformPendingError,
} from "../../models/YoutubeDmBinding.js";
import { OAuthModule } from "./oauth.js";
import { IdentityMismatchError } from "./provider.js";

function fakeReply() {
  return {
    code: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as any;
}

function setup(opts: { redisSeed?: [string, string][] } = {}) {
  const store = new Map<string, string>(opts.redisSeed ?? []);
  const redis = {
    set: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve("OK" as const);
    }),
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    del: jest.fn((k: string) => Promise.resolve(store.delete(k) ? 1 : 0)),
  };
  const routes: Record<string, any> = {};
  const app = {
    http: { server: { get: jest.fn((p: string, h: any) => (routes[p] = h)) } },
    get: jest.fn((name: string) => (name === "redis" ? { redis } : undefined)),
  } as any;
  const send = jest.fn(() => Promise.resolve(undefined));
  const client = {
    users: { fetch: jest.fn(() => Promise.resolve({ send })) },
  } as any;
  return { app, client, redis, store, routes, send };
}

const GOOGLE = "/oauth/youtube-dm/google/callback";

describe("OAuthModule", () => {
  afterEach(() => jest.restoreAllMocks());

  it("registers both callback routes in the constructor", () => {
    const { app, client, routes } = setup();
    new OAuthModule(app, client);
    expect(Object.keys(routes).sort()).toEqual([
      "/oauth/youtube-dm/discord/callback",
      GOOGLE,
    ]);
  });

  it("throws in the constructor when RedisModule is missing", () => {
    const { client } = setup();
    const app = {
      http: { server: { get: jest.fn() } },
      get: jest.fn(() => undefined),
    } as any;
    expect(() => new OAuthModule(app, client)).toThrow(/RedisModule/);
  });

  it("beginAuth stores state and returns the provider auth url", async () => {
    const { app, client, redis } = setup();
    const mod = new OAuthModule(app, client);
    const url = await mod.beginAuth("google", "d1");
    const [key, value] = redis.set.mock.calls[0] as [string, string];
    expect(key).toMatch(/^youtube-dm-oauth:/);
    expect(JSON.parse(value)).toEqual({
      discordUserId: "d1",
      method: "google",
    });
    expect(url).toContain("accounts.google.com");
  });

  it("callback rejects when code is missing without consuming state", async () => {
    const { app, client, routes, redis } = setup();
    new OAuthModule(app, client);
    const reply = fakeReply();
    await routes[GOOGLE]({ query: { state: "st1" } }, reply);
    expect(redis.del).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(400);
  });

  it("google callback: success + DM delivered → 200 with full channel list", async () => {
    const { app, client, routes, redis } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "google" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest
      .spyOn(mod.google, "listChannels")
      .mockResolvedValue([{ channelId: "UCa", title: "A" }]);
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCold", "UCa"] } as any);
    const dm = jest.spyOn(mod, "sendBindingDm").mockResolvedValue(true);
    const reply = fakeReply();

    await routes[GOOGLE]({ query: { code: "c1", state: "st1" } }, reply);

    expect(redis.del).toHaveBeenCalledWith("youtube-dm-oauth:st1");
    expect(dm).toHaveBeenCalledWith("d1", ["UCold", "UCa"]);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.stringContaining("已私訊你頻道清單")
    );
  });

  it("google callback: DM undeliverable → 200 with open-DM hint", async () => {
    const { app, client, routes } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "google" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest
      .spyOn(mod.google, "listChannels")
      .mockResolvedValue([{ channelId: "UCa", title: "A" }]);
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    jest.spyOn(mod, "sendBindingDm").mockResolvedValue(false);
    const reply = fakeReply();

    await routes[GOOGLE]({ query: { code: "c1", state: "st1" } }, reply);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.stringContaining("無法私訊你")
    );
  });

  it("google callback: BindingLimitError → 400 and no DM", async () => {
    const { app, client, routes } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "google" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest
      .spyOn(mod.google, "listChannels")
      .mockResolvedValue([{ channelId: "UCa", title: "A" }]);
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockRejectedValue(new BindingLimitError("limit"));
    const dm = jest.spyOn(mod, "sendBindingDm");
    const reply = fakeReply();

    await routes[GOOGLE]({ query: { code: "c1", state: "st1" } }, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(dm).not.toHaveBeenCalled();
  });

  it("google callback: empty channel list → 400 with the provider message", async () => {
    const { app, client, routes } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "google" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest.spyOn(mod.google, "listChannels").mockResolvedValue([]);
    const reply = fakeReply();

    await routes[GOOGLE]({ query: { code: "c1", state: "st1" } }, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.stringContaining("找不到可綁定")
    );
  });

  it("discord callback: identity mismatch → 403", async () => {
    const { app, client, routes } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "discord" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest
      .spyOn(mod.discord, "listChannels")
      .mockRejectedValue(new IdentityMismatchError());
    const reply = fakeReply();

    await routes["/oauth/youtube-dm/discord/callback"](
      { query: { code: "c1", state: "st1" } },
      reply
    );

    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("google callback: saved-pending + DM delivered → 200 saved-pending copy", async () => {
    const { app, client, routes } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "google" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest
      .spyOn(mod.google, "listChannels")
      .mockResolvedValue([{ channelId: "UCa", title: "A" }]);
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockRejectedValue(new BindingTransformPendingError("db down"));
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    const dm = jest.spyOn(mod, "sendBindingDm").mockResolvedValue(true);
    const reply = fakeReply();

    await routes[GOOGLE]({ query: { code: "c1", state: "st1" } }, reply);

    expect(dm).toHaveBeenCalledWith("d1", ["UCa"]);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(expect.stringContaining("已儲存"));
  });

  it("google callback: pre-write error → 500 and no DM", async () => {
    const { app, client, routes } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "google" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest
      .spyOn(mod.google, "listChannels")
      .mockResolvedValue([{ channelId: "UCa", title: "A" }]);
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockRejectedValue(new Error("write failed"));
    const dm = jest.spyOn(mod, "sendBindingDm");
    const reply = fakeReply();

    await routes[GOOGLE]({ query: { code: "c1", state: "st1" } }, reply);

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(dm).not.toHaveBeenCalled();
  });

  it("google callback: seeds only channels not already present", async () => {
    const { app, client, routes } = setup({
      redisSeed: [
        [
          "youtube-dm-oauth:st1",
          JSON.stringify({ discordUserId: "d1", method: "google" }),
        ],
      ],
    });
    const mod = new OAuthModule(app, client);
    jest.spyOn(mod.google, "listChannels").mockResolvedValue([
      { channelId: "UCnew", title: "New" },
      { channelId: "UCold", title: "Old" },
    ]);
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation(((id: string) =>
        Promise.resolve(id === "UCold" ? {} : null)) as any);
    const create = jest
      .spyOn(ChannelModel, "create")
      .mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "bindChannels")
      .mockResolvedValue({} as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCnew", "UCold"] } as any);
    jest.spyOn(mod, "sendBindingDm").mockResolvedValue(true);
    const reply = fakeReply();

    await routes[GOOGLE]({ query: { code: "c1", state: "st1" } }, reply);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ id: "UCnew", name: "New" });
  });

  it("sendBindingDm returns true on success, false (no warn) on 50007, false (warn) otherwise", async () => {
    const { app, client, send } = setup();
    const mod = new OAuthModule(app, client);
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(null as any);

    expect(await mod.sendBindingDm("d1", [])).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);

    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    send.mockRejectedValueOnce({ code: 50007 });
    expect(await mod.sendBindingDm("d1", [])).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    send.mockRejectedValueOnce(new Error("boom"));
    expect(await mod.sendBindingDm("d1", [])).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
