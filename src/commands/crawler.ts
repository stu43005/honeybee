import fastifyExpress from "@fastify/express";
import type { Job } from "agenda";
import {
  ExtraData,
  SortOrder,
  VideoStatus,
  VideoType,
  type Channel as HolodexChannel,
} from "holodex.js";
import moment from "moment-timezone";
import { setTimeout } from "timers/promises";
import YouTubeNotifier from "youtube-notification";
import {
  PUBLIC_BASE_URL,
  HOLODEX_ALL_VTUBERS,
  HOLODEX_FETCH_ORG,
  HOLODEX_MAX_UPCOMING_HOURS,
  YOUTUBE_PUBSUB_SECRET,
} from "../constants.js";
import ChannelModel from "../models/Channel.js";
import VideoModel from "../models/Video.js";
import { Application } from "../modules/application.js";
import { MongodbModule } from "../modules/db.js";
import { getHolodex } from "../modules/holodex.js";
import { AgendaModule } from "../modules/schedule.js";
import {
  updateChannelFromYoutube,
  updateVideoFromYoutube,
} from "../modules/youtube.js";

export async function runCrawler() {
  const holoapi = getHolodex();
  const app = new Application();
  app.use(new MongodbModule());
  const { agenda } = app.use(new AgendaModule());
  const { server: fastify } = app.http;
  await fastify.register(fastifyExpress);

  await app.init();

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
  agenda.define(JOB_HOLODEX_UPDATE_LIVE, async (_job: Job): Promise<void> => {
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
  void agenda.every("10 minutes", JOB_HOLODEX_UPDATE_LIVE);

  const JOB_HOLODEX_UPDATE_PAST = "crawler holodex update past";
  agenda.define(JOB_HOLODEX_UPDATE_PAST, async (_job: Job): Promise<void> => {
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
  void agenda.every("20 minutes", JOB_HOLODEX_UPDATE_PAST);

  /*
  const JOB_HOLODEX_OUTDATE_VIDEO = "crawler holodex outdate video";
  agenda.define(JOB_HOLODEX_OUTDATE_VIDEO, async (job: Job): Promise<void> => {
    const needUpdate = await VideoModel.findLiveVideos()
      .and([
        {
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
        },
      ])
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
  */

  const JOB_HOLODEX_UPDATE_CHANNELS = "crawler holodex update channels";
  agenda.define(
    JOB_HOLODEX_UPDATE_CHANNELS,
    async (job: Job): Promise<void> => {
      let offset = 0;
      const limit = 100;
      while (true) {
        const channels: HolodexChannel[] = await holoapi.getChannels({
          org: HOLODEX_FETCH_ORG,
          type: "vtuber",
          limit,
          offset,
          sort: "suborg",
          order: SortOrder.Ascending,
        });
        for (const channel of channels) {
          await ChannelModel.updateFromHolodex(channel);
        }
        if (channels.length < limit) break;
        offset += channels.length;

        for (let i = 0; i < 10; i++) {
          await setTimeout(moment.duration(1, "minutes").asMilliseconds());
          await job.touch();
        }
      }
    },
    {
      lockLifetime: moment.duration(1, "hour").asMilliseconds(),
    }
  );
  void agenda.every("1 day", JOB_HOLODEX_UPDATE_CHANNELS);

  const JOB_HOLODEX_OUTDATE_CHANNEL = "crawler holodex outdate channel";
  agenda.define(
    JOB_HOLODEX_OUTDATE_CHANNEL,
    async (_job: Job): Promise<void> => {
      const needUpdate = await ChannelModel.findSubscribed()
        .and([
          {
            $or: [
              {
                holodexCrawledAt: null,
              },
              {
                holodexCrawledAt: {
                  $lt: moment.tz("UTC").subtract(1, "day").toDate(),
                },
              },
            ],
          },
        ])
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
  void agenda.every("1 hour", JOB_HOLODEX_OUTDATE_CHANNEL);

  //#endregion holodex

  //#region youtube pubsub

  const enabledYtPubsub = !!PUBLIC_BASE_URL;
  const ytNotifier = new YouTubeNotifier({
    hubCallback: new URL("./notifications/youtube", PUBLIC_BASE_URL).toString(),
    secret: YOUTUBE_PUBSUB_SECRET,
    middleware: true,
  });
  fastify.use("/notifications/youtube", ytNotifier.listener());

  if (enabledYtPubsub) {
    const JOB_YOUTUBE_PUBSUB_SUBSCRIBE = "crawler youtube pubsub subscribe";
    agenda.define(
      JOB_YOUTUBE_PUBSUB_SUBSCRIBE,
      async (job: Job): Promise<void> => {
        if (!enabledYtPubsub) return;
        for await (const channel of ChannelModel.findSubscribed().select(
          "id name"
        )) {
          console.log(`Subscribing: [${channel.id}] ${channel.name}`);
          ytNotifier.subscribe(channel.id);
          await setTimeout(250);
          await job.touch();
        }
      }
    );
    void agenda.every("12 hours", JOB_YOUTUBE_PUBSUB_SUBSCRIBE);
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
    try {
      const result = await VideoModel.noticeFromNotification(data);
      if (result.modifiedCount > 0) {
        console.log(
          `Pubsub: ${data.channel.name} (${data.channel.id}) already seen this video: [${data.video.id}] ${data.video.title}`
        );
      }
      if (result.upsertedCount > 0) {
        console.log(
          `Pubsub: ${data.channel.name} (${data.channel.id}) new video: [${data.video.id}] ${data.video.title}`
        );
        await updateVideoFromYoutube([data.video.id]);
      }
    } catch (error) {
      console.error(`An error occurred:`, error);
    }
  });

  //#endregion youtube pubsub

  //#region youtube

  function mapToId(list: { id: string }[]): string[] {
    return list.map((item) => item.id);
  }

  const JOB_YOUTUBE_UPDATE_VIDEOS = "crawler youtube update";
  agenda.define(JOB_YOUTUBE_UPDATE_VIDEOS, async (_job: Job): Promise<void> => {
    const videoIds = Array.from(
      new Set<string>([
        // These two sit first in the Set, so without a cap they fill the whole
        // 100-slot slice and push live videos out. Newest-first matters: _id is
        // immutable, so an ascending cap would keep re-selecting the same
        // oldest ids forever and starve newer videos behind them if those ids
        // never manage to save. Descending puts new videos first and lets
        // permanently unsavable ones fall past the cap instead of blocking
        // discovery, and it runs off the default _id index with no in-memory
        // sort stage. Documents that do save leave these queries on their own,
        // so nothing is skipped — only the order changes. The scheduled-start
        // query below stays unbounded on purpose: a stream about to go live has
        // to be fetched now, and that spike drains within a round.
        ...mapToId(
          await VideoModel.find({ status: VideoStatus.New })
            .sort({ _id: -1 })
            .limit(25)
            .select("id")
        ),
        ...mapToId(
          await VideoModel.find({ crawledAt: null })
            .sort({ _id: -1 })
            .limit(25)
            .select("id")
        ),
        ...mapToId(
          await VideoModel.findLiveVideos()
            .and([
              {
                actualStart: null,
                scheduledStart: {
                  $lt: moment.tz("UTC").add(5, "minutes").toDate(),
                  $gt: moment.tz("UTC").subtract(5, "minutes").toDate(),
                },
              },
            ])
            .select("id")
        ),
        ...mapToId(
          await VideoModel.findRecentlyEndedVideos(1)
            .sort({ crawledAt: 1 })
            .limit(5)
            .select("id")
        ),
        ...mapToId(
          await VideoModel.findLiveVideos()
            .sort({ crawledAt: 1 })
            .limit(100)
            .select("id")
        ),
      ])
    ).slice(0, 100);
    const batch: string[][] = [];
    while (videoIds.length) batch.push(videoIds.splice(0, 50));
    await Promise.all(
      batch.map((perBatch) => updateVideoFromYoutube(perBatch))
    );
  });
  void agenda.every("1 minute", JOB_YOUTUBE_UPDATE_VIDEOS);

  const JOB_YOUTUBE_UPDATE_CHANNELS = "crawler youtube update channels";
  agenda.define(
    JOB_YOUTUBE_UPDATE_CHANNELS,
    async (_job: Job): Promise<void> => {
      const channelIds = Array.from(
        new Set<string>([
          ...mapToId(await ChannelModel.find({ crawledAt: null }).select("id")),
          ...mapToId(
            await ChannelModel.findSubscribed()
              .sort({ crawledAt: 1 })
              .limit(25)
              .select("id")
          ),
          ...mapToId(
            await ChannelModel.find({ deleted: true })
              .sort({ crawledAt: 1 })
              .limit(1)
              .select("id")
          ),
          ...mapToId(
            await ChannelModel.find({ deleted: { $ne: true } })
              .sort({ crawledAt: 1 })
              .limit(50)
              .select("id")
          ),
        ])
      ).slice(0, 50);
      const batch: string[][] = [];
      while (channelIds.length) batch.push(channelIds.splice(0, 50));
      await Promise.all(
        batch.map((perBatch) => updateChannelFromYoutube(perBatch))
      );
    }
  );
  void agenda.every("5 minute", JOB_YOUTUBE_UPDATE_CHANNELS);

  //#endregion youtube

  console.log(
    `crawler is ready (org=${HOLODEX_FETCH_ORG}, max_upcoming_hours=${HOLODEX_MAX_UPCOMING_HOURS})`
  );
}
