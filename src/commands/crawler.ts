import fastifyExpress from "@fastify/express";
import { mongoose } from "@typegoose/typegoose";
import type { Job } from "agenda";
import Fastify from "fastify";
import {
  ExtraData,
  VideoStatus,
  VideoType,
  type Channel as HolodexChannel,
} from "holodex.js";
import moment from "moment-timezone";
import { setTimeout } from "timers/promises";
import YouTubeNotifier from "youtube-notification";
import {
  CRAWLER_ROOT_URL,
  HOLODEX_ALL_VTUBERS,
  HOLODEX_FETCH_ORG,
  HOLODEX_MAX_UPCOMING_HOURS,
  YOUTUBE_PUBSUB_SECRET,
} from "../constants";
import ChannelModel from "../models/Channel";
import VideoModel from "../models/Video";
import { initMongo } from "../modules/db";
import { getHolodex } from "../modules/holodex";
import { getAgenda } from "../modules/schedule";
import {
  updateChannelFromYoutube,
  updateVideoFromYoutube,
} from "../modules/youtube";

export async function runCrawler() {
  const holoapi = getHolodex();
  const disconnectFromMongo = await initMongo();
  const agenda = getAgenda();
  await agenda.start();
  const fastify = Fastify({
    logger: false,
    disableRequestLogging: true,
  });
  await fastify.register(fastifyExpress);

  process.on("SIGTERM", async () => {
    console.log("quitting crawler (SIGTERM) ...");

    try {
      await fastify.close();
      await agenda.drain();
      await disconnectFromMongo();
    } catch (err) {
      console.error("crawler failed to shut down gracefully", err);
    }
    process.exit(0);
  });

  fastify.get("/healthz", async function (request, reply) {
    if (
      mongoose.connection.readyState !== mongoose.ConnectionStates.connected
    ) {
      throw new Error("mongoose not ready.");
    }
    return "ok";
  });

  //#region holodex

  async function getCheckChannel() {
    if (HOLODEX_FETCH_ORG === HOLODEX_ALL_VTUBERS) {
      return () => true;
    }

    const crawlChannels: string[] = (
      await ChannelModel.findSubscribed().select("id")
    ).map((channel) => channel.id);

    return (channel: HolodexChannel) => {
      return (
        channel.organization === HOLODEX_FETCH_ORG ||
        crawlChannels.includes(channel.channelId)
      );
    };
  }

  const JOB_HOLODEX_UPDATE_LIVE = "crawler holodex update live";
  agenda.define(JOB_HOLODEX_UPDATE_LIVE, async (job: Job): Promise<void> => {
    const checkChannel = await getCheckChannel();

    const liveAndUpcomingStreams = (
      await holoapi.getLiveVideos({
        org: HOLODEX_ALL_VTUBERS,
        max_upcoming_hours: HOLODEX_MAX_UPCOMING_HOURS,
        include: [ExtraData.Mentions, ExtraData.ChannelStats],
      })
    ).filter(
      (stream) =>
        checkChannel(stream.channel) || !!stream.mentions?.find(checkChannel)
    );
    for (const stream of liveAndUpcomingStreams) {
      await VideoModel.updateFromHolodex(stream);
    }
  });
  agenda.every("5 minutes", JOB_HOLODEX_UPDATE_LIVE);

  const JOB_HOLODEX_UPDATE_PAST = "crawler holodex update past";
  agenda.define(JOB_HOLODEX_UPDATE_PAST, async (job: Job): Promise<void> => {
    const checkChannel = await getCheckChannel();

    const pastStreams = (
      await holoapi.getVideos({
        org: HOLODEX_ALL_VTUBERS,
        status: VideoStatus.Past,
        type: VideoType.Stream,
        include: [
          ExtraData.LiveInfo,
          ExtraData.Mentions,
          ExtraData.ChannelStats,
        ],
        sort: "end_actual",
        limit: 100,
      })
    ).filter(
      (stream) =>
        checkChannel(stream.channel) || !!stream.mentions?.find(checkChannel)
    );
    for (const stream of pastStreams) {
      await VideoModel.updateFromHolodex(stream);
    }
  });
  agenda.every("10 minutes", JOB_HOLODEX_UPDATE_PAST);

  const JOB_HOLODEX_OUTDATE_VIDEO = "crawler holodex outdate video";
  agenda.define(JOB_HOLODEX_OUTDATE_VIDEO, async (job: Job): Promise<void> => {
    const needUpdate = await VideoModel.findLiveVideos()
      .where({
        $or: [
          {
            holodexCrawledAt: null,
          },
          {
            holodexCrawledAt: {
              $lt: moment.tz("UTC").subtract(20, "minutes").toDate(),
            },
          },
        ],
      })
      .sort({ holodexCrawledAt: 1 })
      .limit(1);
    if (needUpdate.length > 0) {
      try {
        const stream = await holoapi.getVideo(needUpdate[0].id);
        if (stream) {
          await VideoModel.updateFromHolodex(stream);
        }
      } catch (error) {
        needUpdate[0].holodexCrawledAt = new Date();
        await needUpdate[0].save();
        throw new Error(
          `[ERROR] An error occurred while updating the past video (${needUpdate[0].id}): ${error}`
        );
      }
    }
  });
  agenda.every("10 minutes", JOB_HOLODEX_OUTDATE_VIDEO);

  const JOB_HOLODEX_UPDATE_CHANNELS = "crawler holodex update channels";
  agenda.define(
    JOB_HOLODEX_UPDATE_CHANNELS,
    {
      lockLifetime: moment.duration(10, "minutes").asMilliseconds(),
    },
    async (job: Job): Promise<void> => {
      let offset = 0;
      const limit = 50;
      while (true) {
        const channels: HolodexChannel[] = await holoapi.getChannels({
          org: HOLODEX_FETCH_ORG,
          type: "vtuber",
          limit,
          offset,
        });
        for (const channel of channels) {
          await ChannelModel.updateFromHolodex(channel);
        }
        if (channels.length < limit) break;
        offset += channels.length;
        await setTimeout(moment.duration(5, "minutes").asMilliseconds());
        await job.touch();
      }
    }
  );
  agenda.every("1 day", JOB_HOLODEX_UPDATE_CHANNELS);

  const JOB_HOLODEX_OUTDATE_CHANNEL = "crawler holodex outdate channel";
  agenda.define(
    JOB_HOLODEX_OUTDATE_CHANNEL,
    async (job: Job): Promise<void> => {
      const needUpdate = await ChannelModel.findSubscribed()
        .where({
          $or: [
            {
              holodexCrawledAt: null,
            },
            {
              holodexCrawledAt: {
                $lt: moment.tz("UTC").subtract(20, "minutes").toDate(),
              },
            },
          ],
        })
        .sort({ holodexCrawledAt: 1 })
        .limit(1);
      if (needUpdate.length > 0) {
        try {
          const channel = await holoapi.getChannel(needUpdate[0].id);
          if (channel) {
            await ChannelModel.updateFromHolodex(channel);
          }
        } catch (error) {
          needUpdate[0].holodexCrawledAt = new Date();
          await needUpdate[0].save();
          throw new Error(
            `[ERROR] An error occurred while updating the channel (${needUpdate[0].id}): ${error}`
          );
        }
      }
    }
  );
  agenda.every("1 hour", JOB_HOLODEX_OUTDATE_CHANNEL);

  //#endregion holodex

  //#region youtube pubsub

  const enabledYtPubsub = !!CRAWLER_ROOT_URL;
  const ytNotifier = new YouTubeNotifier({
    hubCallback: new URL(
      "./notifications/youtube",
      CRAWLER_ROOT_URL
    ).toString(),
    secret: YOUTUBE_PUBSUB_SECRET,
    middleware: true,
  });
  fastify.use("/notifications/youtube", ytNotifier.listener());

  async function subscribeYtPubsub() {
    if (!enabledYtPubsub) return;
    const channels = await ChannelModel.findSubscribed().select("id name");
    for (const channel of channels) {
      await setTimeout(250);
      console.log(`Subscribing: [${channel.id}] ${channel.name}`);
      ytNotifier.subscribe(channel.id);
    }
  }

  if (enabledYtPubsub) {
    const JOB_YOUTUBE_PUBSUB_SUBSCRIBE = "crawler youtube pubsub subscribe";
    agenda.define(
      JOB_YOUTUBE_PUBSUB_SUBSCRIBE,
      async (job: Job): Promise<void> => {
        await subscribeYtPubsub();
      }
    );
    agenda.every("12 hours", JOB_YOUTUBE_PUBSUB_SUBSCRIBE);
  }

  ytNotifier.on("subscribe", (data) => {
    console.log(`Subscribed: ${data.channel} (lease=${data.lease_seconds}s)`);
  });
  ytNotifier.on("unsubscribe", (data) => {
    console.log(`Unsubscribed: ${data.channel}`);
  });
  ytNotifier.on("denied", (data) => {
    console.log(`Subscription denied: ${data.channel}`);
  });
  ytNotifier.on("notified", async (data) => {
    console.log(
      `Pubsub: ${data.channel.name} (${data.channel.id}) new video: [${data.video.id}] ${data.video.title}`
    );
    try {
      const result = await VideoModel.updateFromNotification(data);
      if (result.modifiedCount > 0) {
        console.log(`Already seen this video: ${data.video.id}`);
      }
      await updateVideoFromYoutube([data.video.id]);
    } catch (error) {
      console.error(`An error occurred:`, error);
    }
  });

  //#endregion youtube pubsub

  //#region youtube

  const JOB_YOUTUBE_UPDATE_VIDEOS = "crawler youtube update";
  agenda.define(JOB_YOUTUBE_UPDATE_VIDEOS, async (job: Job): Promise<void> => {
    const videoIds = Array.from(
      new Set<string>([
        ...(
          await VideoModel.find({ status: VideoStatus.New }).select("id")
        ).map((video) => video.id),
        ...(
          await VideoModel.findLiveVideos()
            .sort({ crawledAt: 1 })
            .limit(50)
            .select("id")
        ).map((video) => video.id),
      ])
    );
    const batch: string[][] = [];
    while (videoIds.length) batch.push(videoIds.splice(0, 50));
    await Promise.all(
      batch.map((perBatch) => updateVideoFromYoutube(perBatch))
    );
  });
  agenda.every("1 minute", JOB_YOUTUBE_UPDATE_VIDEOS);

  const JOB_YOUTUBE_UPDATE_CHANNELS = "crawler youtube update channels";
  agenda.define(
    JOB_YOUTUBE_UPDATE_CHANNELS,
    async (job: Job): Promise<void> => {
      const channelIds = Array.from(
        new Set<string>([
          ...(
            await ChannelModel.find()
              .sort({ crawledAt: 1 })
              .limit(50)
              .select("id")
          ).map((channel) => channel.id),
        ])
      );
      const batch: string[][] = [];
      while (channelIds.length) batch.push(channelIds.splice(0, 50));
      await Promise.all(
        batch.map((perBatch) => updateChannelFromYoutube(perBatch))
      );
    }
  );
  agenda.every("10 minute", JOB_YOUTUBE_UPDATE_CHANNELS);

  //#endregion youtube

  await fastify.listen({
    port: Number(process.env.PORT || 17835),
    host: "0.0.0.0",
  });

  console.log(
    `crawler is ready (org=${HOLODEX_FETCH_ORG}, max_upcoming_hours=${HOLODEX_MAX_UPCOMING_HOURS})`
  );
}
