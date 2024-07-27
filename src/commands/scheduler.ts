import type { DocumentType } from "@typegoose/typegoose";
import type { Job } from "agenda";
import type { mongo } from "mongoose";
import { IGNORE_FREE_CHAT, SHUTDOWN_TIMEOUT } from "../constants";
import {
  ErrorCode,
  HoneybeeResult,
  HoneybeeStats,
  HoneybeeStatus,
} from "../interfaces";
import VideoModel, { type Video } from "../models/Video";
import { initMongo } from "../modules/db";
import { getQueueInstance } from "../modules/queue";
import { getAgenda } from "../modules/schedule";

function schedulerLog(...obj: any) {
  console.log(...obj);
}

export async function runScheduler() {
  const disconnectFromMongo = await initMongo();
  const queue = getQueueInstance({ isWorker: false });
  const agenda = getAgenda();

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

  async function handleStream(video: DocumentType<Video>, replica: number) {
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
    const jobId = replica === 1 ? videoId : `${videoId}:${replica}`;
    await queue
      .createJob({
        videoId,
        replica,
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
      await job.remove();
    }
    const succeededJobs = await queue.getJobs("succeeded", { size: 1000 });
    for (const job of succeededJobs) {
      await job.remove();
    }
  });

  const rearrange = "scheduler rearrange";
  agenda.define(rearrange, async (job: Job): Promise<void> => {
    const alreadyActiveJobs = await queue.getJobs("active", {
      start: 0,
      end: 1000,
    });

    const liveAndUpcomingStreams = await VideoModel.findLiveVideos();

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
          await handleStream(video, replica);
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
    const { videoId, replica } = job.data;
    if (replica === 1) {
      await VideoModel.updateStatus(videoId, HoneybeeStatus.Stalled);
    }
  });

  // redis related error
  queue.on("error", (err) => {
    schedulerLog(`${err.message}`);
    process.exit(1);
  });

  queue.on("job succeeded", async (jobId, result: HoneybeeResult) => {
    const job = await queue.getJob(jobId);
    const { videoId, replica } = job.data;
    await job.remove();

    if (replica === 1) {
      await VideoModel.updateResult(videoId, result);
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
      default: {
        schedulerLog(`[job succeeded]: ${jobId}`, result);
        break;
      }
    }
  });

  queue.on("job progress", async (jobId, progress: HoneybeeStats) => {
    const job = await queue.getJob(jobId);
    const { videoId, replica } = job.data;
    if (replica === 1) {
      await VideoModel.updateStatus(videoId, HoneybeeStatus.Progress);
    }
  });

  queue.on("job retrying", async (jobId, err) => {
    const job = await queue.getJob(jobId);
    const { videoId, replica } = job.data;
    const retries = job.options.retries;
    const retryDelay = job.options.backoff.delay
      ? `${Math.ceil(job.options.backoff.delay / 1000)}s`
      : "immediate";

    if (replica === 1) {
      await VideoModel.updateStatus(videoId, HoneybeeStatus.Retrying, err);
    }

    schedulerLog(
      "[job retrying]:",
      `will retry ${jobId} in ${retryDelay} (${retries}). reason: ${err.message}`
    );
  });

  queue.on("job failed", async (jobId, err) => {
    schedulerLog(`[job failed]: ${jobId}`, err.message);
    const job = await queue.getJob(jobId);
    const { videoId, replica } = job.data;
    await job.remove();

    if (replica === 1) {
      await VideoModel.updateStatusFailed(videoId, err);
    }

    schedulerLog(
      `[job failed]: removed ${jobId} from cache and job queue for later retry`
    );
  });

  await queue.ready();
  await agenda.start();
  agenda.every("1 minute", rearrange);
  agenda.every("1 minute", checkStalledJobs);

  VideoModel.watch(
    [
      {
        $match: {
          operationType: { $in: ["insert", "update", "replace"] },
        },
      },
    ],
    {
      fullDocument: "updateLookup",
      fullDocumentBeforeChange: "whenAvailable",
    }
  ).on("change", async (data: mongo.ChangeStreamDocument<Video>) => {
    switch (data.operationType) {
      case "insert":
        try {
          const video = new VideoModel(data.fullDocument);
          if (video.isLive()) {
            await handleStream(video, 1);
          }
        } catch (error) {
          schedulerLog(
            `Unable to schedule the stream: ${data.fullDocument.id},`,
            error
          );
        }
        break;
      case "update":
      case "replace":
        if (data.fullDocument) {
          try {
            if (data.fullDocumentBeforeChange && data.fullDocument) {
              const before = new VideoModel(data.fullDocumentBeforeChange);
              const after = new VideoModel(data.fullDocument);
              if (
                after.getReplicas() > 0 &&
                before.getReplicas() < after.getReplicas()
              ) {
                await handleStream(after, after.getReplicas());
              }
            }
          } catch (error) {
            schedulerLog(
              `Unable to schedule the stream: ${data.fullDocument.id},`,
              error
            );
          }
        }
        break;
    }
  });

  schedulerLog(`scheduler is ready (ignoreFreeChat=${IGNORE_FREE_CHAT})`);
}
