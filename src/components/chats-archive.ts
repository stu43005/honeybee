import { mongoose, type DocumentType } from "@typegoose/typegoose";
import type { Job } from "agenda";
import { VideoStatus } from "holodex.js";
import moment from "moment";
import type { Cursor, mongo } from "mongoose";
import assert from "node:assert";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { CHAT_ARCHIVE_DIR, MAX_HOURS_BEFORE_CLEANUP } from "../constants";
import { currencyMap } from "../data/currency";
import { HoneybeeStatus, MessageAuthorType, MessageType, VideoStatsType } from "../interfaces";
import ChannelModel from "../models/Channel";
import ChatModel, { type Chat } from "../models/Chat";
import MembershipModel, { type Membership } from "../models/Membership";
import MembershipGiftModel, {
  type MembershipGift,
} from "../models/MembershipGift";
import MembershipGiftPurchaseModel, {
  type MembershipGiftPurchase,
} from "../models/MembershipGiftPurchase";
import MilestoneModel, { type Milestone } from "../models/Milestone";
import PollModel, { type Poll } from "../models/Poll";
import RaidModel, { type Raid } from "../models/Raid";
import SuperChatModel, { type SuperChat } from "../models/SuperChat";
import SuperStickerModel, { type SuperSticker } from "../models/SuperSticker";
import VideoModel, { type Video } from "../models/Video";
import VideoStatsModel, { VideoStatsFlags } from "../models/VideoStats";
import type { Application } from "../modules/application";
import { MONGO_URI } from "../modules/db";
import type { AgendaModule } from "../modules/schedule";

export default function chatsArchive(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  if (CHAT_ARCHIVE_DIR) {
    agenda.define("chats archive", archiveAllChats);
    agenda.every("1 minutes", "chats archive");

    agenda.define("chats archive index", genIndexFile);
    agenda.every("1 minutes", "chats archive index");
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

  for await (const { videoId, statsId } of stats) {
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

function getVideoPath(video: DocumentType<Video>) {
  const date = moment(video.availableAt).tz("Asia/Tokyo").format("YYYYMMDD");
  return path.join(video.channelId, `${date}_${video.id}.html`);
}

function getOutputFilePath(video: DocumentType<Video>) {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  return path.join(CHAT_ARCHIVE_DIR, getVideoPath(video));
}

async function archiveVideo(videoId: string) {
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

  const outputFilePath = getOutputFilePath(video);
  await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });
  const ws = fs.createWriteStream(`${outputFilePath}.tmp`, {
    encoding: "utf-8",
  });
  ws.write(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${video.title}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
    }
    .video-thumbnail.small {
      height: 110px;
    }
    .superchat-table {
      font-family: monospace;
      border-collapse: collapse;
    }
    .superchat-table th, .superchat-table td {
      text-align: right;
      padding-left: 10px;
    }
    #chats-table tr.row {
      display: none;
    }
    #chats-table.owner tr.owner,
    #chats-table.moderator tr.moderator,
    #chats-table.memberships tr.memberships,
    #chats-table.milestones tr.milestones,
    #chats-table.membershipgifts tr.membershipgifts,
    #chats-table.membershipgiftpurchases tr.membershipgiftpurchases,
    #chats-table.superchats.significance-1 tr.superchats.significance-1,
    #chats-table.superchats.significance-2 tr.superchats.significance-2,
    #chats-table.superchats.significance-3 tr.superchats.significance-3,
    #chats-table.superchats.significance-4 tr.superchats.significance-4,
    #chats-table.superchats.significance-5 tr.superchats.significance-5,
    #chats-table.superchats.significance-6 tr.superchats.significance-6,
    #chats-table.superchats.significance-7 tr.superchats.significance-7,
    #chats-table.superstickers.significance-1 tr.superstickers.significance-1,
    #chats-table.superstickers.significance-2 tr.superstickers.significance-2,
    #chats-table.superstickers.significance-3 tr.superstickers.significance-3,
    #chats-table.superstickers.significance-4 tr.superstickers.significance-4,
    #chats-table.superstickers.significance-5 tr.superstickers.significance-5,
    #chats-table.superstickers.significance-6 tr.superstickers.significance-6,
    #chats-table.superstickers.significance-7 tr.superstickers.significance-7,
    #chats-table.polls tr.polls,
    #chats-table.raids tr.raids {
      display: table-row;
    }
    .wordless {
      color: blue;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
<table>
<tr><td>
  <h1><a href="${VideoModel.getUrl(video)}">${video.title}</a></h1>
  <img class="video-thumbnail small" src="${
    VideoModel.getVideoThumbnails(video).maxres
  }" onclick="this.classList.toggle('small')" />
