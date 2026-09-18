import type { Masterchat } from "@stu43005/masterchat";
import {
  getModelForClass,
  index,
  isDocument,
  modelOptions,
  prop,
  type DocumentType,
  type Ref,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses.js";
import { Video as HolodexVideo, VideoStatus } from "holodex.js";
import moment from "moment-timezone";
import type { FlattenMaps } from "mongoose";
import assert from "node:assert";
import { YOUTUBE_EXISTENCE_PROBE_RECENT_MS } from "../constants.js";
import {
  HoneybeeStatus,
  PrivacyStatus,
  UploadStatus,
  type HoneybeeResult,
} from "../interfaces.js";
import { setIfDefine } from "../util.js";
import ChannelModel, { Channel } from "./Channel.js";
import type { Raid } from "./Raid.js";

export class Stats {
  @prop({ required: true, default: 0 })
  handled!: number;

  @prop({ required: true, default: 0 })
  errorCount!: number;

  @prop()
  totalSuperChatAmountJpy?: number;

  @prop()
  totalMembers?: number;

  @prop()
  totalGifts?: number;

  @prop()
  chatsArchiveVersion?: number;
}

export const LiveStatus = Object.freeze([
  VideoStatus.Upcoming,
  VideoStatus.Live,
]);

export const EndedStatus = Object.freeze([
  VideoStatus.Past,
  VideoStatus.Missing,
]);

export const IsShortQuery = Object.freeze({
  duration: { $lte: 60 },
});
export const IsNotShortQuery = Object.freeze({
  duration: { $gt: 60 },
});

/**
 * One video as an official discovery source reports it. The RSS feed and
 * `playlistItems.list` both supply exactly these four values, which is the
 * whole reason neither path needs a `videos.list` call to create a document.
 */
export interface DiscoveredVideo {
  videoId: string;
  title: string;
  channelId: string;
  publishedAt?: Date;
}

@modelOptions({ schemaOptions: { collection: "videos" } })
@index(
  { availableAt: 1 },
  {
    partialFilterExpression: {
      status: { $in: LiveStatus },
    },
  }
)
// Non-partial companion to the partial availableAt index above: serves
// availableAt range queries that are NOT restricted to live/upcoming (the
// daily-videos writer scans a JST-day availableAt window across all statuses).
// The partial index cannot serve those, so this one covers every status.
@index({ availableAt: 1 }, { name: "availableAt_all" })
@index(
  { actualEnd: 1 },
  {
    partialFilterExpression: {
      status: VideoStatus.Past,
    },
  }
)
@index(
  { hbEnd: 1 },
  {
    partialFilterExpression: {
      status: VideoStatus.Missing,
    },
  }
)
@index(
  { detectedDeletionAt: 1 },
  {
    partialFilterExpression: {
      status: VideoStatus.Missing,
    },
  }
)
// Serves both existence-probe buckets (equality on `deleted`, range on
// `availableAt`) and the re-check query for heuristically-Missing videos, which
// skips `availableAt` entirely. Both sort on `crawledAt` after a range, so both
// fall back to an in-memory sort — but their limits are 5 and 2, which makes it
// a top-k sort with constant memory rather than a full one.
@index(
  { deleted: 1, availableAt: 1, crawledAt: 1 },
  {
    partialFilterExpression: {
      status: VideoStatus.Missing,
    },
  }
)
@index({ updatedAt: 1 })
@index({ channelId: 1, availableAt: -1 })
@index(
  { hbCleanedAt: 1, actualEnd: 1, hbEnd: 1 },
  {
    partialFilterExpression: {
      hbCleanedAt: null,
    },
  }
)
export class Video extends TimeStamps {
  @prop({ required: true, unique: true })
  public id!: string;

  @prop({ required: true })
  public channelId!: string;

  @prop({ ref: () => Channel })
  public channel?: Ref<Channel>;

  @prop({ required: true })
  public title!: string;

  @prop()
  public description?: string;

  @prop()
  public topic?: string;

  @prop({ required: true, index: true, default: VideoStatus.New })
  public status!: VideoStatus;

  @prop({ required: true, default: 0 })
  public duration!: number;

  @prop()
  public uploadStatus?: UploadStatus;

  @prop()
  public uploadedVideo?: boolean;

  @prop()
  public premiere?: boolean;

  @prop()
  public privacyStatus?: PrivacyStatus;

  @prop()
  public memberLimited?: boolean;

  @prop()
  public deleted?: boolean;

  @prop()
  public detectedDeletionAt?: Date;

  @prop()
  public likes?: number;

  @prop()
  public viewers?: number;

  @prop()
  public maxViewers?: number;

  @prop()
  public publishedAt?: Date;

  @prop({ required: true })
  public availableAt!: Date;

  @prop()
  public scheduledStart?: Date;

  @prop()
  public actualStart?: Date;

  @prop()
  public actualEnd?: Date;

  @prop({ required: true, default: HoneybeeStatus.Created })
  public hbStatus!: HoneybeeStatus;

  @prop()
  public hbErrorCode?: string;

  @prop()
  public hbStart?: Date;

  @prop()
  public hbEnd?: Date;

  @prop()
  public hbCleanedAt?: Date;

  @prop()
  public hbStats?: Stats;

  @prop({ default: 1 })
  public hbReplica?: number;

  @prop()
  public scaleUpAt?: Date;

  @prop()
  public hbRecordReplay?: boolean;

  @prop()
  public hbIgnore?: boolean;

  @prop({ index: true })
  public crawledAt?: Date;

  @prop()
  public holodexCrawledAt?: Date;

  public async getChannel(this: DocumentType<Video>) {
    if (isDocument(this.channel)) {
      return this.channel;
    }
    const channel = await ChannelModel.findByChannelId(this.channelId);
    assert(channel, "Unable to get the channel.");
    return channel;
  }

  public getReplicas(this: DocumentType<Video>): number {
    if (this.isLive()) {
      return Math.max(1, this.hbReplica ?? 1);
    }
    if (this.isNeedReplay()) {
      return 1;
    }
    return 0;
  }

  public isFreeChat(this: DocumentType<Video>): boolean {
    return (
      /(?:free\s?chat|chat\s?room|schedule|チャットルーム|ふりーちゃっと|フリーチャット|雑談部屋)/i.test(
        this.title
      ) || this.topic === "FreeChat"
    );
  }

  public isLive(this: DocumentType<Video>): boolean {
    return LiveStatus.includes(this.status) && !this.hbIgnore;
  }

  public isNeedReplay(this: DocumentType<Video>): boolean {
    return (
      this.status === VideoStatus.Past &&
      this.hbRecordReplay !== true &&
      !this.hbIgnore
    );
  }

  public static getTimeSeconds(
    video: DocumentType<Video> | FlattenMaps<Video>,
    timestamp: Date
  ): number {
    if (!video.actualStart || timestamp < new Date(video.actualStart)) return 0;
    return Math.floor(
      (timestamp.getTime() - new Date(video.actualStart).getTime()) / 1000
    );
  }

  public static getUrl(
    videoOrId: DocumentType<Video> | FlattenMaps<Video> | string,
    timeSecond?: number
  ): string {
    const videoId = typeof videoOrId === "string" ? videoOrId : videoOrId.id;
    return (
      `https://youtu.be/${videoId}` + (timeSecond ? `?t=${timeSecond}` : "")
    );
  }

  public static getVideoThumbnails(
    videoOrId: DocumentType<Video> | FlattenMaps<Video> | string,
    useWebP = false
  ): {
    /** 120w */
    default: string;
    /** 320w */
    medium: string;
    /** 640w */
    standard: string;
    /** 1280w */
    maxres: string;
    hq720: string;
  } {
    const videoId = typeof videoOrId === "string" ? videoOrId : videoOrId.id;
    const base = useWebP
      ? "https://i.ytimg.com/vi_webp"
      : "https://i.ytimg.com/vi";
    const ext = useWebP ? "webp" : "jpg";
    return {
      default: `${base}/${videoId}/default.${ext}`,
      medium: `${base}/${videoId}/mqdefault.${ext}`,
      standard: `${base}/${videoId}/sddefault.${ext}`,
      maxres: `${base}/${videoId}/maxresdefault.${ext}`,
      hq720: `${base}/${videoId}/hq720.${ext}`,
    };
  }

  //#region find methods

  public static findByVideoId(
    this: ReturnModelType<typeof Video>,
    videoId: string
  ) {
    return this.findOne({ id: videoId }).populate("channel");
  }

  public static findLiveVideos(
    this: ReturnModelType<typeof Video>,
    maxUpcomingHours: number | null = null
  ) {
    return this.find({
      status: { $in: LiveStatus },
      hbIgnore: { $ne: true },
      ...(maxUpcomingHours !== null
        ? {
            availableAt: {
              $lt: moment.tz("UTC").add(maxUpcomingHours, "hours").toDate(),
            },
          }
        : {}),
    });
  }

  public static findRecentlyEndedVideos(
    this: ReturnModelType<typeof Video>,
    maxEndedHours: number
  ) {
    const adjustedTime = moment
      .tz("UTC")
      .subtract(maxEndedHours, "hour")
      .toDate();
    return this.find({
      $or: [
        {
          status: VideoStatus.Past,
          actualEnd: { $gt: adjustedTime },
          uploadedVideo: { $ne: true },
          hbIgnore: { $ne: true },
        },
        {
          status: VideoStatus.Missing,
          hbEnd: { $gt: adjustedTime },
          uploadedVideo: { $ne: true },
          hbIgnore: { $ne: true },
        },
      ],
    });
  }

  public static findNeedReplayVideos(
    this: ReturnModelType<typeof Video>,
    maxEndedHours: number
  ) {
    const adjustedTime = moment
      .tz("UTC")
      .subtract(maxEndedHours, "hour")
      .toDate();
    return this.find({
      status: VideoStatus.Past,
      actualEnd: { $gt: adjustedTime },
      hbRecordReplay: { $ne: true },
      hbIgnore: { $ne: true },
    });
  }

  //#endregion find methods

  //#region update methods

  public static async updateFromHolodex(
    this: ReturnModelType<typeof Video>,
    stream: HolodexVideo
  ) {
    const channel = await ChannelModel.updateFromHolodex(stream.channel);
    return await this.findOneAndUpdate(
      {
        id: stream.videoId,
      },
      {
        $setOnInsert: {
          id: stream.videoId,
          hbStatus: HoneybeeStatus.Created,
          hbStart: new Date(),
          channel: channel,
          channelId: stream.channelId,
          ...setIfDefine("title", stream.title),
          ...setIfDefine("description", stream.description),
          ...setIfDefine("status", stream.status),
          ...setIfDefine("viewers", stream.liveViewers),
          ...setIfDefine("availableAt", stream.availableAt),
          ...setIfDefine("scheduledStart", stream.scheduledStart),
          hbIgnore: channel.hbIgnore,
        },
        $set: {
          ...setIfDefine("topic", stream.topic),
          ...setIfDefine("duration", stream.duration),
          ...setIfDefine("publishedAt", stream.publishedAt),
          ...setIfDefine("actualStart", stream.actualStart),
          ...setIfDefine("actualEnd", stream.actualEnd),
          holodexCrawledAt: new Date(),
        },
        $max: {
          ...setIfDefine("maxViewers", stream.liveViewers),
        },
      },
      {
        upsert: true,
        new: true,
      }
    );
  }

  public static async updateFromMasterchat(
    this: ReturnModelType<typeof Video>,
    mc: Masterchat
  ) {
    const metadata = await mc.fetchMetadataFromWatch(mc.videoId);
    if ("subscribers" in metadata && typeof metadata.subscribers === "number") {
      await ChannelModel.updateOne(
        { id: mc.channelId },
        {
          $max: {
            subscriberCount: metadata.subscribers,
          },
        }
      );
    }
    if (
      ("viewCount" in metadata && typeof metadata.viewCount === "number") ||
      ("likes" in metadata && typeof metadata.likes === "number")
    ) {
      await this.updateOne(
        { id: mc.videoId },
        {
          $set: {
            ...setIfDefine("viewers", metadata.viewCount),
          },
          $max: {
            ...setIfDefine("maxViewers", metadata.viewCount),
            ...setIfDefine("likes", metadata.likes),
          },
        }
      );
    }
  }

  public static async updateStatus(
    this: ReturnModelType<typeof Video>,
    videoId: string,
    status: HoneybeeStatus,
    error?: Error
  ) {
    await this.updateOne(
      {
        id: videoId,
      },
      {
        $set: {
          hbStatus: status,
          ...setIfDefine("hbErrorCode", error?.message),
          hbCleanedAt: null,
        },
      }
    );
  }

  public static async updateStatusFailed(
    this: ReturnModelType<typeof Video>,
    videoId: string,
    error: Error
  ) {
    await this.updateOne(
      {
        id: videoId,
      },
      {
        $set: {
          hbStatus: HoneybeeStatus.Failed,
          hbErrorCode: error.message,
          hbEnd: new Date(),
          hbCleanedAt: null,
        },
      }
    );
  }

  public static async updateResult(
    this: ReturnModelType<typeof Video>,
    videoId: string,
    result: HoneybeeResult,
    isReplay?: boolean
  ) {
    await this.updateOne(
      {
        id: videoId,
      },
      {
        $set: {
          viewers: 0,
          hbStatus: HoneybeeStatus.Finished,
          hbErrorCode: result.error,
          hbEnd: new Date(),
          hbCleanedAt: null,
          ...setIfDefine("hbRecordReplay", isReplay),
        },
        $inc: {
          "hbStats.handled": result.result?.handled ?? 0,
          "hbStats.errorCount": result.result?.errors ?? 0,
        },
        $max: {
          maxViewers: 0,
        },
      }
    );
  }

  public static async noticeFromNotification(
    this: ReturnModelType<typeof Video>,
    data: {
      video: {
        id: string;
        title: string;
      };
      channel: {
        id: string;
      };
    }
  ) {
    return await this.updateOne(
      {
        id: data.video.id,
      },
      {
        $setOnInsert: {
          id: data.video.id,
          status: VideoStatus.New,
          duration: 0,
          availableAt: new Date(),
          hbStatus: HoneybeeStatus.Created,
          hbStart: new Date(),
        },
        $set: {
          channelId: data.channel.id,
          channel: await ChannelModel.findByChannelId(data.channel.id),
          title: data.video.title,
          crawledAt: null,
        },
      },
      {
        upsert: true,
      }
    );
  }

  public static async noticeFromRaid(
    this: ReturnModelType<typeof Video>,
    raid: Raid
  ) {
    return await this.updateOne(
      {
        id: raid.originVideoId,
      },
      {
        $setOnInsert: {
          id: raid.originVideoId,
          status: VideoStatus.New,
          duration: 0,
          availableAt: new Date(),
          hbStatus: HoneybeeStatus.Created,
          hbStart: new Date(),
          channelId: "",
          title: "",
        },
        $set: {
          crawledAt: null,
        },
      },
      {
        upsert: true,
      }
    );
  }

  /**
   * Creates the videos this collection has never seen and leaves every existing
   * document untouched.
   *
   * Two layers, answering two different problems. The lookup is an
   * optimisation: a feed round carries 15 entries of which nearly all are
   * already known, and sending those to the database is pure waste. The insert
   * is where correctness lives: between the lookup and the write, pubsub or
   * another discovery round can create the very same video and hydrate it, and
   * an insert simply loses that race against the unique index instead of
   * overwriting a title or resetting `crawledAt`.
   *
   * Unlike every upsert path in this file, this runs schema validators, so a
   * document missing `title` or `channelId` is refused at the boundary rather
   * than written and then failing every later `save()`.
   */
  public static async noticeUnknownVideos(
    this: ReturnModelType<typeof Video>,
    entries: DiscoveredVideo[]
  ): Promise<void> {
    if (entries.length === 0) return;

    const ids = entries.map((entry) => entry.videoId);
    const known = new Set(
      (await this.find({ id: { $in: ids } }).select("id")).map(
        (video) => video.id
      )
    );
    const unknown = entries.filter((entry) => !known.has(entry.videoId));
    if (unknown.length === 0) return;

    const docs = unknown.map((entry) => ({
      id: entry.videoId,
      title: entry.title,
      channelId: entry.channelId,
      // `availableAt` is required with no default. It is only a starting value
      // — updateVideoFromYoutube overwrites it with actualStart/scheduledStart
      // /publishedAt — but it is indexed, so the source's real publish time
      // beats "now" for the feed entries that are already days old.
      availableAt: entry.publishedAt ?? new Date(),
    }));

    try {
      await this.insertMany(docs, { ordered: false });
    } catch (error) {
      // A duplicate key is the expected outcome of losing the race described
      // above, not a failure worth reporting. Anything else is real.
      const writeErrors = (error as { writeErrors?: { code?: number }[] })
        .writeErrors;
      const onlyDuplicates =
        Array.isArray(writeErrors) &&
        writeErrors.length > 0 &&
        writeErrors.every((writeError) => writeError.code === 11000);
      if (!onlyDuplicates) throw error;
    }
  }

  /**
   * One bucket of the existence probe: videos YouTube stopped returning,
   * split by whether they became available within the recent window so the far
   * larger old population cannot starve the recent one.
   *
   * `crawledAt: { $ne: null }` excludes documents with a pending hydration
   * request. A null there means someone (pubsub, via noticeFromNotification)
   * asked for a refresh that `crawler youtube update` has not served yet, and
   * null sorts first — so without this the probe would preferentially grab
   * exactly those documents and overwrite the request with its own timestamp.
   */
  public static findExistenceProbeCandidates(
    this: ReturnModelType<typeof Video>,
    recent: boolean,
    limit: number,
    now: Date = new Date()
  ) {
    const boundary = new Date(
      now.getTime() - YOUTUBE_EXISTENCE_PROBE_RECENT_MS
    );
    return this.find({
      status: VideoStatus.Missing,
      deleted: true,
      crawledAt: { $ne: null },
      availableAt: recent ? { $gte: boundary } : { $lt: boundary },
    })
      .sort({ crawledAt: 1 })
      .limit(limit)
      .select("id crawledAt");
  }

  /**
   * The Missing videos the existence probe deliberately leaves alone: the ones
   * a timeout heuristic marked, whose `deleted` was never set because YouTube
   * still returns them.
   *
   * An oEmbed probe cannot help here — the video is there, so it would answer
   * 200 forever and bounce the document New → Missing on every rotation. Only
   * videos.list can see whether the stream finally started or ended, so these
   * join the hydration candidate list instead and never leave Missing until
   * something really changed.
   */
  public static findMissingRecheckCandidates(
    this: ReturnModelType<typeof Video>,
    limit: number
  ) {
    return this.find({
      status: VideoStatus.Missing,
      // `$in` rather than `$ne: true`, to keep the equality shape the index can
      // use; it also matches documents where the field was never written.
      deleted: { $in: [null, false] },
    })
      .sort({ crawledAt: 1 })
      .limit(limit);
  }

  //#endregion update methods
}

export default getModelForClass(Video);
