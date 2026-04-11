import { isDocument } from "@typegoose/typegoose";
import moment from "moment";
import assert from "node:assert";
import { MessageType, VideoStatsType } from "../interfaces.js";
import ChatModel from "../models/Chat.js";
import VideoModel from "../models/Video.js";
import VideoStatsModel, { VideoStatsFlags } from "../models/VideoStats.js";
import type { Application } from "../modules/application.js";
import type { AgendaModule } from "../modules/schedule.js";

export default function videoScaler(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  agenda.define("video scale", videoScale);
  agenda.every("30 seconds", "video scale");
}

async function videoScale() {
  const stats = await VideoStatsModel.getVideoIdsWithoutFlag(
    {
      type: VideoStatsType.MessageTotal,
      messageType: MessageType.Chat,
      updatedAt: {
        $gte: moment.tz("UTC").subtract(10, "minutes").toDate(),
      },
    },
    VideoStatsFlags.VideoScalerProcessed
  );

  for await (const { videoId, statsId, lastId } of stats) {
    const lastChat = await ChatModel.findById(
      lastId,
      { timestamp: 1 },
      { readPreference: "secondaryPreferred" }
    );
    if (!lastChat) continue;

    const video = await VideoModel.findByVideoId(videoId);
    if (!video) continue;
    if (!video.isLive()) continue;

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
        `[${channelName}][${videoId}] scale up (current: ${currentReplicas}, target: ${targetReplica})`
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
        `[${channelName}][${videoId}] scale down (current: ${currentReplicas}, target: ${targetReplica})`
      );
      await VideoModel.updateOne(
        { id: videoId },
        {
          $inc: { hbReplica: -1 },
        }
      );
    }

    await VideoStatsModel.setFlag(
      statsId,
      VideoStatsFlags.VideoScalerProcessed,
      lastId
    );
  }
}
