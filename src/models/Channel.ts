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
import { setTimeout as sleep } from "node:timers/promises";
import { HOLODEX_ALL_VTUBERS, HOLODEX_FETCH_ORG } from "../constants";
import { setIfDefine } from "../util";

@modelOptions({ schemaOptions: { collection: "channels" } })
@index(
  { organization: 1, isInactive: 1, hbIgnore: 1, deleted: 1 },
  {
    partialFilterExpression: {
      isInactive: { $ne: true },
      hbIgnore: { $ne: true },
      deleted: { $ne: true },
    },
  }
)
@index(
  { extraCrawl: 1, isInactive: 1, hbIgnore: 1, deleted: 1 },
  {
    partialFilterExpression: {
      extraCrawl: true,
      isInactive: { $ne: true },
      hbIgnore: { $ne: true },
      deleted: { $ne: true },
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

  @prop({ index: true })
  public customUrl?: string;

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
  public deleted?: boolean;

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

  public isSubscribed(this: DocumentType<Channel>): boolean {
    if (this.isInactive) return false;
    if (this.hbIgnore) return false;
    if (this.deleted) return false;

    if (HOLODEX_FETCH_ORG === HOLODEX_ALL_VTUBERS && this.organization) return true;
    if (this.organization === HOLODEX_FETCH_ORG) return true;
    if (this.extraCrawl) return true;

    return false;
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

  public static findByHandle(
    this: ReturnModelType<typeof Channel>,
    handle: string
  ) {
    return this.findOne({ customUrl: handle.toLowerCase() });
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
            { customUrl: { $regex: name, $options: "i" } },
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
          deleted: { $ne: true },
        },
        {
          extraCrawl: true,
          isInactive: { $ne: true },
          hbIgnore: { $ne: true },
          deleted: { $ne: true },
        },
      ],
    }
  );
  public static findSubscribed(this: ReturnModelType<typeof Channel>) {
    return this.find(this.SubscribedQuery);
  }

  /**
   * Polls `findByChannelId(channelId)` until the document has a non-null
   * `crawledAt`, or the timeout elapses. Returns the latest snapshot on
   * timeout (which may still have `crawledAt: null`), or `null` if no
   * document exists. Throws if `signal` is aborted.
   *
   * @param options.timeoutMs Total wait budget in ms. Default: 600_000 (10 min).
   * @param options.signal AbortSignal to cancel the wait.
   * @param options.backoffSchedule Internal test seam — delays between polls.
   *   Production callers should leave this unset to use the default
   *   5s→10s→15s→20s→25s→30s schedule.
   */
  public static async waitForCrawl(
    this: ReturnModelType<typeof Channel>,
    channelId: string,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      backoffSchedule?: readonly number[];
    }
  ): Promise<DocumentType<Channel> | null> {
    const timeoutMs = options?.timeoutMs ?? 600_000;
    const signal = options?.signal;
    const backoffSchedule = options?.backoffSchedule ?? [
      5_000, 10_000, 15_000, 20_000, 25_000, 30_000,
    ];
    if (backoffSchedule.length === 0) {
      throw new Error("backoffSchedule must contain at least one delay");
    }
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let latest: DocumentType<Channel> | null = null;

    while (true) {
      signal?.throwIfAborted();

      latest = await this.findByChannelId(channelId);
      if (latest?.crawledAt) {
        return latest;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return latest;
      }

      const delay = backoffSchedule[Math.min(attempt, backoffSchedule.length - 1)];
      const waitMs = Math.min(delay, remaining);
      await sleep(waitMs, undefined, { signal });
      attempt++;
    }
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
