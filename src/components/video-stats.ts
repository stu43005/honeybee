import { mongoose, type ReturnModelType } from "@typegoose/typegoose";
import type { AnyParamConstructor } from "@typegoose/typegoose/lib/types";
import moment from "moment";
import type { AccumulatorOperator, FilterQuery, PipelineStage } from "mongoose";
import assert from "node:assert";
import { MessageType, VideoStatsType } from "../interfaces";
import BanActionModel from "../models/BanAction";
import ChatModel from "../models/Chat";
import MembershipModel from "../models/Membership";
import MembershipGiftModel from "../models/MembershipGift";
import MembershipGiftPurchaseModel from "../models/MembershipGiftPurchase";
import MilestoneModel from "../models/Milestone";
import PollModel from "../models/Poll";
import RaidModel from "../models/Raid";
import RemoveChatActionModel from "../models/RemoveChatAction";
import SuperChatModel from "../models/SuperChat";
import SuperStickerModel from "../models/SuperSticker";
import VideoStatsModel, {
  SCRAPE_DURATION_VIDEOID,
  VideoStatsFlags,
  type VideoStats,
} from "../models/VideoStats";
import type { Application } from "../modules/application";
import type { AgendaModule } from "../modules/schedule";

type MessageTypeModel = {
  messageType: MessageType;
  model: ReturnModelType<AnyParamConstructor<any>>;
  calcUsersTotal?: boolean;
  calcAmount?: boolean;
  calcJpyAmount?: boolean;
};
const messageTypes: MessageTypeModel[] = [
  { messageType: MessageType.Chat, model: ChatModel, calcUsersTotal: true },
  {
    messageType: MessageType.Membership,
    model: MembershipModel,
  },
  {
    messageType: MessageType.MembershipGift,
    model: MembershipGiftModel,
  },
  {
    messageType: MessageType.MembershipGiftPurchase,
    model: MembershipGiftPurchaseModel,
    calcUsersTotal: true,
    calcAmount: true,
  },
  {
    messageType: MessageType.Milestone,
    model: MilestoneModel,
  },
  {
    messageType: MessageType.SuperChat,
    model: SuperChatModel,
    calcUsersTotal: true,
    calcAmount: true,
    calcJpyAmount: true,
  },
  {
    messageType: MessageType.SuperSticker,
    model: SuperStickerModel,
    calcUsersTotal: true,
    calcAmount: true,
    calcJpyAmount: true,
  },
];
const actionTypes: MessageTypeModel[] = [
  {
    messageType: MessageType.BanAction,
    model: BanActionModel,
  },
  {
    messageType: MessageType.RemoveChatAction,
    model: RemoveChatActionModel,
  },
  {
    messageType: MessageType.Poll,
    model: PollModel,
  },
  {
    messageType: MessageType.Raid,
    model: RaidModel,
  },
  // bannerAction: BannerAction,
  // modeChange: ModeChange,
  // placeholder: Placeholder,
  // errorLog: ErrorLog,
];

export default function videoStats(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  const usersTotalSegments = 10;
  const crons: {
    name: string;
    interval: string;
    job: () => Promise<void>;
  }[] = [
    ...messageTypes.map((type) => ({
      name: `video stats - ${VideoStatsType.MessageTotal} - ${type.messageType}`,
      interval: "1 minute",
      async job() {
        await updateStats(
          VideoStatsType.MessageTotal,
          type.messageType,
          type.model,
          {
            labels: {
              videoId: "$originVideoId",
              authorType: "$authorType",
            },
            value: { $sum: 1 },
          }
        );
      },
    })),
    ...messageTypes
      .filter((type) => type.calcUsersTotal)
      .flatMap((type) =>
        Array.from({ length: usersTotalSegments }, (_, i) => i).map(
          (segment) => ({
            name: `video stats - ${VideoStatsType.UsersTotal} - ${type.messageType} - segment ${segment}`,
            interval: `${Array.from(
              { length: Math.floor(60 / usersTotalSegments) },
              (_, i) => i
            )
              .map(
                (i) => i * usersTotalSegments + (segment % usersTotalSegments)
              )
              .join(",")} * * * *`,
            async job() {
              const stats = await VideoStatsModel.getVideoIdsWithoutFlag(
                {
                  type: VideoStatsType.MessageTotal,
                  messageType: type.messageType,
                  updatedAt: {
                    $gte: moment.tz("UTC").subtract(1, "hour").toDate(),
                  },
                },
                VideoStatsFlags.VideoStatsUserTotalProcessed
              );

              const updateUsersVideoIds = new Set(
                stats
                  .filter(
                    ({ videoId }) =>
                      hashStringToSegment(
                        `${type.messageType}${videoId}`,
                        usersTotalSegments
                      ) === segment
                  )
                  .map(({ videoId }) => videoId)
              );

              if (updateUsersVideoIds.size === 0) {
                return;
              }

              await updateStats(
                VideoStatsType.UsersTotal,
                type.messageType,
                type.model,
                {
                  match: {
                    originVideoId: {
                      $in: Array.from(updateUsersVideoIds),
                    },
                  },
                  groupBy: {
                    _id: {
                      authorChannelId: "$authorChannelId",
                      videoId: "$originVideoId",
                    },
                    authorType: {
                      $last: "$authorType",
                    },
                  },
                  labels: {
                    videoId: "$_id.videoId",
                    authorType: "$authorType",
                  },
                  value: { $sum: 1 },
                  fetchAll: true,
                }
              );

              await VideoStatsModel.setFlags(
                stats.filter(({ videoId }) => updateUsersVideoIds.has(videoId)),
                VideoStatsFlags.VideoStatsUserTotalProcessed
              );
            },
          })
        )
      ),
    ...messageTypes
      .filter((type) => type.calcJpyAmount)
      .map((type) => ({
        name: `video stats - ${VideoStatsType.PurchaseAmountJpyTotal} - ${type.messageType}`,
        interval: "1 minute",
        async job() {
          await updateStats(
            VideoStatsType.PurchaseAmountJpyTotal,
            type.messageType,
            type.model,
            {
              labels: {
                videoId: "$originVideoId",
                authorType: "$authorType",
                currency: "$currency",
              },
              value: { $sum: "$jpyAmount" },
            }
          );
        },
      })),
    ...messageTypes
      .filter((type) => type.calcAmount)
      .map((type) => ({
        name: `video stats - ${VideoStatsType.PurchaseAmountTotal} - ${type.messageType}`,
        interval: "1 minute",
        async job() {
          await updateStats(
            VideoStatsType.PurchaseAmountTotal,
            type.messageType,
            type.model,
            {
              labels: {
                videoId: "$originVideoId",
                authorType: "$authorType",
                currency: "$currency",
              },
              value: { $sum: "$amount" },
            }
          );
        },
      })),
    ...actionTypes.map((type) => ({
      name: `video stats - ${VideoStatsType.ActionsTotal} - ${type.messageType}`,
      interval: "1 minute",
      async job() {
        await updateStats(
          VideoStatsType.ActionsTotal,
          type.messageType,
          type.model,
          {
            labels: {
              videoId: "$originVideoId",
            },
            value: { $sum: 1 },
          }
        );
      },
    })),
  ];

  for (const cron of crons) {
    agenda.define(
      cron.name,
      {
        lockLifetime: 20 * 60 * 1000,
      },
      cron.job
    );
    agenda.every(cron.interval, cron.name);
  }
}