</td></tr>
<tr><td>
<table class="superchat-table">
<tr>
  <th>symbol</th>
  <th>code</th>
  <th>sum</th>
  <th>sum (JPY)</th>
</tr>
`);

  const currencies = stats
    .reduce<{ _id: string; amount: number; jpyAmount: number }[]>(
      (acc, stat) => {
        let currency = acc.find((c) => c._id === stat.currency);
        if (!currency) {
          currency = { _id: stat.currency!, amount: 0, jpyAmount: 0 };
          acc.push(currency);
        }
        if (stat.type === VideoStatsType.PurchaseAmountTotal) {
          currency.amount += stat.value;
        } else if (stat.type === VideoStatsType.PurchaseAmountJpyTotal) {
          currency.jpyAmount += stat.value;
        }
        return acc;
      },
      []
    )
    .sort((a, b) => b.jpyAmount - a.jpyAmount);
  let jpySum = 0;
  for (const currency of currencies) {
    ws.write(`<tr>
  <td>${currencyMap[currency._id]?.symbol ?? "N/A"}</td>
  <td>${currency._id ?? "N/A"}</td>
  <td>${formatCurrency(currency.amount, currency._id, "decimal")}</td>
  <td>${formatCurrency(Math.round(currency.jpyAmount), "JPY", "decimal")}</td>
</tr>
`);
    jpySum += Math.round(currency.jpyAmount);
  }

  ws.write(`<tr>
  <td></td>
  <td></td>
  <td></td>
  <td>${formatCurrency(jpySum, "JPY", "decimal")}</td>
</tr>
</table>
</td></tr>
</table>
<hr />
<div id="toggle-controls">
  <label><input type="checkbox" id="toggle-owner" />owner<span class="count"></span></label>
  <label><input type="checkbox" id="toggle-moderator" />moderator<span class="count"></span></label><br/>
  <label><input type="checkbox" id="toggle-memberships" />membership<span class="count"></span></label>
  <label><input type="checkbox" id="toggle-milestones" />milestone<span class="count"></span></label><br/>
  <label><input type="checkbox" id="toggle-membershipgifts" />membershipGift<span class="count"></span></label>
  <label><input type="checkbox" id="toggle-membershipgiftpurchases" />membershipGiftPurchase<span class="count"></span></label><br/>
  <label><input type="checkbox" id="toggle-superchats" checked />superchat<span class="count"></span></label>
  <label><input type="checkbox" id="toggle-superstickers" checked />supersticker<span class="count"></span></label><br/>
  <label><input type="checkbox" id="toggle-all-significance" checked />toggle all:</label>
  <label><input type="checkbox" id="toggle-significance-1" checked /><div style="display: inline-block; width: 16px; height: 16px; background-color: blue;"></div><span class="count"></span></label>
  <label><input type="checkbox" id="toggle-significance-2" checked /><div style="display: inline-block; width: 16px; height: 16px; background-color: lightblue;"></div><span class="count"></span></label>
  <label><input type="checkbox" id="toggle-significance-3" checked /><div style="display: inline-block; width: 16px; height: 16px; background-color: green;"></div><span class="count"></span></label>
  <label><input type="checkbox" id="toggle-significance-4" checked /><div style="display: inline-block; width: 16px; height: 16px; background-color: yellow;"></div><span class="count"></span></label>
  <label><input type="checkbox" id="toggle-significance-5" checked /><div style="display: inline-block; width: 16px; height: 16px; background-color: orange;"></div><span class="count"></span></label>
  <label><input type="checkbox" id="toggle-significance-6" checked /><div style="display: inline-block; width: 16px; height: 16px; background-color: magenta;"></div><span class="count"></span></label>
  <label><input type="checkbox" id="toggle-significance-7" checked /><div style="display: inline-block; width: 16px; height: 16px; background-color: red;"></div><span class="count"></span></label><br/>
  <label><input type="checkbox" id="toggle-polls" />poll<span class="count"></span></label>
  <label><input type="checkbox" id="toggle-raids" />raid<span class="count"></span></label>
</div>
<hr />
<table id="chats-table" border="1">
<tr>
  <th>No.</th>
  <th>Timestamp</th>
  <th>Currency</th>
  <th></th>
  <th>Icon</th>
  <th>Author</th>
  <th>Message</th>
