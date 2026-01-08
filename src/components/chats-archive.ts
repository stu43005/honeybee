import { type DocumentType } from "@typegoose/typegoose";
import type { Job } from "agenda";
import moment from "moment";
import type { Cursor } from "mongoose";
import assert from "node:assert";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CHAT_ARCHIVE_DIR, MAX_HOURS_BEFORE_CLEANUP } from "../constants";
import { currencyMap } from "../data/currency";
import { MessageType, VideoStatsType } from "../interfaces";
import MembershipModel, { type Membership } from "../models/Membership";
import MembershipGiftModel, {
  type MembershipGift,
} from "../models/MembershipGift";
import MembershipGiftPurchaseModel, {
  type MembershipGiftPurchase,
} from "../models/MembershipGiftPurchase";
import MilestoneModel, { type Milestone } from "../models/Milestone";
import SuperChatModel, { type SuperChat } from "../models/SuperChat";
import SuperStickerModel, { type SuperSticker } from "../models/SuperSticker";
import VideoModel, { type Video } from "../models/Video";
import VideoStatsModel, { VideoStatsFlags } from "../models/VideoStats";
import type { Application } from "../modules/application";
import type { AgendaModule } from "../modules/schedule";

export default function chatsArchive(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  if (CHAT_ARCHIVE_DIR) {
    agenda.define("chats archive", archiveAllChats);
    agenda.every("1 minutes", "chats archive");
  }
}

async function archiveAllChats(job: Job) {
  const stats = await VideoStatsModel.getVideoIdsWithoutFlag(
    {
      type: VideoStatsType.MessageTotal,
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
    await job.touch();
  }
}

function getOutputFilePath(video: DocumentType<Video>) {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  const date = moment(video.availableAt).tz("Asia/Tokyo").format("YYYYMMDD");
  return path.join(
    CHAT_ARCHIVE_DIR,
    video.channelId,
    `${date}_${video.id}.html`
  );
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
  const ws = fs.createWriteStream(`${outputFilePath}.tmp`, { encoding: "utf-8" });
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
    #chats-table.superstickers.significance-7 tr.superstickers.significance-7 {
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
    VideoModel.getVideoThumbnails(video, false).maxres
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
  <label><input type="checkbox" id="toggle-significance-7" checked /><div style="display: inline-block; width: 16px; height: 16px; background-color: red;"></div><span class="count"></span></label>
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
  let no = 0;
  for await (const doc of multiCursorOrderedPeek<
    DocumentType<
      | SuperChat
      | SuperSticker
      | Membership
      | MembershipGift
      | MembershipGiftPurchase
      | Milestone
    >
  >(
    superChatCursor,
    superStickerCursor,
    membershipCursor,
    membershipGiftCursor,
    membershipGiftPurchaseCursor,
    milestoneCursor
  )) {
    no++;
    const displayTime = moment(doc.timestamp)
      .tz("Asia/Tokyo")
      .format("YYYY-MM-DD HH:mm:ss");
    const authorPhoto =
      "authorPhoto" in doc && doc.authorPhoto
        ? `<img src="${doc.authorPhoto}" style="height: 48px; border-radius: 50%;" loading="lazy" alt="author photo" /> `
        : "";
    const timeSecond = VideoModel.getTimeSeconds(video, doc.timestamp);

    ws.write(`<tr id="${doc._id}" class="row ${doc.collection.name} ${
      "significance" in doc && doc.significance
        ? `significance-${doc.significance}`
        : ""
    }">
  <td style="text-align: right;">${no}</td>
  <td>${
    timeSecond ? `<a href="${VideoModel.getUrl(video, timeSecond)}">` : ""
  }<time datetime="${doc.timestamp.toISOString()}">${displayTime}</time>${
      timeSecond ? "</a>" : ""
    }</td>
`);
    switch (doc.collection.name) {
      case "superchats": {
        const superChat = doc as DocumentType<SuperChat>;
        ws.write(`  <td style="text-align: right;">${
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
        ws.write(`  <td style="text-align: right;">${
          superSticker.currency !== "JPY"
            ? `${formatCurrency(
                superSticker.amount,
                superSticker.currency
              )}<br/>`
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
        ws.write(`  <td></td>
  <td style="background-color: #00984f;">　</td>
  <td>${authorPhoto}</td>
  <td>${membership.authorName ?? ""}</td>
  <td>Joined as a member (${membership.membership ?? "N/A"})</td>
`);
        break;
      }
      case "membershipgifts": {
        const membershipGift = doc as DocumentType<MembershipGift>;
        ws.write(`  <td></td>
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
        ws.write(`  <td></td>
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
        ws.write(`  <td></td>
  <td style="background-color: #00984f;">　</td>
  <td>${authorPhoto}</td>
  <td>${milestone.authorName ?? ""}</td>
  <td>${
    milestone.message ?? `<span class="wordless">(wordless milestone)</span>`
  }</td>
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
      countSpan.textContent = ' (count: ' + rowCount + ', amount: ' + giftCount + ')';
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

/**
 * Merge multiple cursors ordered by timestamp field.
 */
async function* multiCursorOrderedPeek<T>(...cursors: Array<Cursor<T, any>>) {
  const items: Array<{ cursor: Cursor<T, any>; current: T | null }> =
    cursors.map((cursor) => ({ cursor, current: null }));

  // Initial fetch
  for (const item of items) {
    item.current = await item.cursor.next();
  }

  while (true) {
    // Find the item with the smallest timestamp
    let minItem: (typeof items)[0] | null = null;
    for (const item of items) {
      if (item.current) {
        if (
          !minItem ||
          (item.current as any).timestamp < (minItem.current as any).timestamp
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
  }
}
