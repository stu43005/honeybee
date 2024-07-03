import { VideoStatus } from "holodex.js";
import type { Arguments, Argv } from "yargs";
import { HoneybeeStatus } from "../interfaces";
import BanAction from "../models/BanAction";
import Chat from "../models/Chat";
import LiveViewers from "../models/LiveViewers";
import Membership from "../models/Membership";
import MembershipGift from "../models/MembershipGift";
import MembershipGiftPurchase from "../models/MembershipGiftPurchase";
import Milestone from "../models/Milestone";
import Placeholder from "../models/Placeholder";
import RemoveChatAction from "../models/RemoveChatAction";
import SuperChat from "../models/SuperChat";
import SuperSticker from "../models/SuperSticker";
import Video from "../models/Video";
import { initMongo } from "../modules/db";
import { getAgenda } from "../modules/schedule";

export async function removeDuplicatedActions(argv: any) {
  const disconnect = await initMongo();

  const aggregate = await BanAction.aggregate([
    {
      $group: {
        _id: { channelId: "$channelId", originVideoId: "$originVideoId" },
        uniqueIds: { $addToSet: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);

  let nbRemoved = 0;
  for (const res of aggregate) {
    const records = await BanAction.where("_id")
      .in(res.uniqueIds)
      .select(["_id"]);

    const toRemove = records.slice(1);
    nbRemoved += toRemove.length;
    // await BanAction.deleteMany(records.slice(1));
  }

  console.log(`removed`, nbRemoved);

  await disconnect();
}

async function cleanVideos(videoIds: string[]) {
  await Placeholder.deleteMany({ originVideoId: { $in: videoIds } });
  await RemoveChatAction.deleteMany({ originVideoId: { $in: videoIds } });
  await Membership.deleteMany({ originVideoId: { $in: videoIds } });
  await Milestone.deleteMany({ originVideoId: { $in: videoIds } });
  await SuperChat.deleteMany({ originVideoId: { $in: videoIds } });
  await SuperSticker.deleteMany({ originVideoId: { $in: videoIds } });
  await MembershipGift.deleteMany({ originVideoId: { $in: videoIds } });
  await MembershipGiftPurchase.deleteMany({ originVideoId: { $in: videoIds } });
  await Chat.deleteMany({ originVideoId: { $in: videoIds } });
  await LiveViewers.deleteMany({ originVideoId: { $in: videoIds } });
  await Video.updateMany(
    { id: { $in: videoIds } },
    { $set: { hbCleanedAt: new Date() } }
  );
  console.log(`cleanup ${videoIds.length} streams.`);
}

interface CleanupOptions {
  daemon: boolean;
}

export function cleanupBuilder(yargs: Argv): Argv<CleanupOptions> {
  return yargs.option("daemon", {
    alias: "d",
    describe: "running as daemon mode",
    type: "boolean",
    default: false,
  });
}

export async function cleanup(argv: Arguments<CleanupOptions>) {
  const disconnectFromMongo = await initMongo();

  async function cleanEndedStreams() {
    const chats = await Chat.aggregate<{
      _id: { videoId: string };
      lastTime: Date;
    }>([
      {
        $group: {
          _id: { videoId: "$originVideoId" },
          lastTime: { $last: "$timestamp" },
        },
      },
    ]);
    const liveviewers = await LiveViewers.aggregate<{
      _id: { videoId: string };
      lastTime: Date;
    }>([
      {
        $group: {
          _id: { videoId: "$originVideoId" },
          lastTime: { $last: "$createdAt" },
        },
      },
    ]);
    const videoIds = Array.from(
      new Set([
        ...chats.map((r) => r._id.videoId),
        ...liveviewers.map((r) => r._id.videoId),
      ])
    );

    const videos = await Video.find(
      {
        $or: [
          ...Video.LiveQuerys,
          {
            id: { $in: videoIds },
          },
        ],
      },
      {
        id: 1,
        status: 1,
        actualEnd: 1,
        hbStatus: 1,
        hbEnd: 1,
        hbCleanedAt: 1,
      }
    );

    const toRemoveVideoIds = new Set<string>([
      // Honeybee has stopped processing the video for over 1 hour
      ...videos
        .filter(
          (video) =>
            [HoneybeeStatus.Finished, HoneybeeStatus.Failed].includes(
              video.hbStatus
            ) &&
            video.hbEnd &&
            video.hbEnd.getTime() < Date.now() - 60 * 60 * 1000
        )
        .map((video) => video.id),
      // The status of the video is already past, and both the end time and the last chat have exceeded 1 hour
      ...videos
        .filter((video) => {
          const videoChat = chats.find((chat) => chat._id.videoId === video.id);
          return (
            video.status === VideoStatus.Past &&
            video.actualEnd &&
            video.actualEnd.getTime() < Date.now() - 60 * 60 * 1000 &&
            videoChat &&
            videoChat.lastTime.getTime() < Date.now() - 60 * 60 * 1000
          );
        })
        .map((video) => video.id),
      // video have been cleaned
      ...videos.filter((video) => !!video.hbCleanedAt).map((video) => video.id),
      // video does not exist (may have been cleaned)
      ...videoIds.filter((id) => !videos.find((video) => video.id === id)),
    ]);

    if (toRemoveVideoIds.size) {
      await cleanVideos(Array.from(toRemoveVideoIds));
    }
  }

  if (argv.daemon) {
    const agenda = getAgenda();

    process.on("SIGTERM", async () => {
      console.log("quitting cleanup (SIGTERM) ...");

      try {
        await agenda.drain();
        await disconnectFromMongo();
      } catch (err) {
        console.log("cleanup failed to shut down gracefully", err);
      }
      process.exit(0);
    });

    agenda.define("cleanup ended streams", cleanEndedStreams);

    await agenda.start();
    agenda.every("5 minutes", "cleanup ended streams");
  } else {
    await cleanEndedStreams();

    await disconnectFromMongo();
  }
}
