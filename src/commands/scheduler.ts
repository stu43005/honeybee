import type { DocumentType } from "@typegoose/typegoose";
import type { Job } from "agenda";
import { CRAWL_REPLAY_MAX_HOURS, IGNORE_FREE_CHAT } from "../constants.js";
import {
  ErrorCode,
  HoneybeeResult,
  HoneybeeStats,
  HoneybeeStatus,
} from "../interfaces.js";
import VideoModel, { type Video } from "../models/Video.js";
import { Application } from "../modules/application.js";
import { CollectionWatcher } from "../modules/collection-watcher.js";
import { MongodbModule } from "../modules/db.js";
import { QueueModule } from "../modules/queue.js";
import { AgendaModule } from "../modules/schedule.js";

function schedulerLog(...obj: any) {
  console.log(...obj);
}

function getJobId(videoId: string, replica: number) {
  return replica === 1 ? videoId : `${videoId}:${replica}`;
}

export async function runScheduler() {
  const app = new Application();
  app.use(new MongodbModule());
  const { queue } = app.use(new QueueModule("honeybee", { isWorker: false }));
  const { agenda } = app.use(new AgendaModule());

  async function handleStream(
    video: DocumentType<Video>,
    replica: number,
    isReplay = false
  ) {
    const videoId = video.id;
    const title = video.title;
    const scheduledStartTime = video.scheduledStart;

    const startUntil = scheduledStartTime
      ? new Date(scheduledStartTime).getTime() - Date.now()
      : 0;
    const startsInMin = Math.floor(startUntil / 1000 / 60);

    // filter out freechat
    if (IGNORE_FREE_CHAT && video.isFreeChat()) {
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
    const jobId = getJobId(videoId, replica);
    await queue
      .createJob({
        videoId,
        replica,
        mode: isReplay ? "replay" : "live",
        defaultBackoffDelay: estimatedDelay,
      })
      .setId(jobId)
      .retries(divisor - 1)
      .backoff("fixed", estimatedDelay)
      .save();

    schedulerLog(
      `scheduled ${jobId} (${title}) starts in ${startsInMin} minute(s)`
    );
  }

  const checkStalledJobs = "scheduler checkStalledJobs";
  agenda.define(checkStalledJobs, async (job: Job): Promise<void> => {
    const res = await queue.checkStalledJobs();
    if (res > 0) {
      console.log("enqueue stalled jobs:", res);
    }

    const failedJobs = await queue.getJobs("failed", { size: 1000 });
    for (const job of failedJobs) {
      const { videoId, replica } = job.data;
      await job.remove();
      if (replica === 1) {
        await VideoModel.updateStatusFailed(
          videoId,
          new Error("unknown error")
        );
      }
    }
    const succeededJobs = await queue.getJobs("succeeded", { size: 1000 });
    for (const job of succeededJobs) {
      const { videoId, replica } = job.data;
      await job.remove();
      if (replica === 1) {
        await VideoModel.updateResult(videoId, { error: null });
      }
    }
  });

  const rearrange = "scheduler rearrange";
  agenda.define(rearrange, async (job: Job): Promise<void> => {
    const alreadyActiveJobs = await queue.getJobs("active", {
      start: 0,
      end: 1000,
    });

    const liveAndUpcomingStreams = (
      await Promise.all([
        VideoModel.findLiveVideos(),
        VideoModel.findNeedReplayVideos(CRAWL_REPLAY_MAX_HOURS),
      ])
    ).flat();

    const unscheduledStreams = liveAndUpcomingStreams.filter(
      (video) =>
        alreadyActiveJobs.filter((job) => job.data.videoId === video.id)
          .length < video.getReplicas()
    );

    schedulerLog(`currently ${alreadyActiveJobs.length} job(s) are running`);

    if (unscheduledStreams.length === 0) {
      schedulerLog("no new streams");
      return;
    }

    schedulerLog(
      `will schedule ${unscheduledStreams.length} stream(s) out of ${liveAndUpcomingStreams.length} streams`
    );

    for (const video of unscheduledStreams) {
      const videoJobs = alreadyActiveJobs.filter(
        (job) => job.data.videoId === video.id
      );
      for (let replica = 1; replica <= video.getReplicas(); replica++) {
        const job = videoJobs.find((job) => job.data.replica === replica);
        if (!job) {
          await handleStream(video, replica, video.isNeedReplay());
        }
      }
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

  queue.on("stalled", async (jobId) => {
    schedulerLog("[stalled]:", jobId);
    const job = await queue.getJob(jobId);
    if (job) {
      const { videoId, replica } = job.data;
      if (replica === 1) {
        await VideoModel.updateStatus(videoId, HoneybeeStatus.Stalled);
      }
    }
  });

  // redis related error
  queue.on("error", (err) => {
    schedulerLog(`${err.message}`);
    process.exit(1);
  });

  queue.on("job succeeded", async (jobId, result: HoneybeeResult) => {
    const job = await queue.getJob(jobId);
    if (job) {
      const { videoId, replica, mode } = job.data;
      await job.remove();

      if (mode === "replay") {
        await VideoModel.updateResult(videoId, result, true);
      } else if (replica === 1) {
        await VideoModel.updateResult(videoId, result);
      }
    }

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
      case ErrorCode.Aborted: {
        schedulerLog(`[job aborted]: ${jobId}`);
        break;
      }
      default: {
        schedulerLog(`[job succeeded]: ${jobId}`, result);
        break;
      }
    }
  });

  queue.on("job progress", async (jobId, progress: HoneybeeStats) => {
    const job = await queue.getJob(jobId);
    if (job) {
      const { videoId, replica } = job.data;
      if (replica === 1) {
        await VideoModel.updateStatus(videoId, HoneybeeStatus.Progress);
      }
    }
  });

  queue.on("job retrying", async (jobId, err) => {
    const job = await queue.getJob(jobId);
    if (job) {
      const { videoId, replica } = job.data;
      if (replica === 1) {
        await VideoModel.updateStatus(videoId, HoneybeeStatus.Retrying, err);
      }
    }

    const retries = job.options.retries;
    const retryDelay = job.options.backoff.delay
      ? `${Math.ceil(job.options.backoff.delay / 1000)}s`
      : "immediate";
    schedulerLog(
      "[job retrying]:",
      `will retry ${jobId} in ${retryDelay} (${retries}). reason: ${err.message}`
    );
  });

  queue.on("job failed", async (jobId, err) => {
    schedulerLog(`[job failed]: ${jobId}`, err.message);
    const job = await queue.getJob(jobId);
    if (job) {
      const { videoId, replica } = job.data;
      await job.remove();

      if (replica === 1) {
        await VideoModel.updateStatusFailed(videoId, err);
      }
    }

    schedulerLog(
      `[job failed]: removed ${jobId} from cache and job queue for later retry`
    );
  });

  await app.init();
  agenda.every("30 seconds", rearrange);
  agenda.every("1 minute", checkStalledJobs);

  const watcher = new CollectionWatcher(VideoModel);
  watcher.on("data", async ({ fullDocument: video, operationType }) => {
    try {
      if (operationType === "insert") {
        // insert
        if (video.isLive()) {
          await handleStream(video, 1);
        }
      } else {
        // update
        const replica = video.getReplicas();
        if (video.isLive() && replica > 1) {
          const jobId = getJobId(video.id, replica);
          const job = await queue.getJob(jobId);
          if (!job) {
            await handleStream(video, replica);
          }
        }
      }
    } catch (error) {
      schedulerLog(`Unable to schedule the stream: ${video.id},`, error);
    }
  });
  watcher.listen({
    operationType: ["insert", "update"],
  });

  schedulerLog(`scheduler is ready (ignoreFreeChat=${IGNORE_FREE_CHAT})`);
}
