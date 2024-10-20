import {
  getModelForClass,
  index,
  modelOptions,
  prop,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";
import { Channel as HolodexChannel } from "holodex.js";
import type { FilterQuery } from "mongoose";
import { HOLODEX_ALL_VTUBERS, HOLODEX_FETCH_ORG } from "../constants";
import { setIfDefine } from "../util";

@modelOptions({ schemaOptions: { collection: "channels" } })
@index({ organization: 1, isInactive: 1 })
@index({ extraCrawl: 1, isInactive: 1 })
export class Channel extends TimeStamps {
  @prop({ required: true, unique: true })
  public id!: string;

  @prop({ required: true })
  public name!: string;

  @prop()
  public englishName!: string;

  @prop()
  public description?: string;

  @prop({ index: true })
  public organization?: string;

  @prop()
  public group?: string;

  @prop()
  public avatarUrl?: string;

  @prop()
  public bannerUrl?: string;

  @prop()
  public publishedAt?: Date;

  @prop()
  public subscriberCount?: number;

  @prop()
  public viewCount?: number;

  @prop()
  public videoCount?: number;

  @prop({ index: true })
  public isInactive?: Boolean;

  @prop()
  public extraCrawl?: Boolean;

  @prop({ index: true })
  public crawledAt?: Date;

  @prop({ index: true })
  public holodexCrawledAt?: Date;

  public static findByChannelId(
    this: ReturnModelType<typeof Channel>,
    channelId: string
  ) {
    return this.findOne({ id: channelId });
  }

  public static SubscribedQuery: Readonly<FilterQuery<Channel>> =
    HOLODEX_FETCH_ORG === HOLODEX_ALL_VTUBERS
      ? Object.freeze({
          isInactive: { $ne: true },
        })
      : Object.freeze({
          $or: [
            {
              organization: HOLODEX_FETCH_ORG,
              isInactive: { $ne: true },
            },
            {
              extraCrawl: true,
              isInactive: { $ne: true },
            },
          ],
        });
  public static findSubscribed(this: ReturnModelType<typeof Channel>) {
    return this.find(this.SubscribedQuery);
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
          ...setIfDefine("name", channel.name),
          ...setIfDefine("description", channel.description),
          ...setIfDefine("avatarUrl", channel.avatarUrl),
          ...setIfDefine("bannerUrl", channel.bannerUrl),
          ...setIfDefine("publishedAt", channel.createdAt),
        },
        $set: {
          ...setIfDefine("englishName", channel.englishName),
          ...setIfDefine("organization", channel.organization),
          ...setIfDefine("group", channel.group),
          ...setIfDefine("isInactive", channel.isInactive),
          holodexCrawledAt: new Date(),
        },
        $max: {
          subscriberCount: channel.subscriberCount,
          viewCount: channel.viewCount,
          videoCount: channel.videoCount,
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
