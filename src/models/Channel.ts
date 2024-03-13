import {
  getModelForClass,
  modelOptions,
  prop,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";
import { Channel as HolodexChannel } from "holodex.js";
import { setIfDefine } from "../util";

@modelOptions({ schemaOptions: { collection: "channels" } })
export class Channel extends TimeStamps {
  @prop({ required: true, unique: true })
  public id!: string;

  @prop({ required: true, index: true })
  public name!: string;

  @prop({ required: true, index: true })
  public englishName!: string;

  @prop({ index: true })
  public organization?: string;

  @prop({ index: true })
  public group?: string;

  @prop({ index: true })
  public avatarUrl?: string;

  @prop({ index: true })
  public bannerUrl?: string;

  @prop({ index: true })
  public subscriberCount?: number;

  @prop({ index: true })
  public viewCount?: number;

  @prop({ index: true })
  public isInactive?: Boolean;

  public static async updateFromHolodex(
    this: ReturnModelType<typeof Channel>,
    channel: HolodexChannel
  ) {
    return await this.findOneAndUpdate(
      {
        id: channel.channelId,
      },
      {
        $setOnInsert: {
          id: channel.channelId,
        },
        $set: {
          ...setIfDefine("name", channel.name),
          ...setIfDefine("englishName", channel.englishName),
          ...setIfDefine("organization", channel.organization),
          ...setIfDefine("group", channel.group),
          ...setIfDefine("avatarUrl", channel.avatarUrl),
          ...setIfDefine("bannerUrl", channel.bannerUrl),
          ...setIfDefine("isInactive", channel.isInactive),
        },
        $max: {
          subscriberCount: channel.subscriberCount,
          viewCount: channel.viewCount,
        },
      },
      {
        upsert: true,
      }
    );
  }
}

export default getModelForClass(Channel);
