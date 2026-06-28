/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { ApplicationIntegrationType } from "discord.js";
import ChannelModel from "../../../models/Channel.js";
import YoutubeDmBindingModel from "../../../models/YoutubeDmBinding.js";
import { initOAuthStateStore } from "../../../modules/oauth/state-store.js";
import { YoutubeDmCommand } from "./youtube-dm.js";

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    set: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve("OK" as const);
    }),
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    del: jest.fn((k: string) => Promise.resolve(store.delete(k) ? 1 : 0)),
  };
}

function intr(opts: {
  subcommand: string;
  optionValues?: Record<string, string>;
  owners?: Partial<Record<ApplicationIntegrationType, string>>;
}) {
  return {
    id: "i1",
    user: { id: "d1" },
    client: { application: { id: "app123" } },
    authorizingIntegrationOwners: opts.owners ?? {
      [ApplicationIntegrationType.UserInstall]: "d1",
    },
    options: {
      getSubcommand: () => opts.subcommand,
      getString: (name: string) => opts.optionValues?.[name] ?? null,
    },
    reply: jest.fn(() => Promise.resolve(undefined)),
    followUp: jest.fn(() => Promise.resolve(undefined)),
  } as any;
}

describe("YoutubeDmCommand", () => {
  afterEach(() => jest.restoreAllMocks());

  it("bind stores state (via the real store) and replies with an auth link", async () => {
    const redis = fakeRedis();
    initOAuthStateStore(redis as any);
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: [] } as any);
    const cmd = new YoutubeDmCommand();
    const i = intr({ subcommand: "bind", optionValues: { method: "google" } });

    await cmd.execute(i);

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value] = redis.set.mock.calls[0] as [string, string];
    expect(key).toMatch(/^youtube-dm-oauth:/);
    expect(JSON.parse(value)).toEqual({
      discordUserId: "d1",
      method: "google",
    });
    const arg = i.reply.mock.calls[0][0];
    expect(arg.content).toContain("accounts.google.com");
  });

  it("bind at the cap rejects without creating state", async () => {
    const redis = fakeRedis();
    initOAuthStateStore(redis as any);
    jest.spyOn(YoutubeDmBindingModel, "findOne").mockResolvedValue({
      channelIds: Array.from({ length: 10 }, (_, n) => `UC${n}`),
    } as any);
    const cmd = new YoutubeDmCommand();
    const i = intr({ subcommand: "bind", optionValues: { method: "google" } });

    await cmd.execute(i);

    expect(redis.set).not.toHaveBeenCalled();
    const arg = i.reply.mock.calls[0][0];
    expect(arg.content).toContain("上限");
  });

  it("unbind all clears the user's binding", async () => {
    const unbindAll = jest
      .spyOn(YoutubeDmBindingModel, "unbindAll")
      .mockResolvedValue({} as any);
    const cmd = new YoutubeDmCommand();
    await cmd.execute(
      intr({ subcommand: "unbind", optionValues: { channel: "all" } })
    );
    expect(unbindAll).toHaveBeenCalledWith("d1");
  });

  it("unbind <id> removes one channel", async () => {
    const unbind = jest
      .spyOn(YoutubeDmBindingModel, "unbindChannel")
      .mockResolvedValue({} as any);
    const cmd = new YoutubeDmCommand();
    await cmd.execute(
      intr({ subcommand: "unbind", optionValues: { channel: "UCa" } })
    );
    expect(unbind).toHaveBeenCalledWith("d1", "UCa");
  });

  it("list shows the user's channels with names", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue({ name: "Chan A" } as any);
    const cmd = new YoutubeDmCommand();
    const i = intr({ subcommand: "list" });

    await cmd.execute(i);

    const arg = i.reply.mock.calls[0][0];
    expect(arg.content).toContain("Chan A");
    expect(arg.content).toContain("UCa");
  });

  it("appends a user-install hint followUp when only guild-installed", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue({ name: "Chan A" } as any);
    const cmd = new YoutubeDmCommand();
    const i = intr({
      subcommand: "list",
      owners: { [ApplicationIntegrationType.GuildInstall]: "g1" },
    });

    await cmd.execute(i);

    expect(i.followUp).toHaveBeenCalledTimes(1);
    const arg = i.followUp.mock.calls[0][0];
    expect(arg.content).toContain("integration_type=1");
    expect(arg.ephemeral).toBe(true);
  });

  it("does not append a hint when already user-installed", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue({ name: "Chan A" } as any);
    const cmd = new YoutubeDmCommand();
    const i = intr({
      subcommand: "list",
      owners: { [ApplicationIntegrationType.UserInstall]: "d1" },
    });

    await cmd.execute(i);

    expect(i.followUp).not.toHaveBeenCalled();
  });
});
