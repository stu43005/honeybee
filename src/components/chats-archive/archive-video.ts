import { type DocumentType } from "@typegoose/typegoose";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import type { Cursor, mongo } from "mongoose";
import assert from "node:assert";
import { CHAT_ARCHIVE_DIR } from "../../constants.js";
import { MessageType, VideoStatsType } from "../../interfaces.js";
import ChatModel, { type Chat } from "../../models/Chat.js";
import MembershipModel, { type Membership } from "../../models/Membership.js";
import MembershipGiftModel, {
  type MembershipGift,
} from "../../models/MembershipGift.js";
import MembershipGiftPurchaseModel, {
  type MembershipGiftPurchase,
} from "../../models/MembershipGiftPurchase.js";
import MilestoneModel, { type Milestone } from "../../models/Milestone.js";
import PollModel, { type Poll } from "../../models/Poll.js";
import RaidModel, { type Raid } from "../../models/Raid.js";
import SuperChatModel, { type SuperChat } from "../../models/SuperChat.js";
import SuperStickerModel, {
  type SuperSticker,
} from "../../models/SuperSticker.js";
import VideoModel, { type Video } from "../../models/Video.js";
import VideoStatsModel from "../../models/VideoStats.js";
import { setIfDefine } from "../../util.js";
import { buildVideoSummary } from "./build-video-summary.js";

export type ChatRowDoc = DocumentType<
  | Chat
  | SuperChat
  | SuperSticker
  | Membership
  | MembershipGift
  | MembershipGiftPurchase
  | Milestone
  | Poll
  | Raid
>;

export interface CurrencyAgg {
  currency: string;
  amount: number;
  jpyAmount: number;
}

function getTimestamp(current: DocumentType<object>): Date;
function getTimestamp(current: DocumentType<object> | null): Date | null;
function getTimestamp(current: DocumentType<object> | null): Date | null {
  if (!current) return null;
  if ("timestamp" in current && current.timestamp instanceof Date) {
    return current.timestamp;
  }
  if ("updatedAt" in current && current.updatedAt instanceof Date) {
    return current.updatedAt;
  }
  if ("createdAt" in current && current.createdAt instanceof Date) {
    return current.createdAt;
  }
  return (current._id as mongo.BSON.ObjectId).getTimestamp();
}

function getOutputFilePaths(video: DocumentType<Video>): {
  jsonl: string;
  meta: string;
} {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  return {
    jsonl: path.join(CHAT_ARCHIVE_DIR, "data", "videos", `${video.id}.jsonl`),
    meta: path.join(
      CHAT_ARCHIVE_DIR,
      "data",
      "videos",
      `${video.id}.meta.json`
    ),
  };
}

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

export async function archiveVideo(
  videoId: string,
  { isDirect = false }: { isDirect?: boolean } = {}
): Promise<void> {
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

  const { jsonl: jsonlPath, meta: metaPath } = getOutputFilePaths(video);

  await fsp.mkdir(path.dirname(jsonlPath), { recursive: true });

  await Promise.all([
    fsp.rm(`${jsonlPath}.tmp`, { force: true }),
    fsp.rm(`${metaPath}.tmp`, { force: true }),
  ]);

  const jsonlWs = fs.createWriteStream(`${jsonlPath}.tmp`, {
    encoding: "utf-8",
  });

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
  const raidCursor = RaidModel.find({
    $or: [{ originVideoId: videoId }, { sourceVideoId: videoId }],
  })
    .sort({ timestamp: 1 })
    .setOptions({ readPreference: "secondaryPreferred" })
    .cursor();

  let no = 0;
  const aggregates: VideoAggregates = {
    chatCount: 0,
    superChatCount: 0,
    superStickerCount: 0,
    membershipCount: 0,
    giftCount: 0,
    giftPurchaseCount: 0,
    totalGiftAmount: 0,
    milestoneCount: 0,
    pollCount: 0,
    raidCount: 0,
  };

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
    const row = buildJsonlRow(doc, videoId);
    if (row) {
      jsonlWs.write(JSON.stringify(row) + "\n");
      bumpAggregate(aggregates, doc);
    }
  }

  jsonlWs.end();
  await finished(jsonlWs);

  const meta = {
    ...(await buildVideoSummary(video)),
    archiveVersion: 2,
    aggregates: {
      ...aggregates,
      currencyTable: currencies,
      jpyTotal: jpySum,
    },
  };

  await fsp.writeFile(`${metaPath}.tmp`, JSON.stringify(meta) + "\n", "utf-8");

  // Rename jsonl before meta so a consumer fetching meta.json never sees
  // meta.json without its sibling .jsonl in place at the final name. For
  // empty videos the .jsonl tmp is discarded instead.
  if (no > 0) {
    await fsp.rename(`${jsonlPath}.tmp`, jsonlPath);
  } else {
    await fsp.rm(`${jsonlPath}.tmp`, { force: true });
  }
  await fsp.rename(`${metaPath}.tmp`, metaPath);

  if (!isDirect && (video.hbStats?.chatsArchiveVersion ?? 0) < 2) {
    await VideoModel.updateOne(
      { id: videoId },
      { $set: { "hbStats.chatsArchiveVersion": 2 } }
    );
  }
}

