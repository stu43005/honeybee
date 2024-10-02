import { mongoose, type ReturnModelType } from "@typegoose/typegoose";
import type { AnyParamConstructor } from "@typegoose/typegoose/lib/types";
import Fastify from "fastify";
import { VideoStatus } from "holodex.js";
import moment from "moment-timezone";
import type { AccumulatorOperator, FilterQuery, PipelineStage } from "mongoose";
import PQueue from "p-queue";
import { Gauge, Registry, type Metric, type MetricValue } from "prom-client";
import { MessageType } from "../interfaces";
import BanAction from "../models/BanAction";
import Channel from "../models/Channel";
import Chat from "../models/Chat";
import Membership from "../models/Membership";
import MembershipGift from "../models/MembershipGift";
import MembershipGiftPurchase from "../models/MembershipGiftPurchase";
import Milestone from "../models/Milestone";
import RemoveChatAction from "../models/RemoveChatAction";
import SuperChat from "../models/SuperChat";
import SuperSticker from "../models/SuperSticker";
import Video, { LiveStatus } from "../models/Video";
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

type MessageTypeModel = {
  messageType: MessageType;
  model: ReturnModelType<AnyParamConstructor<any>>;
  calcUsersTotal?: boolean;
  calcAmount?: boolean;
  calcJpyAmount?: boolean;
};
const messageTypes: MessageTypeModel[] = [
  { messageType: MessageType.Chat, model: Chat, calcUsersTotal: true },
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
    calcUsersTotal: true,
    calcAmount: true,
  },
  {
    messageType: MessageType.Milestone,
    model: Milestone,
  },
  {
    messageType: MessageType.SuperChat,
    model: SuperChat,
    calcUsersTotal: true,
    calcAmount: false,
    calcJpyAmount: true,
  },
  {
    messageType: MessageType.SuperSticker,
    model: SuperSticker,
    calcUsersTotal: true,
    calcAmount: false,
    calcJpyAmount: true,
  },
];
const actions: Record<string, ReturnModelType<AnyParamConstructor<any>>> = {
  banAction: BanAction,
  removeChatAction: RemoveChatAction,
  // bannerAction: BannerAction,
  // modeChange: ModeChange,
  // placeholder: Placeholder,
  // poll: Poll,
  // raid: Raid,
  // errorLog: ErrorLog,
};

