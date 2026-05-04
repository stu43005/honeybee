# chats-archive TSX Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor [src/components/chats-archive.ts](src/components/chats-archive.ts) (~927 lines) into a 4-file control layer + 5-file `hono/jsx` template layer, preserving streaming write behavior and producing DOM-equivalent HTML output.

**Architecture:** Control layer (`.ts`, no JSX) opens Mongo cursors, computes derived values, and writes to file streams. Presentation layer (`templates/*.tsx`) renders HTML strings via `hono/jsx`. The full per-video page is authored as one JSX tree with a `<!--HONEYBEE_ROWS-->` sentinel; the shell render helper splits the result into `[head, tail]` so the control layer can stream rows in between. Auto-escaping via hono/jsx replaces the previous unsafe template-string interpolation. No unit tests — verification is `npm run build` + `npm run lint` + manual visual diff against pre-refactor output.

**Tech Stack:** TypeScript (target es2024, NodeNext modules), `hono/jsx` 4.12.16, mongoose / typegoose, agenda, moment-timezone.

**Spec:** [docs/superpowers/specs/2026-05-04-chats-archive-tsx-design.md](docs/superpowers/specs/2026-05-04-chats-archive-tsx-design.md)

---

## File Structure

**Modify:**

- `tsconfig.json` — add `jsx: "react-jsx"`, `jsxImportSource: "hono/jsx"`
- `package.json` — add `"hono": "^4.12.16"` dependency
- `src/components/chats-archive.ts` — rewrite as entry shim (~80 lines, was ~927)

**Create:**

- `src/components/chats-archive/archive-video.ts` — per-video control + `multiCursorOrderedPeek`
- `src/components/chats-archive/gen-index-file.ts` — top-level index control
- `src/components/chats-archive/gen-channel-index-file.ts` — per-channel index control
- `src/components/chats-archive/templates/format.tsx` — formatters + `FormattedTimestamp`
- `src/components/chats-archive/templates/VideoCard.tsx` — shared card
- `src/components/chats-archive/templates/VideoArchive.tsx` — per-video shell + 9 ChatRow variants
- `src/components/chats-archive/templates/IndexPage.tsx` — top-level index shell
- `src/components/chats-archive/templates/ChannelIndexPage.tsx` — per-channel index shell

---

## Pre-flight: Capture Baseline

Before any changes, capture HTML output from the current code against a developer's local Mongo, against representative videos. This is the visual-diff baseline used in Task 11.

- [ ] **Step 1: Build current code**

  ```bash
  npm run build
  ```

  Expected: PASS, dist/components/chats-archive.js exists.

- [ ] **Step 2: Run dev runner against local DB; save output**

  ```bash
  CHAT_ARCHIVE_DIR=/tmp/chats-archive-baseline node dist/components/chats-archive.js
  ```

  Pick `CHAT_ARCHIVE_DIR` to a fresh path. Then keep that directory aside (do NOT delete; this is the baseline).

  Expected: HTML files written under `/tmp/chats-archive-baseline/`. At minimum, ensure the run produces:
  - `index.html` (live + past tabs)
  - At least one channel `<channelId>/index.html`
  - At least one per-video `<channelId>/<date>_<videoId>.html` containing rows from each variant: `chats` (owner/moderator), `superchats`, `superstickers`, `memberships`, `membershipgifts`, `membershipgiftpurchases`, `milestones`, `polls`, `raids`. If your local DB lacks one of these, note which and skip its visual check in Task 11.

- [ ] **Step 3: Note baseline path in shell**

  ```bash
  echo "BASELINE=/tmp/chats-archive-baseline" > /tmp/chats-archive-baseline.path
  ```

  This will be referenced by Task 11.

---

## Task 1: tsconfig + package.json + install hono

**Files:**

- Modify: `tsconfig.json`
- Modify: `package.json`

- [ ] **Step 1: Add JSX options to tsconfig.json**

  In `tsconfig.json` `compilerOptions`, add two lines:

  ```jsonc
  "jsx": "react-jsx",
  "jsxImportSource": "hono/jsx",
  ```

  Place alongside existing entries. Do not modify any other key.

