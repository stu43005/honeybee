import {
  getModelForClass,
  index,
  modelOptions,
  prop,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";
import { defaultTrackFeatures } from "../data/track";

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

  public static async addTrackChannel(
    this: ReturnModelType<typeof Track>,
    key: TrackKey,
    clientId: string,
    token: string,
    trackChannelId: string
  ) {
    return await this.findOneAndUpdate(
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
          clientId,
          token,
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
  }

  public static async removeTrackChannel(
    this: ReturnModelType<typeof Track>,
    key: TrackKey,
    trackChannelId: string
  ) {
    return await this.findOneAndUpdate(
      {
        guildId: key.guildId,
        channelId: key.channelId,
        threadId: key.threadId,
      },
      {
        $pull: {
          trackChannels: trackChannelId,
        },
      },
      {
        new: true,
      }
    );
  }

  public static async addFeature(
    this: ReturnModelType<typeof Track>,
    key: TrackKey,
    feature: string
  ) {
    return await this.findOneAndUpdate(
      {
        guildId: key.guildId,
        channelId: key.channelId,
        threadId: key.threadId,
      },
      {
        $addToSet: {
          enabledFeatures: feature,
        },
      },
      {
        new: true,
      }
    );
  }

  public static async removeFeature(
    this: ReturnModelType<typeof Track>,
    key: TrackKey,
    feature: string
  ) {
    return await this.findOneAndUpdate(
      {
        guildId: key.guildId,
        channelId: key.channelId,
        threadId: key.threadId,
      },
      {
        $pull: {
          enabledFeatures: feature,
        },
      },
      {
        new: true,
      }
    );
  }
}

export default getModelForClass(Track);
