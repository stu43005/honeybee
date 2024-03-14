import type { Arguments, Argv } from "yargs";
import { HoneybeeStatus } from "../interfaces";
import BanAction from "../models/BanAction";
import BannerAction from "../models/BannerAction";
import Chat from "../models/Chat";
import Deletion from "../models/Deletion";
import Membership from "../models/Membership";
import Milestone from "../models/Milestone";
import ModeChange from "../models/ModeChange";
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
    const chatVideoIds = (
      await Chat.aggregate<{
        _id: { videoId: string };
      }>([
        {
          $group: {
            _id: { videoId: "$originVideoId" },
          },
        },
      ])
    ).map((r) => r._id.videoId);

    const videos = await Video.find(
      {
        id: { $in: chatVideoIds },
        // hbStatus: HoneybeeStatus.Finished,
        // hbEnd: { $lt: new Date(Date.now() - 10 * 60 * 1000) },
      },
      {
        id: 1,
        hbStatus: 1,
        hbEnd: 1,
      }
    );

    const toRemoveVideoIds = videos
      .filter(
        (video) =>
          video.hbStatus === HoneybeeStatus.Finished &&
          video.hbEnd &&
          video.hbEnd.getTime() < Date.now() - 10 * 60 * 1000
      )
      .map((video) => video.id)
      .concat(
        chatVideoIds.filter((id) => !videos.find((video) => video.id === id))
      );

    await BanAction.deleteMany({ originVideoId: { $in: toRemoveVideoIds } });
    await BannerAction.deleteMany({ originVideoId: { $in: toRemoveVideoIds } });
    await Deletion.deleteMany({ originVideoId: { $in: toRemoveVideoIds } });
    await ModeChange.deleteMany({ originVideoId: { $in: toRemoveVideoIds } });
    await Placeholder.deleteMany({ originVideoId: { $in: toRemoveVideoIds } });
    await RemoveChatAction.deleteMany({
      originVideoId: { $in: toRemoveVideoIds },
    });
    await Membership.deleteMany({ originVideoId: { $in: toRemoveVideoIds } });
    await Milestone.deleteMany({ originVideoId: { $in: toRemoveVideoIds } });
    await SuperChat.deleteMany({ originVideoId: { $in: toRemoveVideoIds } });
    await SuperSticker.deleteMany({ originVideoId: { $in: toRemoveVideoIds } });
    await Chat.deleteMany({ originVideoId: { $in: toRemoveVideoIds } });
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