</tr>
`);

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
  const superStickerCursor = SuperStickerModel.find({ originVideoId: videoId })
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
  for await (const doc of multiCursorOrderedPeek<
    DocumentType<
      | Chat
      | SuperChat
      | SuperSticker
      | Membership
      | MembershipGift
      | MembershipGiftPurchase
      | Milestone
      | Poll
      | Raid
    >
  >(
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
    const classNames = [
      "row",
      doc.collection.name,
      ...("significance" in doc && doc.significance
        ? [`significance-${doc.significance}`]
        : []),
      ...("isOwner" in doc && doc.isOwner ? ["owner"] : []),
      ...("isModerator" in doc && doc.isModerator ? ["moderator"] : []),
    ];
    const authorPhoto =
      "authorPhoto" in doc && doc.authorPhoto
        ? `<img src="${doc.authorPhoto}" style="height: 48px; border-radius: 50%;" loading="lazy" alt="author photo" /> `
        : "";
    const timestamp = getTimestamp(doc);
    let time = formatTimestamp(video, timestamp);

    ws.write(`<tr id="${doc._id}" class="${classNames.join(" ")}">
  <td style="text-align: right;">${no}</td>
`);
    switch (doc.collection.name) {
      case "chats": {
        const chat = doc as DocumentType<Chat>;
        ws.write(`  <td>${time}</td>
  <td></td>
  <td></td>
  <td>${authorPhoto}</td>
  <td>${chat.authorName ?? ""}</td>
  <td>${chat.message}</td>
`);
        break;
      }
      case "superchats": {
        const superChat = doc as DocumentType<SuperChat>;
        ws.write(`  <td>${time}</td>
  <td style="text-align: right;">${
    superChat.currency !== "JPY"
      ? `${formatCurrency(superChat.amount, superChat.currency)}<br/>`
      : ""
  }${formatCurrency(superChat.jpyAmount, "JPY")}</td>
  <td style="background-color: ${superChat.color};">　</td>
  <td>${authorPhoto}</td>
  <td>${superChat.authorName ?? ""}</td>
  <td>${
    superChat.message ?? `<span class="wordless">(wordless superchat)</span>`
  }</td>
`);
        break;
      }
      case "superstickers": {
        const superSticker = doc as DocumentType<SuperSticker>;
        ws.write(`  <td>${time}</td>
  <td style="text-align: right;">${
    superSticker.currency !== "JPY"
      ? `${formatCurrency(superSticker.amount, superSticker.currency)}<br/>`
      : ""
  }${formatCurrency(superSticker.jpyAmount, "JPY")}</td>
  <td style="background-color: ${superSticker.color};">　</td>
  <td>${authorPhoto}</td>
  <td>${superSticker.authorName ?? ""}</td>
  <td><img src="${superSticker.image}" title="${
          superSticker.text ?? ""
        }" alt="sticker" /></td>
`);
        break;
      }
      case "memberships": {
        const membership = doc as DocumentType<Membership>;
        ws.write(`  <td>${time}</td>
  <td></td>
  <td style="background-color: #00984f;">　</td>
  <td>${authorPhoto}</td>
  <td>${membership.authorName ?? ""}</td>
  <td>Joined as a member (${membership.membership ?? "N/A"})</td>
`);
        break;
      }
      case "membershipgifts": {
        const membershipGift = doc as DocumentType<MembershipGift>;
        ws.write(`  <td>${time}</td>
  <td></td>
  <td style="background-color: #00984f;">　</td>
  <td>${authorPhoto}</td>
  <td>${membershipGift.authorName ?? ""}</td>
  <td>Received a membership gift from ${membershipGift.senderName ?? "N/A"}</td>
`);
        break;
      }
      case "membershipgiftpurchases": {
        const membershipGiftPurchase =
          doc as DocumentType<MembershipGiftPurchase>;
        ws.write(`  <td>${time}</td>
  <td></td>
  <td style="background-color: #00984f;">　</td>
  <td>${authorPhoto}</td>
  <td>${membershipGiftPurchase.authorName ?? ""}</td>
  <td>Purchased <span class="gift-count">${
    membershipGiftPurchase.amount
  }</span> membership gift(s)</td>
`);
        break;
      }
      case "milestones": {
        const milestone = doc as DocumentType<Milestone>;
        ws.write(`  <td>${time}</td>
  <td></td>
  <td style="background-color: #00984f;">　</td>
  <td>${authorPhoto}</td>
  <td>${milestone.authorName ?? ""}</td>
  <td>${
    milestone.message ?? `<span class="wordless">(wordless milestone)</span>`
  }</td>
