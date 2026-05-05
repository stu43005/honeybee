import type { DocumentType } from "@typegoose/typegoose";
import { raw } from "hono/html";
import { currencyMap } from "../../../data/currency.js";
import type { Chat } from "../../../models/Chat.js";
import type { Membership } from "../../../models/Membership.js";
import type { MembershipGift } from "../../../models/MembershipGift.js";
import type { MembershipGiftPurchase } from "../../../models/MembershipGiftPurchase.js";
import type { Milestone } from "../../../models/Milestone.js";
import type { Poll } from "../../../models/Poll.js";
import type { Raid } from "../../../models/Raid.js";
import type { SuperChat } from "../../../models/SuperChat.js";
import type { SuperSticker } from "../../../models/SuperSticker.js";
import type { Video } from "../../../models/Video.js";
import VideoModel from "../../../models/Video.js";
import { FormattedTimestamp, formatCurrency, getTimestamp } from "./format.js";

const ROWS_MARKER = "<!--HONEYBEE_ROWS-->";

const PAGE_CSS = `
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
`;

const TOGGLE_SCRIPT = `
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
`;

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

function computeRowClasses(doc: ChatRowDoc): string[] {
  const classes = ["row", doc.collection.name];
  if ("significance" in doc && doc.significance) {
    classes.push(`significance-${doc.significance}`);
  }
  if ("isOwner" in doc && doc.isOwner) classes.push("owner");
  if ("isModerator" in doc && doc.isModerator) classes.push("moderator");
  return classes;
}

function AuthorPhoto({ src }: { src: string | undefined | null }) {
  if (!src) return null;
  return (
    <>
      <img
        src={src}
        style="height: 48px; border-radius: 50%;"
        loading="lazy"
        alt="author photo"
      />{" "}
    </>
  );
}

function OwnerOrModeratorChatCells({
  doc,
  video,
}: {
  doc: DocumentType<Chat>;
  video: DocumentType<Video>;
}) {
  return (
    <>
      <td>
        <FormattedTimestamp video={video} timestamp={getTimestamp(doc)} />
      </td>
      <td></td>
      <td></td>
      <td>
        <AuthorPhoto src={doc.authorPhoto} />
      </td>
      <td>{doc.authorName ?? ""}</td>
      <td>{doc.message}</td>
    </>
  );
}

function SuperChatCells({
  doc,
  video,
}: {
  doc: DocumentType<SuperChat>;
  video: DocumentType<Video>;
}) {
  return (
    <>
      <td>
        <FormattedTimestamp video={video} timestamp={getTimestamp(doc)} />
      </td>
      <td style="text-align: right;">
        {doc.currency !== "JPY" ? (
          <>
            {formatCurrency(doc.amount, doc.currency)}
            <br />
          </>
        ) : null}
        {formatCurrency(doc.jpyAmount, "JPY")}
      </td>
      <td style={`background-color: ${doc.color};`}>{"　"}</td>
      <td>
        <AuthorPhoto src={doc.authorPhoto} />
      </td>
      <td>{doc.authorName ?? ""}</td>
      <td>
        {doc.message ?? <span class="wordless">(wordless superchat)</span>}
      </td>
    </>
  );
}

function SuperStickerCells({
  doc,
  video,
}: {
  doc: DocumentType<SuperSticker>;
  video: DocumentType<Video>;
}) {
  return (
    <>
      <td>
        <FormattedTimestamp video={video} timestamp={getTimestamp(doc)} />
      </td>
      <td style="text-align: right;">
        {doc.currency !== "JPY" ? (
          <>
            {formatCurrency(doc.amount, doc.currency)}
            <br />
          </>
        ) : null}
        {formatCurrency(doc.jpyAmount, "JPY")}
      </td>
      <td style={`background-color: ${doc.color};`}>{"　"}</td>
      <td>
        <AuthorPhoto src={doc.authorPhoto} />
      </td>
      <td>{doc.authorName ?? ""}</td>
      <td>
        <img src={doc.image} title={doc.text ?? ""} alt="sticker" />
      </td>
    </>
  );
}

function MembershipCells({
  doc,
  video,
}: {
  doc: DocumentType<Membership>;
  video: DocumentType<Video>;
}) {
  return (
    <>
      <td>
        <FormattedTimestamp video={video} timestamp={getTimestamp(doc)} />
      </td>
      <td></td>
      <td style="background-color: #00984f;">{"　"}</td>
      <td>
        <AuthorPhoto src={doc.authorPhoto} />
      </td>
      <td>{doc.authorName ?? ""}</td>
      <td>Joined as a member ({doc.membership ?? "N/A"})</td>
    </>
  );
}

function MembershipGiftCells({
  doc,
  video,
}: {
  doc: DocumentType<MembershipGift>;
  video: DocumentType<Video>;
}) {
  return (
    <>
      <td>
        <FormattedTimestamp video={video} timestamp={getTimestamp(doc)} />
      </td>
      <td></td>
      <td style="background-color: #00984f;">{"　"}</td>
      <td>
        <AuthorPhoto src={doc.authorPhoto} />
      </td>
      <td>{doc.authorName ?? ""}</td>
      <td>Received a membership gift from {doc.senderName ?? "N/A"}</td>
    </>
  );
}

