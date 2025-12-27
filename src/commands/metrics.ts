import moment from "moment-timezone";
import PQueue from "p-queue";
import { Gauge, Registry } from "prom-client";
import {
  METRICS_MAX_ENDED_HOURS,
  METRICS_MAX_UPCOMING_HOURS,
} from "../constants";
import { VideoStatsType } from "../interfaces";
import ChannelModel from "../models/Channel";
import VideoModel, { type Video } from "../models/Video";
import VideoStatsModel, { SCRAPE_DURATION_VIDEOID } from "../models/VideoStats";
import { Application } from "../modules/application";
import { MongodbModule } from "../modules/db";
import { QueueModule } from "../modules/queue";
import { throttleWithReturnValue } from "../util";

export async function metrics() {
  const app = new Application();
  app.use(new MongodbModule());
  const { queue } = app.use(new QueueModule("honeybee", { isWorker: false }));
  const { server: fastify } = app.http;
  const register = new Registry();

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

  function setVideoMetrics(video: Video) {
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
      metrics.honeybee_video_max_viewers.set(videoIdLabel, video.maxViewers);
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
      metrics.honeybee_video_duration_seconds.set(videoIdLabel, video.duration);
    else if (video.actualStart !== undefined)
      metrics.honeybee_video_duration_seconds.set(
        videoIdLabel,
        moment.tz("UTC").diff(video.actualStart, "second")
      );
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

  async function _collect() {
    try {
      metrics.honeybee_scrape_duration_seconds.reset();

      const videoIds = new Set<string>();
      const channelIds = new Set<string>();

      metrics.honeybee_video_info.reset();
      metrics.honeybee_video_viewers.reset();
      metrics.honeybee_video_max_viewers.reset();
      metrics.honeybee_video_likes.reset();
      metrics.honeybee_video_start_time_seconds.reset();
      metrics.honeybee_video_actual_start_time_seconds.reset();
      metrics.honeybee_video_end_time_seconds.reset();
      metrics.honeybee_video_actual_end_time_seconds.reset();
      metrics.honeybee_video_duration_seconds.reset();

      await wrapScrapeDuration("video_info", "video", async () => {
        for await (const video of VideoModel.findLiveVideos(
          METRICS_MAX_UPCOMING_HOURS
        ).setOptions({ readPreference: "secondaryPreferred" })) {
          videoIds.add(video.id);
          channelIds.add(video.channelId);
          setVideoMetrics(video);
        }
        for await (const video of VideoModel.findRecentlyEndedVideos(
          METRICS_MAX_ENDED_HOURS
        ).setOptions({ readPreference: "secondaryPreferred" })) {
          videoIds.add(video.id);
          channelIds.add(video.channelId);
          setVideoMetrics(video);
        }
      });

      metrics.honeybee_messages_total.reset();
      metrics.honeybee_users_total.reset();
      metrics.honeybee_purchase_amount_jpy_total.reset();
      metrics.honeybee_purchase_amount_total.reset();
      metrics.honeybee_actions_total.reset();

      await wrapScrapeDuration("video_stats", "video", async () => {
        for await (const videoStats of VideoStatsModel.find(
          {
            videoId: { $in: Array.from(videoIds) },
          },
          null,
          { readPreference: "secondaryPreferred" }
        )) {
          switch (videoStats.type) {
            case VideoStatsType.MessageTotal:
              if (!videoStats.authorType) break;
              metrics.honeybee_messages_total.set(
                {
                  videoId: videoStats.videoId,
                  type: videoStats.messageType,
                  authorType: videoStats.authorType,
                },
                videoStats.value
              );
              break;
            case VideoStatsType.UsersTotal:
              if (!videoStats.authorType) break;
              metrics.honeybee_users_total.set(
                {
                  videoId: videoStats.videoId,
                  type: videoStats.messageType,
                  authorType: videoStats.authorType,
                },
                videoStats.value
              );
              break;
            case VideoStatsType.PurchaseAmountJpyTotal:
              if (!videoStats.authorType || !videoStats.currency) break;
              metrics.honeybee_purchase_amount_jpy_total.set(
                {
                  videoId: videoStats.videoId,
                  type: videoStats.messageType,
                  authorType: videoStats.authorType,
                  currency: videoStats.currency,
                },
                videoStats.value
              );
              break;
            case VideoStatsType.PurchaseAmountTotal:
              if (!videoStats.authorType) break;
              metrics.honeybee_purchase_amount_total.set(
                {
                  videoId: videoStats.videoId,
                  type: videoStats.messageType,
                  authorType: videoStats.authorType,
                  currency: videoStats.currency,
                },
                videoStats.value
              );
              break;
            case VideoStatsType.ActionsTotal:
              metrics.honeybee_actions_total.set(
                {
                  videoId: videoStats.videoId,
                  actionType: videoStats.messageType,
                },
                videoStats.value
              );
              break;
          }
        }
      });

      await wrapScrapeDuration("video_stats", "scrape_duration", async () => {
        for await (const videoStats of VideoStatsModel.find(
          {
            videoId: SCRAPE_DURATION_VIDEOID,
          },
          null,
          { readPreference: "secondaryPreferred" }
        )) {
          metrics.honeybee_scrape_duration_seconds.set(
            {
              metric_name: videoStats.type,
              type: videoStats.messageType,
            },
            videoStats.value
          );
        }
      });

      metrics.honeybee_channel_info.reset();
      metrics.honeybee_channel_subscribers.reset();

      await wrapScrapeDuration("channel_info", "channel", async () => {
        for await (const channel of ChannelModel.find(
          {
            $or: [
              ChannelModel.SubscribedQuery,
              {
                id: {
                  $in: [...channelIds],
                },
              },
            ],
          },
          null,
          { readPreference: "secondaryPreferred" }
        )) {
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
      });
    } catch (error) {
      console.error("[FATAL] Collect failed:", error);
      process.exit(1);
    }
  }

  fastify.get("/metrics", async function (request, reply) {
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });

  await app.init();

  console.log(`metrics is ready`);
}