- [ ] **Step 2: Verify hono dependency is present and installed**

  At plan-writing time, `package.json` already declares `"hono": "^4.12.16"` (line 63). Run:

  ```bash
  npm install
  ```

  Expected: `node_modules/hono` exists at version satisfying `^4.12.16`. Confirm:

  ```bash
  node -e "console.log(require('hono/package.json').version)"
  ```

  Expected output: `4.12.16` (or a later 4.x).

  Fallback (only if `package.json` no longer contains the entry by the time this task runs): manually add `"hono": "^4.12.16",` to `dependencies` in alphabetical order, then run `npm install`. Do not use `npm install hono@^4.12.16` because npm rewrites the caret range to the highest matching version.

- [ ] **Step 3: Verify build still passes (no source changes yet)**

  ```bash
  npm run build
  ```

  Expected: PASS. The JSX options are inert until the first `.tsx` file exists.

- [ ] **Step 4: Commit**

  Stage the changed files. `package.json` is unchanged if hono was already present (a no-op `git add`). `package-lock.json` may have updated.

  ```bash
  git add tsconfig.json package.json package-lock.json
  git commit -m "chore(tsconfig): add JSX options for chats-archive refactor"
  ```

---

## Task 2: templates/format.tsx

**Files:**

- Create: `src/components/chats-archive/templates/format.tsx`

This module hosts pure formatters (`formatCurrency`, `getTimestamp`, `getVideoPath`) plus the JSX element `<FormattedTimestamp>` that replaces the old string-returning `formatTimestamp`.

- [ ] **Step 1: Create directory**

  ```bash
  mkdir -p src/components/chats-archive/templates
  ```

- [ ] **Step 2: Write the file**

  Create `src/components/chats-archive/templates/format.tsx` with:

  ```tsx
  import type { DocumentType } from "@typegoose/typegoose";
  import moment from "moment";
  import type { mongo } from "mongoose";
  import path from "node:path";
  import { currencyMap } from "../../../data/currency.js";
  import VideoModel, { type Video } from "../../../models/Video.js";

  export function formatCurrency(
    amount: number,
    currency: string,
    style: Intl.NumberFormatOptions["style"] = "currency"
  ): string {
    return amount.toLocaleString("ja-JP", {
      style,
      currency,
      currencyDisplay: "symbol",
      minimumFractionDigits: currencyMap[currency].decimal_digits,
      maximumFractionDigits: currencyMap[currency].decimal_digits,
    });
  }

  export function getVideoPath(video: DocumentType<Video>): string {
    const date = moment(video.availableAt).tz("Asia/Tokyo").format("YYYYMMDD");
    return path.join(video.channelId, `${date}_${video.id}.html`);
  }

  export function getTimestamp(current: DocumentType<object>): Date;
  export function getTimestamp(
    current: DocumentType<object> | null
  ): Date | null;
  export function getTimestamp(
    current: DocumentType<object> | null
  ): Date | null {
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

  export function FormattedTimestamp(props: {
    video: DocumentType<Video>;
    timestamp: Date;
  }) {
    const { video, timestamp } = props;
    const timeSecond = VideoModel.getTimeSeconds(video, timestamp);
    const display = moment(timestamp)
      .tz("Asia/Tokyo")
      .format("YYYY-MM-DD HH:mm:ss");
    const time = <time datetime={timestamp.toISOString()}>{display}</time>;
    return timeSecond ? (
      <a href={VideoModel.getUrl(video, timeSecond)}>{time}</a>
    ) : (
      time
    );
  }
  ```

- [ ] **Step 3: Verify type check**

  ```bash
  npx tsc --noEmit
  ```

  Expected: PASS (file compiles; no errors).