function MembershipGiftPurchaseCells({
  doc,
  video,
}: {
  doc: DocumentType<MembershipGiftPurchase>;
  video: DocumentType<Video>;
}) {
  return (
    <>
      <td>
        <FormattedTimestamp video={video} timestamp={getTimestamp(doc)} />
      </td>
      <td></td>
      <td style="background-color: #00984f;">{"　"}</td>
      <td>
        <AuthorPhoto src={doc.authorPhoto} />
      </td>
      <td>{doc.authorName ?? ""}</td>
      <td>
        {"Purchased "}
        <span class="gift-count">{doc.amount}</span>
        {" membership gift(s)"}
      </td>
    </>
  );
}

function MilestoneCells({
  doc,
  video,
}: {
  doc: DocumentType<Milestone>;
  video: DocumentType<Video>;
}) {
  return (
    <>
      <td>
        <FormattedTimestamp video={video} timestamp={getTimestamp(doc)} />
      </td>
      <td></td>
      <td style="background-color: #00984f;">{"　"}</td>
      <td>
        <AuthorPhoto src={doc.authorPhoto} />
      </td>
      <td>{doc.authorName ?? ""}</td>
      <td>
        {doc.message ?? <span class="wordless">(wordless milestone)</span>}
      </td>
    </>
  );
}

function PollCells({
  doc,
  video,
}: {
  doc: DocumentType<Poll>;
  video: DocumentType<Video>;
}) {
  const timestamp = getTimestamp(doc);
  const choiceLines: Array<string> = doc.choices.map(
    (choice) =>
      "- " +
      choice.text +
      (choice.voteRatio
        ? ` (${Math.floor(choice.voteRatio * 1000) / 10}%)`
        : "")
  );
  return (
    <>
      <td>
        {doc.createdAt ? (
          <>
            <FormattedTimestamp video={video} timestamp={doc.createdAt} />
            {" ~"}
            <br />
            <FormattedTimestamp video={video} timestamp={timestamp} />
          </>
        ) : (
          <FormattedTimestamp video={video} timestamp={timestamp} />
        )}
      </td>
      <td></td>
      <td></td>
      <td></td>
      <td>Poll</td>
      <td>
        {doc.voteCount ? (
          <>
            {doc.voteCount} votes
            <br />
          </>
        ) : null}
        {doc.question ?? "(empty question)"}
        <br />
        {choiceLines.map((line, i) => (
          <>
            {i > 0 ? <br /> : null}
            {line}
          </>
        ))}
      </td>
    </>
  );
}

function RaidCells({
  doc,
  video,
}: {
  doc: DocumentType<Raid>;
  video: DocumentType<Video>;
}) {
  return (
    <>
      <td>
        <FormattedTimestamp video={video} timestamp={getTimestamp(doc)} />
      </td>
      <td></td>
      <td></td>
      <td>
        <AuthorPhoto src={doc.sourcePhoto} />
      </td>
      <td>{doc.sourceName ?? ""}</td>
      <td>{doc.sourceName ?? ""} and their viewers just joined. Say hello!</td>
    </>
  );
}

function ChatRow({
  doc,
  no,
  video,
}: {
  doc: ChatRowDoc;
  no: number;
  video: DocumentType<Video>;
}) {
  const classes = computeRowClasses(doc);
  let cells;
  switch (doc.collection.name) {
    case "chats":
      cells = (
        <OwnerOrModeratorChatCells
          doc={doc as DocumentType<Chat>}
          video={video}
        />
      );
      break;
    case "superchats":
      cells = (
        <SuperChatCells doc={doc as DocumentType<SuperChat>} video={video} />
      );
      break;
    case "superstickers":
      cells = (
        <SuperStickerCells
          doc={doc as DocumentType<SuperSticker>}
          video={video}
        />
      );
      break;
    case "memberships":
      cells = (
        <MembershipCells doc={doc as DocumentType<Membership>} video={video} />
      );
      break;
    case "membershipgifts":
      cells = (
        <MembershipGiftCells
          doc={doc as DocumentType<MembershipGift>}
          video={video}
        />
      );
      break;
    case "membershipgiftpurchases":
      cells = (
        <MembershipGiftPurchaseCells
          doc={doc as DocumentType<MembershipGiftPurchase>}
          video={video}
        />
      );
      break;
    case "milestones":
      cells = (
        <MilestoneCells doc={doc as DocumentType<Milestone>} video={video} />
      );
      break;
    case "polls":
      cells = <PollCells doc={doc as DocumentType<Poll>} video={video} />;
      break;
    case "raids":
      cells = <RaidCells doc={doc as DocumentType<Raid>} video={video} />;
      break;
    default:
      cells = null;
  }
  return (
    <tr id={String(doc._id)} class={classes.join(" ")}>
      <td style="text-align: right;">{no}</td>
      {cells}
    </tr>
  );
}

