import {
  ApplicationIntegrationType,
  InteractionContextType,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { YOUTUBE_DM_MAX_CHANNELS_PER_USER } from "../../../constants.js";
import ChannelModel from "../../../models/Channel.js";
import YoutubeDmBindingModel from "../../../models/YoutubeDmBinding.js";
import { buildDiscordAuthUrl } from "../../oauth/discord.js";
import { buildGoogleAuthUrl } from "../../oauth/google.js";
import {
  putOAuthState,
  randomState,
  type OAuthMethod,
} from "../../oauth/state.js";
import type { Command } from "../command.js";
import { buildUserInstallHint } from "./install-hint.js";

export class YoutubeDmCommand implements Command {
  public metadata = new SlashCommandBuilder()
    .setName("youtube-dm")
    .setDescription("Manage YouTube → Discord DM notifications.")
    .addSubcommand((b) =>
      b
        .setName("bind")
        .setDescription("Bind a YouTube account you own (via OAuth).")
        .addStringOption((o) =>
          o
            .setName("method")
            .setDescription("Verification method")
            .setRequired(true)
            .addChoices(
              { name: "Google", value: "google" },
              { name: "Discord connection", value: "discord" }
            )
        )
    )
    .addSubcommand((b) =>
      b.setName("list").setDescription("List your bound YouTube channels.")
    )
    .addSubcommand((b) =>
      b
        .setName("unbind")
        .setDescription("Unbind a channel (or all).")
        .addStringOption((o) =>
          o
            .setName("channel")
            .setDescription("Channel id, or 'all'")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .setContexts(InteractionContextType.BotDM)
    .setIntegrationTypes(
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall
    )
    .toJSON();

  public async execute(intr: ChatInputCommandInteraction): Promise<void> {
    const subcommand = intr.options.getSubcommand(true);
    const discordUserId = intr.user.id;
    switch (subcommand) {
      case "bind":
        await this.bind(intr, discordUserId);
        break;
      case "list":
        await this.list(intr, discordUserId);
        break;
      case "unbind":
        await this.unbind(intr, discordUserId);
        break;
    }

    // Every subcommand has already replied (ephemerally) above; nudge guild-install
    // users toward user-install so the DM path is not tied to shared-guild membership.
    const hint = buildUserInstallHint(
      intr.authorizingIntegrationOwners,
      intr.client.application.id
    );
    if (hint) {
      await intr.followUp({ content: hint, ephemeral: true });
    }
  }

  private async bind(
    intr: ChatInputCommandInteraction,
    discordUserId: string
  ): Promise<void> {
    const binding = await YoutubeDmBindingModel.findOne({ discordUserId });
    if ((binding?.channelIds.length ?? 0) >= YOUTUBE_DM_MAX_CHANNELS_PER_USER) {
      await intr.reply({
        content: `你已達綁定上限（${YOUTUBE_DM_MAX_CHANNELS_PER_USER}）。請先用 /youtube-dm unbind 解除部分頻道。`,
        ephemeral: true,
      });
      return;
    }
    const method = intr.options.getString("method", true) as OAuthMethod;
    const state = randomState();
    await putOAuthState(state, { discordUserId, method });
    const url =
      method === "google"
        ? buildGoogleAuthUrl(state)
        : buildDiscordAuthUrl(state);
    await intr.reply({
      content: `點此完成授權（連結 10 分鐘內有效，請勿轉傳）：\n${url}`,
      ephemeral: true,
    });
  }

  private async list(
    intr: ChatInputCommandInteraction,
    discordUserId: string
  ): Promise<void> {
    const binding = await YoutubeDmBindingModel.findOne({ discordUserId });
    const ids = binding?.channelIds ?? [];
    if (ids.length === 0) {
      await intr.reply({
        content: "你尚未綁定任何 YouTube 頻道。",
        ephemeral: true,
      });
      return;
    }
    const lines = await Promise.all(
      ids.map(async (id) => {
        const channel = await ChannelModel.findByChannelId(id);
        return `• ${channel?.name ?? "Unknown channel"} (${id})`;
      })
    );
    await intr.reply({
      content: lines.join("\n"),
      ephemeral: true,
    });
  }

  private async unbind(
    intr: ChatInputCommandInteraction,
    discordUserId: string
  ): Promise<void> {
    const channel = intr.options.getString("channel", true);
    if (channel === "all") {
      await YoutubeDmBindingModel.unbindAll(discordUserId);
      await intr.reply({
        content: "已解除所有綁定。",
        ephemeral: true,
      });
      return;
    }
    await YoutubeDmBindingModel.unbindChannel(discordUserId, channel);
    await intr.reply({
      content: `已解除綁定 ${channel}。`,
      ephemeral: true,
    });
  }

  public async autocomplete(intr: AutocompleteInteraction): Promise<void> {
    const focused = intr.options.getFocused(true);
    if (focused.name !== "channel") {
      await intr.respond([]);
      return;
    }
    const binding = await YoutubeDmBindingModel.findOne({
      discordUserId: intr.user.id,
    });
    const ids = (binding?.channelIds ?? []).filter((id) =>
      id.includes(focused.value)
    );
    const options = [
      { name: "All channels", value: "all" },
      ...ids.map((id) => ({ name: id, value: id })),
    ].slice(0, 25);
    await intr.respond(options);
  }
}
