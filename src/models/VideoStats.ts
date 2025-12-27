import { getModelForClass, index, modelOptions, prop } from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";
import { mongo } from "mongoose";
import { VideoStatsType, MessageType, MessageAuthorType } from "../interfaces";

export const SCRAPE_DURATION_VIDEOID = "scrape_duration";

@modelOptions({ schemaOptions: { collection: "videostats" } })
@index(
  { videoId: 1, type: 1, messageType: 1, authorType: 1, currency: 1 },
  { unique: true }
)
@index({ type: 1, messageType: 1, lastId: -1 })
export class VideoStats extends TimeStamps {
  @prop({ required: true })
  public videoId!: string;

  /**
   * `message_total`, `purchase_amount_jpy_total`, ...
   */
  @prop({ required: true })
  public type!: VideoStatsType;

  /**
   * `chat`, `superChat`, ...
   */
  @prop({ required: true })
  public messageType!: MessageType;

  /**
   * `owner`, `moderator`, `member`, `verified`, `other`
   */
  @prop()
  public authorType?: MessageAuthorType;

  /**
   * `USD`, `JPY`, ...
   */
  @prop()
  public currency?: string;

  @prop({ required: true, default: 0 })
  public value!: number;

  @prop()
  public lastId?: mongo.BSON.ObjectId;
}

export default getModelForClass(VideoStats);
