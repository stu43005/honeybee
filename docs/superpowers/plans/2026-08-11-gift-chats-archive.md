# Gift（Jewels）寫入 chats-archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `gifts` collection 的文件以 `type: "gift"` 的列出現在 `{videoId}.jsonl`，並讓只收到禮物的直播也能觸發封存。

**Architecture:** 在既有的 k-way merge 封存管線多接一條 `GiftModel` cursor，`buildJsonlRow` 多一個 `case "gifts"` 走既有的 `makeAuthorRow`；`makeAuthorRow` 補上定值退回，讓 gift 文件缺少的 author 欄位仍能滿足契約的必填保證。`meta.json` 完全不動。契約以 additive 方式在 `video-chats.md` 的 version 2 章節新增 revision r1。

**Tech Stack:** TypeScript (ESM, NodeNext)、Typegoose 12.2.0 / mongoose 8.2.1、Jest 29（true ESM）。

**Spec:** [docs/superpowers/specs/2026-08-10-gift-chats-archive-design.md](../specs/2026-08-10-gift-chats-archive-design.md)

---

## File Structure

| 檔案                                                 | 動作   | 職責                                                 |
| ---------------------------------------------------- | ------ | ---------------------------------------------------- |
| `src/components/chats-archive/archive-video.ts`      | Modify | 匯出 `buildJsonlRow`、gift 列、gift cursor、定值退回 |
| `src/components/chats-archive/archive-video.spec.ts` | Create | `buildJsonlRow` 的單元測試                           |
| `src/components/chats-archive.ts`                    | Modify | 封存觸發條件加入 `MessageType.Gift`                  |
| `docs/data-contract/video-chats.md`                  | Modify | version 2 新增 revision r1：`gift` 列                |

不新增檔案模組。`buildJsonlRow` 從模組私有改為 export，是因為它是
`(doc, videoId) → 列` 的純函式、只讀 `doc.collection.name` 與文件欄位，用手寫
物件就能餵，不需要資料庫也不需要 mock 任何模組 —— 這是這次唯一有分支邏輯的
部分，值得直接測。

---

## 通用驗證指令

每個 Task 的最後都要能通過：

```bash
npm run build && npm run lint && npm test
```

單一測試檔：`npm run test -- src/components/chats-archive/archive-video.spec.ts`

---

### Task 1: 匯出 `buildJsonlRow` 並建立既有行為的基準測試

**Files:**

- Modify: `src/components/chats-archive/archive-video.ts`
- Create: `src/components/chats-archive/archive-video.spec.ts`

這個 Task 不改任何行為，只是把純函式露出來並把「superchat 列現在長什麼樣」
釘住。後面 Task 3 會改 `makeAuthorRow`，這個測試就是那次改動不會波及既有九種
列的保證。

- [ ] **Step 1: 寫測試**

建立 `src/components/chats-archive/archive-video.spec.ts`：

```ts
/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { buildJsonlRow, type ChatRowDoc } from "./archive-video.js";

const VIDEO_ID = "9hFxGFgx8Pc";

/**
 * A stand-in for a mongoose document. `buildJsonlRow` only reads
 * `collection.name` and plain fields, so a literal is enough — and keeping the
 * cast in here means no test body has to repeat it.
 */
function doc(
  collectionName: string,
  fields: Record<string, unknown>
): ChatRowDoc {
  return {
    collection: { name: collectionName },
    ...fields,
  } as unknown as ChatRowDoc;
}

describe("buildJsonlRow", () => {
  it("carries every author field of a superchat through to the row", () => {
    const row = buildJsonlRow(
      doc("superchats", {
        id: "sc-1",
        timestamp: new Date("2026-08-09T00:00:00.000Z"),
        authorName: "Supporter",
        authorPhoto: "https://example.test/photo.jpg",
        authorChannelId: "UCsender",
        authorType: "member",
        membership: "1 month",
        isVerified: false,
        isOwner: false,
        isModerator: true,
        message: "thanks!",
        amount: 1000,
        currency: "JPY",
        jpyAmount: 1000,
        significance: 2,
        color: "blue",
      }),
      VIDEO_ID
    );

    expect(row).toEqual({
      type: "superChat",
      id: "sc-1",
      timestamp: new Date("2026-08-09T00:00:00.000Z"),
      authorName: "Supporter",
      authorPhoto: "https://example.test/photo.jpg",
      authorChannelId: "UCsender",
      authorType: "member",
      membership: "1 month",
      isVerified: false,
      isOwner: false,
      isModerator: true,
      message: "thanks!",
      amount: 1000,
      currency: "JPY",
      jpyAmount: 1000,
      significance: 2,
      color: "blue",
    });
  });

  it("returns null for a collection it does not know", () => {
    expect(
      buildJsonlRow(doc("banactions", { id: "b-1" }), VIDEO_ID)
    ).toBeNull();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/components/chats-archive/archive-video.spec.ts`
