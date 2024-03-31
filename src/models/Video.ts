import type { Masterchat } from "@stu43005/masterchat";
import {
  getModelForClass,
  modelOptions,
  prop,
  type Ref,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";
import { Video as HolodexVideo } from "holodex.js";
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
  public status!: string;

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
          channelId: stream.channelId,
          channel: channel,
          hbStatus: HoneybeeStatus.Created,
          hbStart: new Date(),
        },
        $set: {
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
    if ("viewCount" in metadata) {
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
    await this.updateOne(
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
  }
}

export default getModelForClass(Video);
