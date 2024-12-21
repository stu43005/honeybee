import { VideoStatus } from "holodex.js";
import moment from "moment-timezone";
import mongoose, { mongo } from "mongoose";
import type { Arguments, Argv } from "yargs";
import { MAX_HOURS_BEFORE_CLEANUP } from "../constants";
import Chat from "../models/Chat";
import Membership from "../models/Membership";
import MembershipGift from "../models/MembershipGift";
import MembershipGiftPurchase from "../models/MembershipGiftPurchase";
import Milestone from "../models/Milestone";
import Placeholder from "../models/Placeholder";
import RemoveChatAction from "../models/RemoveChatAction";
import SuperChat from "../models/SuperChat";
import SuperSticker from "../models/SuperSticker";
import Video, { EndedStatus } from "../models/Video";
import WebhookResult from "../models/WebhookResult";
import { initMongo } from "../modules/db";
import { getAgenda } from "../modules/schedule";

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
  await Video.updateMany(
    { id: { $in: videoIds } },
    { $set: { hbCleanedAt: new Date() } }
  );
  console.log(`cleanup ${videoIds.length} streams: ${videoIds.join(", ")}`);
}

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
  const videoIds = Array.from(new Set([...chats.map((r) => r._id.videoId)]));

  const videos = await Video.find(
    {
      id: { $in: videoIds },
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

  const cleanupThresholdTime = moment
    .tz("UTC")
    .subtract(MAX_HOURS_BEFORE_CLEANUP, "hour");
  const toRemoveVideoIds = new Set<string>([
    // The status of the video is already past or missing, and the last chat have exceeded 1 hour ago
    ...videos
      .filter((video) => {
        const videoChat = chats.find((chat) => chat._id.videoId === video.id);
        return (
          [VideoStatus.Past, VideoStatus.Missing].includes(video.status) &&
          (!video.availableAt ||
            moment(video.availableAt).isBefore(cleanupThresholdTime)) &&
          (!video.publishedAt ||
            moment(video.publishedAt).isBefore(cleanupThresholdTime)) &&
          (!video.actualEnd ||
            moment(video.actualEnd).isBefore(cleanupThresholdTime)) &&
          (!video.hbEnd ||
            moment(video.hbEnd).isBefore(cleanupThresholdTime)) &&
          (!videoChat ||
            moment(videoChat.lastTime).isBefore(cleanupThresholdTime))
        );
      })
      .map((video) => video.id),
    // video does not exist (may have been cleaned)
    ...videoIds.filter((id) => !videos.find((video) => video.id === id)),
  ]);

  if (toRemoveVideoIds.size) {
    await cleanVideos(Array.from(toRemoveVideoIds));
  }
}

async function cleanWebhookResults() {
  const conn = mongoose.connection;

  async function cleanByCollection(coll: string, ids: Set<string>) {
    const findCursor = conn.collection(coll).find({
      _id: {
        $in: Array.from(ids).map((id) => new mongo.BSON.ObjectId(id)),
      },
    });
    for await (const doc of findCursor) {
      let markDelete = false;
      switch (coll) {
        case "polls":
          if (
            doc.finished &&
            moment.tz().diff(doc.updatedAt, "hour", true) >= 1
          ) {
            markDelete = true;
          }
          break;
        case "raids":
          if (moment.tz().diff(doc.updatedAt, "hour", true) >= 1) {
            markDelete = true;
          }
          break;
        case "videos":
          if (
            EndedStatus.includes(doc.status) &&
            moment.tz().diff(doc.updatedAt, "hour", true) >= 24
          ) {
            markDelete = true;
          }
          break;
      }
      if (!markDelete) {
        // Not delete
        ids.delete((doc._id as mongo.BSON.ObjectId).toString());
      }
    }

    const result = await WebhookResult.deleteMany({
      coll: coll,
      docId: {
        $in: Array.from(ids),
      },
    });
    if (result.deletedCount > 0) {
      console.log(`cleanup ${result.deletedCount} webhookResult.`);
    }

    if (coll === "webhooks") {
      const result2 = await WebhookResult.deleteMany({
        webhookId: {
          $in: Array.from(ids),
        },
      });
      if (result2.deletedCount > 0) {
        console.log(`cleanup ${result2.deletedCount} webhookResult.`);
      }
    }
  }

  const docIds: Record<string, Set<string>> = {
    webhooks: new Set(),
  };

  for await (const item of WebhookResult.find().cursor()) {
    docIds["webhooks"].add(item.webhookId);
    docIds[item.coll] ??= new Set();
    docIds[item.coll].add(item.docId);
    if (docIds[item.coll].size >= 50) {
      await cleanByCollection(item.coll, docIds[item.coll]);
      docIds[item.coll].clear();
    }
  }

  for (const [coll, ids] of Object.entries(docIds)) {
    if (!ids.size) continue;
    await cleanByCollection(coll, ids);
    ids.clear();
  }
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
    agenda.define("cleanup webhookresults", cleanWebhookResults);

    await agenda.start();
    agenda.every("5 minutes", "cleanup ended streams");
    agenda.every("1 hour", "cleanup webhookresults");
  } else {
    await cleanEndedStreams();
    await cleanWebhookResults();

    await disconnectFromMongo();
  }
}
