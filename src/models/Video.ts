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
  type HoneybeeResult
} from "../interfaces";
import { setIfDefine } from "../util";
import ChannelModel, { Channel } from "./Channel";

@modelOptions({ schemaOptions: { collection: "videos" } })
export class Video extends TimeStamps {
  @prop({ required: true, unique: true })
  public id!: string;

  @prop({ required: true, index: true })
  public channelId!: string;

  @prop({ ref: () => Channel })
  public channel: Ref<Channel>;

  @prop({ required: true })
  public title!: string;

  @prop({ index: true })
  public topic?: string;

  @prop({ required: true, index: true })
  public status!: string;

  @prop({ required: true })
  public duration!: number;

  @prop()
  public liveViewers?: LiveViewers;

  @prop({ index: true })
  public publishedAt?: Date;

  @prop({ required: true, index: true })
  public availableAt?: Date;

  @prop({ index: true })
  public scheduledStart?: Date;

  @prop({ index: true })
  public actualStart?: Date;

  @prop({ index: true })
  public actualEnd?: Date;

  @prop({ required: true, index: true })
  public hbStatus?: string;

  @prop({ index: true })
  public hbErrorCode?: string;

  @prop()
  public hbStats?: Stats;

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
          channelId: stream.channelId,
          channel: channel,
          liveViewers: {
            max: stream.liveViewers,
            last: stream.liveViewers,
          },
          hbStatus: HoneybeeStatus.Created,
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
        $max: {
          "liveViewers.max": stream.liveViewers,
        },
      },
      {
        upsert: true,
      }
    );
  }

  public static async updateStatus(
    this: ReturnModelType<typeof Video>,
    videoId: string,
    status: HoneybeeStatus
  ) {
    await this.updateOne(
      {
        id: videoId,
      },
      {
        $set: {
          hbStatus: status,
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
        },
        $inc: {
          "hbStats.handled": result.result?.handled ?? 0,
          "hbStats.errors": result.result?.errors ?? 0,
        },
      }
    );
  }
}

export class LiveViewers {
  @prop({ required: true })
  max!: number;

  @prop({ required: true })
  last!: number;
}

export class Stats {
  @prop({ required: true })
  handled!: number;

  @prop({ required: true })
  errors!: number;
}

export default getModelForClass(Video);
