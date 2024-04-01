import type { Job } from "agenda";
import {
  ExtraData,
  VideoStatus,
  VideoType,
  type Channel,
  type Video as HolodexVideo,
} from "holodex.js";
import {
  HOLODEX_FETCH_ORG,
  HOLODEX_MAX_UPCOMING_HOURS,
  IGNORE_FREE_CHAT,
  SHUTDOWN_TIMEOUT,
} from "../constants";
import {
  ErrorCode,
  HoneybeeResult,
  HoneybeeStats,
  HoneybeeStatus,
} from "../interfaces";
import ChannelModel from "../models/Channel";
import VideoModel from "../models/Video";
import { initMongo } from "../modules/db";
import { getHolodex } from "../modules/holodex";
import { getQueueInstance } from "../modules/queue";
import { getAgenda } from "../modules/schedule";
import { guessFreeChat } from "../util";

function schedulerLog(...obj: any) {
  console.log(...obj);
}

export async function runScheduler() {
  const holoapi = getHolodex();
  const disconnectFromMongo = await initMongo();
  const queue = getQueueInstance({ isWorker: false });
  const agenda = getAgenda();
  const handledVideoIdCache: Set<string> = new Set();

  process.on("SIGTERM", async () => {
    schedulerLog("quitting scheduler (SIGTERM) ...");

    try {
      await agenda.drain();
      await queue.close(SHUTDOWN_TIMEOUT);
      await disconnectFromMongo();
    } catch (err) {
      schedulerLog("scheduler failed to shut down gracefully", err);
    }
    process.exit(0);
  });

  async function handleStream(stream: HolodexVideo) {
    const videoId = stream.videoId;
    const title = stream.title;
    const scheduledStartTime = stream.scheduledStart;

    const startUntil = scheduledStartTime
      ? new Date(scheduledStartTime).getTime() - Date.now()
      : 0;
    const startsInMin = Math.floor(startUntil / 1000 / 60);
    // if (startsInMin < -10080 && !guessFreeChat(title)) {
    //   schedulerLog(
    //     `${videoId} (${title}) will be ignored. it was started in ${startsInMin} min and not a free chat, which must be abandoned.`
    //   );
    //   return;
    // }

    if (handledVideoIdCache.has(videoId)) {
      schedulerLog(
        `ignored ${videoId} (${title}) [${startsInMin}] as it is either being delayed`
      );
      return;
    }

    // filter out freechat
    if (IGNORE_FREE_CHAT && guessFreeChat(title)) {
      schedulerLog(
        `ignored ${videoId} (${title}) [${startsInMin}] as it is freechat`
      );
      return;
    }

    // if failed to obtain chat:
    // startUntil > 0 (pre)     -> retry after max(1/5 of startUntil, 1min) for 5 times
    // startUntil < 0 (ongoing) -> retry after 1m for 5 times
    const minimumWaits = 1;
    const divisor = 10;
    const estimatedDelay = Math.max(
      Math.floor(startUntil / divisor),
      1000 * 60 * minimumWaits
    );
    await queue
      .createJob({
        videoId,
        stream: stream.toRaw(),
        defaultBackoffDelay: estimatedDelay,
      })
      .setId(videoId)
      .retries(divisor - 1)
      .backoff("fixed", estimatedDelay)
      .save();

    schedulerLog(
      `scheduled ${videoId} (${title}) starts in ${startsInMin} minute(s)`
    );

    handledVideoIdCache.add(videoId);
  }

  const checkStalledJobs = "scheduler checkStalledJobs";
  agenda.define(checkStalledJobs, async (job: Job): Promise<void> => {
    const res = await queue.checkStalledJobs();
    if (res > 0) {
      console.log("enqueue stalled jobs:", res);
    }
  });

  const rearrange = "scheduler rearrange";
  agenda.define(rearrange, async (job: Job): Promise<void> => {
    const alreadyActiveJobs = (
      await queue.getJobs("active", { start: 0, end: 1000 })
    ).map((job) => job.data.videoId);

    const crawlChannels: string[] = (
      await ChannelModel.find(
        { $or: [{ extraCrawl: true }, { organization: HOLODEX_FETCH_ORG }] },
        { id: 1 }
      )
    ).map((channel) => channel.id);

    function checkChannel(channel: Channel) {
      return (
        channel.organization === HOLODEX_FETCH_ORG ||
        crawlChannels.includes(channel.channelId)
      );
    }

    const liveAndUpcomingStreams = (
      await holoapi.getLiveVideos({
        org: "All Vtubers",
        max_upcoming_hours: HOLODEX_MAX_UPCOMING_HOURS,
        include: [ExtraData.Mentions],
      })
    ).filter(
      (stream) =>
        checkChannel(stream.channel) || !!stream.mentions?.find(checkChannel)
    );

    // update database
    for (const stream of liveAndUpcomingStreams) {
      await VideoModel.updateFromHolodex(stream);
    }

    const unscheduledStreams = liveAndUpcomingStreams.filter(
      (stream) => !alreadyActiveJobs.includes(stream.videoId)
    );

    schedulerLog(`currently ${alreadyActiveJobs.length} job(s) are running`);

    if (unscheduledStreams.length === 0) {
      schedulerLog("no new streams");
      return;
    }

    schedulerLog(
      `will schedule ${unscheduledStreams.length} stream(s) out of ${liveAndUpcomingStreams.length} streams`
    );

    for (const stream of unscheduledStreams) {
      await handleStream(stream);
    }

    // show metrics
    const health = await queue.checkHealth();
    console.log(
      `< Queue Metrics >
Active=${health.active}
Waiting=${health.waiting}
Delayed=${health.delayed}
Failed=${health.failed}`
    );
  });

  const updatepast = "scheduler update past";
  agenda.define(updatepast, async (job: Job): Promise<void> => {
    const pastStreams = await holoapi.getVideos({
      org: HOLODEX_FETCH_ORG,
      status: VideoStatus.Past,
      type: VideoType.Stream,
      include: [ExtraData.LiveInfo],
    });
    for (const stream of pastStreams) {
      await VideoModel.updateFromHolodex(stream);
    }
  });

  queue.on("stalled", async (jobId) => {
    schedulerLog("[stalled]:", jobId);
    await VideoModel.updateStatus(jobId, HoneybeeStatus.Stalled);
  });

  // redis related error
  queue.on("error", (err) => {
    schedulerLog(`${err.message}`);
    process.exit(1);
  });

  queue.on("job succeeded", async (jobId, result: HoneybeeResult) => {
    const job = await queue.getJob(jobId);
    await job.remove();

    await VideoModel.updateResult(jobId, result);

    switch (result.error) {
      case ErrorCode.MembersOnly: {
        schedulerLog(`[job cancelled (members-only mode)]: ${jobId}`);
        break;
      }
      case ErrorCode.Ban: {
        // handle ban
        schedulerLog(`[job aborted (ban)]: ${jobId}`);
        break;
      }
      case ErrorCode.Unavailable:
      case ErrorCode.Private: {
        // live stream is still ongoing but somehow got response with empty continuation hence mistaken as being finished -> will be added in next invocation. If the stream was actually ended that's ok bc the stream index won't have that stream anymore, or else it will be added to worker again.
        // live stream was over and the result is finalized -> the index won't have that videoId anymore so it's safe to remove them from the cache
        schedulerLog(`[job maybe succeeded]: ${jobId} (${result.error})`);
        break;
      }
      case ErrorCode.Unknown: {
        schedulerLog(`[action required]: Unknown error occurred at ${jobId}`);
        break;
      }
      default: {
        schedulerLog(`[job succeeded]: ${jobId}`, result);
        break;
      }
    }

    handledVideoIdCache.delete(jobId);
  });

  queue.on("job progress", async (jobId, progress: HoneybeeStats) => {
    await VideoModel.updateStatus(jobId, HoneybeeStatus.Progress);
  });

  queue.on("job retrying", async (jobId, err) => {
    const job = await queue.getJob(jobId);
    const retries = job.options.retries;
    const retryDelay = job.options.backoff.delay
      ? `${Math.ceil(job.options.backoff.delay / 1000)}s`
      : "immediate";

    await VideoModel.updateStatus(jobId, HoneybeeStatus.Retrying, err);

    schedulerLog(
      "[job retrying]:",
      `will retry ${jobId} in ${retryDelay} (${retries}). reason: ${err.message}`
    );
  });

  queue.on("job failed", async (jobId, err) => {
    schedulerLog(`[job failed]: ${jobId}`, err.message);

    // chances that chat is disabled until live goes online
    handledVideoIdCache.delete(jobId);
    await queue.removeJob(jobId);

    await VideoModel.updateStatusFailed(jobId, err);

    schedulerLog(
      `[job failed]: removed ${jobId} from cache and job queue for later retry`
    );
  });

  queue.on("ready", async () => {
    await agenda.start();
    agenda.every("5 minutes", rearrange);
    agenda.every("10 minutes", updatepast);
    agenda.every("1 minute", checkStalledJobs);

    schedulerLog(
      `scheduler is ready (org=${HOLODEX_FETCH_ORG}, max_upcoming_hours=${HOLODEX_MAX_UPCOMING_HOURS}, ignoreFreeChat=${IGNORE_FREE_CHAT})`
    );
  });
}
