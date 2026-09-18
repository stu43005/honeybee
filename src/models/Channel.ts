import {
  getModelForClass,
  index,
  modelOptions,
  prop,
  type DocumentType,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses.js";
import { hyperlink } from "discord.js";
import { Channel as HolodexChannel } from "holodex.js";
import type { FilterQuery, FlattenMaps } from "mongoose";
import { setTimeout as sleep } from "node:timers/promises";
import {
  HOLODEX_ALL_VTUBERS,
  HOLODEX_FETCH_ORG,
  PUBSUB_RENEW_BEFORE_MS,
  PUBSUB_REQUEST_COOLDOWN_MS,
} from "../constants.js";
import { setIfDefine } from "../util.js";

@modelOptions({ schemaOptions: { collection: "channels" } })
@index({ organization: 1, isInactive: 1, hbIgnore: 1, deleted: 1 })
@index({ extraCrawl: 1, isInactive: 1, hbIgnore: 1, deleted: 1 })
@index({ updatedAt: 1 })
@index({ pubsubExpiresAt: 1, pubsubRequestedAt: 1 })
@index({ feedCrawledAt: 1 })
@index({ membersProbeNextAt: 1 })
@index({ hasMembersPlaylist: 1, membersCrawledAt: 1 })
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
  public isInactive?: boolean;

  @prop()
  public extraCrawl?: boolean;

  @prop()
  public hbIgnore?: boolean;

  @prop({ index: true })
  public crawledAt?: Date;

  @prop({ index: true })
  public holodexCrawledAt?: Date;

  /** When we last sent a subscribe request for this channel to the hub. */
  @prop()
  public pubsubRequestedAt?: Date;

  /** When the subscription expires, derived from the lease the verification carried. */
  @prop()
  public pubsubExpiresAt?: Date;

  /** When we last fetched this channel's RSS feed. */
  @prop()
  public feedCrawledAt?: Date;

  /**
   * Whether the channel has a members-only uploads playlist. Stays unset until
   * a probe reaches a conclusion, and the playlist scan only accepts `true`, so
   * an unset channel is never scanned.
   */
  @prop()
  public hasMembersPlaylist?: boolean;

  /**
   * Earliest time the existence probe may run for this channel again. A
   * conclusive answer pushes it out by the long TTL, an inconclusive one by the
   * short retry — storing the deadline rather than the last attempt is what
   * stops a failed re-probe from renewing a stale verdict for another week.
   */
  @prop()
  public membersProbeNextAt?: Date;

  /** When we last read the members-only uploads playlist. */
  @prop()
  public membersCrawledAt?: Date;

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

    if (HOLODEX_FETCH_ORG === HOLODEX_ALL_VTUBERS && this.organization)
      return true;
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

  /**
   * Renders one display line per channel id, joining the channel name (falling
   * back to "Unknown channel" when not yet crawled), preserving input order.
   * Shared by `/youtube-dm list` and the binding-confirmation DM.
   */
  public static async renderBoundChannelLines(
    this: ReturnModelType<typeof Channel>,
    channelIds: string[]
  ): Promise<string[]> {
    return Promise.all(
      channelIds.map(async (id) => {
        const channel = await this.findByChannelId(id);
        return `• ${channel?.name ?? "Unknown channel"} (${id})`;
      })
    );
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
   * Channels that need their pubsub subscription renewed: the subscription is
   * near expiry (or was never established), and no request went out recently.
   *
   * The sort puts channels without a `pubsubRequestedAt` (never requested)
   * first and otherwise the least recently requested first, so a channel that
   * always fails drops to the back of the queue after each attempt instead of
   * holding the front of it.
   */
  public static findPubsubRenewalCandidates(
    this: ReturnModelType<typeof Channel>,
    limit: number,
    now: Date = new Date()
  ) {
    return this.findSubscribed()
      .and([
        {
          $or: [
            { pubsubExpiresAt: null },
            {
              pubsubExpiresAt: {
                $lt: new Date(now.getTime() + PUBSUB_RENEW_BEFORE_MS),
              },
            },
          ],
        },
        {
          $or: [
            { pubsubRequestedAt: null },
            {
              pubsubRequestedAt: {
                $lt: new Date(now.getTime() - PUBSUB_REQUEST_COOLDOWN_MS),
              },
            },
          ],
        },
      ])
      .sort({ pubsubRequestedAt: 1 })
      .limit(limit)
      .select("id name");
  }

  /**
   * Channels whose RSS feed is due a fetch: the least recently fetched first,
   * with never-fetched channels (null sorts first) ahead of them.
   */
  public static findFeedPollCandidates(
    this: ReturnModelType<typeof Channel>,
    limit: number
  ) {
    return this.findSubscribed()
      .sort({ feedCrawledAt: 1 })
      .limit(limit)
      .select("id name");
  }

  /**
   * Channels due an existence probe for their members-only uploads playlist.
   * The stored timestamp is a deadline, not a history: a conclusive answer sets
   * it a week out and an inconclusive one an hour out, so this single
   * comparison gives both a long cache for answers and a short retry for
   * failures.
   */
  public static findMembersProbeCandidates(
    this: ReturnModelType<typeof Channel>,
    limit: number,
    now: Date = new Date()
  ) {
    return this.findSubscribed()
      .and([
        {
          $or: [
            { membersProbeNextAt: null },
            { membersProbeNextAt: { $lt: now } },
          ],
        },
      ])
      .sort({ membersProbeNextAt: 1 })
      .limit(limit)
      .select("id name");
  }

  /**
   * Channels whose members-only uploads playlist should be read. Restricted to
   * a confirmed `true` so channels without memberships never consume a slot
   * that costs a quota unit; that keeps the daily spend equal to the batch size
   * regardless of how many channels have no members playlist.
   */
  public static findMembersPollCandidates(
    this: ReturnModelType<typeof Channel>,
    limit: number
  ) {
    return this.findSubscribed()
      .and([{ hasMembersPlaylist: true }])
      .sort({ membersCrawledAt: 1 })
      .limit(limit)
      .select("id name");
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

      const delay =
        backoffSchedule[Math.min(attempt, backoffSchedule.length - 1)];
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
