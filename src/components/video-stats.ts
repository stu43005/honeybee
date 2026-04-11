import { mongoose, type ReturnModelType } from "@typegoose/typegoose";
import type { AnyParamConstructor } from "@typegoose/typegoose/lib/types.js";
import moment from "moment";
import type { AccumulatorOperator, FilterQuery, PipelineStage } from "mongoose";
import assert from "node:assert";
import { MessageType, VideoStatsType } from "../interfaces.js";
import VideoModel from "../models/Video.js";
import BanActionModel from "../models/BanAction.js";
import ChatModel from "../models/Chat.js";
import MembershipModel from "../models/Membership.js";
import MembershipGiftModel from "../models/MembershipGift.js";
import MembershipGiftPurchaseModel from "../models/MembershipGiftPurchase.js";
import MilestoneModel from "../models/Milestone.js";
import PollModel from "../models/Poll.js";
import RaidModel from "../models/Raid.js";
import RemoveChatActionModel from "../models/RemoveChatAction.js";
import SuperChatModel from "../models/SuperChat.js";
import SuperStickerModel from "../models/SuperSticker.js";
import VideoStatsModel, {
  SCRAPE_DURATION_VIDEOID,
  VideoStatsFlags,
  type VideoStats,
} from "../models/VideoStats.js";
import VideoUserStatsModel from "../models/VideoUserStats.js";
import type { Application } from "../modules/application.js";
import type { AgendaModule } from "../modules/schedule.js";

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
        const records = await updateStats(
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
        if (type.messageType === MessageType.Membership) {
          await incVideoHbStats(records, "totalMembers");
        }
      },
    })),
    ...messageTypes
      .filter((type) => type.calcUsersTotal)
      .map((type) => ({
        name: `video stats - ${VideoStatsType.UsersSync} - ${type.messageType}`,
        interval: "1 minute",
        async job() {
          await syncVideoUserStats(type.messageType, type.model);
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
                VideoUserStatsModel,
                {
                  match: {
                    videoId: {
                      $in: Array.from(updateUsersVideoIds),
                    },
                    messageType: type.messageType,
                  },
                  labels: {
                    videoId: "$videoId",
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
          const records = await updateStats(
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
          await incVideoHbStats(records, "totalSuperChatAmountJpy");
        },
      })),
    ...messageTypes
      .filter((type) => type.calcAmount)
      .map((type) => ({
        name: `video stats - ${VideoStatsType.PurchaseAmountTotal} - ${type.messageType}`,
        interval: "1 minute",
        async job() {
          const records = await updateStats(
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
          if (type.messageType === MessageType.MembershipGiftPurchase) {
            await incVideoHbStats(records, "totalGifts");
          }
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
      cron.job,
      {
        lockLifetime: 20 * 60 * 1000,
      }
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

async function syncVideoUserStats<T extends AnyParamConstructor<any>>(
  messageType: MessageType,
  model: ReturnModelType<T>
) {
  const start = performance.now();

  const lastRecord = await VideoStatsModel.findOne(
    {
      type: VideoStatsType.UsersSync,
      messageType: messageType,
    },
    {
      lastId: 1,
    },
    {
      readPreference: "secondaryPreferred",
    }
  ).sort({ lastId: -1 });
  let lastId = lastRecord?.lastId;

  const newDocs = await model.aggregate<{
    videoId: string;
    authorChannelId: string;
    authorType: string;
    lastId: mongoose.mongo.ObjectId;
  }>(
    [
      {
        $match: {
          ...(lastId ? { _id: { $gt: lastId } } : null),
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 300_000 },
      {
        $group: {
          _id: {
            videoId: "$originVideoId",
            authorChannelId: "$authorChannelId",
          },
          authorType: { $last: "$authorType" },
          lastId: { $last: "$_id" },
        },
      },
      {
        $project: {
          _id: 0,
          videoId: "$_id.videoId",
          authorChannelId: "$_id.authorChannelId",
          authorType: 1,
          lastId: 1,
        },
      },
    ],
    { readPreference: "secondaryPreferred" }
  );

  if (newDocs.length > 0) {
    // Upsert into videouserstats
    const userBulk = newDocs.map<mongoose.mongo.AnyBulkWriteOperation>(
      (doc) => ({
        updateOne: {
          filter: {
            videoId: doc.videoId,
            messageType: messageType,
            authorChannelId: doc.authorChannelId,
          },
          update: {
            $setOnInsert: {
              videoId: doc.videoId,
              messageType: messageType,
              authorChannelId: doc.authorChannelId,
            },
            $set: {
              authorType: doc.authorType,
            },
          },
          upsert: true,
        },
      })
    );
    await VideoUserStatsModel.bulkWrite(userBulk, { ordered: false });

    // Find global max lastId
    lastId = newDocs[0].lastId;
    for (const doc of newDocs) {
      if (doc.lastId.toString() > lastId.toString()) {
        lastId = doc.lastId;
      }
    }
  }

  const durationMs = performance.now() - start;

  // Save lastId and duration to videostats
  await VideoStatsModel.bulkWrite([
    {
      updateOne: {
        filter: {
          videoId: SCRAPE_DURATION_VIDEOID,
          type: VideoStatsType.UsersSync,
          messageType: messageType,
        },
        update: {
          $setOnInsert: {
            videoId: SCRAPE_DURATION_VIDEOID,
            type: VideoStatsType.UsersSync,
            messageType: messageType,
          },
          $set: {
            lastId: lastId,
            value: durationMs / 1000,
          },
        },
        upsert: true,
      },
    },
  ]);
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

/**
 * Aggregate updateStats records by videoId and $inc the specified hbStats field.
 */
export async function incVideoHbStats(
  records: { _id: { videoId?: string }; value: number }[],
  field: "totalSuperChatAmountJpy" | "totalMembers" | "totalGifts"
) {
  if (records.length === 0) return;

  const videoTotals = new Map<string, number>();
  for (const record of records) {
    const videoId = record._id.videoId;
    if (!videoId) continue;
    videoTotals.set(videoId, (videoTotals.get(videoId) ?? 0) + record.value);
  }

  if (videoTotals.size === 0) return;

  const bulk = Array.from(videoTotals, ([videoId, value]) => ({
    updateOne: {
      filter: { id: videoId },
      update: { $inc: { [`hbStats.${field}`]: value } },
    },
  }));
  await VideoModel.bulkWrite(bulk);
}

/**
 * Recalculate hbStats (totalSuperChatAmountJpy, totalMembers, totalGifts) from VideoStats
 * and $set them on Video documents.
 */
export async function recalcVideoHbStats(videoIds: string[]) {
  if (videoIds.length === 0) return;

  const results = await VideoStatsModel.aggregate<{
    _id: string;
    totalSuperChatAmountJpy: number;
    totalMembers: number;
    totalGifts: number;
  }>(
    [
      {
        $match: {
          videoId: { $in: videoIds },
          $or: [
            {
              type: VideoStatsType.PurchaseAmountJpyTotal,
              messageType: {
                $in: [MessageType.SuperChat, MessageType.SuperSticker],
              },
            },
            {
              type: VideoStatsType.MessageTotal,
              messageType: MessageType.Membership,
            },
            {
              type: VideoStatsType.PurchaseAmountTotal,
              messageType: MessageType.MembershipGiftPurchase,
            },
          ],
        },
      },
      {
        $group: {
          _id: "$videoId",
          totalSuperChatAmountJpy: {
            $sum: {
              $cond: [
                { $eq: ["$type", VideoStatsType.PurchaseAmountJpyTotal] },
                "$value",
                0,
              ],
            },
          },
          totalMembers: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$type", VideoStatsType.MessageTotal] },
                    { $eq: ["$messageType", MessageType.Membership] },
                  ],
                },
                "$value",
                0,
              ],
            },
          },
          totalGifts: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$type", VideoStatsType.PurchaseAmountTotal] },
                    {
                      $eq: [
                        "$messageType",
                        MessageType.MembershipGiftPurchase,
                      ],
                    },
                  ],
                },
                "$value",
                0,
              ],
            },
          },
        },
      },
    ],
    { readPreference: "secondaryPreferred" }
  );

  const resultMap = new Map(results.map((r) => [r._id, r]));

  const bulk = videoIds.map((videoId) => {
    const stats = resultMap.get(videoId);
    return {
      updateOne: {
        filter: { id: videoId },
        update: {
          $set: {
            "hbStats.totalSuperChatAmountJpy":
              stats?.totalSuperChatAmountJpy ?? 0,
            "hbStats.totalMembers": stats?.totalMembers ?? 0,
            "hbStats.totalGifts": stats?.totalGifts ?? 0,
          },
        },
      },
    };
  });
  await VideoModel.bulkWrite(bulk);
}