`);
        break;
      }
      case "polls": {
        const poll = doc as DocumentType<Poll>;
        if (poll.createdAt) {
          time = formatTimestamp(video, poll.createdAt) + " ~<br/>" + time;
        }
        ws.write(`  <td>${time}</td>
  <td></td>
  <td></td>
  <td></td>
  <td>Poll</td>
  <td>${poll.voteCount ? `${poll.voteCount} votes<br/>` : ""}${
          poll.question ?? "(empty question)"
        }<br/>${poll.choices
          .map(
            (choice) =>
              "- " +
              choice.text +
              (choice.voteRatio
                ? ` (${Math.floor(choice.voteRatio * 1000) / 10}%)`
                : "")
          )
          .join("<br/>")}</td>
`);
        break;
      }
      case "raids": {
        const raid = doc as DocumentType<Raid>;
        const sourcePhoto = raid.sourcePhoto
          ? `<img src="${raid.sourcePhoto}" style="height: 48px; border-radius: 50%;" loading="lazy" alt="author photo" /> `
          : "";
        ws.write(`  <td>${time}</td>
  <td></td>
  <td></td>
  <td>${sourcePhoto}</td>
  <td>${raid.sourceName ?? ""}</td>
  <td>${raid.sourceName ?? ""} and their viewers just joined. Say hello!</td>
`);
        break;
      }
    }

    ws.write(`</tr>\n`);
  }

  ws.end(`</table>