- [ ] **Step 4: Run lint**

  ```bash
  npm run lint -- src/components/chats-archive/templates/format.tsx
  ```

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/chats-archive/templates/format.tsx
  git commit -m "feat(chats-archive): add format.tsx with FormattedTimestamp JSX helper"
  ```

---

## Task 3: templates/VideoCard.tsx

**Files:**

- Create: `src/components/chats-archive/templates/VideoCard.tsx`

Replaces the existing `videoCard()` writer helper. Receives plain props (control layer pre-computes `recalcVideoHbStats` + re-fetch in `isDirect` mode).

- [ ] **Step 1: Write the file**

  ```tsx
  import type { DocumentType } from "@typegoose/typegoose";
  import { VideoStatus } from "holodex.js";
  import moment from "moment";
  import type { Channel } from "../../../models/Channel.js";
  import type { Video } from "../../../models/Video.js";
  import VideoModel from "../../../models/Video.js";
  import { formatCurrency, getVideoPath } from "./format.js";

  export interface VideoCardProps {
    video: DocumentType<Video>;
    channel: DocumentType<Channel>;
    basePath: string;
    hbStats:
      | {
          totalSuperChatAmountJpy?: number;
          totalMembers?: number;
          totalGifts?: number;
        }
      | undefined;
  }

  function StatusText({ video }: { video: DocumentType<Video> }) {
    switch (video.status) {
      case VideoStatus.Upcoming:
        if (video.scheduledStart) {
          return (
            <>
              Start at{" "}
              <time datetime={video.scheduledStart.toISOString()}>
                {moment(video.scheduledStart)
                  .tz("Asia/Tokyo")
                  .format("YYYY-MM-DD HH:mm")}
              </time>
            </>
          );
        }
        return <>Upcoming</>;
      case VideoStatus.Live:
        return <span style="color: red; font-weight: 500;">Live Now</span>;
      case VideoStatus.Past:
      case VideoStatus.Missing:
        return (
          <>
            Published at{" "}
            <time datetime={video.availableAt.toISOString()}>
              {moment(video.availableAt)
                .tz("Asia/Tokyo")
                .format("YYYY-MM-DD HH:mm")}
            </time>
          </>
        );
      default:
        return <></>;
    }
  }

  function VideoCard(props: VideoCardProps) {
    const { video, channel, basePath, hbStats } = props;
    const totalSuperChatAmountJpy = hbStats?.totalSuperChatAmountJpy ?? 0;
    const totalMembers = hbStats?.totalMembers ?? 0;
    const totalGifts = hbStats?.totalGifts ?? 0;
    const videoHref = `${basePath}${getVideoPath(video)}`;
    const channelHref = `${basePath}${video.channelId}/index.html`;
    return (
      <div class="col">
        <div class="card">
          <a href={videoHref}>
            <img
              src={VideoModel.getVideoThumbnails(video).medium}
              class="card-img-top"
              alt="Video Thumbnail"
              loading="lazy"
            />
          </a>
          <div class="row g-0 align-items-center">
            <div class="col-md-auto">
              <img
                src={channel.avatarUrl}
                alt="Channel Thumbnail"
                style="height: 48px; width: 48px; border-radius: 50%; margin: 8px;"
                loading="lazy"
              />
            </div>
            <div class="col">
              <div class="card-body" style="padding-left: 0;">
                <h5
                  class="card-title"
                  style="font-size: 1rem; line-height: 1.25rem; max-height: 2.5rem; white-space: normal; overflow: hidden; text-overflow: ellipsis; word-break: break-all; word-break: break-word; hyphens: auto; -webkit-line-clamp: 2; -webkit-box-orient: vertical;"
                >
                  <a href={videoHref}>{video.title}</a>
                </h5>
                <p
                  class="card-text"
                  style="font-size: .875rem; margin-bottom: 0;"
                >
                  <a href={channelHref}>{channel.name}</a>
                </p>
                <p class="card-text">
                  <small class="text-body-secondary">
                    <StatusText video={video} />
                  </small>
                </p>
              </div>
            </div>
          </div>
          <div
            class="card-footer text-body-secondary text-center"
            style="font-size: 0.875rem;"
          >
            SC: {formatCurrency(totalSuperChatAmountJpy, "JPY")}, Members:{" "}
            {totalMembers.toLocaleString()}, Gifts:{" "}
            {totalGifts.toLocaleString()}
          </div>
        </div>
      </div>
    );
  }

  export async function renderVideoCard(
    props: VideoCardProps
  ): Promise<string> {
    return await (<VideoCard {...props} />).toString();
  }
  ```

- [ ] **Step 2: Type check + lint**

  ```bash
  npx tsc --noEmit && npm run lint -- src/components/chats-archive/templates/VideoCard.tsx
  ```

  Expected: PASS both.

- [ ] **Step 3: Commit**

  ```bash
  git add src/components/chats-archive/templates/VideoCard.tsx
  git commit -m "feat(chats-archive): add VideoCard.tsx template"
  ```

---

## Task 4: templates/VideoArchive.tsx

**Files:**

- Create: `src/components/chats-archive/templates/VideoArchive.tsx`

The largest template: page shell + 9 row-cell components + class computation + CSS/JS string constants. Public exports: `renderVideoArchiveShell` (returns `[head, tail]`), `renderChatRow` (returns one `<tr>` string).

- [ ] **Step 1: Write CSS and toggle script constants**

  Open the file and start with imports + constants. The CSS string is a verbatim copy of the existing `<style>` body in [src/components/chats-archive.ts:147-193](src/components/chats-archive.ts#L147-L193); the toggle script is a verbatim copy of [src/components/chats-archive.ts:521-553](src/components/chats-archive.ts#L521-L553).

  ```tsx
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
  import {
    FormattedTimestamp,
    formatCurrency,
    getTimestamp,
  } from "./format.js";

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
  ```

- [ ] **Step 2: Add the union type and class helper**

  Append to the same file:

  ```tsx
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
  ```

- [ ] **Step 3: Add the 9 row-cell components**

  Append:

  ```tsx
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
          Purchased <span class="gift-count">{doc.amount}</span> membership
          gift(s)
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
        <td>
          {doc.sourceName ?? ""} and their viewers just joined. Say hello!
        </td>
      </>
    );
  }
  ```

  Note: the poll question line is followed by an unconditional `<br/>` then the choice list begins (matching current source line 488 `</br>` separator after `(empty question)`). Choice lines are joined with `<br/>` BETWEEN — no trailing `<br/>` (the `i > 0` guard achieves this).

- [ ] **Step 4: Add `<ChatRow>` dispatcher and `renderChatRow`**

  Append:

  ```tsx
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
          <MembershipCells
            doc={doc as DocumentType<Membership>}
            video={video}
          />
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
    return await (<ChatRow {...props} />).toString();
  }
  ```

- [ ] **Step 5: Add the page shell + `renderVideoArchiveShell`**

  Append:

  ```tsx
  interface CurrencyAgg {
    _id: string;
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
            <td>{currencyMap[c._id]?.symbol ?? "N/A"}</td>
            <td>{c._id ?? "N/A"}</td>
            <td>{formatCurrency(c.amount, c._id, "decimal")}</td>
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
            <input
              type="checkbox"
              id={`toggle-significance-${i + 1}`}
              checked
            />
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

  function PageHead({ video }: { video: DocumentType<Video> }) {
    return (
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{video.title}</title>
        <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      </head>
    );
  }

  function HeaderBlock({
    video,
    currencies,
    jpySum,
  }: {
    video: DocumentType<Video>;
    currencies: CurrencyAgg[];
    jpySum: number;
  }) {
    return (
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
    );
  }

  function ChatTableHead() {
    return (
      <tr>
        <th>No.</th>
        <th>Timestamp</th>
        <th>Currency</th>
        <th></th>
        <th>Icon</th>
        <th>Author</th>
        <th>Message</th>
      </tr>
    );
  }

  function TogglesScript() {
    return (
      <script
        type="text/javascript"
        dangerouslySetInnerHTML={{ __html: TOGGLE_SCRIPT }}
      />
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
        <PageHead video={video} />
        <body>
          <HeaderBlock video={video} currencies={currencies} jpySum={jpySum} />
          <hr />
          <ToggleControls />
          <hr />
          <table id="chats-table" border="1">
            <ChatTableHead />
            {raw(ROWS_MARKER)}
          </table>
          <TogglesScript />
        </body>
      </html>
    );
  }

  export async function renderVideoArchiveShell(props: {
    video: DocumentType<Video>;
    currencies: CurrencyAgg[];
    jpySum: number;
  }): Promise<[head: string, tail: string]> {
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
  ```

- [ ] **Step 6: Type check + lint**

  ```bash
  npx tsc --noEmit && npm run lint -- src/components/chats-archive/templates/VideoArchive.tsx
  ```

  Expected: PASS both. If lint flags the inline `style` attribute (CSS-in-string) or the inline `onclick` handler on the thumbnail `<img>`, both are supported by hono/jsx and must remain to preserve thumbnail click-to-toggle and the in-line `<style>` / `<script>` bodies. Silence the offending rules with file-scoped `/* eslint-disable react/no-unknown-property */` (or the project-specific rule names) at the top of `VideoArchive.tsx`. Do not change the DOM output.

- [ ] **Step 7: Commit**

  ```bash
  git add src/components/chats-archive/templates/VideoArchive.tsx
  git commit -m "feat(chats-archive): add VideoArchive.tsx with 9 row variants and shell"
  ```

---

## Task 5: templates/IndexPage.tsx

**Files:**

- Create: `src/components/chats-archive/templates/IndexPage.tsx`

Top-level index page with two tabs (live + past). Two sentinels split the rendered shell into `[head, between, tail]`.

- [ ] **Step 1: Write the file**

  ```tsx
  import { raw } from "hono/html";

  const LIVE_MARKER = "<!--HONEYBEE_LIVE-->";
  const PAST_MARKER = "<!--HONEYBEE_PAST-->";

  const INDEX_PAGE_CSS = `
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
  `;

  function IndexPage() {
    return (
      <html lang="ja">
        <head>
          <meta charset="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />
          <title>Chat Archives Index</title>
          <link
            href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css"
            rel="stylesheet"
            integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB"
            crossorigin="anonymous"
          />
          <style dangerouslySetInnerHTML={{ __html: INDEX_PAGE_CSS }} />
        </head>
        <body>
          <ul class="nav nav-tabs" role="tablist">
            <li class="nav-item" role="presentation">
              <button
                class="nav-link active"
                id="live-tab"
                data-bs-toggle="tab"
                data-bs-target="#live-tab-pane"
                type="button"
                role="tab"
                aria-controls="live-tab-pane"
                aria-selected="true"
              >
                Live / Upcoming
              </button>
            </li>
            <li class="nav-item" role="presentation">
              <button
                class="nav-link"
                id="past-tab"
                data-bs-toggle="tab"
                data-bs-target="#past-tab-pane"
                type="button"
                role="tab"
                aria-controls="past-tab-pane"
                aria-selected="false"
              >
                Past
              </button>
            </li>
          </ul>
          <div class="tab-content">
            <div
              class="tab-pane fade show active"
              id="live-tab-pane"
              role="tabpanel"
              aria-labelledby="live-tab"
              tabindex="0"
            >
              <div class="container">
                <div class="row row-cols-1 row-cols-md-4 g-4">
                  {raw(LIVE_MARKER)}
                </div>
              </div>
            </div>
            <div
              class="tab-pane fade"
              id="past-tab-pane"
              role="tabpanel"
              aria-labelledby="past-tab"
              tabindex="0"
            >
              <div class="container">
                <div class="row row-cols-1 row-cols-md-4 g-4">
                  {raw(PAST_MARKER)}
                </div>
              </div>
            </div>
          </div>
          <script
            src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.min.js"
            integrity="sha384-G/EV+4j2dNv+tEPo3++6LCgdCROaejBqfUeNjuKAiuXbjrxilcCdDz6ZAVfHWe1Y"
            crossorigin="anonymous"
          ></script>
        </body>
      </html>
    );
  }

  export async function renderIndexShell(): Promise<
    [head: string, between: string, tail: string]
  > {
    const full = await (<IndexPage />).toString();
    const liveIdx = full.indexOf(LIVE_MARKER);
    const pastIdx = full.indexOf(PAST_MARKER);
    if (liveIdx < 0 || pastIdx < 0 || pastIdx <= liveIdx) {
      throw new Error(
        "IndexPage shell render did not contain both markers in order"
      );
    }
    return [
      "<!DOCTYPE html>" + full.slice(0, liveIdx),
      full.slice(liveIdx + LIVE_MARKER.length, pastIdx),
      full.slice(pastIdx + PAST_MARKER.length),
    ];
  }
  ```

- [ ] **Step 2: Type check + lint + commit**

  ```bash
  npx tsc --noEmit && npm run lint -- src/components/chats-archive/templates/IndexPage.tsx
  git add src/components/chats-archive/templates/IndexPage.tsx
  git commit -m "feat(chats-archive): add IndexPage.tsx top-level index template"
  ```

---

## Task 6: templates/ChannelIndexPage.tsx

**Files:**

- Create: `src/components/chats-archive/templates/ChannelIndexPage.tsx`

- [ ] **Step 1: Write the file**

  ```tsx
  import type { DocumentType } from "@typegoose/typegoose";
  import { raw } from "hono/html";
  import type { Channel } from "../../../models/Channel.js";

  const CARDS_MARKER = "<!--HONEYBEE_CHANNEL_CARDS-->";

  const CHANNEL_PAGE_CSS = `
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
  `;

  function ChannelIndexPage({ channel }: { channel: DocumentType<Channel> }) {
    return (
      <html lang="ja">
        <head>
          <meta charset="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />
          <title>{channel.name} - Video Archive</title>
          <link
            href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css"
            rel="stylesheet"
            integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB"
            crossorigin="anonymous"
          />
          <style dangerouslySetInnerHTML={{ __html: CHANNEL_PAGE_CSS }} />
        </head>
        <body>
          <div class="container">
            <div class="d-flex align-items-center my-3">
              <img
                src={channel.avatarUrl}
                alt="Channel Avatar"
                style="height: 48px; width: 48px; border-radius: 50%; margin-right: 12px;"
              />
              <h1 class="mb-0">{channel.name}</h1>
            </div>
            <hr />
            <div class="row row-cols-1 row-cols-md-4 g-4">
              {raw(CARDS_MARKER)}
            </div>
          </div>
        </body>
      </html>
    );
  }

  export async function renderChannelIndexShell(props: {
    channel: DocumentType<Channel>;
  }): Promise<[head: string, tail: string]> {
    const full = await (<ChannelIndexPage {...props} />).toString();
    const idx = full.indexOf(CARDS_MARKER);
    if (idx < 0) {
      throw new Error(
        "ChannelIndexPage shell render did not contain CARDS_MARKER"
      );
    }
    return [
      "<!DOCTYPE html>" + full.slice(0, idx),
      full.slice(idx + CARDS_MARKER.length),
    ];
  }
  ```

- [ ] **Step 2: Type check + lint + commit**

  ```bash
  npx tsc --noEmit && npm run lint -- src/components/chats-archive/templates/ChannelIndexPage.tsx
  git add src/components/chats-archive/templates/ChannelIndexPage.tsx
  git commit -m "feat(chats-archive): add ChannelIndexPage.tsx template"
  ```

---

## Task 7: chats-archive/archive-video.ts

**Files:**

- Create: `src/components/chats-archive/archive-video.ts`

Per-video control: opens 10 cursors (chat × 2 + 8 others), merges by timestamp, computes `currencies` and `jpySum`, streams via placeholder+split, per-row `await job?.touch()`.

- [ ] **Step 1: Write the file**

  ```ts
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

  export async function archiveVideo(
    videoId: string,
    job?: Job
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
  ```

- [ ] **Step 2: Type check + lint + commit**

  ```bash
  npx tsc --noEmit && npm run lint -- src/components/chats-archive/archive-video.ts
  git add src/components/chats-archive/archive-video.ts
  git commit -m "feat(chats-archive): add archive-video.ts per-video control layer"
  ```

---

## Task 8: chats-archive/gen-channel-index-file.ts

Done before `gen-index-file.ts` because the index file imports it.

**Files:**

- Create: `src/components/chats-archive/gen-channel-index-file.ts`

- [ ] **Step 1: Write the file**

  ```ts
  import assert from "node:assert";
  import fs from "node:fs";
  import fsp from "node:fs/promises";
  import path from "node:path";
  import { CHAT_ARCHIVE_DIR } from "../../constants.js";
  import ChannelModel from "../../models/Channel.js";
  import VideoModel from "../../models/Video.js";
  import { isMain } from "../../utils/esm.js";
  import { archiveVideo } from "./archive-video.js";
  import { recalcVideoHbStats } from "../video-stats.js";
  import { renderChannelIndexShell } from "./templates/ChannelIndexPage.js";
  import { renderVideoCard } from "./templates/VideoCard.js";

  export async function genChannelIndexFile(channelId: string): Promise<void> {
    assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
    const outputFilePath = path.join(CHAT_ARCHIVE_DIR, channelId, "index.html");
    await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });

    const channel = await ChannelModel.findByChannelId(channelId);
    if (!channel) return;

    const ws = fs.createWriteStream(`${outputFilePath}.tmp`, {
      encoding: "utf-8",
    });

    const [head, tail] = await renderChannelIndexShell({ channel });
    ws.write(head);

    const isDirect = isMain(import.meta);
    let count = 0;
    for await (let video of VideoModel.find({
      channelId,
      uploadedVideo: { $ne: true },
    })
      .sort({ availableAt: -1 })
      .limit(100)
      .populate("channel")
      .setOptions({ readPreference: "secondaryPreferred" })) {
      if (isDirect) {
        await recalcVideoHbStats([video.id]);
        const updated = await VideoModel.findByVideoId(video.id);
        if (updated) video = updated;
      }
      ws.write(
        await renderVideoCard({
          video,
          channel: await video.getChannel(),
          basePath: "../",
          hbStats: video.hbStats,
        })
      );
      if (isDirect) await archiveVideo(video.id);
      count++;
    }

    ws.end(tail);

    if (count === 0) {
      await fsp.unlink(`${outputFilePath}.tmp`);
      return;
    }
    await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
  }
  ```

- [ ] **Step 2: Type check + lint + commit**

  ```bash
  npx tsc --noEmit && npm run lint -- src/components/chats-archive/gen-channel-index-file.ts
  git add src/components/chats-archive/gen-channel-index-file.ts
  git commit -m "feat(chats-archive): add gen-channel-index-file.ts control layer"
  ```

---

## Task 9: chats-archive/gen-index-file.ts

**Files:**

- Create: `src/components/chats-archive/gen-index-file.ts`

- [ ] **Step 1: Write the file**

  ```ts
  import assert from "node:assert";
  import fs from "node:fs";
  import fsp from "node:fs/promises";
  import path from "node:path";
  import moment from "moment";
  import { VideoStatus } from "holodex.js";
  import { CHAT_ARCHIVE_DIR } from "../../constants.js";
  import VideoModel from "../../models/Video.js";
  import { isMain } from "../../utils/esm.js";
  import { archiveVideo } from "./archive-video.js";
  import { genChannelIndexFile } from "./gen-channel-index-file.js";
  import { recalcVideoHbStats } from "../video-stats.js";
  import { renderIndexShell } from "./templates/IndexPage.js";
  import { renderVideoCard } from "./templates/VideoCard.js";

  export async function genIndexFile(): Promise<void> {
    assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
    const outputFilePath = path.join(CHAT_ARCHIVE_DIR, "index.html");
    await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });
    const ws = fs.createWriteStream(`${outputFilePath}.tmp`, {
      encoding: "utf-8",
    });

    const [head, between, tail] = await renderIndexShell();
    ws.write(head);

    const channelIds = new Set<string>();
    const isDirect = isMain(import.meta);

    for await (let video of VideoModel.findLiveVideos(48)
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

      if (isDirect) {
        await recalcVideoHbStats([video.id]);
        const updated = await VideoModel.findByVideoId(video.id);
        if (updated) video = updated;
      }
      channelIds.add(video.channelId);
      ws.write(
        await renderVideoCard({
          video,
          channel: await video.getChannel(),
          basePath: "",
          hbStats: video.hbStats,
        })
      );
      if (isDirect) await archiveVideo(video.id);
    }

    ws.write(between);

    for await (let video of VideoModel.findRecentlyEndedVideos(48)
      .sort({ availableAt: -1 })
      .populate("channel")
      .setOptions({ readPreference: "secondaryPreferred" })) {
      if (
        video.status === VideoStatus.Missing &&
        video.scheduledStart &&
        moment.tz("UTC").isBefore(video.scheduledStart)
      )
        continue;
      if (isDirect) {
        await recalcVideoHbStats([video.id]);
        const updated = await VideoModel.findByVideoId(video.id);
        if (updated) video = updated;
      }
      channelIds.add(video.channelId);
      ws.write(
        await renderVideoCard({
          video,
          channel: await video.getChannel(),
          basePath: "",
          hbStats: video.hbStats,
        })
      );
      if (isDirect) await archiveVideo(video.id);
    }

    ws.end(tail);
    await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);

    for (const channelId of channelIds) {
      try {
        await genChannelIndexFile(channelId);
      } catch (error) {
        console.error(
          `Failed to generate channel index for ${channelId}:`,
          error
        );
      }
    }
  }
  ```

- [ ] **Step 2: Type check + lint + commit**

  ```bash
  npx tsc --noEmit && npm run lint -- src/components/chats-archive/gen-index-file.ts
  git add src/components/chats-archive/gen-index-file.ts
  git commit -m "feat(chats-archive): add gen-index-file.ts control layer"
  ```

---

## Task 10: chats-archive.ts entry rewrite

**Files:**

- Modify: `src/components/chats-archive.ts`

Reduce the entry file from ~927 lines to ~80 lines: agenda registration, `archiveAllChats` outer loop (passing `job` through to `archiveVideo` for the new per-row touch), dev runner. Delete all moved code.

- [ ] **Step 1: Replace entire file content**

  Open `src/components/chats-archive.ts` and replace its content with:

  ```ts
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

      agenda.define("chats archive index", genIndexFile);
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
        await archiveVideo(videoId, job);
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
      await genIndexFile();
      await mongoose.disconnect();
      process.exit(0);
    })();
  }
  ```

- [ ] **Step 2: Type check + lint + commit**

  ```bash
  npx tsc --noEmit && npm run lint -- src/components/chats-archive.ts
  git add src/components/chats-archive.ts
  git commit -m "refactor(chats-archive): rewrite entry as orchestration shim"
  ```

---

## Task 11: Final integration verification

**Files:** none modified.

- [ ] **Step 1: Full build**

  ```bash
  npm run build
  ```

  Expected: PASS, no tsc errors.

- [ ] **Step 2: Full lint**

  ```bash
  npm run lint
  ```

  Expected: PASS.

- [ ] **Step 3: Run dev runner against same local DB; produce new output**

  ```bash
  CHAT_ARCHIVE_DIR=/tmp/chats-archive-new node dist/components/chats-archive.js
  ```

  Expected: completes without errors, files written under `/tmp/chats-archive-new/`.

- [ ] **Step 4: Visual diff against baseline**

  Open both `/tmp/chats-archive-baseline/` (from Pre-flight) and `/tmp/chats-archive-new/` in a browser. For each of:
  - `index.html`
  - At least one `<channelId>/index.html`
  - At least one `<channelId>/<date>_<videoId>.html`

  verify:
  - Page renders without console errors.
  - Toggle controls (`owner`, `moderator`, `memberships`, `milestones`, `membershipgifts`, `membershipgiftpurchases`, `superchats`, `superstickers`, `polls`, `raids`) function as in baseline.
  - Significance toggles 1–7 function; the master `toggle-all-significance` drives all seven.
  - Toggle counts shown next to each label match baseline.
  - `membershipgiftpurchases` label shows `(count: N, total: M)` matching baseline.
  - Currency stats table at top of video page shows the same totals as baseline.
  - `(wordless superchat)` and `(wordless milestone)` fallback text appears for empty messages.
  - Poll display shows `voteCount votes`, question, choice list with optional `(NN.N%)` suffix; no trailing `<br/>` after last choice.
  - Raid row displays source author photo and the joined-the-stream message.
  - User-supplied text containing `&`, `<`, `>`, `"`, emoji renders correctly (and is now visibly escaped where it contains HTML special characters — that is a deliberate XSS fix).

  If any difference appears beyond expected whitespace/attribute-order changes, debug and fix before proceeding.

- [ ] **Step 5: Verify file size compared to original**

  ```bash
  wc -l src/components/chats-archive.ts src/components/chats-archive/**/*.ts src/components/chats-archive/**/*.tsx
  ```

  Expected: total roughly comparable to original 927 lines (give or take 30%); no individual file exceeds ~300 lines.

- [ ] **Step 6: Final commit (only if any verification fixes were needed)**

  Only if Steps 1–4 surfaced bugs requiring code changes. Otherwise no commit needed at this step.

- [ ] **Step 7: Cleanup baseline artifacts**

  ```bash
  rm -rf /tmp/chats-archive-baseline /tmp/chats-archive-new /tmp/chats-archive-baseline.path
  ```
