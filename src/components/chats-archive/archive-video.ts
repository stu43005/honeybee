import { type DocumentType } from "@typegoose/typegoose";
import type { Job } from "agenda";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Cursor } from "mongoose";
import assert from "node:assert";
import { CHAT_ARCHIVE_DIR } from "../../constants.js";
import { MessageType, VideoStatsType } from "../../interfaces.js";
import ChatModel from "../../models/Chat.js";
import MembershipModel from "../../models/Membership.js";
import MembershipGiftModel from "../../models/MembershipGift.js";
import MembershipGiftPurchaseModel from "../../models/MembershipGiftPurchase.js";
import MilestoneModel from "../../models/Milestone.js";
import PollModel from "../../models/Poll.js";
import RaidModel from "../../models/Raid.js";
import SuperChatModel from "../../models/SuperChat.js";
import SuperStickerModel from "../../models/SuperSticker.js";
import VideoModel, { type Video } from "../../models/Video.js";
import VideoStatsModel from "../../models/VideoStats.js";
import { getTimestamp, getVideoPath } from "./templates/format.js";
import {
  renderChatRow,
  renderVideoArchiveShell,
  type ChatRowDoc,
  type CurrencyAgg,
} from "./templates/VideoArchive.js";

function getOutputFilePath(video: DocumentType<Video>): string {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  return path.join(CHAT_ARCHIVE_DIR, getVideoPath(video));
}

/**
 * Merge multiple cursors ordered by timestamp field.
 */
async function* multiCursorOrderedPeek<T extends DocumentType<object>>(
  ...cursors: Array<Cursor<T, any>>
) {
  const items: Array<{
    cursor: Cursor<T, any>;
    current: T | null;
    timestamp: Date | null;
  }> = cursors.map((cursor) => ({
    cursor,
    current: null,
    timestamp: null,
  }));

  for (const item of items) {
    item.current = await item.cursor.next();
    item.timestamp = getTimestamp(item.current);
  }

  while (true) {
    let minItem: (typeof items)[0] | null = null;
    for (const item of items) {
      if (item.current) {
        if (
          !minItem ||
          !minItem.timestamp ||
          (item.timestamp && item.timestamp < minItem.timestamp)
        ) {
          minItem = item;
        }
      }
    }

    if (!minItem) break;

    yield minItem.current as T;

    minItem.current = await minItem.cursor.next();
    minItem.timestamp = getTimestamp(minItem.current);
  }
}

export async function archiveVideo(videoId: string, job?: Job): Promise<void> {
  const video = await VideoModel.findByVideoId(videoId).setOptions({
    readPreference: "secondaryPreferred",
  });
  if (!video) return;

  const stats = await VideoStatsModel.find(
    {
      videoId,
      type: {
        $in: [
          VideoStatsType.PurchaseAmountTotal,
          VideoStatsType.PurchaseAmountJpyTotal,
        ],
      },
      messageType: {
        $in: [MessageType.SuperChat, MessageType.SuperSticker],
      },
    },
    null,
    { readPreference: "secondaryPreferred" }
  );

  const currencies = stats
    .reduce<CurrencyAgg[]>((acc, stat) => {
      let entry = acc.find((c) => c.currency === stat.currency);
      if (!entry) {
        entry = { currency: stat.currency!, amount: 0, jpyAmount: 0 };
        acc.push(entry);
      }
      if (stat.type === VideoStatsType.PurchaseAmountTotal) {
        entry.amount += stat.value;
      } else if (stat.type === VideoStatsType.PurchaseAmountJpyTotal) {
        entry.jpyAmount += stat.value;
      }
      return acc;
    }, [])
    .sort((a, b) => b.jpyAmount - a.jpyAmount);
  const jpySum = currencies.reduce(
    (acc, c) => acc + Math.round(c.jpyAmount),
    0
  );

  const outputFilePath = getOutputFilePath(video);
  await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });
  const ws = fs.createWriteStream(`${outputFilePath}.tmp`, {
    encoding: "utf-8",
  });

  const [head, tail] = await renderVideoArchiveShell({
    video,
    currencies,
    jpySum,
  });
  ws.write(head);

  const ownerChatCursor = ChatModel.find({
    originVideoId: videoId,
    isOwner: true,
  })
    .sort({ timestamp: 1 })
    .setOptions({ readPreference: "secondaryPreferred" })
    .cursor();
  const moderatorChatCursor = ChatModel.find({
    originVideoId: videoId,
    isModerator: true,
  })
    .sort({ timestamp: 1 })
    .setOptions({ readPreference: "secondaryPreferred" })
    .cursor();
  const superChatCursor = SuperChatModel.find({ originVideoId: videoId })
    .sort({ timestamp: 1 })
    .setOptions({ readPreference: "secondaryPreferred" })
    .cursor();
  const superStickerCursor = SuperStickerModel.find({
    originVideoId: videoId,
  })
    .sort({ timestamp: 1 })
    .setOptions({ readPreference: "secondaryPreferred" })
    .cursor();
  const membershipCursor = MembershipModel.find({ originVideoId: videoId })
    .sort({ timestamp: 1 })
    .setOptions({ readPreference: "secondaryPreferred" })
    .cursor();
  const membershipGiftCursor = MembershipGiftModel.find({
    originVideoId: videoId,
  })
    .sort({ timestamp: 1 })
    .setOptions({ readPreference: "secondaryPreferred" })
    .cursor();
  const membershipGiftPurchaseCursor = MembershipGiftPurchaseModel.find({
    originVideoId: videoId,
  })
    .sort({ timestamp: 1 })
    .setOptions({ readPreference: "secondaryPreferred" })
    .cursor();
  const milestoneCursor = MilestoneModel.find({ originVideoId: videoId })
    .sort({ timestamp: 1 })
    .setOptions({ readPreference: "secondaryPreferred" })
    .cursor();
  const pollCursor = PollModel.find({ originVideoId: videoId })
    .sort({ updatedAt: 1 })
    .setOptions({ readPreference: "secondaryPreferred" })
    .cursor();
  const raidCursor = RaidModel.find({ originVideoId: videoId })
    .sort({ timestamp: 1 })
    .setOptions({ readPreference: "secondaryPreferred" })
    .cursor();

  let no = 0;
  for await (const doc of multiCursorOrderedPeek<ChatRowDoc>(
    ownerChatCursor,
    moderatorChatCursor,
    superChatCursor,
    superStickerCursor,
    membershipCursor,
    membershipGiftCursor,
    membershipGiftPurchaseCursor,
    milestoneCursor,
    pollCursor,
    raidCursor
  )) {
    no++;
    ws.write(await renderChatRow({ doc, no, video }));
    await job?.touch();
  }

  ws.end(tail);

  if (no === 0) {
    await fsp.unlink(`${outputFilePath}.tmp`);
    return;
  }
  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
}
