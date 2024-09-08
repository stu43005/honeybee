import { mongoose, type ReturnModelType } from "@typegoose/typegoose";
import type { AnyParamConstructor } from "@typegoose/typegoose/lib/types";
import Fastify from "fastify";
import { VideoStatus } from "holodex.js";
import moment from "moment-timezone";
import type { AccumulatorOperator, FilterQuery, PipelineStage } from "mongoose";
import PQueue from "p-queue";
import { Gauge, Registry, type Metric } from "prom-client";
import { MessageAuthorType, MessageType } from "../interfaces";
import BanAction from "../models/BanAction";
import BannerAction from "../models/BannerAction";
import Channel from "../models/Channel";
import Chat from "../models/Chat";
import ErrorLog from "../models/ErrorLog";
import Membership from "../models/Membership";
import MembershipGift from "../models/MembershipGift";
import MembershipGiftPurchase from "../models/MembershipGiftPurchase";
import Milestone from "../models/Milestone";
import ModeChange from "../models/ModeChange";
import Placeholder from "../models/Placeholder";
import Poll from "../models/Poll";
import Raid from "../models/Raid";
import RemoveChatAction from "../models/RemoveChatAction";
import SuperChat from "../models/SuperChat";
import SuperSticker from "../models/SuperSticker";
import Video from "../models/Video";
import { initMongo } from "../modules/db";
import { getQueueInstance } from "../modules/queue";
import { promiseSettledCallback, throttleWithReturnValue } from "../util";

const { Long } = mongoose.mongo;

type LabelValues<L extends string, V = string> = Record<L, V>;
type MetricLabels<M extends Metric> = M extends Metric<infer L> ? L : never;
type MetricPayload<L extends string> = {
  _id: LabelValues<L>;
  value: any;
  lastId: string;
};

function collectLabelValues<L extends string>(
  set: Set<string>,
  payloads: MetricPayload<L>[],
  label: NoInfer<L>
) {
  for (const payload of payloads) {
    const { _id: labels } = payload;
    set.add(labels[label]);
  }
  return set;
}

const purchaseMessageTypes: {
  messageType: MessageType;
  model: ReturnModelType<AnyParamConstructor<any>>;
}[] = [
  { messageType: MessageType.SuperChat, model: SuperChat },
  { messageType: MessageType.SuperSticker, model: SuperSticker },
];
const messageTypes: typeof purchaseMessageTypes = [
  { messageType: MessageType.Chat, model: Chat },
  {
    messageType: MessageType.Membership,
    model: Membership,
  },
  {
    messageType: MessageType.MembershipGift,
    model: MembershipGift,
  },
  {
    messageType: MessageType.MembershipGiftPurchase,
    model: MembershipGiftPurchase,
  },
  {
    messageType: MessageType.Milestone,
    model: Milestone,
  },
  ...purchaseMessageTypes,
];
const actions: Record<string, ReturnModelType<AnyParamConstructor<any>>> = {
  banAction: BanAction,
  removeChatAction: RemoveChatAction,
  bannerAction: BannerAction,
  modeChange: ModeChange,
  placeholder: Placeholder,
  poll: Poll,
  raid: Raid,
  errorLog: ErrorLog,
};

