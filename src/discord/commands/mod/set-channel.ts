import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import ChannelModel, { type Channel } from "../../../models/Channel";
import { updateChannelFromYoutube } from "../../../modules/youtube";
import type { Command } from "../command";

export class SetChannelCommand implements Command {
  public metadata = new SlashCommandBuilder()
    .setName("set-channel")
    .setDescription("Modify channel settings")
    .addStringOption((builder) =>
      builder
        .setName("channel-id")
        .setDescription("The Youtube channelId")
        .setRequired(true)
    )
    .addBooleanOption((builder) =>
      builder
        .setName("extra-crawl")
        .setDescription("Whether to crawl the channel.")
    )
    .addBooleanOption((builder) =>
      builder
        .setName("is-ignore")
        .setDescription("Whether to ignore the channel.")
    )
    .toJSON();

  public async execute(intr: ChatInputCommandInteraction): Promise<void> {
    const channelId = intr.options.getString("channel-id", true);

    let channel = await ChannelModel.findByChannelId(channelId);
    if (!channel) {
      await updateChannelFromYoutube([channelId]);

      channel = await ChannelModel.findByChannelId(channelId);
      if (!channel) {
        await intr.reply({
          content: "Cannot find the channel.",
          ephemeral: true,
        });
        return;
      }
    }

    let modified = false;
    function setBoolean(key: keyof Channel, valueKey: string) {
      const value = intr.options.getBoolean(valueKey);
      if (channel && value !== null) {
        channel[key] = value;
        modified = true;
      }
    }
    setBoolean("extraCrawl", "extra-crawl");
    setBoolean("hbIgnore", "is-ignore");

    if (modified) {
      await channel.save();
      await intr.reply({
        content: "Successfully modified channel settings.",
        ephemeral: true,
      });
    } else {
      await intr.reply({
        content: "No channel settings have been modified.",
        ephemeral: true,
      });
    }
  }
}
