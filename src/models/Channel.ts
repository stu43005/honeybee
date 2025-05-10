import {
  getModelForClass,
  index,
  modelOptions,
  prop,
  type DocumentType,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";
import { hyperlink } from "discord.js";
import { Channel as HolodexChannel } from "holodex.js";
import type { FilterQuery, FlattenMaps } from "mongoose";
import { HOLODEX_ALL_VTUBERS, HOLODEX_FETCH_ORG } from "../constants";
import { setIfDefine } from "../util";

@modelOptions({ schemaOptions: { collection: "channels" } })
@index(
  { organization: 1, isInactive: 1, hbIgnore: 1 },
  {
    partialFilterExpression: {
      isInactive: { $ne: true },
      hbIgnore: { $ne: true },
    },
  }
)
@index(
  { extraCrawl: 1, isInactive: 1, hbIgnore: 1 },
  {
    partialFilterExpression: {
      extraCrawl: true,
      isInactive: { $ne: true },
      hbIgnore: { $ne: true },
    },
  }
)
@index({ updatedAt: 1 })
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

  @prop()
  public isInactive?: Boolean;

  @prop()
  public extraCrawl?: Boolean;

  @prop()
  public hbIgnore?: boolean;

  @prop({ index: true })
  public crawledAt?: Date;

  @prop({ index: true })
  public holodexCrawledAt?: Date;

  public getUrl(this: DocumentType<Channel>): string {
    return Channel.getUrl(this);
  }

  public getHyperlink(this: DocumentType<Channel>): string {
    return hyperlink(this.name, Channel.getUrl(this));
  }

  public static getUrl(
    channelOrId: DocumentType<Channel> | FlattenMaps<Channel> | string
  ): string {
    const channelId =
      typeof channelOrId === "string" ? channelOrId : channelOrId.id;
    return `https://www.youtube.com/channel/${channelId}`;
  }

  //#region find methods

  public static findByChannelId(
    this: ReturnModelType<typeof Channel>,
    channelId: string
  ) {
    return this.findOne({ id: channelId });
  }

  public static findByName(
    this: ReturnModelType<typeof Channel>,
    name: string,
    limit: number = 25
  ) {
    return this.findSubscribed()
      .and([
        {
          $or: [
            { name: { $regex: name, $options: "i" } },
            { englishName: { $regex: name, $options: "i" } },
            { organization: { $regex: name, $options: "i" } },
            { group: { $regex: name, $options: "i" } },
            { id: { $regex: name, $options: "i" } },
          ],
        },
      ])
      .sort({ subscriberCount: -1 })
      .limit(limit);
  }

  public static SubscribedQuery: Readonly<FilterQuery<Channel>> = Object.freeze(
    {
      $or: [
        {
          organization:
            HOLODEX_FETCH_ORG === HOLODEX_ALL_VTUBERS
              ? { $ne: null }
              : HOLODEX_FETCH_ORG,
          isInactive: { $ne: true },
          hbIgnore: { $ne: true },
        },
        {
          extraCrawl: true,
          isInactive: { $ne: true },
          hbIgnore: { $ne: true },
        },
      ],
    }
  );
  public static findSubscribed(this: ReturnModelType<typeof Channel>) {
    return this.find(this.SubscribedQuery);
  }

  //#endregion find methods

  //#region update methods

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
          ...setIfDefine("viewCount", channel.viewCount),
          ...setIfDefine("videoCount", channel.videoCount),
          ...setIfDefine("subscriberCount", channel.subscriberCount),
        },
        $set: {
          ...setIfDefine("englishName", channel.englishName),
          ...setIfDefine("organization", channel.organization),
          ...setIfDefine("group", channel.group),
          ...setIfDefine("isInactive", channel.isInactive),
          holodexCrawledAt: new Date(),
        },
      },
      {
        upsert: true,
        new: true,
      }
    );
  }

  //#endregion update methods
}

export default getModelForClass(Channel);
