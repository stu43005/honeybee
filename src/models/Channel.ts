import {
  getModelForClass,
  modelOptions,
  prop,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";
import { Channel as HolodexChannel } from "holodex.js";
import { HOLODEX_FETCH_ORG } from "../constants";
import { setIfDefine } from "../util";

@modelOptions({ schemaOptions: { collection: "channels" } })
export class Channel extends TimeStamps {
  @prop({ required: true, unique: true })
  public id!: string;

  @prop({ required: true, index: true })
  public name!: string;

  @prop({ index: true })
  public englishName!: string;

  @prop({ index: true })
  public organization?: string;

  @prop({ index: true })
  public group?: string;

  @prop()
  public avatarUrl?: string;

  @prop()
  public bannerUrl?: string;

  @prop()
  public subscriberCount?: number;

  @prop()
  public viewCount?: number;

  @prop({ index: true })
  public isInactive?: Boolean;

  @prop({ index: true })
  public extraCrawl?: Boolean;

  public static findSubscribed(this: ReturnModelType<typeof Channel>) {
    return this.find({
      $or: [
        {
          organization: HOLODEX_FETCH_ORG,
        },
        {
          extraCrawl: true,
        },
      ],
    });
  }

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
        new: true,
      }
    );
  }
}

export default getModelForClass(Channel);
