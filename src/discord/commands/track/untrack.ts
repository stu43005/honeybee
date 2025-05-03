import {
  InteractionContextType,
  PermissionsBitField,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import ChannelModel from "../../../models/Channel";
import TrackModel from "../../../models/Track";
import type { Command } from "../command";
import { getTrackKey } from "./fns";

export class UntrackCommand implements Command {
  public metadata = new SlashCommandBuilder()
    .setName("untrack")
    .setDescription("Untrack a currently tracked channel.")
    .addStringOption((builder) =>
      builder
        .setName("channel-id")
        .setDescription("The Youtube channelId")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageWebhooks)
    .setContexts(InteractionContextType.Guild)
    .toJSON();

  public async execute(intr: ChatInputCommandInteraction): Promise<void> {
    const { trackKey, baseChannel } = await getTrackKey(intr);
    if (!trackKey || !baseChannel) {
      await intr.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const channelId = intr.options.getString("channel-id", true);
    const channel = await ChannelModel.findByChannelId(channelId);
    if (!channel) {
      await intr.reply({
        content: "Cannot find the channel.",
        ephemeral: true,
      });
      return;
    }

    const track = await TrackModel.findOne(trackKey);
    if (!track) {
      await intr.reply({
        content: "No tracking found for this channel.",
        ephemeral: true,
      });
      return;
    }

    if (!track.trackChannels.includes(channelId)) {
      await intr.reply({
        content: `${channel.name} (${channelId}) is not currently tracked in this channel.`,
        ephemeral: true,
      });
      return;
    }

    await TrackModel.removeTrackChannel(trackKey, channelId);

    await intr.reply({
      embeds: [
        {
          description: `No longer tracking ${channel.name} (${channelId}).`,
        },
      ],
    });
  }

  public async autocomplete(intr: AutocompleteInteraction): Promise<void> {
    const focusedValue = intr.options.getFocused();
    const { trackKey, baseChannel } = await getTrackKey(intr);
    if (!trackKey || !baseChannel) {
      await intr.respond([]);
      return;
    }
    const track = await TrackModel.findOne(trackKey);
    if (!track) {
      await intr.respond([]);
      return;
    }
    const channels = await ChannelModel.findByName(focusedValue).and([
      {
        id: { $in: track.trackChannels },
      },
    ]);
    await intr.respond(
      channels.map((channel) => ({
        name: `${channel.name} (${channel.id})`,
        value: channel.id,
      }))
    );
  }
}