<script type="text/javascript">
document.getElementById('toggle-all-significance').addEventListener('change', function() {
  const checked = this.checked;
  const checkboxes = document.querySelectorAll('#toggle-controls input[id^="toggle-significance-"]');
  checkboxes.forEach(function(checkbox) {
    checkbox.checked = checked;
    const className = checkbox.id.replace('toggle-', '');
    document.getElementById('chats-table').classList.toggle(className, checkbox.checked);
  });
});
document.querySelectorAll('#toggle-controls input[type="checkbox"]').forEach(function(checkbox) {
  if (checkbox.id === 'toggle-all-significance') return;
  const className = checkbox.id.replace('toggle-', '');
  // row count
  const countSpan = checkbox.parentElement.querySelector('.count');
  if (countSpan) {
    const rowCount = document.querySelectorAll('#chats-table tr.' + className).length;
    if (className === 'membershipgiftpurchases') {
      const giftCount = Array.from(document.querySelectorAll('#chats-table tr.' + className + ' .gift-count')).reduce(function(acc, span) {
        return acc + parseInt(span.textContent);
      }, 0);
      countSpan.textContent = ' (count: ' + rowCount + ', total: ' + giftCount + ')';
    } else {
      countSpan.textContent = ' (' + rowCount + ')';
    }
  }
  // change event
  checkbox.addEventListener('change', function() {
    document.getElementById('chats-table').classList.toggle(className, this.checked);
  });
  // initial state
  document.getElementById('chats-table').classList.toggle(className, checkbox.checked);
});
</script>
</body>
</html>
`);

  // Replace tmp file to final file
  if (no === 0) {
    // No chats, remove the file
    await fsp.unlink(`${outputFilePath}.tmp`);
    return;
  }
  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
}

function formatCurrency(
  amount: number,
  currency: string,
  style: Intl.NumberFormatOptions["style"] = "currency"
) {
  return amount.toLocaleString("ja-JP", {
    style: style,
    currency: currency,
    currencyDisplay: "symbol",
    minimumFractionDigits: currencyMap[currency].decimal_digits,
    maximumFractionDigits: currencyMap[currency].decimal_digits,
  });
}

function formatTimestamp(video: DocumentType<Video>, timestamp: Date) {
  const timeSecond = VideoModel.getTimeSeconds(video, timestamp);
  const displayTime = moment(timestamp)
    .tz("Asia/Tokyo")
    .format("YYYY-MM-DD HH:mm:ss");
  return (
    (timeSecond ? `<a href="${VideoModel.getUrl(video, timeSecond)}">` : "") +
    `<time datetime="${timestamp.toISOString()}">${displayTime}</time>` +
    (timeSecond ? "</a>" : "")
  );
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
  }> = cursors.map((cursor) => ({ cursor, current: null, timestamp: null }));

  // Initial fetch
  for (const item of items) {
    item.current = await item.cursor.next();
    item.timestamp = getTimestamp(item.current);
  }

  while (true) {
    // Find the item with the smallest timestamp
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

    if (!minItem) {
      // All cursors are exhausted
      break;
    }

    yield minItem.current as T;

    // Advance the cursor that provided the minimum item
    minItem.current = await minItem.cursor.next();
    minItem.timestamp = getTimestamp(minItem.current);
  }
}

async function genIndexFile() {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  const outputFilePath = path.join(CHAT_ARCHIVE_DIR, `index.html`);
  await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });
  const ws = fs.createWriteStream(`${outputFilePath}.tmp`, {
    encoding: "utf-8",
  });

  ws.write(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chat Archives Index</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB" crossorigin="anonymous">
  <style>
    body {
      font-family: Arial, sans-serif;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px;
    }
    th {
      background-color: #f2f2f2;
    }
  </style>
</head>
<body>
<ul class="nav nav-tabs" role="tablist">
  <li class="nav-item" role="presentation">
    <button class="nav-link active" id="live-tab" data-bs-toggle="tab" data-bs-target="#live-tab-pane" type="button" role="tab" aria-controls="live-tab-pane" aria-selected="true">Live / Upcoming</button>
  </li>
  <li class="nav-item" role="presentation">
    <button class="nav-link" id="past-tab" data-bs-toggle="tab" data-bs-target="#past-tab-pane" type="button" role="tab" aria-controls="past-tab-pane" aria-selected="false">Past</button>
  </li>
</ul>
<div class="tab-content">
  <div class="tab-pane fade show active" id="live-tab-pane" role="tabpanel" aria-labelledby="live-tab" tabindex="0">
    <div class="container"><div class="row row-cols-1 row-cols-md-4 g-4">
`);

  const channelIds = new Set<string>();

  for await (const video of VideoModel.findLiveVideos(48)
    .sort({ availableAt: 1 })
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    if (
      video.status === VideoStatus.Live &&
      !video.actualStart &&
      video.scheduledStart &&
      moment.tz("UTC").isAfter(moment(video.scheduledStart).add(2, "days"))
    )
      continue;

    channelIds.add(video.channelId);
    await videoCard(ws, video);
    if (require.main === module) await archiveVideo(video.id);
  }

  ws.write(`    </div></div>
  </div>
  <div class="tab-pane fade" id="past-tab-pane" role="tabpanel" aria-labelledby="past-tab" tabindex="0">
    <div class="container"><div class="row row-cols-1 row-cols-md-4 g-4">
`);

  for await (const video of VideoModel.findRecentlyEndedVideos(48)
    .sort({ availableAt: -1 })
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    if (
      video.status === VideoStatus.Missing &&
      video.scheduledStart &&
      moment.tz("UTC").isBefore(video.scheduledStart)
    )
      continue;
    channelIds.add(video.channelId);
    await videoCard(ws, video);
    if (require.main === module) await archiveVideo(video.id);
  }

  ws.end(`    </div></div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.min.js" integrity="sha384-G/EV+4j2dNv+tEPo3++6LCgdCROaejBqfUeNjuKAiuXbjrxilcCdDz6ZAVfHWe1Y" crossorigin="anonymous"></script>
</body>
</html>
`);

  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);

  // Generate per-channel index files
  for (const channelId of channelIds) {
    try {
      await genChannelIndexFile(channelId);
    } catch (error) {
      console.error(`Failed to generate channel index for ${channelId}:`, error);
    }
  }
}