export async function metrics() {
  const disconnect = await initMongo();
  const queue = getQueueInstance("honeybee", { isWorker: false });
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
    honeybee_scrape_duration_seconds: new Gauge({
      registers: [register],
      name: "honeybee_scrape_duration_seconds",
      help: "Data collect time in seconds",
      labelNames: ["metric_name", "type"],
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
      method = "inc",
    }: {
      match?: FilterQuery<any>;
      groupBy?: PipelineStage.Group["$group"];
      labels: Partial<LabelValues<HoneybeeMetricLabels<M>, any>>;
      value: AccumulatorOperator;
      fetchAll?: boolean;
      reset?: boolean;
      method?: "inc" | "set";
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
          gauge[method](labels, value);
        } else if (typeof value === "bigint") {
          if (value > Number.MAX_SAFE_INTEGER) {
            throw new TypeError("can't convert BigInt to number");
          }
          gauge[method](labels, Number(value));
        } else if (value instanceof Long) {
          if (value.greaterThan(Number.MAX_SAFE_INTEGER)) {
            throw new TypeError("can't convert Long to number");
          }
          gauge[method](labels, value.toInt());
        } else if (value instanceof Date) {
          gauge.set(labels, value.getTime() / 1000);
        }
      }
      lastIdMap.set(idKey, records[records.length - 1].lastId);
    }
    return records;
  }

  async function wrapScrapeDuration<T>(
    metricName: string,
    type: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const start = performance.now();
    const result = await fn();
    const durationMs = performance.now() - start;
    metrics.honeybee_scrape_duration_seconds.set(
      {
        metric_name: metricName,
        type: type,
      },
      durationMs / 1000
    );
    return result;
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

  function getMessagesTotal() {
    let total = 0;
    const values = Object.values<MetricValue<string>>(
      (metrics.honeybee_messages_total as any).hashMap
    );
    for (const { value } of values) {
      total += value;
    }
    return total;
  }

  function removeOtherVideos(metric: Gauge<"videoId">, videoIds: Set<string>) {
    const values = Object.values<MetricValue<"videoId">>(
      (metric as any).hashMap
    );
    for (const { labels } of values) {
      if (labels.videoId && !videoIds.has(labels.videoId.toString())) {
        metric.remove(labels);
      }
    }
  }

  const lastFullCollect = {
    honeybee_messages_total: Date.now(),
    honeybee_users_total: 0,
    honeybee_purchase_amount_jpy_total: Date.now(),
    honeybee_purchase_amount_total: Date.now(),
    honeybee_actions_total: Date.now(),
  } satisfies Partial<Record<keyof typeof metrics, number>>;
  const recentUpdateUsersVideoIds = new Set<string>();

  async function _collect() {
    try {
      const messagesTotalMils = Math.max(
        1,
        Math.ceil(getMessagesTotal() / 1_000_000)
      );

      const resetTimeMs = 2 * 3_600_000 * messagesTotalMils;
      const force = Object.entries(lastFullCollect).find(
        ([, time]) => time + resetTimeMs < Date.now()
      )?.[0] as keyof typeof lastFullCollect | undefined;
      if (force) {
        metrics[force].reset();
      }
      const forceUsersTotal =
        force === "honeybee_users_total" ||
        lastFullCollect.honeybee_users_total === 0;
      if (forceUsersTotal) {
        metrics.honeybee_users_total.reset();
      }
      metrics.honeybee_scrape_duration_seconds.reset();

      const videoIds = new Set<string>();
      const channelIds = new Set<string>();

      const halfHourAgo = moment.tz("UTC").subtract(30, "minutes").toDate();
      const videos = await wrapScrapeDuration(
        "honeybee_video_info",
        "video",
        () =>
          Video.find({
            $or: [
              {
                status: { $in: LiveStatus },
                availableAt: {
                  $lt: moment.tz("UTC").add(48, "hours").toDate(),
                },
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
          })
      );

      metrics.honeybee_video_info.reset();
      metrics.honeybee_video_viewers.reset();
      metrics.honeybee_video_max_viewers.reset();
      metrics.honeybee_video_likes.reset();
      metrics.honeybee_video_start_time_seconds.reset();
      metrics.honeybee_video_actual_start_time_seconds.reset();
      metrics.honeybee_video_end_time_seconds.reset();
      metrics.honeybee_video_actual_end_time_seconds.reset();
      metrics.honeybee_video_duration_seconds.reset();

      if (videos.length > 0) {
        for (const video of videos) {
          videoIds.add(video.id);
          channelIds.add(video.channelId);

          metrics.honeybee_video_info.set(
            {
              videoId: video.id,
              channelId: video.channelId,
              title: video.title,
              topic: video.topic,
            },
            1
          );

          const videoIdLabel = { videoId: video.id };
          if (video.viewers !== undefined)
            metrics.honeybee_video_viewers.set(videoIdLabel, video.viewers);
          if (video.maxViewers !== undefined && video.maxViewers > 0)
            metrics.honeybee_video_max_viewers.set(
              videoIdLabel,
              video.maxViewers
            );
          if (video.likes !== undefined && video.likes > 0)
            metrics.honeybee_video_likes.set(videoIdLabel, video.likes);
          if (video.availableAt !== undefined)
            metrics.honeybee_video_start_time_seconds.set(
              videoIdLabel,
              video.availableAt.getTime() / 1000
            );
          if (video.actualStart !== undefined)
            metrics.honeybee_video_actual_start_time_seconds.set(
              videoIdLabel,
              video.actualStart.getTime() / 1000
            );
          if (
            video.hbEnd !== undefined &&
            ["Failed", "Finished"].includes(video.hbStatus)
          )
            metrics.honeybee_video_end_time_seconds.set(
              videoIdLabel,
              video.hbEnd.getTime() / 1000
            );
          if (video.actualEnd !== undefined)
            metrics.honeybee_video_actual_end_time_seconds.set(
              videoIdLabel,
              video.actualEnd.getTime() / 1000
            );

          // duration
          if (video.duration !== undefined && video.duration > 0)
            metrics.honeybee_video_duration_seconds.set(
              videoIdLabel,
              video.duration
            );
          else if (video.actualStart !== undefined)
            metrics.honeybee_video_duration_seconds.set(
              videoIdLabel,
              moment.tz("UTC").diff(video.actualStart, "second")
            );
        }
      }

      removeOtherVideos(metrics.honeybee_messages_total, videoIds);
      removeOtherVideos(metrics.honeybee_users_total, videoIds);
      removeOtherVideos(metrics.honeybee_purchase_amount_jpy_total, videoIds);
      removeOtherVideos(metrics.honeybee_purchase_amount_total, videoIds);
      removeOtherVideos(metrics.honeybee_actions_total, videoIds);

      let updateUsersVideoIds: string[];
      if (forceUsersTotal) {
        updateUsersVideoIds = [...videoIds];
        recentUpdateUsersVideoIds.clear();
      } else {
        const updateSize = Math.round(videoIds.size / 10 / messagesTotalMils);
        updateUsersVideoIds = [...videoIds]
          .filter((vid) => !recentUpdateUsersVideoIds.has(vid))
          .sort(() => Math.random() - 0.5)
          .slice(0, updateSize);
        if (updateUsersVideoIds.length < updateSize) {
          updateUsersVideoIds = updateUsersVideoIds.concat(
            [...videoIds]
              .filter((vid) => !updateUsersVideoIds.includes(vid))
              .sort(() => Math.random() - 0.5)
              .slice(0, updateSize - updateUsersVideoIds.length)
          );
          recentUpdateUsersVideoIds.clear();
        }
        for (const vid of updateUsersVideoIds)
          recentUpdateUsersVideoIds.add(vid);
      }

      promiseSettledCallback(
        await Promise.allSettled([
          ...messageTypes.map((type) =>
            wrapScrapeDuration(
              "honeybee_messages_total",
              type.messageType,
              () =>
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
                  fetchAll: force === "honeybee_messages_total",
                })
            )
          ),
          ...messageTypes
            .filter((type) => type.calcUsersTotal)
            .map((type) =>
              wrapScrapeDuration("honeybee_users_total", type.messageType, () =>
                updateMetrics("honeybee_users_total", type.model, {
                  match: {
                    originVideoId: {
                      $in: updateUsersVideoIds,
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
                  method: "set",
                })
              )
            ),
          ...messageTypes
            .filter((type) => type.calcJpyAmount)
            .map((type) =>
              wrapScrapeDuration(
                "honeybee_purchase_amount_jpy_total",
                type.messageType,
                () =>
                  updateMetrics(
                    "honeybee_purchase_amount_jpy_total",
                    type.model,
                    {
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
                      fetchAll: force === "honeybee_purchase_amount_jpy_total",
                    }
                  )
              )
            ),
          ...messageTypes
            .filter((type) => type.calcAmount)
            .map((type) =>
              wrapScrapeDuration(
                "honeybee_purchase_amount_total",
                type.messageType,
                () =>
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
                    fetchAll: force === "honeybee_purchase_amount_total",
                  })
              )
            ),
          ...Object.entries(actions).map(([actionType, model]) =>
            wrapScrapeDuration("honeybee_actions_total", actionType, () =>
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
                fetchAll: force === "honeybee_actions_total",
              })
            )
          ),
        ]),
        () => void 0,
        (reason) => console.error(reason)
      );

      const channels = await wrapScrapeDuration(
        "honeybee_channel_info",
        "channel",
        () =>
          Channel.find({
            $or: [
              Channel.SubscribedQuery,
              {
                id: {
                  $in: [...channelIds],
                },
              },
            ],
          })
      );

      metrics.honeybee_channel_info.reset();
      metrics.honeybee_channel_subscribers.reset();

      if (channels.length > 0) {
        for (const channel of channels) {
          channelIds.add(channel.id);

          metrics.honeybee_channel_info.set(
            {
              channelId: channel.id,
              name: channel.name,
              englishName: channel.englishName,
              organization: channel.organization,
              group: channel.group,
              avatarUrl: channel.avatarUrl,
            },
            1
          );

          const channelIdLabel = { channelId: channel.id };
          if (
            channel.subscriberCount !== undefined &&
            channel.subscriberCount > 0
          )
            metrics.honeybee_channel_subscribers.set(
              channelIdLabel,
              channel.subscriberCount
            );
        }
      }

      if (force) {
        lastFullCollect[force] = Date.now();
      }
      if (forceUsersTotal) {
        lastFullCollect.honeybee_users_total = Date.now();
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
