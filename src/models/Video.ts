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
import type { FilterQuery } from "mongoose";
import assert from "node:assert";
import type { NotifiedData } from "youtube-notification";
import {
  HoneybeeStatus,
  LiveViewersSource,
  type HoneybeeResult,
} from "../interfaces";
import { setIfDefine } from "../util";
import ChannelModel, { Channel } from "./Channel";
import LiveViewers from "./LiveViewers";

export class Stats {
  @prop({ required: true })
  handled!: number;

  @prop({ required: true })
  errorCount!: number;
}

@modelOptions({ schemaOptions: { collection: "videos" } })
@index({ status: 1, hbCleanedAt: 1 })
export class Video extends TimeStamps {
  @prop({ required: true, unique: true })
  public id!: string;

  @prop({ required: true, index: true })
  public channelId!: string;

  @prop({ ref: () => Channel })
  public channel?: Ref<Channel>;

  @prop({ required: true })
  public title!: string;

  @prop({ index: true })
  public topic?: string;

  @prop({ required: true, index: true })
  public status!: VideoStatus;

  @prop({ required: true })
  public duration!: number;

  @prop()
  public likes?: number;

  @prop()
  public publishedAt?: Date;

  @prop({ required: true, index: true })
  public availableAt?: Date;

  @prop()
  public scheduledStart?: Date;

  @prop()
  public actualStart?: Date;

  @prop()
  public actualEnd?: Date;

  @prop({ required: true, index: true })
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

  public async getChannel(this: DocumentType<Video>) {
    if (isDocument(this.channel)) {
      return this.channel;
    }
    const channel = await ChannelModel.findByChannelId(this.channelId);
    assert(channel, "Unable to get the channel.");
    return channel;
  }

  public isLive(this: DocumentType<Video>) {
    if (
      this.hbCleanedAt ||
      [VideoStatus.Past, VideoStatus.Missing].includes(this.status)
    ) {
      return false;
    }
    return true;
  }

  public static LiveQuerys: readonly FilterQuery<Video>[] = Object.freeze([
    {
      status: { $nin: [VideoStatus.Past, VideoStatus.Missing] },
      hbCleanedAt: null,
    },
  ]);
  public static findLiveVideos(this: ReturnModelType<typeof Video>) {
    return this.find({
      $or: [...this.LiveQuerys],
    });
  }

  public static findByVideoId(
    this: ReturnModelType<typeof Video>,
    videoId: string
  ) {
    return this.findOne({ id: videoId }).populate("channel");
  }

  public static async updateFromHolodex(
    this: ReturnModelType<typeof Video>,
    stream: HolodexVideo
  ) {
    const channel = await ChannelModel.updateFromHolodex(stream.channel);
    if (stream.liveViewers > 0) {
      await LiveViewers.create({
        originVideoId: stream.videoId,
        originChannelId: stream.channelId,
        viewers: stream.liveViewers,
        source: LiveViewersSource.Holodex,
      });
    }
    return await this.findOneAndUpdate(
      {
        id: stream.videoId,
      },
      {
        $setOnInsert: {
          id: stream.videoId,
          hbStatus: HoneybeeStatus.Created,
          hbStart: new Date(),
        },
        $set: {
          channel: channel,
          channelId: stream.channelId,
          ...setIfDefine("title", stream.title),
          ...setIfDefine("topic", stream.topic),
          ...setIfDefine("status", stream.status),
          ...setIfDefine("duration", stream.duration),
          ...setIfDefine("publishedAt", stream.publishedAt),
          ...setIfDefine("availableAt", stream.availableAt),
          ...setIfDefine("scheduledStart", stream.scheduledStart),
          ...setIfDefine("actualStart", stream.actualStart),
          ...setIfDefine("actualEnd", stream.actualEnd),
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
    if ("subscribers" in metadata && metadata.subscribers) {
      await ChannelModel.updateOne(
        { id: mc.channelId },
        {
          $max: {
            subscriberCount: metadata.subscribers,
          },
        }
      );
    }
    if ("viewCount" in metadata && typeof metadata.viewCount === "number") {
      const lastViewCount = await LiveViewers.findOne({
        originVideoId: mc.videoId,
        source: LiveViewersSource.Masterchat,
      }).sort({ createdAt: -1 });
      if (!lastViewCount || lastViewCount.viewers !== metadata.viewCount) {
        await LiveViewers.create({
          originVideoId: mc.videoId,
          originChannelId: mc.channelId,
          viewers: metadata.viewCount,
          source: LiveViewersSource.Masterchat,
        });
      }
    }
    if ("likes" in metadata && metadata.likes) {
      await this.updateOne(
        { id: mc.videoId },
        {
          $max: {
            likes: metadata.likes,
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
    const video = await this.findOneAndUpdate(
      {
        id: videoId,
      },
      {
        $set: {
          hbStatus: HoneybeeStatus.Finished,
          hbErrorCode: result.error,
          hbEnd: new Date(),
          hbCleanedAt: null,
        },
        $inc: {
          "hbStats.handled": result.result?.handled ?? 0,
          "hbStats.errorCount": result.result?.errors ?? 0,
        },
      }
    );
    if (video) {
      // set live viewers to 0
      await LiveViewers.create({
        originVideoId: video.id,
        originChannelId: video.channelId,
        viewers: 0,
        source: LiveViewersSource.Honeybee,
      });
    }
  }

  public static async updateFromNotification(
    this: ReturnModelType<typeof Video>,
    data: NotifiedData
  ) {
    return await this.updateOne(
      {
        id: data.video.id,
      },
      {
        $setOnInsert: {
          id: data.video.id,
          status: VideoStatus.New,
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
}

export default getModelForClass(Video);