async function genChannelIndexFile(channelId: string) {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  const outputFilePath = path.join(CHAT_ARCHIVE_DIR, channelId, "index.html");
  await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });

  const channel = await ChannelModel.findByChannelId(channelId);
  if (!channel) return;

  const ws = fs.createWriteStream(`${outputFilePath}.tmp`, {
    encoding: "utf-8",
  });

  ws.write(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${channel.name} - Video Archive</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB" crossorigin="anonymous">
  <style>
    body {
      font-family: Arial, sans-serif;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px;
    }
    th {
      background-color: #f2f2f2;
    }
  </style>
</head>
<body>
<div class="container">
  <div class="d-flex align-items-center my-3">
    <img src="${channel.avatarUrl}" alt="Channel Avatar" style="height: 48px; width: 48px; border-radius: 50%; margin-right: 12px;" />
    <h1 class="mb-0">${channel.name}</h1>
  </div>
  <hr />
  <div class="row row-cols-1 row-cols-md-4 g-4">
`);

  let count = 0;
  for await (const video of VideoModel.find({
    channelId,
    uploadedVideo: { $ne: true },
  })
    .sort({ availableAt: -1 })
    .limit(200)
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    const before = ws.bytesWritten;
    await videoCard(ws, video, "../");
    if (ws.bytesWritten > before) count++;
  }

  ws.end(`  </div>
</div>
</body>
</html>
`);

  if (count === 0) {
    await fsp.unlink(`${outputFilePath}.tmp`);
    return;
  }
  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
}

async function videoCard(ws: Writable, video: DocumentType<Video>, basePath = "") {
  const videoStats = await VideoStatsModel.find({
    videoId: video.id,
    type: {
      $in: [
        VideoStatsType.MessageTotal,
        VideoStatsType.PurchaseAmountTotal,
        VideoStatsType.PurchaseAmountJpyTotal,
      ],
    },
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
  });
  if (!videoStats.length) {
    return;
  }

  const totalSuperChatAmountJpy = videoStats
    .filter((stat) => stat.type === VideoStatsType.PurchaseAmountJpyTotal)
    .reduce((sum, stat) => sum + stat.value, 0);
  const totalMembers = videoStats
    .filter(
      (stat) =>
        stat.type === VideoStatsType.MessageTotal &&
        stat.messageType === MessageType.Membership
    )
    .reduce((sum, stat) => sum + stat.value, 0);
  const totalGifts = videoStats
    .filter(
      (stat) =>
        stat.type === VideoStatsType.PurchaseAmountTotal &&
        stat.messageType === MessageType.MembershipGiftPurchase
    )
    .reduce((sum, stat) => sum + stat.value, 0);

  const channel = await video.getChannel();
  let statusText = "";
  switch (video.status) {
    case VideoStatus.Upcoming:
      if (video.scheduledStart) {
        statusText = `Start at <time datetime="${video.scheduledStart.toISOString()}">${moment(
          video.scheduledStart
        )
          .tz("Asia/Tokyo")
          .format("YYYY-MM-DD HH:mm")}</time>`;
      } else {
        statusText = "Upcoming";
      }
      break;
    case VideoStatus.Live:
      statusText = `<span style="color: red; font-weight: 500;">Live Now</span>`;
      break;
    case VideoStatus.Past:
    case VideoStatus.Missing:
      statusText = `Published at <time datetime="${video.availableAt.toISOString()}">${moment(
        video.availableAt
      )
        .tz("Asia/Tokyo")
        .format("YYYY-MM-DD HH:mm")}</time>`;
      break;
  }
  ws.write(`      <div class="col">
        <div class="card">
          <a href="${basePath}${getVideoPath(video)}"><img src="${
    VideoModel.getVideoThumbnails(video).medium
  }" class="card-img-top" alt="Video Thumbnail" loading="lazy" /></a>
          <div class="row g-0 align-items-center">
            <div class="col-md-auto">
              <img src="${
                channel.avatarUrl
              }" alt="Channel Thumbnail" style="height: 48px; width: 48px; border-radius: 50%; margin: 8px;" loading="lazy" />
            </div>
            <div class="col">
              <div class="card-body" style="padding-left: 0;">
                <h5 class="card-title" style="font-size: 1rem; line-height: 1.25rem; max-height: 2.5rem; white-space: normal; overflow: hidden; text-overflow: ellipsis; word-break: break-all; word-break: break-word; hyphens: auto; -webkit-line-clamp: 2; -webkit-box-orient: vertical;"><a href="${basePath}${getVideoPath(
                  video
                )}">${video.title}</a></h5>
                <p class="card-text" style="font-size: .875rem; margin-bottom: 0;"><a href="${basePath}${video.channelId}/index.html">${
                  channel.name
                }</a></p>
                <p class="card-text"><small class="text-body-secondary">${statusText}</small></p>
              </div>
            </div>
          </div>
          <div class="card-footer text-body-secondary text-center" style="font-size: 0.875rem;">
            SC: ${formatCurrency(
              totalSuperChatAmountJpy,
              "JPY"
            )}, Members: ${totalMembers.toLocaleString()}, Gifts: ${totalGifts.toLocaleString()}
          </div>
        </div>
      </div>
`);
}

// main
if (require.main === module) {
  (async () => {
    assert(MONGO_URI, "MONGO_URI should be defined.");
    await mongoose.connect(MONGO_URI);
    // await archiveAllChats();
    await genIndexFile();
    await mongoose.disconnect();
    process.exit(0);
  })();
}
