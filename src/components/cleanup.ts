import moment from "moment-timezone";
import mongoose, { mongo } from "mongoose";
import assert from "node:assert";
import { MAX_HOURS_BEFORE_CLEANUP } from "../constants";
import { HoneybeeStatus, VideoStatsType } from "../interfaces";
import { recalcVideoHbStats } from "./video-stats";
import BanAction from "../models/BanAction";
import Chat from "../models/Chat";
import Membership from "../models/Membership";
import MembershipGift from "../models/MembershipGift";
import MembershipGiftPurchase from "../models/MembershipGiftPurchase";
import Milestone from "../models/Milestone";
import Placeholder from "../models/Placeholder";
import RemoveChatAction from "../models/RemoveChatAction";
import SuperChat from "../models/SuperChat";
import SuperSticker from "../models/SuperSticker";
import Video, { LiveStatus } from "../models/Video";
import VideoStats from "../models/VideoStats";
import VideoUserStats from "../models/VideoUserStats";
import WebhookResult from "../models/WebhookResult";
import type { Application } from "../modules/application";
import type { AgendaModule } from "../modules/schedule";

export default function cleanup(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  agenda.define("cleanup ended streams", cleanEndedStreams);
  agenda.define("cleanup webhookresults", cleanWebhookResults);

  agenda.every("5 minutes", "cleanup ended streams");
  agenda.every("1 hour", "cleanup webhookresults");
}

async function cleanVideos(videoIds: string[]) {
  await Placeholder.deleteMany({ originVideoId: { $in: videoIds } });
  await RemoveChatAction.deleteMany({ originVideoId: { $in: videoIds } });
  await BanAction.deleteMany({ originVideoId: { $in: videoIds } });
  await Membership.deleteMany({ originVideoId: { $in: videoIds } });
  await Milestone.deleteMany({ originVideoId: { $in: videoIds } });
  await SuperChat.deleteMany({ originVideoId: { $in: videoIds } });
  await SuperSticker.deleteMany({ originVideoId: { $in: videoIds } });
  await MembershipGift.deleteMany({ originVideoId: { $in: videoIds } });
  await MembershipGiftPurchase.deleteMany({ originVideoId: { $in: videoIds } });
  await Chat.deleteMany({ originVideoId: { $in: videoIds } });
  await VideoUserStats.deleteMany({ videoId: { $in: videoIds } });
  await Video.updateMany(
    { id: { $in: videoIds } },
    { $set: { hbCleanedAt: new Date() } }
  );
  console.log(`cleanup ${videoIds.length} streams: ${videoIds.join(", ")}`);
}

async function cleanEndedStreams() {
  const cleanupThresholdTime = moment
    .tz("UTC")
    .subtract(MAX_HOURS_BEFORE_CLEANUP, "hour")
    .toDate();

  // Step 1: Find candidate videos from Video collection directly
  const videos = await Video.find(
    {
      hbCleanedAt: null,
      hbStatus: { $ne: HoneybeeStatus.Created },
      status: { $nin: LiveStatus },
      $or: [
        { actualEnd: { $lt: cleanupThresholdTime } },
        { hbEnd: { $lt: cleanupThresholdTime } },
        // Fallback: neither actualEnd nor hbEnd exist (e.g. worker crashed)
        {
          actualEnd: { $exists: false },
          hbEnd: { $exists: false },
          updatedAt: { $lt: cleanupThresholdTime },
        },
      ],
    },
    {
      id: 1,
      status: 1,
      availableAt: 1,
      publishedAt: 1,
      actualEnd: 1,
      hbEnd: 1,
      hbIgnore: 1,
    },
    {
      readPreference: "secondaryPreferred",
    }
  );

  if (videos.length === 0) return;

  const candidateVideoIds = videos.map((v) => v.id);

  // Step 2: Get last activity time from VideoStats for candidates
  const statsRecords = await VideoStats.aggregate<{
    _id: string;
    lastTime: Date;
  }>(
    [
      {
        $match: {
          type: VideoStatsType.MessageTotal,
          videoId: { $in: candidateVideoIds },
        },
      },
      {
        $group: {
          _id: "$videoId",
          lastTime: { $max: "$updatedAt" },
        },
      },
    ],
    {
      readPreference: "secondaryPreferred",
    }
  );

  // Step 3: Filter videos that are safe to clean
  const toRemoveVideoIds = videos
    .filter((video) => {
      if (video.hbIgnore) return true;
      const statsRecord = statsRecords.find((r) => r._id === video.id);
      return (
        (!video.availableAt || video.availableAt < cleanupThresholdTime) &&
        (!video.publishedAt || video.publishedAt < cleanupThresholdTime) &&
        (!video.actualEnd || video.actualEnd < cleanupThresholdTime) &&
        (!video.hbEnd || video.hbEnd < cleanupThresholdTime) &&
        (!statsRecord || statsRecord.lastTime < cleanupThresholdTime)
      );
    })
    .map((video) => video.id);

  if (toRemoveVideoIds.length > 0) {
    await cleanVideos(toRemoveVideoIds);
    await recalcVideoHbStats(toRemoveVideoIds);
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
            moment.tz().diff(doc.updatedAt, "days", true) >= 1
          ) {
            markDelete = true;
          }
          break;
        case "raids":
          if (moment.tz().diff(doc.updatedAt, "days", true) >= 1) {
            markDelete = true;
          }
          break;
        case "videos":
          if (
            !LiveStatus.includes(doc.status) &&
            moment.tz().diff(doc.updatedAt, "days", true) >= 1
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