export async function renderChatRow(props: {
  doc: ChatRowDoc;
  no: number;
  video: DocumentType<Video>;
}): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/await-thenable
  return await (<ChatRow {...props} />).toString();
}

export interface CurrencyAgg {
  currency: string;
  amount: number;
  jpyAmount: number;
}

function CurrencyTable({
  currencies,
  jpySum,
}: {
  currencies: CurrencyAgg[];
  jpySum: number;
}) {
  return (
    <table class="superchat-table">
      <tr>
        <th>symbol</th>
        <th>code</th>
        <th>sum</th>
        <th>sum (JPY)</th>
      </tr>
      {currencies.map((c) => (
        <tr>
          <td>{currencyMap[c.currency]?.symbol ?? "N/A"}</td>
          <td>{c.currency ?? "N/A"}</td>
          <td>{formatCurrency(c.amount, c.currency, "decimal")}</td>
          <td>{formatCurrency(Math.round(c.jpyAmount), "JPY", "decimal")}</td>
        </tr>
      ))}
      <tr>
        <td></td>
        <td></td>
        <td></td>
        <td>{formatCurrency(jpySum, "JPY", "decimal")}</td>
      </tr>
    </table>
  );
}

function ToggleControls() {
  const colors = [
    "blue",
    "lightblue",
    "green",
    "yellow",
    "orange",
    "magenta",
    "red",
  ];
  return (
    <div id="toggle-controls">
      <label>
        <input type="checkbox" id="toggle-owner" />
        owner<span class="count"></span>
      </label>
      <label>
        <input type="checkbox" id="toggle-moderator" />
        moderator<span class="count"></span>
      </label>
      <br />
      <label>
        <input type="checkbox" id="toggle-memberships" />
        membership<span class="count"></span>
      </label>
      <label>
        <input type="checkbox" id="toggle-milestones" />
        milestone<span class="count"></span>
      </label>
      <br />
      <label>
        <input type="checkbox" id="toggle-membershipgifts" />
        membershipGift<span class="count"></span>
      </label>
      <label>
        <input type="checkbox" id="toggle-membershipgiftpurchases" />
        membershipGiftPurchase<span class="count"></span>
      </label>
      <br />
      <label>
        <input type="checkbox" id="toggle-superchats" checked />
        superchat<span class="count"></span>
      </label>
      <label>
        <input type="checkbox" id="toggle-superstickers" checked />
        supersticker<span class="count"></span>
      </label>
      <br />
      <label>
        <input type="checkbox" id="toggle-all-significance" checked />
        toggle all:
      </label>
      {colors.map((color, i) => (
        <label>
          <input type="checkbox" id={`toggle-significance-${i + 1}`} checked />
          <div
            style={`display: inline-block; width: 16px; height: 16px; background-color: ${color};`}
          ></div>
          <span class="count"></span>
        </label>
      ))}
      <br />
      <label>
        <input type="checkbox" id="toggle-polls" />
        poll<span class="count"></span>
      </label>
      <label>
        <input type="checkbox" id="toggle-raids" />
        raid<span class="count"></span>
      </label>
    </div>
  );
}

function VideoArchivePage(props: {
  video: DocumentType<Video>;
  currencies: CurrencyAgg[];
  jpySum: number;
}) {
  const { video, currencies, jpySum } = props;
  return (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{video.title}</title>
        <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      </head>
      <body>
        <table>
          <tr>
            <td>
              <h1>
                <a href={VideoModel.getUrl(video)}>{video.title}</a>
              </h1>
              <img
                class="video-thumbnail small"
                src={VideoModel.getVideoThumbnails(video).maxres}
                onclick="this.classList.toggle('small')"
              />
            </td>
          </tr>
          <tr>
            <td>
              <CurrencyTable currencies={currencies} jpySum={jpySum} />
            </td>
          </tr>
        </table>
        <hr />
        <ToggleControls />
        <hr />
        <table id="chats-table" border={1}>
          <tr>
            <th>No.</th>
            <th>Timestamp</th>
            <th>Currency</th>
            <th></th>
            <th>Icon</th>
            <th>Author</th>
            <th>Message</th>
          </tr>
          {raw(ROWS_MARKER)}
        </table>
        <script
          type="text/javascript"
          dangerouslySetInnerHTML={{ __html: TOGGLE_SCRIPT }}
        />
      </body>
    </html>
  );
}

export async function renderVideoArchiveShell(props: {
  video: DocumentType<Video>;
  currencies: CurrencyAgg[];
  jpySum: number;
}): Promise<[head: string, tail: string]> {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/await-thenable
  const full = await (<VideoArchivePage {...props} />).toString();
  const idx = full.indexOf(ROWS_MARKER);
  if (idx < 0) {
    throw new Error(
      "VideoArchive shell render did not contain ROWS_MARKER sentinel"
    );
  }
  return [
    "<!DOCTYPE html>" + full.slice(0, idx),
    full.slice(idx + ROWS_MARKER.length),
  ];
}
