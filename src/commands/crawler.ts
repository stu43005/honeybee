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
import {
  HOLODEX_ALL_VTUBERS,
  HOLODEX_FETCH_ORG,
  HOLODEX_MAX_UPCOMING_HOURS,
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
import { YoutubePubsubModule } from "../modules/youtube-pubsub/youtube-pubsub.js";
import { pollChannelFeeds } from "../components/youtube-discovery/feed-poll.js";
import { pollMembersPlaylists } from "../components/youtube-discovery/members-poll.js";
import { probeMissingVideos } from "../components/youtube-discovery/existence-probe.js";

function mapToId(list: { id: string }[]): string[] {
  return list.map((item) => item.id);
}

/**
 * The videos one `crawler youtube update` round will hydrate.
 *
 * Exported for testing: the order of these queries is the actual priority
 * ordering, because `Set` keeps insertion order and `.slice(0, 100)` is what
 * finally decides. A query placed after the live one below can be starved
 * entirely, and nothing about that is visible to the compiler.
 */
export async function collectVideoUpdateCandidates(): Promise<string[]> {
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
      // Streams a timeout heuristic marked Missing: the scheduled start came
      // and went, or the stream stopped without being ended. The video is
      // still on YouTube, so only videos.list can tell whether it has since
      // started or finally ended, and nothing else re-checks it — the one
      // query above that touches Missing is limited to hbEnd within the hour.
      // They stay Missing throughout; nothing flips them to New first, so
      // there is no round trip through the two queries at the top of this
      // list.
      //
      // Two per round because the hit rate is low and the population large:
      // for most of them YouTube never does fill in actualEnd. The position
      // matters as much as the limit — the live query below covers every
      // upcoming and live video and would fill the slice on its own, so
      // anything after it would never be reached.
      ...mapToId(await VideoModel.findMissingRecheckCandidates(2).select("id")),
      ...mapToId(
        await VideoModel.findLiveVideos()
          .sort({ crawledAt: 1 })
          .limit(100)
          .select("id")
      ),
    ])
  ).slice(0, 100);
  return videoIds;
}

export async function runCrawler() {
  const holoapi = getHolodex();
  const app = new Application();
  app.use(new MongodbModule());
  const { agenda } = app.use(new AgendaModule());
  // Registered after AgendaModule, because its constructor looks that module up,
  // and before app.init(), because its constructor adds the notification routes
  // and fastify refuses to add routes once HttpServerModule has called listen().
  app.use(new YoutubePubsubModule(app));

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

  //#region youtube

  const JOB_YOUTUBE_UPDATE_VIDEOS = "crawler youtube update";
  agenda.define(JOB_YOUTUBE_UPDATE_VIDEOS, async (_job: Job): Promise<void> => {
    const videoIds = await collectVideoUpdateCandidates();
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

  // None of these three set a lockLifetime or call job.touch(). Their worst
  // cases are 3.4, 4.3 and 1.7 minutes — every request carries a timeout and
  // retries are off — which stays well inside agenda's 10 minute default, the
  // same reasoning the pubsub renewal job relies on.

  const JOB_YOUTUBE_FEED_POLL = "crawler youtube feed poll";
  agenda.define(JOB_YOUTUBE_FEED_POLL, async (_job: Job): Promise<void> => {
    await pollChannelFeeds();
  });
  // Two minutes covers 600 channels an hour, and the feed's own 15 minute edge
  // cache means polling any single channel faster than that would return the
  // same bytes anyway.
  void agenda.every("2 minutes", JOB_YOUTUBE_FEED_POLL);

  const JOB_YOUTUBE_MEMBERS_POLL = "crawler youtube members poll";
  agenda.define(JOB_YOUTUBE_MEMBERS_POLL, async (_job: Job): Promise<void> => {
    await pollMembersPlaylists();
  });
  void agenda.every("5 minutes", JOB_YOUTUBE_MEMBERS_POLL);

  const JOB_YOUTUBE_EXISTENCE_PROBE = "crawler youtube existence probe";
  agenda.define(
    JOB_YOUTUBE_EXISTENCE_PROBE,
    async (_job: Job): Promise<void> => {
      await probeMissingVideos();
    }
  );
  void agenda.every("5 minutes", JOB_YOUTUBE_EXISTENCE_PROBE);

  //#endregion youtube

  console.log(
    `crawler is ready (org=${HOLODEX_FETCH_ORG}, max_upcoming_hours=${HOLODEX_MAX_UPCOMING_HOURS})`
  );
}
