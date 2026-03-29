import {
  getModelForClass,
  index,
  modelOptions,
  prop,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";
import { mongo, type FilterQuery } from "mongoose";
import { MessageAuthorType, MessageType, VideoStatsType } from "../interfaces";

export const SCRAPE_DURATION_VIDEOID = "scrape_duration";

export const VideoStatsFlags = Object.freeze({
  VideoStatsUserTotalProcessed: 0,
  VideoScalerProcessed: 1,
  ChatsArchiveProcessed: 2,
});

@modelOptions({ schemaOptions: { collection: "videostats" } })
@index(
  { videoId: 1, type: 1, messageType: 1, authorType: 1, currency: 1 },
  { unique: true }
)
@index({ type: 1, messageType: 1, lastId: -1 })
@index({ type: 1, updatedAt: -1, messageType: 1, authorType: 1 })
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

  @prop()
  public flag?: number;

  //#region find methods

  /**
   * Get video ids which do not have the specified flag bit set.
   */
  public static getVideoIdsWithoutFlag(
    this: ReturnModelType<typeof VideoStats>,
    match: FilterQuery<any>,
    flag: number
  ) {
    return this.aggregate<{
      videoId: string;
      statsId: mongo.BSON.ObjectId;
      lastId: mongo.BSON.ObjectId;
      flag: number;
    }>(
      [
        {
          $match: {
            $and: [match, { videoId: { $ne: SCRAPE_DURATION_VIDEOID } }],
          },
        },
        {
          $sort: { lastId: 1 },
        },
        {
          $group: {
            _id: "$videoId",
            statsId: { $last: "$_id" },
            lastId: { $last: "$lastId" },
            flag: { $last: "$flag" },
          },
        },
        {
          $match: {
            $or: [{ flag: null }, { flag: { $bitsAllClear: [flag] } }],
          },
        },
        {
          $project: {
            _id: 0,
            videoId: "$_id",
            statsId: 1,
            lastId: 1,
            flag: 1,
          },
        },
      ],
      { readPreference: "secondaryPreferred" }
    );
  }

  //#endregion find methods

  //#region update methods

  public static async setFlag(
    this: ReturnModelType<typeof VideoStats>,
    statsId: mongo.BSON.ObjectId,
    setBit: number,
    matchLastId?: mongo.BSON.ObjectId
  ) {
    await this.updateOne(
      {
        _id: statsId,
        ...(matchLastId ? { lastId: matchLastId } : {}),
      },
      [
        {
          $set: {
            flag: {
              $cond: {
                if: { $ne: [{ $type: "$flag" }, "int"] },
                then: 1 << setBit,
                else: { $bitOr: ["$flag", 1 << setBit] },
              },
            },
          },
        },
      ]
    );
  }

  public static async setFlags(
    this: ReturnModelType<typeof VideoStats>,
    entries: {
      statsId: mongo.BSON.ObjectId;
      lastId?: mongo.BSON.ObjectId;
    }[],
    setBit: number
  ) {
    await this.updateMany(
      {
        $or: entries.map((entry) => ({
          _id: entry.statsId,
          ...(entry.lastId ? { lastId: entry.lastId } : {}),
        })),
      },
      [
        {
          $set: {
            flag: {
              $cond: {
                if: { $ne: [{ $type: "$flag" }, "int"] },
                then: 1 << setBit,
                else: { $bitOr: ["$flag", 1 << setBit] },
              },
            },
          },
        },
      ]
    );
  }

  //#endregion update methods
}

export default getModelForClass(VideoStats);
