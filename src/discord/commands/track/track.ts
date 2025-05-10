import type { DocumentType } from "@typegoose/typegoose";
import {
  bold,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  DiscordjsError,
  DiscordjsErrorCodes,
  InteractionContextType,
  MessageFlags,
  PermissionsBitField,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  type AutocompleteInteraction,
  type CategoryChildChannel,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  allTrackFeatures,
  defaultTrackFeatures,
  trackFeatures,
} from "../../../data/track";
import ChannelModel from "../../../models/Channel";
import TrackModel, { type Track, type TrackKey } from "../../../models/Track";
import { validateChannelId } from "../../../modules/youtube";
import type { Command } from "../command";
import { getTrackKey } from "./fns";

export class TrackCommand implements Command {
  public metadata = new SlashCommandBuilder()
    .setName("track")
    .setDescription("Manage track.")
    .addSubcommand((builder) =>
      builder
        .setName("add")
        .setDescription("Track a streamer's channel.")
        .addStringOption((builder) =>
          builder
            .setName("channel-id")
            .setDescription("The Youtube channelId")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((builder) =>
      builder
        .setName("remove")
        .setDescription("Untrack a currently tracked channel.")
        .addStringOption((builder) =>
          builder
            .setName("channel-id")
            .setDescription("The Youtube channelId")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((builder) =>
      builder.setName("list").setDescription("List currently tracked channels.")
    )
    .addSubcommand((builder) =>
      builder
        .setName("configure")
        .setDescription("Configure tracking settings.")
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

    const subcommand = intr.options.getSubcommand(true);
    switch (subcommand) {
      case "add":
        await this.addTrackChannel(intr, trackKey, baseChannel);
        break;
      case "remove":
        await this.removeTrackChannel(intr, trackKey, baseChannel);
        break;
      case "list":
        await this.listTrackChannels(intr, trackKey, baseChannel);
        break;
      case "configure":
        await this.configure(intr, trackKey, baseChannel);
        break;
      default:
        await intr.reply({
          content: "Unknown subcommand.",
          ephemeral: true,
        });
        break;
    }
  }

  private async getChannelWebhook(
    intr: ChatInputCommandInteraction,
    track: DocumentType<Track> | null,
    baseChannel: CategoryChildChannel
  ) {
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
    return channelWebhook;
  }

  private async addTrackChannel(
    intr: ChatInputCommandInteraction,
    trackKey: TrackKey,
    baseChannel: CategoryChildChannel
  ) {
    const channelId = intr.options.getString("channel-id", true);
    if (!validateChannelId(channelId)) {
      await intr.reply({
        content: "Invalid channelId format.",
        ephemeral: true,
      });
      return;
    }

    const channel =
      (await ChannelModel.findByChannelId(channelId)) ??
      (await ChannelModel.create({
        id: channelId,
        name: "Unknown channel",
      }));

    let track = await TrackModel.findOne(trackKey);
    const channelWebhook = await this.getChannelWebhook(
      intr,
      track,
      baseChannel
    );

    if (
      track &&
      track.clientId === channelWebhook.id &&
      track.trackChannels.includes(channelId)
    ) {
      await intr.reply({
        content: `Already tracked ${channel.getHyperlink()} (${channelId}).`,
        ephemeral: true,
      });
      return;
    }

    track = await TrackModel.addTrackChannel(
      trackKey,
      channelWebhook,
      channelId
    );

    await intr.reply({
      embeds: [
        {
          description: `Now tracking ${channel.getHyperlink()} (${channelId}).`,
        },
      ],
    });
  }

  private async removeTrackChannel(
    intr: ChatInputCommandInteraction,
    trackKey: TrackKey,
    baseChannel: CategoryChildChannel
  ) {
    let track = await TrackModel.findOne(trackKey);
    if (!track) {
      await intr.reply({
        content: "No tracking found for this channel.",
        ephemeral: true,
      });
      return;
    }

    const channelId = intr.options.getString("channel-id", true);
    if (!validateChannelId(channelId)) {
      await intr.reply({
        content: "Invalid channelId format.",
        ephemeral: true,
      });
      return;
    }

    const channel =
      (await ChannelModel.findByChannelId(channelId)) ??
      new ChannelModel({
        id: channelId,
        name: "Unknown channel",
      });

    if (!track.trackChannels.includes(channelId)) {
      await intr.reply({
        content: `${channel.getHyperlink()} (${channelId}) is not currently tracked in this channel.`,
        ephemeral: true,
      });
      return;
    }

    const channelWebhook = await this.getChannelWebhook(
      intr,
      track,
      baseChannel
    );
    track = await TrackModel.removeTrackChannel(
      trackKey,
      channelWebhook,
      channelId
    );

    await intr.reply({
      embeds: [
        {
          description: `No longer tracking ${channel.getHyperlink()} (${channelId}).`,
        },
      ],
    });
  }

  private async listTrackChannels(
    intr: ChatInputCommandInteraction,
    trackKey: TrackKey,
    baseChannel: CategoryChildChannel
  ) {
    const track = await TrackModel.findOne(trackKey);
    const trackChannels = track?.trackChannels ?? [];
    const channels =
      trackChannels.length > 0
        ? await ChannelModel.find({
            id: { $in: trackChannels },
          })
        : [];

    const container = new ContainerBuilder();
    const text1 = new TextDisplayBuilder().setContent(
      [
        `# Tracked channels for #${baseChannel.name}` +
          (intr.channel?.isThread() ? ` > 💬 ${intr.channel.name}` : ""),
        trackChannels
          .map((channelId) => {
            const channel =
              channels.find((c) => c.id === channelId) ??
              new ChannelModel({
                id: channelId,
                name: "Unknown channel",
              });
            return `- ${channel.getHyperlink()} (${channelId})`;
          })
          .join("\n") || "-# No channels are currently being tracked.",
      ].join("\n")
    );
    container.addTextDisplayComponents(text1);

    await intr.reply({
      components: [container],
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    });
  }

  private getFeatureOption(feature: string, isEnabled: boolean) {
    const featureOption = trackFeatures[feature];
    return {
      text: featureOption.description
        ? `- ${featureOption.description} ${bold(`(${feature})`)}`
        : `- ${bold(feature)}`,
      name: feature,
      description: featureOption.description,
      isEnabled,
    };
  }

  private async configure(
    intr: ChatInputCommandInteraction,
    trackKey: TrackKey,
    baseChannel: CategoryChildChannel
  ) {
    await intr.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    let isExiting = false;
    while (true) {
      let track = await TrackModel.findOne(trackKey);
      const enabledFeatures = track?.enabledFeatures ?? defaultTrackFeatures;
      const features = allTrackFeatures.map((feature) =>
        this.getFeatureOption(feature, enabledFeatures.includes(feature))
      );

      const container = new ContainerBuilder();
      const text1 = new TextDisplayBuilder().setContent(
        [
          `# Tracker settings for #${baseChannel.name}` +
            (intr.channel?.isThread() ? ` > 💬 ${intr.channel.name}` : ""),
          "## Enabled Features",
          features
            .filter((f) => f.isEnabled)
            .map((f) => f.text)
            .join("\n") || "-# All features are disabled.",
          "## Disabled Features",
          features
            .filter((f) => !f.isEnabled)
            .map((f) => f.text)
            .join("\n") || "-# All features are enabled.",
        ].join("\n")
      );
      container.addTextDisplayComponents(text1);

      container.addSeparatorComponents((separator) =>
        separator.setSpacing(SeparatorSpacingSize.Large)
      );

      if (isExiting) {
        const text2 = new TextDisplayBuilder().setContent(
          `-# Operation canceled due to no action for over 10 minutes.`
        );
        container.addTextDisplayComponents(text2);
      } else {
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId("track-configure-features")
          .setPlaceholder("Select features to enable/disable")
          .setMinValues(0)
          .setMaxValues(allTrackFeatures.length)
          .addOptions(
            ...features.map((feature) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(feature.name)
                .setValue(feature.name)
                .setDescription(feature.description ?? "")
                .setDefault(feature.isEnabled)
            )
          );
        container.addActionRowComponents((builder) =>
          builder.addComponents(selectMenu)
        );

        const exitButton = new ButtonBuilder()
          .setCustomId("track-configure-save")
          .setLabel("Save and exit")
          .setStyle(ButtonStyle.Success);
        container.addActionRowComponents((builder) =>
          builder.addComponents(exitButton)
        );
      }

      const msg = await intr.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      if (isExiting) {
        break;
      }

      try {
        const response = await msg.awaitMessageComponent({
          filter: (i) =>
            i.user.id === intr.user.id &&
            i.customId.startsWith("track-configure-"),
          time: 600_000,
        });
        if (
          response.customId === "track-configure-features" &&
          response.isStringSelectMenu()
        ) {
          await response.deferUpdate();
          const enabledFeatures = allTrackFeatures.filter((feature) =>
            response.values.includes(feature)
          );
          const channelWebhook = await this.getChannelWebhook(
            intr,
            track,
            baseChannel
          );
          track = await TrackModel.setFeatures(
            trackKey,
            channelWebhook,
            enabledFeatures
          );
        } else if (
          response.customId === "track-configure-save" &&
          response.isButton()
        ) {
          await response.deferUpdate();
          isExiting = true;
          await intr.deleteReply();
          break;
        }
      } catch (error) {
        if (
          error instanceof DiscordjsError &&
          error.code === DiscordjsErrorCodes.InteractionCollectorError
        ) {
          isExiting = true;
        } else {
          throw error;
        }
      }
    }
  }

  public async autocomplete(intr: AutocompleteInteraction): Promise<void> {
    const subcommand = intr.options.getSubcommand(true);
    const focusedValue = intr.options.getFocused();

    switch (subcommand) {
      case "add": {
        const channels = await ChannelModel.findByName(focusedValue);
        await intr.respond(
          channels.map((channel) => ({
            name: `${channel.name} (${channel.id})`,
            value: channel.id,
          }))
        );
        break;
      }
      case "remove": {
        const { trackKey } = await getTrackKey(intr);
        const track = trackKey && (await TrackModel.findOne(trackKey));
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
        break;
      }
      default:
        await intr.respond([]);
        break;
    }
  }
}
