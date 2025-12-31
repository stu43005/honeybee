import { isDocument } from "@typegoose/typegoose";
import moment from "moment";
import assert from "node:assert";
import { MessageType, VideoStatsType } from "../interfaces";
import ChatModel from "../models/Chat";
import VideoModel from "../models/Video";
import VideoStatsModel from "../models/VideoStats";
import type { Application } from "../modules/application";
import type { AgendaModule } from "../modules/schedule";

export default function videoScaler(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  agenda.define("video scale", videoScale);
  agenda.every("1 minute", "video scale");
}

async function videoScale() {
  const videos = await VideoStatsModel.aggregate<{
    _id: string;
  }>(
    [
      {
        $match: {
          type: VideoStatsType.MessageTotal,
          messageType: MessageType.Chat,
          updatedAt: {
            $gte: new Date(Date.now() - 10 * 60 * 1000),
          },
        },
      },
      {
        $group: {
          _id: "$videoId",
        },
      },
    ],
    {
      readPreference: "secondaryPreferred",
    }
  );

  for await (const { _id: videoId } of videos) {
    const lastChat = await ChatModel.findOne({
      originVideoId: videoId,
    })
      .sort({ timestamp: -1 })
      .select({ timestamp: 1 })
      .setOptions({ readPreference: "secondaryPreferred" })
      .exec();
    if (!lastChat) continue;

    const video = await VideoModel.findByVideoId(videoId);
    if (!video) continue;
    if (video.hbIgnore) continue;

    const chatsCount = await ChatModel.find({
      originVideoId: videoId,
      timestamp: {
        $gt: moment(lastChat.timestamp).clone().subtract(1, "minute").toDate(),
        $lte: lastChat.timestamp,
      },
    })
      .setOptions({ readPreference: "secondaryPreferred" })
      .countDocuments();

    const chatReplicaCapacity = 350;
    const currentReplicas = video.getReplicas();
    const targetReplica = Math.ceil(chatsCount / chatReplicaCapacity) || 1;
    const scaleDownThreshold =
      (currentReplicas - 1) * chatReplicaCapacity * 0.9;
    const channelName = isDocument(video.channel)
      ? video.channel.name
      : video.channelId;

    // console.log(`[${channelName}][${videoId}] chats in last minute: ${chatsCount}, current replicas: ${currentReplicas}, target replicas: ${targetReplica}`);

    if (currentReplicas < targetReplica) {
      console.log(
        `[${channelName}][${videoId}] scale up (target: ${targetReplica})`
      );
      await VideoModel.updateOne(
        { id: videoId },
        {
          $inc: { hbReplica: 1 },
          $set: { scaleUpAt: new Date() },
        }
      );
    } else if (
      currentReplicas > targetReplica &&
      scaleDownThreshold > chatsCount &&
      (!video.scaleUpAt ||
        moment.tz("UTC").subtract(10, "minute").isAfter(video.scaleUpAt))
    ) {
      console.log(
        `[${channelName}][${videoId}] scale down (target: ${targetReplica})`
      );
      await VideoModel.updateOne(
        { id: videoId },
        {
          $inc: { hbReplica: -1 },
        }
      );
    }
  }
}