function hashStringToSegment(str: string, segment: number): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash) % segment;
}

type LabelName = Exclude<
  keyof VideoStats,
  "updatedAt" | "createdAt" | "type" | "messageType" | "value" | "lastId"
>;

async function updateStats<T extends AnyParamConstructor<any>>(
  type: VideoStatsType,
  messageType: MessageType,
  model: ReturnModelType<T>,
  {
    match,
    value,
    labels: groupId,
    groupBy,
    fetchAll = false,
    method = "$inc",
  }: {
    match?: FilterQuery<any>;
    groupBy?: PipelineStage.Group["$group"];
    labels: {
      [K in LabelName]?: string;
    };
    value: AccumulatorOperator;
    fetchAll?: boolean;
    method?: "$inc" | "$set";
  }
) {
  if (fetchAll) {
    method = "$set";
  }

  const lastRecord = await VideoStatsModel.findOne(
    {
      type: type,
      messageType: messageType,
    },
    {
      lastId: 1,
    },
    {
      readPreference: "secondaryPreferred",
    }
  ).sort({ lastId: -1 });
  const lastId = lastRecord?.lastId;

  function* buildPipeline(): Generator<PipelineStage, any, undefined> {
    const matches: FilterQuery<any> = {
      ...(lastId && !fetchAll ? { _id: { $gt: lastId } } : null),
      ...match,
    };
    if (Object.keys(matches).length > 0) {
      yield { $match: matches };
    }
    yield { $sort: { _id: 1 } };
    if (!fetchAll) {
      yield { $limit: 300_000 };
    }
    if (groupBy) {
      yield {
        $group: {
          ...groupBy,
          lastId: { $last: "$_id" },
        },
      };
      yield { $sort: { lastId: 1 } };
      yield {
        $group: {
          _id: groupId,
          value: value,
          lastId: { $last: "$lastId" },
        },
      };
    } else {
      yield {
        $group: {
          _id: groupId,
          value: value,
          lastId: { $last: "$_id" },
        },
      };
    }
    yield { $sort: { lastId: 1 } };
  }

  const start = performance.now();
  const records = await model.aggregate<{
    _id: {
      [K in LabelName]?: string;
    };
    value: any;
    lastId: mongoose.mongo.ObjectId;
  }>(Array.from(buildPipeline()), {
    readPreference: "secondaryPreferred",
  });
  const durationMs = performance.now() - start;

  const bulk = records
    .map<mongoose.mongo.AnyBulkWriteOperation>((record) => {
      const { _id: labels, value, lastId } = record;
      return {
        updateOne: {
          filter: {
            videoId: labels.videoId,
            type: type,
            messageType: messageType,
            authorType: labels.authorType,
            currency: labels.currency,
          },
          update: {
            $setOnInsert: {
              videoId: labels.videoId,
              type: type,
              messageType: messageType,
              authorType: labels.authorType,
              currency: labels.currency,
            },
            $set: {
              lastId: lastId,
              ...(method === "$set" ? { value: value } : {}),
            },
            $unset: {
              flag: "",
            },
            ...(method === "$inc"
              ? {
                  $inc: { value: value },
                }
              : {}),
          },
          upsert: true,
        },
      };
    })
    .concat([
      {
        updateOne: {
          filter: {
            videoId: SCRAPE_DURATION_VIDEOID,
            type: type,
            messageType: messageType,
          },
          update: {
            $setOnInsert: {
              videoId: SCRAPE_DURATION_VIDEOID,
              type: type,
              messageType: messageType,
            },
            $set: {
              value: durationMs / 1000,
            },
          },
          upsert: true,
        },
      },
    ]);

  if (bulk.length > 0) {
    await VideoStatsModel.bulkWrite(bulk);
  }
  return records;
}