Expected: FAIL —— `buildJsonlRow` 尚未被 export，錯誤訊息類似
`does not provide an export named 'buildJsonlRow'`。

- [ ] **Step 3: 匯出 `buildJsonlRow`**

在 `src/components/chats-archive/archive-video.ts` 把

```ts
function buildJsonlRow(doc: ChatRowDoc, videoId: string): JsonlRow | null {
```

改成

```ts
export function buildJsonlRow(
  doc: ChatRowDoc,
  videoId: string
): JsonlRow | null {
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run test -- src/components/chats-archive/archive-video.spec.ts`
Expected: PASS，2 個 test 全綠。

- [ ] **Step 5: 確認編譯與 lint 通過**

Run: `npm run build && npm run lint`
Expected: 皆成功。

- [ ] **Step 6: Commit**

```bash
git add src/components/chats-archive/archive-video.ts src/components/chats-archive/archive-video.spec.ts
git commit -m "test(chats-archive): pin the current jsonl row shape before adding gifts"
```

---

### Task 2: `buildJsonlRow` 新增 gift 列

**Files:**

- Modify: `src/components/chats-archive/archive-video.ts`
- Modify: `src/components/chats-archive/archive-video.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

在 `src/components/chats-archive/archive-video.spec.ts` 的 `describe("buildJsonlRow", ...)`
區塊末端追加兩個測試：

```ts
it("turns a gift document into a gift row", () => {
  const row = buildJsonlRow(
    doc("gifts", {
      id: "gift-1",
      timestamp: new Date("2026-08-09T00:00:05.000Z"),
      authorName: "sender",
      authorPhoto: "https://example.test/sender.jpg",
      authorChannelId: "UCsender",
      authorType: "other",
      giftName: "Heart",
      assetName: "heart",
      image:
        "https://www.gstatic.com/youtube/img/pdg/gift/assets/heart.png=w640-h640",
      amount: 10,
      currency: "JEWEL",
      // Present on the document, deliberately not carried into the row.
      message: "comboed x8 Heart for 80 Jewels",
      jewelCount: 80,
      comboCount: 8,
      hasGiftImageUrl: true,
      originVideoId: VIDEO_ID,
      originChannelId: "UCchannel",
      isVerified: false,
      isOwner: false,
      isModerator: false,
    }),
    VIDEO_ID
  );

  // toEqual rather than toMatchObject: the point is that the price-derivation
  // scaffolding and the raw wave-summary text do not leak into the archive.
  expect(row).toEqual({
    type: "gift",
    id: "gift-1",
    timestamp: new Date("2026-08-09T00:00:05.000Z"),
    authorName: "sender",
    authorPhoto: "https://example.test/sender.jpg",
    authorChannelId: "UCsender",
    authorType: "other",
    isVerified: false,
    isOwner: false,
    isModerator: false,
    giftName: "Heart",
    assetName: "heart",
    image:
      "https://www.gstatic.com/youtube/img/pdg/gift/assets/heart.png=w640-h640",
    amount: 10,
    currency: "JEWEL",
  });
});

