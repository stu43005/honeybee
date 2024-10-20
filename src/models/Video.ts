import type { Masterchat } from "@stu43005/masterchat";
import {
  DocumentType,
  getModelForClass,
  index,
  isDocument,
  modelOptions,
  prop,
  type Ref,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";
import { Video as HolodexVideo, VideoStatus } from "holodex.js";
import assert from "node:assert";
import { HoneybeeStatus, type HoneybeeResult } from "../interfaces";
import { setIfDefine } from "../util";
import ChannelModel, { Channel } from "./Channel";

export class Stats {
  @prop({ required: true })
  handled!: number;

  @prop({ required: true })
  errorCount!: number;
}

export const LiveStatus = Object.freeze([
  VideoStatus.Upcoming,
  VideoStatus.Live,
]);

@modelOptions({ schemaOptions: { collection: "videos" } })
@index(
  { availableAt: 1 },
  {
    partialFilterExpression: {
      status: { $in: LiveStatus },
    },
  }
)
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
  public uploadedVideo?: boolean;

  @prop()
  public premiere?: boolean;

  @prop()
  public memberLimited?: boolean;

  @prop()
  public deleted?: boolean;

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
    if (!this.isLive()) {
      return 0;
    }
    return Math.max(1, this.hbReplica ?? 1);
  }

  public isFreeChat(this: DocumentType<Video>): boolean {
    return (
      /(?:free\s?chat|chat\s?room|schedule|チャットルーム|ふりーちゃっと|フリーチャット|雑談部屋)/i.test(
        this.title
      ) || this.topic === "FreeChat"
    );
  }

  public isLive(this: DocumentType<Video>): boolean {
    return LiveStatus.includes(this.status);
  }

  public getTimeSeconds(this: DocumentType<Video>, timestamp: Date): number {
    if (!this.actualStart || timestamp < this.actualStart) return 0;
    return Math.floor(
      (timestamp.getTime() - this.actualStart.getTime()) / 1000
    );
  }

  public getUrl(this: DocumentType<Video>, timeSecond?: number): string {
    return (
      `https://youtu.be/${this.id}` + (timeSecond ? `?t=${timeSecond}` : "")
    );
  }

  //#region find methods

  public static findByVideoId(
    this: ReturnModelType<typeof Video>,
    videoId: string
  ) {
    return this.findOne({ id: videoId }).populate("channel");
  }

  public static findLiveVideos(this: ReturnModelType<typeof Video>) {
    return this.find({
      status: { $in: LiveStatus },
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
          ...setIfDefine("viewers", stream.liveViewers),
        },
        $set: {
          ...setIfDefine("description", stream.description),
          ...setIfDefine("topic", stream.topic),
          ...setIfDefine("status", stream.status),
          ...setIfDefine("duration", stream.duration),
          ...setIfDefine("publishedAt", stream.publishedAt),
          ...setIfDefine("availableAt", stream.availableAt),
          ...setIfDefine("scheduledStart", stream.scheduledStart),
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
    result: HoneybeeResult
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

  public static async updateFromNotification(
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
        },
      },
      {
        upsert: true,
      }
    );
  }

  //#endregion update methods
}

export default getModelForClass(Video);
