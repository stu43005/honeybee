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

export class TrackCommand implements Command {
  public metadata = new SlashCommandBuilder()
    .setName("track")
    .setDescription("Track a streamer's channel.")
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
    const channelWebhooks = (await baseChannel.fetchWebhooks()).filter(
      (webhook) => webhook.isIncoming()
    );
    const channelWebhook =
      (track && channelWebhooks.get(track.clientId)) ||
      channelWebhooks.find(
        (webhook) => webhook.owner?.id === intr.client.user.id
      ) ||
      (await baseChannel.createWebhook({
        name: intr.client.user.username,
        avatar: intr.client.user.avatarURL(),
      }));

    if (
      track &&
      track.clientId === channelWebhook.id &&
      track.trackChannels.includes(channelId)
    ) {
      await intr.reply({
        content: `Already tracked ${channel.name} (${channelId}).`,
        ephemeral: true,
      });
      return;
    }

    await TrackModel.addTrackChannel(
      trackKey,
      channelWebhook.id,
      channelWebhook.token,
      channelId
    );

    await intr.reply({
      embeds: [
        {
          description: `Now tracking ${channel.name} (${channelId}).`,
        },
      ],
    });
  }

  public async autocomplete(intr: AutocompleteInteraction): Promise<void> {
    const focusedValue = intr.options.getFocused();
    const channels = await ChannelModel.findByName(focusedValue);
    await intr.respond(
      channels.map((channel) => ({
        name: `${channel.name} (${channel.id})`,
        value: channel.id,
      }))
    );
  }
}