it("leaves out the gift fields the document does not carry", () => {
  const row = buildJsonlRow(
    doc("gifts", {
      id: "gift-2",
      timestamp: new Date("2026-08-09T00:00:06.000Z"),
      authorType: "other",
      currency: "JEWEL",
      originVideoId: VIDEO_ID,
      originChannelId: "UCchannel",
    }),
    VIDEO_ID
  );

  // Asserting the key is absent, not that its value is undefined: only an
  // absent key is dropped by JSON.stringify, and the two are indistinguishable
  // to toEqual.
  for (const field of ["giftName", "assetName", "image", "amount"]) {
    expect(row).not.toHaveProperty(field);
  }
  expect(row).toHaveProperty("currency", "JEWEL");
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/components/chats-archive/archive-video.spec.ts`
Expected: FAIL —— 兩個新測試都失敗，`buildJsonlRow` 對未知的 collection 回傳
`null`（`expected null to equal { type: "gift", ... }`）。

- [ ] **Step 3: 加入 import 與型別**

在 `src/components/chats-archive/archive-video.ts` 的 model import 群組中，於
`import ChatModel, { type Chat } from "../../models/Chat.js";` 之後加入（維持
字母順序）：

```ts
import GiftModel, { type Gift } from "../../models/Gift.js";
```

並把 `ChatRowDoc` 聯集中的 `SuperSticker` 之後加入 `Gift`：

```ts
export type ChatRowDoc = DocumentType<
  | Chat
  | SuperChat
  | SuperSticker
  | Gift
  | Membership
  | MembershipGift
  | MembershipGiftPurchase
  | Milestone
  | Poll
  | Raid
>;
```

`GiftModel` 這個 import 在本 Task 還沒有用到，Task 4 接上 cursor 時才會用；若
lint 因未使用而報錯，先只 import 型別（`import { type Gift } from ...`），Task 4
再改成含 default import 的形式。

- [ ] **Step 4: 新增 `case "gifts"`**

在 `buildJsonlRow` 的 `case "superstickers": { ... }` 區塊之後、
`case "memberships":` 之前插入：

```ts
    case "gifts": {
      const d = doc as DocumentType<Gift>;
      return makeAuthorRow("gift", d, {
        ...setIfDefine("giftName", d.giftName),
        ...setIfDefine("assetName", d.assetName),
        ...setIfDefine("image", d.image),
        ...setIfDefine("amount", d.amount),
        currency: d.currency,
      });
    }
```

`message` 不放進列裡：它存的是原始文字，而一波連發中的某一則會被改寫成
`comboed x8 Heart for 80 Jewels` 這種整波摘要，但該列仍然只代表一份禮物，且列
上沒有任何欄位能讓讀者分辨哪些被改寫過。`jewelCount` / `comboCount` /
`hasGiftImageUrl` 只是單價推導的原料，同樣不外流。

- [ ] **Step 5: 執行測試確認通過**

Run: `npm run test -- src/components/chats-archive/archive-video.spec.ts`
Expected: PASS，4 個 test 全綠。

- [ ] **Step 6: 確認編譯與 lint 通過**

Run: `npm run build && npm run lint`
Expected: 皆成功。

- [ ] **Step 7: Commit**

```bash
git add src/components/chats-archive/archive-video.ts src/components/chats-archive/archive-video.spec.ts
git commit -m "feat(chats-archive): emit a gift row for jewel gift documents"
```

---

### Task 3: `makeAuthorRow` 補上 author 必填欄位的定值退回

**Files:**

- Modify: `src/components/chats-archive/archive-video.ts`
- Modify: `src/components/chats-archive/archive-video.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

在 `src/components/chats-archive/archive-video.spec.ts` 的
`describe("buildJsonlRow", ...)` 區塊末端追加：

```ts
it("fills the author fields a gift document never carries", () => {
  const row = buildJsonlRow(
    doc("gifts", {
      id: "gift-3",
      timestamp: new Date("2026-08-09T00:00:07.000Z"),
      authorType: "other",
      currency: "JEWEL",
      originVideoId: VIDEO_ID,
      originChannelId: "UCchannel",
    }),
    VIDEO_ID
  );

  // A gift action carries no badge information and only the ticker (>= 100
  // Jewels) carries a channel id, so these four arrive undefined — and
  // JSON.stringify drops undefined-valued keys, which would produce a row
  // missing fields every author row is supposed to have.
  expect(row).toEqual(
    expect.objectContaining({
      authorChannelId: "",
      authorType: "other",
      isVerified: false,
      isOwner: false,
      isModerator: false,
    })
  );
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/components/chats-archive/archive-video.spec.ts -t "fills the author fields"`
Expected: FAIL —— `authorChannelId` 收到 `undefined` 而非 `""`。

- [ ] **Step 3: 改 `makeAuthorRow`**

把 `src/components/chats-archive/archive-video.ts` 的 `makeAuthorRow` 改成：

```ts
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
    // A gift action carries no badge information at all, and only its ticker
    // (>= 100 Jewels) carries a channel id, so these four can arrive
    // undefined. JSON.stringify drops undefined-valued keys, so without a
    // fallback the row would be missing fields every author row is supposed to
    // have. Every other collection always populates them, so this is inert
    // there.
    authorChannelId: r.authorChannelId ?? "",
    authorType: r.authorType,
    ...setIfDefine("membership", r.membership),
    isVerified: r.isVerified ?? false,
    isOwner: r.isOwner ?? false,
    isModerator: r.isModerator ?? false,
    ...extra,
  };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run test -- src/components/chats-archive/archive-video.spec.ts`
Expected: PASS，5 個 test 全綠。Task 1 那個 superchat 測試也必須仍然通過 ——
它證明這次改動沒有覆蓋既有列的實際值。

- [ ] **Step 5: 確認編譯與 lint 通過**

Run: `npm run build && npm run lint`
Expected: 皆成功。

- [ ] **Step 6: Commit**

```bash
git add src/components/chats-archive/archive-video.ts src/components/chats-archive/archive-video.spec.ts
git commit -m "fix(chats-archive): keep every author row's required fields present"
```

---

### Task 4: 把 gift cursor 併入封存的 k-way merge

**Files:**

- Modify: `src/components/chats-archive/archive-video.ts`

- [ ] **Step 1: 確保 `GiftModel` 是 default import**

確認 `src/components/chats-archive/archive-video.ts` 的 import 是：

```ts
import GiftModel, { type Gift } from "../../models/Gift.js";
```

（Task 2 若為了避開未使用變數而只 import 了型別，這一步改回上面的形式。）

- [ ] **Step 2: 新增 cursor**

在 `archiveVideo` 中，於 `const superStickerCursor = ...` 那一段之後、
`const membershipCursor = ...` 之前插入：

```ts
const giftCursor = GiftModel.find({ originVideoId: videoId })
  .sort({ timestamp: 1 })
  .setOptions({ readPreference: "secondaryPreferred" })
  .cursor();
```

- [ ] **Step 3: 併入 `multiCursorOrderedPeek`**

把 `for await (const doc of multiCursorOrderedPeek<ChatRowDoc>(...)` 的參數列
改成（在 `superStickerCursor` 之後加入 `giftCursor`）：

```ts
  for await (const doc of multiCursorOrderedPeek<ChatRowDoc>(
    ownerChatCursor,
    moderatorChatCursor,
    superChatCursor,
    superStickerCursor,
    giftCursor,
    membershipCursor,
    membershipGiftCursor,
    membershipGiftPurchaseCursor,
    milestoneCursor,
    pollCursor,
    raidCursor
  )) {
```

`bumpAggregate` **不要動**。它以 `doc.collection.name` 分派且沒有 default
分支，`"gifts"` 自然不計入任何 aggregate —— `meta.json` 維持不變是這次的設計
決定。

- [ ] **Step 4: 確認編譯、lint 與全部測試通過**

Run: `npm run build && npm run lint && npm test`
Expected: 皆成功，既有測試無退化。

- [ ] **Step 5: Commit**

```bash
git add src/components/chats-archive/archive-video.ts
git commit -m "feat(chats-archive): merge gift documents into the archived timeline"
```

---

### Task 5: 封存觸發條件加入 Gift

**Files:**

- Modify: `src/components/chats-archive.ts`

- [ ] **Step 1: 加入 `MessageType.Gift`**

在 `src/components/chats-archive.ts` 的 `archiveAllChats` 中，把
`VideoStatsModel.getVideoIdsWithoutFlag` 第一個引數裡的 `messageType.$in`
陣列改成（於 `MessageType.SuperSticker` 之後插入一行）：

```ts
          messageType: {
            $in: [
              MessageType.SuperChat,
              MessageType.SuperSticker,
              MessageType.Gift,
              MessageType.Membership,
              MessageType.MembershipGift,
              MessageType.MembershipGiftPurchase,
              MessageType.Milestone,
            ],
          },
```

這一步是「只收到禮物的直播也會被封存」的全部實作。`video-stats.ts` 對
`messageTypes` 的每一項都註冊一條寫 `VideoStatsType.MessageTotal` 的 cron，而
該陣列已含 `MessageType.Gift`，所以這些影片一定有對應的 `VideoStats` 列可被
挑中。

- [ ] **Step 2: 確認編譯、lint 與全部測試通過**

Run: `npm run build && npm run lint && npm test`
Expected: 皆成功。

- [ ] **Step 3: Commit**

```bash
git add src/components/chats-archive.ts
git commit -m "feat(chats-archive): archive streams whose only messages are gifts"
```

---

### Task 6: 契約新增 revision r1

**Files:**

- Modify: `docs/data-contract/video-chats.md`

這是 additive 變更（Path A，單一 PR）：新增的是聯集的一個新成員與它自己的可選
欄位，既有九種列的欄位名稱、型別、可選性、語意、編碼、單位、排序全部不變。
`docs/data-contract/video-meta.md` 完全不動。

`### Base shape (r0)` 章節**不要修改** —— 新的列型別寫在自己的 r1 章節裡，比照
`docs/data-contract/root-index.md` 的 `### Additive fields (r1)` 做法。

- [ ] **Step 1: 更新檔頭的 `Current writer emits`**

把第 11 行

```markdown
**Current writer emits:** version 2, revision r0
```

改成

```markdown
**Current writer emits:** version 2, revision r1
```

- [ ] **Step 2: 修訂歷史新增一列**

在修訂歷史表格末端追加：

```markdown
| 2 | r1 | 2026-08-11 | — | Add the `gift` row type (YouTube Gifts, bought with Jewels). |
```

`PR` 欄用 `—`，與既有兩列一致。

- [ ] **Step 3: 新增 r1 章節**

在 `### Base shape (r0)` 章節的結尾（`RaidOutgoingRow` 那個程式碼區塊的
結束標記之後）、`### Cumulative JSON example (r0)` 之前插入：

````markdown
### Additive row type (r1)

Since r1, `JsonlRow` has one further member. Readers written against r0 skip it
under the existing "unknown `type` values" rule.

```ts
interface GiftRow extends AuthorRowBase {
  type: "gift";
  giftName?: string; // display name; absent outside the English locale
  assetName?: string; // gift image file name, e.g. "finger_heart"
  image?: string; // gift image URL
  amount?: number; // Jewels for this one gift; absent when the price is unknown
  currency: string; // always "JEWEL"
}
```

One gift is one row. YouTube rewrites one message of a connected wave into a
`comboed xN … for J Jewels` summary, but that message still stands for a single
gift, so `amount` is a unit price and is never the wave total. The raw text is
not archived, because a row carries nothing that would let a reader tell a
rewritten message apart from a plain one.

`authorChannelId` is an empty string on a gift row unless the gift cost 100
Jewels or more — only those produce the ticker that carries the sender's channel
id. A gift also carries no badge information, so `authorType` is always
`"other"` and `isVerified` / `isOwner` / `isModerator` are always `false`.
````

- [ ] **Step 4: 重新產生 cumulative JSON example**

把 `### Cumulative JSON example (r0)` 這個標題改成
`### Cumulative JSON example (r1)`，並在該節既有的三個 JSON 區塊之後追加第四個：

````markdown
```json
{
  "type": "gift",
  "id": "GiftJkl012",
  "timestamp": "2026-05-29T12:12:00.000Z",
  "authorName": "Gifter",
  "authorChannelId": "",
  "authorType": "other",
  "isVerified": false,
  "isOwner": false,
  "isModerator": false,
  "giftName": "Heart",
  "assetName": "heart",
  "image": "https://www.gstatic.com/youtube/img/pdg/gift/assets/heart.png=w640-h640",
  "amount": 10,
  "currency": "JEWEL"
}
```
````

該節開頭那句「A representative sequence of three rows (one per line in the
actual file):」改成「A representative sequence of four rows (one per line in the
actual file):」。

- [ ] **Step 5: 更新 Reader guidance**

在 `### Reader guidance` 的項目清單中做三處修改。

其一，把

```markdown
- **Always present on every author row:** `type`, `id`, `timestamp`,
  `authorChannelId`, `authorType`, `isVerified`, `isOwner`, `isModerator`.
```

改成

```markdown
- **Always present on every author row:** `type`, `id`, `timestamp`,
  `authorChannelId`, `authorType`, `isVerified`, `isOwner`, `isModerator`. On
  `gift` rows (since r1) `authorChannelId` is an empty string unless the gift
  cost 100 Jewels or more, and `authorType` / `isVerified` / `isOwner` /
  `isModerator` are always `"other"` / `false` / `false` / `false` — a gift
  carries no badge information.
```

其二，把

```markdown
- **May be absent on author rows:** `authorName`, `authorPhoto`,
  `membership`, plus the per-type optional extras shown above.
```

改成

```markdown
- **May be absent on author rows:** `authorName`, `authorPhoto`,
  `membership`, plus the per-type optional extras shown above; and, since r1,
  `giftName`, `assetName`, `image`, `amount` on `gift` rows.
```

其三，在「Always present on poll rows」那一項之前插入一項：

```markdown
- **`amount` on `gift` rows:** the Jewels a single gift cost. Absent when that
  gift's price was not yet known at archive time — a price is only derivable
  from a combo summary, and the archive is written once and never revised.
```

- [ ] **Step 6: 確認 format 通過**

Run: `npm run format:check`
Expected: 成功。若失敗，執行 `npm run format` 後重跑。

- [ ] **Step 7: Commit**

```bash
git add docs/data-contract/video-chats.md
git commit -m "docs(data-contract): add the gift jsonl row type as video-chats v2 r1"
```

---

## 完成後的整體驗證

- [ ] **Step 1: 全套驗證**

Run: `npm run build && npm run lint && npm run format:check && npm test`
Expected: 全部通過。

- [ ] **Step 2: 確認程式碼沒有指向契約文件**

寫入端的原始碼、JSDoc、行內註解都不得引用契約文件（無論是字面字串或轉述）。

Run:

```bash
grep -nEi 'data-contract|contract (md|document|spec)|see the contract|as documented in docs' src/components/chats-archive/archive-video.ts src/components/chats-archive/archive-video.spec.ts src/components/chats-archive.ts
```

Expected: 無輸出。

- [ ] **Step 3: 確認規格與計畫的引用沒有洩漏進程式碼**

Run:

```bash
grep -nE '§|\bspec\b|\bplan\b|Task [0-9]|Layer [0-9]' src/components/chats-archive/archive-video.ts src/components/chats-archive/archive-video.spec.ts src/components/chats-archive.ts
```

Expected: 無輸出。

- [ ] **Step 4: 契約審查**

本計畫的契約變更須通過 [docs/data-contract/README.md](../../data-contract/README.md)
§8 的 reviewer checklist（Path A）。

- [ ] **Step 5: 部署後抽驗**

只有這一項需要一個實際跑起來的環境，因此擺在最後。

服務啟動並跑過一輪封存後，找一支有禮物的影片，檢查
`${CHAT_ARCHIVE_DIR}/data/videos/{videoId}.jsonl`：

```bash
grep '"type":"gift"' "${CHAT_ARCHIVE_DIR}/data/videos/{videoId}.jsonl" | head -3
```

Pass 條件：

- 有 `"type":"gift"` 的列
- 每一列都有 `authorChannelId`、`authorType`、`isVerified`、`isOwner`、
  `isModerator` 五個鍵（低單價禮物的 `authorChannelId` 為 `""`）
- 列上**沒有** `message`、`jewelCount`、`comboCount`、`hasGiftImageUrl`
- 整份檔案的 `timestamp` 仍是遞增的
