import {
  getModelForClass,
  index,
  modelOptions,
  prop,
  type ReturnModelType,
  type DocumentType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses.js";
import { defaultTrackFeatures } from "../data/track.js";
import { transformTrack } from "../components/track-operator.js";
import type {
  Webhook as DiscordWebhook,
  WebhookType as DiscordWebhookType,
} from "discord.js";

export interface TrackKey {
  guildId: string;
  channelId: string;
  threadId: string | null;
}

@modelOptions({ schemaOptions: { collection: "tracks" } })
@index({ guildId: 1, channelId: 1, threadId: 1 }, { unique: true })
export class Track extends TimeStamps {
  @prop({ required: true })
  clientId!: string;

  @prop({ required: true })
  token!: string;

  @prop({ required: true })
  guildId!: string;

  @prop({ required: true })
  channelId!: string;

  @prop()
  threadId?: string;

  @prop({ type: String, default: [] })
  trackChannels!: string[];

  @prop({ type: String, default: defaultTrackFeatures })
  enabledFeatures!: string[];

  @prop({ type: String, default: [] })
  chatBlocklist!: string[];

  @prop({ type: String, default: [] })
  chatFollowlist!: string[];

  public getTrackKey(this: DocumentType<Track>): TrackKey {
    return {
      guildId: this.guildId,
      channelId: this.channelId,
      threadId: this.threadId ?? null,
    };
  }

  public static async addTrackChannel(
    this: ReturnModelType<typeof Track>,
    key: TrackKey,
    channelWebhook: DiscordWebhook<DiscordWebhookType.Incoming>,
    trackChannelId: string
  ) {
    const track = await this.findOneAndUpdate(
      {
        guildId: key.guildId,
        channelId: key.channelId,
        threadId: key.threadId,
      },
      {
        $set: {
          guildId: key.guildId,
          channelId: key.channelId,
          threadId: key.threadId,
          clientId: channelWebhook.id,
          token: channelWebhook.token,
        },
        $addToSet: {
          trackChannels: trackChannelId,
        },
      },
      {
        upsert: true,
        new: true,
      }
    );
    await transformTrack(track);
    return track;
  }

  public static async removeTrackChannel(
    this: ReturnModelType<typeof Track>,
    key: TrackKey,
    channelWebhook: DiscordWebhook<DiscordWebhookType.Incoming>,
    trackChannelId: string
  ) {
    const track = await this.findOneAndUpdate(
      {
        guildId: key.guildId,
        channelId: key.channelId,
        threadId: key.threadId,
      },
      {
        $set: {
          guildId: key.guildId,
          channelId: key.channelId,
          threadId: key.threadId,
          clientId: channelWebhook.id,
          token: channelWebhook.token,
        },
        $pull: {
          trackChannels: trackChannelId,
        },
      },
      {
        upsert: true,
        new: true,
      }
    );
    await transformTrack(track);
    return track;
  }

  public static async setFeatures(
    this: ReturnModelType<typeof Track>,
    key: TrackKey,
    channelWebhook: DiscordWebhook<DiscordWebhookType.Incoming>,
    features: string[]
  ) {
    const track = await this.findOneAndUpdate(
      {
        guildId: key.guildId,
        channelId: key.channelId,
        threadId: key.threadId,
      },
      {
        $set: {
          guildId: key.guildId,
          channelId: key.channelId,
          threadId: key.threadId,
          clientId: channelWebhook.id,
          token: channelWebhook.token,
          enabledFeatures: features,
        },
      },
      {
        upsert: true,
        new: true,
      }
    );
    await transformTrack(track);
    return track;
  }

  public static async addChatBlock(
    this: ReturnModelType<typeof Track>,
    key: TrackKey,
    channelWebhook: DiscordWebhook<DiscordWebhookType.Incoming>,
    userId: string
  ) {
    const track = await this.findOneAndUpdate(
      {
        guildId: key.guildId,
        channelId: key.channelId,
        threadId: key.threadId,
      },
      {
        $set: {
          guildId: key.guildId,
          channelId: key.channelId,
          threadId: key.threadId,
          clientId: channelWebhook.id,
          token: channelWebhook.token,
        },
        $addToSet: {
          chatBlocklist: userId,
        },
      },
      {
        upsert: true,
        new: true,
      }
    );
    await transformTrack(track);
    return track;
  }

  public static async removeChatBlock(
    this: ReturnModelType<typeof Track>,
    key: TrackKey,
    channelWebhook: DiscordWebhook<DiscordWebhookType.Incoming>,
    userId: string
  ) {
    const track = await this.findOneAndUpdate(
      {
        guildId: key.guildId,
        channelId: key.channelId,
        threadId: key.threadId,
      },
      {
        $set: {
          guildId: key.guildId,
          channelId: key.channelId,
          threadId: key.threadId,
          clientId: channelWebhook.id,
          token: channelWebhook.token,
        },
        $pull: {
          chatBlocklist: userId,
        },
      },
      {
        upsert: true,
        new: true,
      }
    );
    await transformTrack(track);
    return track;
  }

  public static async addChatFollow(
    this: ReturnModelType<typeof Track>,
    key: TrackKey,
    channelWebhook: DiscordWebhook<DiscordWebhookType.Incoming>,
    userId: string
  ) {
    const track = await this.findOneAndUpdate(
      {
        guildId: key.guildId,
        channelId: key.channelId,
        threadId: key.threadId,
      },
      {
        $set: {
          guildId: key.guildId,
          channelId: key.channelId,
          threadId: key.threadId,
          clientId: channelWebhook.id,
          token: channelWebhook.token,
        },
        $addToSet: {
          chatFollowlist: userId,
          enabledFeatures: "followedChats",
        },
      },
      {
        upsert: true,
        new: true,
      }
    );
    await transformTrack(track);
    return track;
  }

  public static async removeChatFollow(
    this: ReturnModelType<typeof Track>,
    key: TrackKey,
    channelWebhook: DiscordWebhook<DiscordWebhookType.Incoming>,
    userId: string
  ) {
    const track = await this.findOneAndUpdate(
      {
        guildId: key.guildId,
        channelId: key.channelId,
        threadId: key.threadId,
      },
      {
        $set: {
          guildId: key.guildId,
          channelId: key.channelId,
          threadId: key.threadId,
          clientId: channelWebhook.id,
          token: channelWebhook.token,
        },
        $pull: {
          chatFollowlist: userId,
        },
      },
      {
        upsert: true,
        new: true,
      }
    );
    await transformTrack(track);
    return track;
  }
}

export default getModelForClass(Track);
