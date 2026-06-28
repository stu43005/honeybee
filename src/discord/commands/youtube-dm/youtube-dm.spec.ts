/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { ApplicationIntegrationType, MessageFlags } from "discord.js";
import ChannelModel from "../../../models/Channel.js";
import YoutubeDmBindingModel from "../../../models/YoutubeDmBinding.js";
import { YoutubeDmCommand } from "./youtube-dm.js";

function fakeOAuth() {
  return {
    beginAuth: jest.fn(() =>
      Promise.resolve("https://accounts.google.com/o/oauth2/v2/auth?state=x")
    ),
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

  it("bind calls beginAuth and replies ephemerally with the auth link", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: [] } as any);
    const oauth = fakeOAuth();
    const i = intr({ subcommand: "bind", optionValues: { method: "google" } });
    await new YoutubeDmCommand(oauth).execute(i);
    expect(oauth.beginAuth).toHaveBeenCalledWith("google", "d1");
    const arg = i.reply.mock.calls[0][0];
    expect(arg.content).toContain("accounts.google.com");
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
  });

  it("bind at the cap rejects ephemerally without calling beginAuth", async () => {
    jest.spyOn(YoutubeDmBindingModel, "findOne").mockResolvedValue({
      channelIds: Array.from({ length: 10 }, (_, n) => `UC${n}`),
    } as any);
    const oauth = fakeOAuth();
    const i = intr({ subcommand: "bind", optionValues: { method: "google" } });
    await new YoutubeDmCommand(oauth).execute(i);
    expect(oauth.beginAuth).not.toHaveBeenCalled();
    expect(i.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    expect(i.reply.mock.calls[0][0].content).toContain("上限");
  });

  it("list replies NON-ephemerally with channel names", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue({ name: "Chan A" } as any);
    const i = intr({ subcommand: "list" });
    await new YoutubeDmCommand(fakeOAuth()).execute(i);
    const arg = i.reply.mock.calls[0][0];
    expect(arg.content).toContain("Chan A");
    expect(arg.content).toContain("UCa");
    expect(arg.flags).toBeUndefined();
  });

  it("unbind all replies NON-ephemerally and clears the binding", async () => {
    const unbindAll = jest
      .spyOn(YoutubeDmBindingModel, "unbindAll")
      .mockResolvedValue({} as any);
    const i = intr({ subcommand: "unbind", optionValues: { channel: "all" } });
    await new YoutubeDmCommand(fakeOAuth()).execute(i);
    expect(unbindAll).toHaveBeenCalledWith("d1");
    expect(i.reply.mock.calls[0][0].flags).toBeUndefined();
  });

  it("the install hint followUp stays ephemeral via flags", async () => {
    jest
      .spyOn(YoutubeDmBindingModel, "findOne")
      .mockResolvedValue({ channelIds: ["UCa"] } as any);
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue({ name: "Chan A" } as any);
    const i = intr({
      subcommand: "list",
      owners: { [ApplicationIntegrationType.GuildInstall]: "g1" },
    });
    await new YoutubeDmCommand(fakeOAuth()).execute(i);
    expect(i.followUp).toHaveBeenCalledTimes(1);
    const arg = i.followUp.mock.calls[0][0];
    expect(arg.content).toContain("integration_type=1");
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
  });
});