type VideoAggregates = {
  chatCount: number;
  superChatCount: number;
  superStickerCount: number;
  membershipCount: number;
  giftCount: number;
  giftPurchaseCount: number;
  totalGiftAmount: number;
  milestoneCount: number;
  pollCount: number;
  raidCount: number;
};

type JsonlRow = { type: string; [key: string]: unknown };

function buildJsonlRow(doc: ChatRowDoc, videoId: string): JsonlRow | null {
  switch (doc.collection.name) {
    case "chats": {
      const d = doc as DocumentType<Chat>;
      return makeAuthorRow("chat", d, {
        message: d.message,
      });
    }
    case "superchats": {
      const d = doc as DocumentType<SuperChat>;
      return makeAuthorRow("superChat", d, {
        message: d.message,
        amount: d.amount,
        currency: d.currency,
        jpyAmount: d.jpyAmount,
        ...setIfDefine("significance", d.significance),
        ...setIfDefine("color", d.color),
      });
    }
    case "superstickers": {
      const d = doc as DocumentType<SuperSticker>;
      return makeAuthorRow("superSticker", d, {
        ...setIfDefine("text", d.text),
        image: d.image,
        amount: d.amount,
        currency: d.currency,
        jpyAmount: d.jpyAmount,
        ...setIfDefine("significance", d.significance),
        ...setIfDefine("color", d.color),
      });
    }
    case "memberships": {
      const d = doc as DocumentType<Membership>;
      return makeAuthorRow("membership", d, {
        ...setIfDefine("level", d.level),
        ...setIfDefine("since", d.since),
      });
    }
    case "membershipgifts": {
      const d = doc as DocumentType<MembershipGift>;
      return makeAuthorRow("membershipGift", d, {
        ...setIfDefine("senderName", d.senderName),
      });
    }
    case "membershipgiftpurchases": {
      const d = doc as DocumentType<MembershipGiftPurchase>;
      return makeAuthorRow("membershipGiftPurchase", d, {
        amount: d.amount,
      });
    }
    case "milestones": {
      const d = doc as DocumentType<Milestone>;
      return makeAuthorRow("milestone", d, {
        message: d.message,
        ...setIfDefine("level", d.level),
        ...setIfDefine("duration", d.duration),
        ...setIfDefine("since", d.since),
      });
    }
    case "polls": {
      const d = doc as DocumentType<Poll>;
      return {
        type: "poll",
        id: d.id,
        timestamp: d.updatedAt,
        ...setIfDefine("createdAt", d.createdAt),
        ...setIfDefine("question", d.question),
        choices: d.choices.map((c) => ({
          text: c.text,
          ...setIfDefine("voteRatio", c.voteRatio),
        })),
        ...setIfDefine("voteCount", d.voteCount),
      };
    }
    case "raids": {
      const d = doc as DocumentType<Raid>;
      if (d.originVideoId === videoId) {
        return {
          type: "raid",
          ...setIfDefine("id", d.id),
          timestamp: d.timestamp,
          ...setIfDefine("sourceVideoId", d.sourceVideoId),
          ...setIfDefine("sourceChannelId", d.sourceChannelId),
          sourceName: d.sourceName,
          ...setIfDefine("sourcePhoto", d.sourcePhoto),
        };
      }
      if (d.sourceVideoId === videoId) {
        return {
          type: "raidOutgoing",
          ...setIfDefine("id", d.id),
          timestamp: d.timestamp,
          originVideoId: d.originVideoId,
          ...setIfDefine("originChannelId", d.originChannelId),
          ...setIfDefine("originName", d.originName),
          ...setIfDefine("originPhoto", d.originPhoto),
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function makeAuthorRow(
  type: string,
  d: unknown,
  extra: Record<string, unknown>
): JsonlRow {
  const r = d as Record<string, unknown>;
  return {
    type,
    id: r.id as string,
    timestamp: r.timestamp as Date,
    ...setIfDefine("authorName", r.authorName),
    ...setIfDefine("authorPhoto", r.authorPhoto),
    authorChannelId: r.authorChannelId,
    authorType: r.authorType,
    ...setIfDefine("membership", r.membership),
    isVerified: r.isVerified,
    isOwner: r.isOwner,
    isModerator: r.isModerator,
    ...extra,
  };
}

function bumpAggregate(agg: VideoAggregates, doc: ChatRowDoc): void {
  switch (doc.collection.name) {
    case "chats":
      agg.chatCount++;
      break;
    case "superchats":
      agg.superChatCount++;
      break;
    case "superstickers":
      agg.superStickerCount++;
      break;
    case "memberships":
      agg.membershipCount++;
      break;
    case "membershipgifts":
      agg.giftCount++;
      break;
    case "membershipgiftpurchases": {
      const d = doc as DocumentType<MembershipGiftPurchase>;
      agg.giftPurchaseCount++;
      agg.totalGiftAmount += d.amount;
      break;
    }
    case "milestones":
      agg.milestoneCount++;
      break;
    case "polls":
      agg.pollCount++;
      break;
    case "raids":
      agg.raidCount++;
      break;
  }
}