export async function metrics() {
  const disconnect = await initMongo();
  const queue = getQueueInstance({ isWorker: false });
  const fastify = Fastify({
    logger: true,
  });
  const lastIdMap = new Map<string, string>();
  const register = new Registry();

  process.on("SIGINT", async () => {
    console.log("quitting metrics (SIGTERM) ...");

    try {
      await fastify.close();
      await queue.close();
      await disconnect();
    } catch (err) {
      console.error("metrics failed to shut down gracefully", err);
    }
    process.exit(0);
  });

  const collectData = throttleWithReturnValue(_collectWithLock, 59_000);
  const checkHealth = throttleWithReturnValue(
    () => queue.checkHealth(),
    59_000
  );
  const metrics = {
    honeybee_channel_info: new Gauge({
      registers: [register],
      name: "honeybee_channel_info",
      help: "Labeled channel infomation",
      labelNames: [
        "channelId",
        "name",
        "englishName",
        "organization",
        "group",
        "avatarUrl",
      ],
      aggregator: "first",
      async collect() {
        await collectData();
      },
    }),
    honeybee_video_info: new Gauge({
      registers: [register],
      name: "honeybee_video_info",
      help: "Labeled video infomation",
      labelNames: ["videoId", "channelId", "title", "topic"],
      aggregator: "first",
      async collect() {
        await collectData();
      },
    }),
    honeybee_messages_total: new Gauge({
      registers: [register],
      name: "honeybee_messages_total",
      help: "Number of received chat messages",
      labelNames: ["videoId", "type", "authorType"],
      async collect() {
        await collectData();
      },
    }),
    honeybee_users_total: new Gauge({
      registers: [register],
      name: "honeybee_users_total",
      help: "Number of received user count",
      labelNames: ["videoId", "type", "authorType"],
      async collect() {
        await collectData();
      },
    }),
    honeybee_actions_total: new Gauge({
      registers: [register],
      name: "honeybee_actions_total",
      help: "Number of received actions",
      labelNames: ["videoId", "actionType"],
      async collect() {
        await collectData();
      },
    }),
    honeybee_purchase_amount_jpy_total: new Gauge({
      registers: [register],
      name: "honeybee_purchase_amount_jpy_total",
      help: "Sum of super chat value in jpy",
      labelNames: ["videoId", "type", "authorType", "currency"],
      async collect() {
        await collectData();
      },
    }),
    honeybee_purchase_amount_total: new Gauge({
      registers: [register],
      name: "honeybee_purchase_amount_total",
      help: "Sum of super chat value in origin currency",
      labelNames: ["videoId", "type", "authorType", "currency"],
      async collect() {
        await collectData();
      },
    }),
    honeybee_video_viewers: new Gauge({
      registers: [register],
      name: "honeybee_video_viewers",
      help: "Number of viedo viewer count",
      labelNames: ["videoId"],
      async collect() {
        await collectData();
      },
    }),
    honeybee_video_max_viewers: new Gauge({
      registers: [register],
      name: "honeybee_video_max_viewers",
      help: "Number of viedo max viewer count",
      labelNames: ["videoId"],
      async collect() {
        await collectData();
      },
    }),
    honeybee_video_likes: new Gauge({
      registers: [register],
      name: "honeybee_video_likes",
      help: "Number of viedo likes",
      labelNames: ["videoId"],
      async collect() {
        await collectData();
      },
    }),
    honeybee_video_start_time_seconds: new Gauge({
      registers: [register],
      name: "honeybee_video_start_time_seconds",
      help: "Start time of the video since unix epoch in seconds.",
      labelNames: ["videoId"],
      aggregator: "omit",
      async collect() {
        await collectData();
      },
    }),
    honeybee_video_actual_start_time_seconds: new Gauge({
      registers: [register],
      name: "honeybee_video_actual_start_time_seconds",
      help: "Actual start time of the video since unix epoch in seconds.",
      labelNames: ["videoId"],
      aggregator: "omit",
      async collect() {
        await collectData();
      },
    }),
    honeybee_video_end_time_seconds: new Gauge({
      registers: [register],
      name: "honeybee_video_end_time_seconds",
      help: "End time of the video since unix epoch in seconds.",
      labelNames: ["videoId"],
      aggregator: "omit",
      async collect() {
        await collectData();
      },
    }),
    honeybee_video_actual_end_time_seconds: new Gauge({
      registers: [register],
      name: "honeybee_video_actual_end_time_seconds",
      help: "Actual end time of the video since unix epoch in seconds.",
      labelNames: ["videoId"],
      aggregator: "omit",
      async collect() {
        await collectData();
      },
    }),
    honeybee_video_duration_seconds: new Gauge({
      registers: [register],
      name: "honeybee_video_duration_seconds",
      help: "Duration of the video in seconds.",
      labelNames: ["videoId"],
      async collect() {
        await collectData();
      },
    }),
    honeybee_channel_subscribers: new Gauge({
      registers: [register],
      name: "honeybee_channel_subscribers",
      help: "Number of channel subscribers",
      labelNames: ["channelId"],
      async collect() {
        await collectData();
      },
    }),
    honeybee_queue_active_jobs: new Gauge({
      registers: [register],
      name: "honeybee_queue_active_jobs",
      help: "Number of active jobs",
      async collect() {
        const { active } = await checkHealth();
        this.set(active);
      },
    }),
    honeybee_queue_waiting_jobs: new Gauge({
      registers: [register],
      name: "honeybee_queue_waiting_jobs",
      help: "Number of waiting jobs",
      async collect() {
        const { waiting } = await checkHealth();
        this.set(waiting);
      },
    }),
    honeybee_queue_delayed_jobs: new Gauge({
      registers: [register],
      name: "honeybee_queue_delayed_jobs",
      help: "Number of delayed jobs",
      async collect() {
        const { delayed } = await checkHealth();
        this.set(delayed);
      },
    }),
    honeybee_queue_failed_jobs: new Gauge({
      registers: [register],
      name: "honeybee_queue_failed_jobs",
      help: "Number of failed jobs",
      async collect() {
        const { failed } = await checkHealth();
        this.set(failed);
      },
    }),
  };

  type HoneybeeMetricLabels<M extends keyof typeof metrics> = MetricLabels<
    (typeof metrics)[M]
  >;

  async function updateMetrics<
    M extends keyof typeof metrics,
    T extends AnyParamConstructor<any>
  >(
    key: M,
    model: ReturnModelType<T>,
    {
      match,
      value,
      labels: groupId,
      groupBy,
      fetchAll = false,
      reset = false,
    }: {
      match?: FilterQuery<any>;
      groupBy?: PipelineStage.Group["$group"];
      labels: Partial<LabelValues<HoneybeeMetricLabels<M>, any>>;
      value: AccumulatorOperator;
      fetchAll?: boolean;
      reset?: boolean;
    }
  ): Promise<MetricPayload<HoneybeeMetricLabels<M>>[]> {
    const gauge: Gauge<string> = metrics[key];

    const idKey = `${key}_@${model.modelName}`;
    const lastId = lastIdMap.get(idKey);

    function* buildPipeline(): Generator<PipelineStage, any, undefined> {
      yield {
        $match: {
          ...(lastId && !fetchAll ? { _id: { $gt: lastId } } : null),
          ...match,
        },
      };
      yield { $sort: { _id: 1 } };
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

    const records = await model.aggregate<
      MetricPayload<HoneybeeMetricLabels<M>>
    >(Array.from(buildPipeline()));

    if (reset) {
      gauge.reset();
    }

    if (records.length > 0) {
      for (const record of records) {
        const { _id: labels, value } = record;
        if (typeof value === "number") {
          gauge.inc(labels, value);
        } else if (typeof value === "bigint") {
          if (value > Number.MAX_SAFE_INTEGER) {
            throw new TypeError("can't convert BigInt to number");
          }
          gauge.inc(labels, Number(value));
        } else if (value instanceof Long) {
          if (value.greaterThan(Number.MAX_SAFE_INTEGER)) {
            throw new TypeError("can't convert Long to number");
          }
          gauge.inc(labels, value.toInt());
        } else if (value instanceof Date) {
          gauge.set(labels, value.getTime() / 1000);
        }
      }
      lastIdMap.set(idKey, records[records.length - 1].lastId);
    }
    return records;
  }

  const pqueue = new PQueue({ concurrency: 1 });
  async function _collectWithLock() {
    if (pqueue.size > 0) {
      // Only wait for the previous collect task to unlock, but do not take any action.
      await pqueue.onEmpty();
      return;
    }
    await pqueue.add(_collect);
  }

  let lastFullCollect = 0;
  async function _collect() {
    try {
      const force = lastFullCollect + 3_600_000 < Date.now();

      const halfHourAgo = moment.tz("UTC").subtract(30, "minutes").toDate();
      const videoInfoRecords = await updateMetrics(
        "honeybee_video_info",
        Video,
        {
          match: {
            $or: [
              {
                $and: [
                  Video.LiveQuery,
                  {
                    availableAt: {
                      $lt: moment.tz("UTC").add(48, "hours").toDate(),
                    },
                  },
                ],
              },
              {
                status: VideoStatus.Past,
                actualEnd: { $gt: halfHourAgo },
              },
              {
                status: VideoStatus.Missing,
                hbEnd: { $gt: halfHourAgo },
              },
            ],
          },
          labels: {
            videoId: "$id",
            channelId: "$channelId",
            title: "$title",
            topic: "$topic",
          },
          value: { $last: 1 },
          fetchAll: true,
          reset: true,
        }
      );

      const videoIds = new Set<string>();
      const channelIds = new Set<string>();
      collectLabelValues(videoIds, videoInfoRecords, "videoId");
      collectLabelValues(channelIds, videoInfoRecords, "channelId");

      if (force) {
        metrics.honeybee_messages_total.reset();
        metrics.honeybee_purchase_amount_jpy_total.reset();
        metrics.honeybee_purchase_amount_total.reset();
        metrics.honeybee_actions_total.reset();
      }
      metrics.honeybee_users_total.reset();
      promiseSettledCallback(
        await Promise.allSettled([
          ...messageTypes.map((type) =>
            updateMetrics("honeybee_messages_total", type.model, {
              match: {
                originVideoId: {
                  $in: [...videoIds],
                },
              },
              labels: {
                videoId: "$originVideoId",
                authorType: "$authorType",
                type: type.messageType,
              },
              value: { $sum: 1 },
              fetchAll: force,
            })
          ),
          ...messageTypes.map((type) =>
            updateMetrics("honeybee_users_total", type.model, {
              match: {
                originVideoId: {
                  $in: [...videoIds],
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
                type: type.messageType,
              },
              value: { $sum: 1 },
              fetchAll: true,
            })
          ),
          ...purchaseMessageTypes.map((type) =>
            updateMetrics("honeybee_purchase_amount_jpy_total", type.model, {
              match: {
                originVideoId: {
                  $in: [...videoIds],
                },
              },
              labels: {
                videoId: "$originVideoId",
                authorType: "$authorType",
                type: type.messageType,
                currency: "$currency",
              },
              value: { $sum: "$jpyAmount" },
              fetchAll: force,
            })
          ),
          ...purchaseMessageTypes.map((type) =>
            updateMetrics("honeybee_purchase_amount_total", type.model, {
              match: {
                originVideoId: {
                  $in: [...videoIds],
                },
              },
              labels: {
                videoId: "$originVideoId",
                authorType: "$authorType",
                type: type.messageType,
                currency: "$currency",
              },
              value: { $sum: "$amount" },
              fetchAll: force,
            })
          ),
          updateMetrics(
            "honeybee_purchase_amount_total",
            MembershipGiftPurchase,
            {
              match: {
                originVideoId: {
                  $in: [...videoIds],
                },
              },
              labels: {
                videoId: "$originVideoId",
                authorType: "$authorType",
                type: MessageType.MembershipGiftPurchase,
              },
              value: { $sum: "$amount" },
              fetchAll: force,
            }
          ),
          ...Object.entries(actions).map(([actionType, model]) =>
            updateMetrics("honeybee_actions_total", model, {
              match: {
                originVideoId: {
                  $in: [...videoIds],
                },
              },
              labels: {
                videoId: "$originVideoId",
                actionType: actionType,
              },
              value: { $sum: 1 },
              fetchAll: force,
            })
          ),
          updateMetrics("honeybee_video_viewers", Video, {
            match: {
              id: {
                $in: [...videoIds],
              },
            },
            labels: {
              videoId: "$id",
            },
            value: { $last: "$viewers" },
            fetchAll: true,
            reset: true,
          }),
          updateMetrics("honeybee_video_max_viewers", Video, {
            match: {
              id: {
                $in: [...videoIds],
              },
              maxViewers: { $gt: 0 },
            },
            labels: {
              videoId: "$id",
            },
            value: { $max: "$maxViewers" },
            fetchAll: true,
            reset: true,
          }),
          updateMetrics("honeybee_video_likes", Video, {
            match: {
              id: {
                $in: [...videoIds],
              },
              likes: { $gt: 0 },
            },
            labels: {
              videoId: "$id",
            },
            value: { $max: "$likes" },
            fetchAll: true,
            reset: true,
          }),
          updateMetrics("honeybee_video_start_time_seconds", Video, {
            match: {
              id: {
                $in: [...videoIds],
              },
            },
            labels: {
              videoId: "$id",
            },
            value: { $last: "$availableAt" },
            fetchAll: true,
            reset: true,
          }),
          updateMetrics("honeybee_video_actual_start_time_seconds", Video, {
            match: {
              id: {
                $in: [...videoIds],
              },
              actualStart: { $ne: null },
            },
            labels: {
              videoId: "$id",
            },
            value: { $last: "$actualStart" },
            fetchAll: true,
            reset: true,
          }),
          updateMetrics("honeybee_video_end_time_seconds", Video, {
            match: {
              id: {
                $in: [...videoIds],
              },
              hbStatus: {
                $in: ["Failed", "Finished"],
              },
              hbEnd: { $ne: null },
            },
            labels: {
              videoId: "$id",
            },
            value: { $last: "$hbEnd" },
            fetchAll: true,
            reset: true,
          }),
          updateMetrics("honeybee_video_actual_end_time_seconds", Video, {
            match: {
              id: {
                $in: [...videoIds],
              },
              actualEnd: { $ne: null },
            },
            labels: {
              videoId: "$id",
            },
            value: { $last: "$actualEnd" },
            fetchAll: true,
            reset: true,
          }),
          updateMetrics("honeybee_video_duration_seconds", Video, {
            match: {
              id: {
                $in: [...videoIds],
              },
            },
            labels: {
              videoId: "$id",
            },
            value: {
              $last: {
                $cond: {
                  if: "$duration",
                  then: "$duration",
                  else: {
                    $cond: {
                      if: "$actualStart",
                      then: {
                        $dateDiff: {
                          startDate: "$actualStart",
                          endDate: new Date(),
                          unit: "second",
                        },
                      },
                      else: null,
                    },
                  },
                },
              },
            },
            fetchAll: true,
            reset: true,
          }),
        ]),
        () => void 0,
        (reason) => console.error(reason)
      );

      const channelInfoRecords = await updateMetrics(
        "honeybee_channel_info",
        Channel,
        {
          match: {
            $or: [
              Channel.SubscribedQuery,
              {
                id: {
                  $in: [...channelIds],
                },
              },
            ],
          },
          labels: {
            channelId: "$id",
            name: "$name",
            englishName: "$englishName",
            organization: "$organization",
            group: "$group",
            avatarUrl: "$avatarUrl",
          },
          value: { $last: 1 },
          fetchAll: true,
          reset: true,
        }
      );

      collectLabelValues(channelIds, channelInfoRecords, "channelId");

      promiseSettledCallback(
        await Promise.allSettled([
          updateMetrics("honeybee_channel_subscribers", Channel, {
            match: {
              id: {
                $in: [...channelIds],
              },
              subscriberCount: { $gt: 0 },
            },
            labels: {
              channelId: "$id",
            },
            value: { $max: "$subscriberCount" },
            fetchAll: true,
            reset: true,
          }),
        ]),
        () => void 0,
        (reason) => console.error(reason)
      );

      if (force) {
        lastFullCollect = Date.now();
      }
    } catch (error) {
      console.error("[FATAL] Collect failed:", error);
      process.exit(1);
    }
  }

  fastify.get("/healthz", async function (request, reply) {
    if (
      mongoose.connection.readyState !== mongoose.ConnectionStates.connected
    ) {
      throw new Error("mongoose not ready.");
    }
    try {
      await queue.checkHealth();
    } catch (error) {
      throw new Error("bee-queue not ready.");
    }
    return "ok";
  });
  fastify.get("/metrics", async function (request, reply) {
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });

  await fastify.listen({
    port: Number(process.env.PORT || 3000),
    host: "0.0.0.0",
  });

  console.log(`metrics is ready`);
}
