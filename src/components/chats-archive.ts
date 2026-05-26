import { mongoose } from "@typegoose/typegoose";
import type { Job } from "agenda";
import moment from "moment";
import assert from "node:assert";
import { CHAT_ARCHIVE_DIR, MAX_HOURS_BEFORE_CLEANUP } from "../constants.js";
import {
  MessageAuthorType,
  MessageType,
  VideoStatsType,
} from "../interfaces.js";
import VideoStatsModel, { VideoStatsFlags } from "../models/VideoStats.js";
import type { Application } from "../modules/application.js";
import { MONGO_URI } from "../modules/db.js";
import type { AgendaModule } from "../modules/schedule.js";
import { isMain } from "../utils/esm.js";
import { archiveVideo } from "./chats-archive/archive-video.js";
import { genIndexFile } from "./chats-archive/gen-index-file.js";

export default function chatsArchive(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  if (CHAT_ARCHIVE_DIR) {
    agenda.define("chats archive", archiveAllChats);
    void agenda.every("1 minutes", "chats archive");

    agenda.define("chats archive index", () => genIndexFile());
    void agenda.every("10 minutes", "chats archive index");
  }
}

async function archiveAllChats(job?: Job) {
  const stats = await VideoStatsModel.getVideoIdsWithoutFlag(
    {
      type: VideoStatsType.MessageTotal,
      $or: [
        {
          messageType: {
            $in: [
              MessageType.SuperChat,
              MessageType.SuperSticker,
              MessageType.Membership,
              MessageType.MembershipGift,
              MessageType.MembershipGiftPurchase,
              MessageType.Milestone,
            ],
          },
        },
        {
          messageType: MessageType.Chat,
          authorType: {
            $in: [MessageAuthorType.Owner, MessageAuthorType.Moderator],
          },
        },
      ],
      updatedAt: {
        $gte: moment
          .tz("UTC")
          .subtract(MAX_HOURS_BEFORE_CLEANUP, "hour")
          .toDate(),
      },
    },
    VideoStatsFlags.ChatsArchiveProcessed
  );

  for (const { videoId, statsId } of stats) {
    try {
      await archiveVideo(videoId);
      await VideoStatsModel.setFlag(
        statsId,
        VideoStatsFlags.ChatsArchiveProcessed
      );
    } catch (error) {
      console.error(`Failed to archive chats for video ${videoId}:`, error);
    }
    await job?.touch();
  }
}

if (isMain(import.meta)) {
  void (async () => {
    assert(MONGO_URI, "MONGO_URI should be defined.");
    await mongoose.connect(MONGO_URI);
    await genIndexFile({ isDirect: true });
    await mongoose.disconnect();
    process.exit(0);
  })();
}
