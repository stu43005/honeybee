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
    .addSubcommandGroup((builder) =>
      builder
        .setName("chat")
        .setDescription("Manage chat tracking settings.")
        .addSubcommand((subBuilder) =>
          subBuilder
            .setName("block-moderator")
            .setDescription("Block a moderator.")
            .addStringOption((option) =>
              option
                .setName("channel-id")
                .setDescription("The Youtube channelId of the moderator")
                .setRequired(true)
                .setAutocomplete(true)
            )
        )
        .addSubcommand((subBuilder) =>
          subBuilder
            .setName("unblock-moderator")
            .setDescription("Unblock a previously blocked moderator.")
            .addStringOption((option) =>
              option
                .setName("channel-id")
                .setDescription("The Youtube channelId of the moderator")
                .setRequired(true)
                .setAutocomplete(true)
            )
        )
        .addSubcommand((subBuilder) =>
          subBuilder
            .setName("follow-sender")
            .setDescription("Follow the sender in the tracked channel.")
            .addStringOption((option) =>
              option
                .setName("channel-id")
                .setDescription("The Youtube channelId of the sender")
                .setRequired(true)
                .setAutocomplete(true)
            )
        )
        .addSubcommand((subBuilder) =>
          subBuilder
            .setName("unfollow-sender")
            .setDescription("Unfollow the sender in the tracked channel.")
            .addStringOption((option) =>
              option
                .setName("channel-id")
                .setDescription("The Youtube channelId of the sender")
                .setRequired(true)
                .setAutocomplete(true)
            )
        )
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

    const subcommandGroup = intr.options.getSubcommandGroup();
    const subcommand = intr.options.getSubcommand(true);
    if (subcommandGroup === "chat") {
      switch (subcommand) {
        case "block-moderator":
          await this.blockModerator(intr, trackKey, baseChannel);
          break;
        case "unblock-moderator":
          await this.unblockModerator(intr, trackKey, baseChannel);
          break;
        case "follow-sender":
          await this.followSender(intr, trackKey, baseChannel);
          break;
        case "unfollow-sender":
          await this.unfollowSender(intr, trackKey, baseChannel);
          break;
      }
    } else {
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
      }
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

    if (!channel.crawledAt) {
      try {
        const updated = await ChannelModel.waitForCrawl(channelId);
        if (updated?.crawledAt) {
          const warning = updated.deleted
            ? " ⚠️ This channel may not exist on YouTube."
            : "";
          await intr.editReply({
            embeds: [
              {
                description: `Now tracking ${updated.getHyperlink()} (${channelId}).${warning}`,
              },
            ],
          });
        }
      } catch (err) {
        console.error("[track add] waitForCrawl/editReply failed:", err);
      }
    }
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
    let errorMsgs: string[] = [];
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

      if (errorMsgs.length > 0) {
        const errorMsg = errorMsgs.join("\n");
        const text2 = new TextDisplayBuilder().setContent(errorMsg);
        container.addTextDisplayComponents(text2);
        errorMsgs = [];
      }

      if (!isExiting) {
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
          const enabledFeatures = new Set(
            allTrackFeatures.filter((feature) =>
              response.values.includes(feature)
            )
          );

          if (
            !enabledFeatures.has("memberVideos") &&
            !enabledFeatures.has("nonMemberVideos")
          ) {
            enabledFeatures.add("memberVideos");
            enabledFeatures.add("nonMemberVideos");
            errorMsgs.push(
              "-# You have disabled `memberVideos` and `nonMemberVideos`. With both options disabled, **no** uploaded or live stream will be posted. They have been re-enabled for you. Only disable `memberVideos` if you specifically do not want to publish any membership-only videos on this channel, and only disable `nonMemberVideos` if you want this channel to contain only member videos (with no public videos at all)."
            );
          }

          if (
            !enabledFeatures.has("includeShorts") &&
            !enabledFeatures.has("includeNonShorts")
          ) {
            enabledFeatures.add("includeShorts");
            enabledFeatures.add("includeNonShorts");
            enabledFeatures.delete("uploads");
            errorMsgs.push(
              "-# You have disabled `includeShorts` and `includeNonShorts`. **Only adjust these settings if you want to exclude shorts or wish to have a channel limited to shorts.** They have been re-enabled for you, while the `uploads` feature has been disabled. If you want to fully enable/disable video uploads, please only change the `uploads` setting."
            );
          }

          const channelWebhook = await this.getChannelWebhook(
            intr,
            track,
            baseChannel
          );
          track = await TrackModel.setFeatures(trackKey, channelWebhook, [
            ...enabledFeatures,
          ]);
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
          errorMsgs.push(
            "-# Operation canceled due to no action for over 10 minutes."
          );
        } else {
          throw error;
        }
      }
    }
  }

  public async blockModerator(
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

    let track = await TrackModel.findOne(trackKey);
    if (!track) {
      await intr.reply({
        content: "No tracking found for this channel.",
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

    if (track.chatBlocklist.includes(channelId)) {
      await intr.reply({
        content: `Already blocked ${channel.getHyperlink()} (${channelId}).`,
        ephemeral: true,
      });
      return;
    }

    const channelWebhook = await this.getChannelWebhook(
      intr,
      track,
      baseChannel
    );
    track = await TrackModel.addChatBlock(trackKey, channelWebhook, channelId);

    await intr.reply({
      embeds: [
        {
          description: `Blocked ${channel.getHyperlink()} (${channelId}) from chat.`,
        },
      ],
    });

    if (!channel.crawledAt) {
      try {
        const updated = await ChannelModel.waitForCrawl(channelId);
        if (updated?.crawledAt) {
          const warning = updated.deleted
            ? " ⚠️ This channel may not exist on YouTube."
            : "";
          await intr.editReply({
            embeds: [
              {
                description: `Blocked ${updated.getHyperlink()} (${channelId}) from chat.${warning}`,
              },
            ],
          });
        }
      } catch (err) {
        console.error("[track block-moderator] waitForCrawl/editReply failed:", err);
      }
    }
  }

  private async unblockModerator(
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

    let track = await TrackModel.findOne(trackKey);
    if (!track) {
      await intr.reply({
        content: "No tracking found for this channel.",
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

    if (!track.chatBlocklist.includes(channelId)) {
      await intr.reply({
        content: `${channel.getHyperlink()} (${channelId}) is not currently blocked in this channel.`,
        ephemeral: true,
      });
      return;
    }

    const channelWebhook = await this.getChannelWebhook(
      intr,
      track,
      baseChannel
    );
    track = await TrackModel.removeChatBlock(
      trackKey,
      channelWebhook,
      channelId
    );

    await intr.reply({
      embeds: [
        {
          description: `Unblocked ${channel.getHyperlink()} (${channelId}) from chat.`,
        },
      ],
    });
  }

  private async followSender(
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

    let track = await TrackModel.findOne(trackKey);
    if (!track) {
      await intr.reply({
        content: "No tracking found for this channel.",
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

    if (track.chatFollowlist.includes(channelId)) {
      await intr.reply({
        content: `Already following ${channel.getHyperlink()} (${channelId}).`,
        ephemeral: true,
      });
      return;
    }

    const channelWebhook = await this.getChannelWebhook(
      intr,
      track,
      baseChannel
    );
    track = await TrackModel.addChatFollow(trackKey, channelWebhook, channelId);

    await intr.reply({
      embeds: [
        {
          description: `Following ${channel.getHyperlink()} (${channelId}) in chat.`,
        },
      ],
    });
  }

  private async unfollowSender(
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

    let track = await TrackModel.findOne(trackKey);
    if (!track) {
      await intr.reply({
        content: "No tracking found for this channel.",
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

    if (!track.chatFollowlist.includes(channelId)) {
      await intr.reply({
        content: `${channel.getHyperlink()} (${channelId}) is not currently followed in this channel.`,
        ephemeral: true,
      });
      return;
    }

    const channelWebhook = await this.getChannelWebhook(
      intr,
      track,
      baseChannel
    );
    track = await TrackModel.removeChatFollow(
      trackKey,
      channelWebhook,
      channelId
    );

    await intr.reply({
      embeds: [
        {
          description: `Unfollowed ${channel.getHyperlink()} (${channelId}) in chat.`,
        },
      ],
    });
  }

  public async autocomplete(intr: AutocompleteInteraction): Promise<void> {
    const subcommand = intr.options.getSubcommand(true);
    const focused = intr.options.getFocused(true);

    switch (focused.name) {
      case "channel-id":
        switch (subcommand) {
          case "remove":
          case "unblock-moderator":
          case "unfollow-sender": {
            const { trackKey } = await getTrackKey(intr);
            const track = trackKey && (await TrackModel.findOne(trackKey));
            if (!track) {
              await intr.respond([]);
              return;
            }
            const channels = await ChannelModel.findByName(focused.value).and([
              {
                id: {
                  $in:
                    subcommand === "remove"
                      ? track.trackChannels
                      : subcommand === "unblock-moderator"
                      ? track.chatBlocklist
                      : track.chatFollowlist,
                },
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
          default: {
            const channels = await ChannelModel.findByName(focused.value);
            await intr.respond(
              channels.map((channel) => ({
                name: `${channel.name} (${channel.id})`,
                value: channel.id,
              }))
            );
          }
        }
        break;
      default:
        await intr.respond([]);
        break;
    }
  }
}
