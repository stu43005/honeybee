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
  errorCount!: number;
}

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
  public hbStatus?: string;

  @prop()
  public hbErrorCode?: string;

  @prop()
  public hbStart?: Date;

  @prop()
  public hbEnd?: Date;

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
          hbEnd: new Date(),
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
