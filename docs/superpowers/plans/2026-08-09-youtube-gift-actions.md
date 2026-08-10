# YouTube Gift（Jewels）action 收集與統計 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收集 masterchat 的 `addGiftItemAction` / `addGiftTickerAction` 兩種 action 寫入新的 `gifts` collection，維護一份自動學習的 Gift 單價表，並產出 `message_total` 與 `purchase_amount_total` 兩項 VideoStats 統計。

**Architecture:** worker 在同一批次內以 `id` 合併 item 與 ticker，用 aggregation pipeline upsert 寫入 `gifts`（互補欄位填缺不覆蓋、combo 狀態群整組替換）。manager 每 10 分鐘從 `gifts` 的當前窗口重建 `giftprices` 單價表，worker 以雙層快取讀取它換算單價。統計、cleanup、webhook 全部沿用既有框架，不新增機制。

**Tech Stack:** TypeScript (ESM, NodeNext)、Typegoose 12.2.0 / mongoose 8.2.1（內嵌 mongodb driver 6.3.0）、MongoDB 5、Agenda、cache-manager 6.1.1、Jest 29（true ESM）。

**Spec:** [docs/superpowers/specs/2026-08-09-youtube-gift-actions-design.md](../specs/2026-08-09-youtube-gift-actions-design.md)

---

## File Structure

| 檔案                                    | 動作   | 職責                                                                                  |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `src/interfaces.ts`                     | Modify | 新增 `MessageType.Gift`                                                               |
| `src/models/Gift.ts`                    | Create | `gifts` collection schema 與索引                                                      |
| `src/models/GiftPrice.ts`               | Create | `giftprices` 單價表 schema                                                            |
| `src/components/gift.ts`                | Create | worker 端純函式：資產名解析、單價推導、item/ticker 合併、pipeline op 組裝、價格表快取 |
| `src/components/gift.spec.ts`           | Create | 上述純函式的單元測試                                                                  |
| `src/components/gift-price.ts`          | Create | manager 的價格重建 Agenda job 與其決策純函式                                          |
| `src/components/gift-price.spec.ts`     | Create | 重建決策與冪等性測試                                                                  |
| `src/commands/worker.ts`                | Modify | 新增 gift action 的 switch case                                                       |
| `src/commands/manager.ts`               | Modify | 註冊 `giftPrice` component                                                            |
| `src/components/video-stats.ts`         | Modify | `messageTypes` 新增 Gift                                                              |
| `src/components/cleanup.ts`             | Modify | `cleanVideos` 刪除 gifts                                                              |
| `src/data/track.ts`                     | Modify | 三個 chat preset 的 `colls` 加入 `"gifts"`                                            |
| `src/components/youtube-dm-operator.ts` | Modify | `DM_COLLS` 加入 `"gifts"`                                                             |
| `src/data/webhook.ts`                   | Modify | `getMessage()` 與 embed fields 的 Gift 分支                                           |

`src/components/gift.ts` 與 `src/components/gift-price.ts` 分開，是因為前者跑在 worker（每則訊息都會呼叫、必須是同步純函式加一層快取），後者跑在 manager（每 10 分鐘一次、直接打 DB）。兩者沒有共用邏輯。

---

## 通用驗證指令

每個 Task 的最後都要能通過：

```bash
npm run build && npm run lint && npm test
```

單一測試檔：`npm run test -- src/components/gift.spec.ts`

---

### Task 1: 新增 `MessageType.Gift`

**Files:**

- Modify: `src/interfaces.ts:10-24`

- [ ] **Step 1: 在 `MessageType` enum 新增 Gift**

在 `src/interfaces.ts` 的 `MessageType` enum 中，於 `Chat = "chat"` 之前插入一行：

```ts
export enum MessageType {
  Milestone = "milestone",
  Membership = "membership",
  MembershipGift = "membershipGift",
  MembershipGiftPurchase = "membershipGiftPurchase",
  SuperChat = "superChat",
  SuperSticker = "superSticker",
  Gift = "gift",
  Chat = "chat",

  // Actions
  BanAction = "banAction",
  RemoveChatAction = "removeChatAction",
  Poll = "poll",
  Raid = "raid",
}
```

`"gift"` 與既有的 `"membershipGift"` 是不同字串，不會衝突。

- [ ] **Step 2: 確認編譯通過**

Run: `npm run build`
Expected: 編譯成功，無錯誤輸出。

- [ ] **Step 3: Commit**

```bash
git add src/interfaces.ts
git commit -m "feat(interfaces): add gift message type"
```

---

### Task 2: 建立 `Gift` model

**Files:**

- Create: `src/models/Gift.ts`

- [ ] **Step 1: 建立 model 檔案**

建立 `src/models/Gift.ts`：

```ts
import {
  getModelForClass,
  index,
  modelOptions,
  prop,
} from "@typegoose/typegoose";
import type { MessageAuthorType } from "../interfaces.js";

@modelOptions({
  schemaOptions: { collection: "gifts" },
})
@index({ originVideoId: 1, timestamp: 1 })
// Narrows the price rebuild's sweep to the documents it can actually learn a
// price from. Every condition here is either an equality or `$exists: true`,
// which is deliberate: a partial filter may only use equality, `$exists: true`,
// the range operators, `$type`, `$and`, `$or` and `$in`. Anything else (`$ne`,
// say) makes the server reject createIndex, and mongoose's autoIndex swallows
// that rejection — the code would believe the index exists while queries
// silently fall back to a collection scan.
@index(
  { assetName: 1 },
  {
    partialFilterExpression: {
      hasGiftImageUrl: true,
      assetName: { $exists: true },
      jewelCount: { $exists: true },
      comboCount: { $exists: true },
    },
  }
)
export class Gift {
  @prop({ required: true, unique: true })
  public id!: string;

  @prop({ required: true })
  public timestamp!: Date;

  @prop()
  public authorName?: string;

  @prop()
  public authorPhoto?: string;

  /**
   * Only a ticker carries the sender's channel id, and tickers only appear for
   * gifts priced at 100 Jewels or more.
   */
  @prop()
  public authorChannelId?: string;

  /**
   * Always `other` — a gift action carries no badge information at all, so
   * membership / moderator / owner cannot be told apart.
   */
  @prop({ required: true })
  public authorType!: MessageAuthorType;

  /** Raw display text, e.g. `"comboed x5 Heart for 17,000 Jewels"`. */
  @prop()
  public message?: string;

  @prop()
  public giftName?: string;

  /** Image file name, e.g. `finger_heart`. The key into the price table. */
  @prop()
  public assetName?: string;

  @prop()
  public image?: string;

  /** Raw parsed figure. Feeds price derivation only, never `amount`. */
  @prop()
  public jewelCount?: number;

  /** Raw parsed figure. Feeds price derivation only, never `amount`. */
  @prop()
  public comboCount?: number;

  /**
   * Whether the chat item carried its own image. `assetName` can also come from
   * a ticker's sticker url, so this is the only way to tell whether
   * `jewelCount` is a whole-wave total (safe to divide by `comboCount`) or a
   * single unit price (not safe).
   */
  @prop()
  public hasGiftImageUrl?: boolean;

  /** Jewels for this one gift — always a unit price, never a wave total. */
  @prop()
  public amount?: number;

  /** Always `"JEWEL"`. Keeps the stats label set complete without pretending to be fiat. */
  @prop({ required: true })
  public currency!: string;

  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true })
  public originChannelId!: string;

  @prop()
  public isReplay?: boolean;
}

export default getModelForClass(Gift);
```

不繼承 `TimeStamps`：寫入走 aggregation pipeline，mongoose 在 pipeline update 下不會補 `createdAt`，留一個永遠缺失的欄位只會誤導。

- [ ] **Step 2: 確認編譯與 lint 通過**

Run: `npm run build && npm run lint`
Expected: 皆成功。`importAllModels()` 會自動掃到這個檔案，不需要註冊。

- [ ] **Step 3: Commit**

```bash
git add src/models/Gift.ts
git commit -m "feat(models): add Gift model for jewel gift messages"
```

---

### Task 3: 建立 `GiftPrice` model

**Files:**

- Create: `src/models/GiftPrice.ts`

- [ ] **Step 1: 建立 model 檔案**

建立 `src/models/GiftPrice.ts`：

```ts
import { getModelForClass, modelOptions, prop } from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses.js";

@modelOptions({ schemaOptions: { collection: "giftprices" } })
export class GiftPrice extends TimeStamps {
  /** Image file name, e.g. `finger_heart`. */
  @prop({ required: true, unique: true })
  public assetName!: string;

  /** Jewels for a single gift of this asset. */
  @prop({ required: true })
  public price!: number;

  /**
   * Latest observed display name. Reference only — two different assets can
   * share one display name, so it must never be used to look a price up.
   */
  @prop()
  public giftName?: string;

  /**
   * Hand-entered price. A seed, not a lock: the rebuild applies the very same
   * overwrite rules to it and clears this flag once real observations back the
   * value. A permanently pinned price would silently stay wrong after YouTube
   * repriced the asset.
   */
  @prop()
  public manual?: boolean;

  /**
   * Largest number of observations any single rebuild has seen supporting the
   * current `price`. A max rather than a running total: every rebuild rescans
   * the same window, so summing would let a value gain confidence purely by
   * sitting there across reruns — the opposite of what this field is for.
   */
  @prop({ required: true, default: 0 })
  public sampleCount!: number;
}

export default getModelForClass(GiftPrice);
```

- [ ] **Step 2: 確認編譯與 lint 通過**

Run: `npm run build && npm run lint`
Expected: 皆成功。

- [ ] **Step 3: Commit**

```bash
git add src/models/GiftPrice.ts
git commit -m "feat(models): add GiftPrice model for the learned jewel price table"
```

---

### Task 4: `parseGiftAssetName`

**Files:**

- Create: `src/components/gift.ts`
- Create: `src/components/gift.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

建立 `src/components/gift.spec.ts`：

```ts
/// <reference types="jest" />
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// Read at module load by src/constants.ts, so it has to be set before anything
// pulls the cache module in. Empty keeps getCacheInstance memory-only.
process.env.REDIS_URI = "";

const find = jest.fn<() => Promise<{ assetName: string; price: number }[]>>();

jest.unstable_mockModule("../models/GiftPrice.js", () => ({
  default: { find },
}));

// Dynamic import so the mock above is registered first — the project's ESM
// Jest setup has no hoisted jest.mock.
const { parseGiftAssetName } = await import("./gift.js");

const PREFIX = "https://www.gstatic.com/youtube/img/pdg/gift/assets";

describe("parseGiftAssetName", () => {
  it("collapses the chat-item and ticker spellings onto one key", () => {
    expect(parseGiftAssetName(`${PREFIX}/finger_heart.png=w640-h640`)).toBe(
      "finger_heart"
    );
    expect(parseGiftAssetName(`${PREFIX}/finger_heart.png`)).toBe(
      "finger_heart"
    );
  });

  it("keeps different assets apart", () => {
    expect(parseGiftAssetName(`${PREFIX}/hanabi.png=w640-h640`)).toBe("hanabi");
    expect(parseGiftAssetName(`${PREFIX}/maturi_uchiwa.png=w640-h640`)).toBe(
      "maturi_uchiwa"
    );
    expect(parseGiftAssetName(`${PREFIX}/cat_jammin.png`)).toBe("cat_jammin");
  });

  it("ignores the image format so a re-encode keeps the same key", () => {
    expect(parseGiftAssetName(`${PREFIX}/kami.webp`)).toBe("kami");
    expect(parseGiftAssetName(`${PREFIX}/kami`)).toBe("kami");
  });

  it("returns undefined when there is nothing to key on", () => {
    expect(parseGiftAssetName(undefined)).toBeUndefined();
    expect(parseGiftAssetName("")).toBeUndefined();
    expect(parseGiftAssetName(`${PREFIX}/`)).toBeUndefined();
    expect(parseGiftAssetName(`${PREFIX}/.png`)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/components/gift.spec.ts`
Expected: FAIL，錯誤訊息為 `Cannot find module './gift.js'`。

- [ ] **Step 3: 寫最小實作**

建立 `src/components/gift.ts`：

```ts
/**
 * Gift images are served as
 * `https://www.gstatic.com/youtube/img/pdg/gift/assets/finger_heart.png=w640-h640`
 * on chat items, and the very same asset appears without the `=w640-h640`
 * suffix as a ticker sticker url. Strip the suffix and the extension so both
 * spellings land on one key, and so re-encoding the asset to another format
 * later would not fork it into a second price table entry.
 */
export function parseGiftAssetName(
  url: string | undefined
): string | undefined {
  if (!url) return undefined;
  const lastSegment = url.split("/").pop();
  if (!lastSegment) return undefined;
  const withoutSizeSuffix = lastSegment.split("=")[0];
  const withoutExtension = withoutSizeSuffix.replace(/\.[^.]+$/, "");
  return withoutExtension || undefined;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run test -- src/components/gift.spec.ts`
Expected: PASS，4 個 test 全綠。

- [ ] **Step 5: Commit**

```bash
git add src/components/gift.ts src/components/gift.spec.ts
git commit -m "feat(gift): derive a stable asset name from gift image urls"
```

---

### Task 5: `deriveGiftAmount`

**Files:**

- Modify: `src/components/gift.ts`
- Modify: `src/components/gift.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

在 `src/components/gift.spec.ts` 把動態 import 的解構加上 `deriveGiftAmount`：

```ts
const { deriveGiftAmount, parseGiftAssetName } = await import("./gift.js");
```

並在檔案末端追加：

```ts
// Heart 10 and Star 2 are real production prices; the combo figures below are
// the wave summaries actually observed for them.
const PRICES = new Map([
  ["heart", 10],
  ["star", 2],
]);

describe("deriveGiftAmount", () => {
  it("takes a stated unit price directly when there is no combo", () => {
    // "sent Heart for 10 Jewels"
    expect(
      deriveGiftAmount({ jewelCount: 10, comboCount: undefined }, PRICES)
    ).toBe(10);
  });

  it("never treats a wave summary total as this gift's amount", () => {
    // "comboed x8 Heart for 80 Jewels" — this document is still one gift.
    expect(
      deriveGiftAmount(
        { assetName: "heart", jewelCount: 80, comboCount: 8 },
        PRICES
      )
    ).toBe(10);
    // "comboed x4 Star for 8 Jewels"
    expect(
      deriveGiftAmount(
        { assetName: "star", jewelCount: 8, comboCount: 4 },
        PRICES
      )
    ).toBe(2);
  });

  it("looks the price up when the message states no figure", () => {
    // "sent Star" — the merged spelling carries no jewel count at all.
    expect(deriveGiftAmount({ assetName: "star" }, PRICES)).toBe(2);
  });

  it("prices a ticker-only document from its sticker asset", () => {
    expect(deriveGiftAmount({ assetName: "heart" }, PRICES)).toBe(10);
  });

  it("returns undefined when the price is unknown", () => {
    expect(
      deriveGiftAmount({ assetName: "unlearned" }, PRICES)
    ).toBeUndefined();
    expect(deriveGiftAmount({}, PRICES)).toBeUndefined();
    expect(
      deriveGiftAmount({ jewelCount: 80, comboCount: 8 }, PRICES)
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/components/gift.spec.ts -t "deriveGiftAmount"`
Expected: FAIL，`deriveGiftAmount is not a function`（動態 import 解構出
`undefined`）。

- [ ] **Step 3: 寫最小實作**

在 `src/components/gift.ts` 追加：

```ts
export interface GiftAmountFields {
  assetName?: string;
  jewelCount?: number;
  comboCount?: number;
}

/**
 * Jewels for one gift. Every document is exactly one gift — a connected wave
 * shows up as several separate ids — so this is always a unit price and must
 * never be multiplied by `comboCount`.
 *
 * A `comboed xN … for J Jewels` message states that wave's summary figure, and
 * `J` means different things depending on whether the item carried its own
 * image, so it can never be used as this document's amount. Only a message
 * with no `comboCount` states a unit price outright.
 */
export function deriveGiftAmount(
  fields: GiftAmountFields,
  priceTable: Map<string, number>
): number | undefined {
  const { assetName, jewelCount, comboCount } = fields;
  if (comboCount == null && jewelCount != null) {
    return jewelCount;
  }
  return assetName ? priceTable.get(assetName) : undefined;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run test -- src/components/gift.spec.ts`
Expected: PASS，9 個 test 全綠。

- [ ] **Step 5: Commit**

```bash
git add src/components/gift.ts src/components/gift.spec.ts
git commit -m "feat(gift): derive the per-gift jewel amount as a unit price"
```

---

### Task 6: `mergeGiftActions`

**Files:**

- Modify: `src/components/gift.ts`
- Modify: `src/components/gift.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

在 `src/components/gift.spec.ts` 的靜態 import 區加入型別與 enum：

```ts
import type {
  AddGiftItemAction,
  AddGiftTickerAction,
} from "@stu43005/masterchat";
import { MessageAuthorType } from "../interfaces.js";
```

並把動態 import 的解構加上 `mergeGiftActions`：

```ts
const { deriveGiftAmount, mergeGiftActions, parseGiftAssetName } =
  await import("./gift.js");
```

並在檔案末端追加：

```ts
const CTX = {
  originVideoId: "9hFxGFgx8Pc",
  originChannelId: "UCchannel",
  isReplay: undefined,
  receivedAt: new Date("2026-08-09T00:00:00.000Z"),
};

function giftItem(overrides: Partial<AddGiftItemAction>): AddGiftItemAction {
  return {
    type: "addGiftItemAction",
    id: "gift-1",
    authorName: "sender",
    message: "sent Heart for 10 Jewels",
    jewelCount: 10,
    ...overrides,
  } as AddGiftItemAction;
}

function giftTicker(
  overrides: Partial<AddGiftTickerAction> = {}
): AddGiftTickerAction {
  return {
    type: "addGiftTickerAction",
    id: "gift-1",
    authorChannelId: "UCsender",
    durationSec: 300,
    fullDurationSec: 300,
    contents: {
      id: "gift-1",
      timestamp: new Date("2026-08-09T00:00:05.000Z"),
      timestampUsec: "1786492805000000",
      authorChannelId: "UCsender",
      authorName: "sender",
      giftName: "Heart",
      stickerUrl: `${PREFIX}/heart.png`,
    },
    startBackgroundColor: 0,
    endBackgroundColor: 0,
    ...overrides,
  } as AddGiftTickerAction;
}

describe("mergeGiftActions", () => {
  it("merges the item and the ticker of one gift into a single write", () => {
    const merged = mergeGiftActions(
      [giftItem({ giftImageUrl: `${PREFIX}/heart.png=w640-h640` })],
      [giftTicker()],
      CTX,
      PRICES
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      id: "gift-1",
      complement: {
        // The item states no timestamp here, so the ticker's stands in.
        timestamp: new Date("2026-08-09T00:00:05.000Z"),
        authorName: "sender",
        authorPhoto: undefined,
        authorChannelId: "UCsender",
        authorType: MessageAuthorType.Other,
        giftName: "Heart",
        image: `${PREFIX}/heart.png=w640-h640`,
        assetName: "heart",
        currency: "JEWEL",
        originVideoId: "9hFxGFgx8Pc",
        originChannelId: "UCchannel",
        isReplay: undefined,
      },
      amount: 10,
      combo: {
        message: "sent Heart for 10 Jewels",
        jewelCount: 10,
        comboCount: undefined,
        hasGiftImageUrl: true,
      },
    });
  });

  it("emits a ticker-only write with no combo state but a looked-up amount", () => {
    const merged = mergeGiftActions([], [giftTicker()], CTX, PRICES);

    expect(merged).toHaveLength(1);
    expect(merged[0].combo).toBeUndefined();
    expect(merged[0].amount).toBe(10);
    expect(merged[0].complement.authorChannelId).toBe("UCsender");
    expect(merged[0].complement.assetName).toBe("heart");
    expect(merged[0].complement.timestamp).toEqual(
      new Date("2026-08-09T00:00:05.000Z")
    );
  });

  it("prefers the item timestamp and falls back to the batch time", () => {
    const withTimestamp = mergeGiftActions(
      [giftItem({ timestamp: new Date("2026-08-09T00:00:01.000Z") })],
      [giftTicker()],
      CTX,
      PRICES
    );
    expect(withTimestamp[0].complement.timestamp).toEqual(
      new Date("2026-08-09T00:00:01.000Z")
    );

    const itemOnly = mergeGiftActions([giftItem({})], [], CTX, PRICES);
    expect(itemOnly[0].complement.timestamp).toEqual(CTX.receivedAt);
  });

  it("keeps the newest combo state when one id is delivered twice", () => {
    const merged = mergeGiftActions(
      [
        giftItem({ message: "sent Star", jewelCount: undefined }),
        giftItem({
          message: "comboed x4 Star for 8 Jewels",
          jewelCount: 8,
          comboCount: 4,
        }),
      ],
      [],
      CTX,
      PRICES
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].combo).toEqual({
      message: "comboed x4 Star for 8 Jewels",
      jewelCount: 8,
      comboCount: 4,
      hasGiftImageUrl: false,
    });
  });

  it("keeps the delivery that states a figure when the combo count ties", () => {
    const merged = mergeGiftActions(
      [
        giftItem({ message: "sent Heart", jewelCount: undefined }),
        giftItem({ message: "sent Heart for 10 Jewels", jewelCount: 10 }),
      ],
      [],
      CTX,
      PRICES
    );

    expect(merged[0].combo?.jewelCount).toBe(10);
  });

  it("does not let a later delivery walk the combo state backwards", () => {
    const merged = mergeGiftActions(
      [
        giftItem({
          message: "comboed x8 Heart for 80 Jewels",
          jewelCount: 80,
          comboCount: 8,
        }),
        giftItem({ message: "sent Heart for 10 Jewels", jewelCount: 10 }),
      ],
      [],
      CTX,
      PRICES
    );

    expect(merged[0].combo?.comboCount).toBe(8);
    expect(merged[0].combo?.jewelCount).toBe(80);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/components/gift.spec.ts -t "mergeGiftActions"`
Expected: FAIL，`mergeGiftActions is not a function`（動態 import 解構出
`undefined`）。

- [ ] **Step 3: 寫最小實作**

在 `src/components/gift.ts` 的最上方加入 import：

```ts
import type {
  AddGiftItemAction,
  AddGiftTickerAction,
} from "@stu43005/masterchat";
import { MessageAuthorType } from "../interfaces.js";
```

並在檔案末端追加：

```ts
/** Gifts are bought with Jewels, so the amount is not denominated in any fiat currency. */
export const GIFT_CURRENCY = "JEWEL";

export interface GiftMergeContext {
  originVideoId: string;
  originChannelId: string;
  isReplay: boolean | undefined;
  /** Read once per batch so documents written together do not scatter in time. */
  receivedAt: Date;
}

export interface GiftUpsert {
  id: string;
  /** Written on insert, only gap-filled afterwards — an item and a ticker each hold what the other lacks. */
  complement: {
    timestamp: Date;
    authorName?: string;
    authorPhoto?: string;
    authorChannelId?: string;
    authorType: MessageAuthorType;
    giftName?: string;
    image?: string;
    assetName?: string;
    currency: string;
    originVideoId: string;
    originChannelId: string;
    isReplay?: boolean;
  };
  /** Recomputed on every write; left out when the price is unknown. */
  amount?: number;
  /** Absent when this write only saw a ticker, which carries no combo information. */
  combo?: {
    message: string;
    jewelCount?: number;
    comboCount?: number;
    hasGiftImageUrl: boolean;
  };
}

/**
 * Which of two deliveries of the same id holds the newer wave summary: the
 * larger `comboCount` (an absent one counts as 1), and on a tie the delivery
 * that actually states a jewel figure.
 */
function pickNewerGiftItem(
  current: AddGiftItemAction | undefined,
  incoming: AddGiftItemAction
): AddGiftItemAction {
  if (!current) return incoming;
  const currentCombo = current.comboCount ?? 1;
  const incomingCombo = incoming.comboCount ?? 1;
  if (incomingCombo > currentCombo) return incoming;
  if (incomingCombo < currentCombo) return current;
  if (incoming.jewelCount != null && current.jewelCount == null) {
    return incoming;
  }
  return current;
}

function buildGiftUpsert(
  item: AddGiftItemAction | undefined,
  ticker: AddGiftTickerAction | undefined,
  ctx: GiftMergeContext,
  priceTable: Map<string, number>
): GiftUpsert {
  const contents = ticker?.contents;
  const image = item?.giftImageUrl ?? contents?.stickerUrl;
  const assetName = parseGiftAssetName(image);
  return {
    id: (item?.id ?? ticker?.id)!,
    complement: {
      // Both sides recover the same instant from the shared id, but a ticker
      // only exists above 100 Jewels, so the item is the primary source.
      timestamp: item?.timestamp ?? contents?.timestamp ?? ctx.receivedAt,
      authorName: item?.authorName ?? contents?.authorName,
      authorPhoto: item?.authorPhoto ?? contents?.authorPhoto,
      authorChannelId: ticker?.authorChannelId,
      authorType: MessageAuthorType.Other,
      giftName: item?.giftName ?? contents?.giftName,
      image,
      assetName,
      currency: GIFT_CURRENCY,
      originVideoId: ctx.originVideoId,
      originChannelId: ctx.originChannelId,
      isReplay: ctx.isReplay,
    },
    amount: deriveGiftAmount(
      {
        assetName,
        jewelCount: item?.jewelCount,
        comboCount: item?.comboCount,
      },
      priceTable
    ),
    combo: item
      ? {
          message: item.message,
          jewelCount: item.jewelCount,
          comboCount: item.comboCount,
          hasGiftImageUrl: item.giftImageUrl != null,
        }
      : undefined,
  };
}

/**
 * Collapse one batch of gift actions into one write per id.
 *
 * Merging before writing is what puts the ticker's `authorChannelId` on the
 * insert event: webhooks only fire on inserts, so writing the item first and
 * the ticker second would leave the ticker's fields on an update nobody reads.
 *
 * A batch holding only a ticker still produces a write — it stands for a gift
 * that really happened, and the shared id guarantees it converges with a later
 * item into the same document rather than counting twice.
 */
export function mergeGiftActions(
  items: AddGiftItemAction[],
  tickers: AddGiftTickerAction[],
  ctx: GiftMergeContext,
  priceTable: Map<string, number>
): GiftUpsert[] {
  const byId = new Map<
    string,
    { item?: AddGiftItemAction; ticker?: AddGiftTickerAction }
  >();

  for (const ticker of tickers) {
    const entry = byId.get(ticker.id) ?? {};
    entry.ticker = ticker;
    byId.set(ticker.id, entry);
  }
  for (const item of items) {
    const entry = byId.get(item.id) ?? {};
    entry.item = pickNewerGiftItem(entry.item, item);
    byId.set(item.id, entry);
  }

  return Array.from(byId.values(), ({ item, ticker }) =>
    buildGiftUpsert(item, ticker, ctx, priceTable)
  );
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run test -- src/components/gift.spec.ts`
Expected: PASS，15 個 test 全綠。

- [ ] **Step 5: Commit**

```bash
git add src/components/gift.ts src/components/gift.spec.ts
git commit -m "feat(gift): merge item and ticker actions of one gift into a single write"
```

---

### Task 7: `buildGiftUpsertOps`（pipeline upsert）

**Files:**

- Modify: `src/components/gift.ts`
- Modify: `src/components/gift.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

在 `src/components/gift.spec.ts` 把動態 import 的解構加上 `buildGiftUpsertOps`：

```ts
const {
  buildGiftUpsertOps,
  deriveGiftAmount,
  mergeGiftActions,
  parseGiftAssetName,
} = await import("./gift.js");
```

並在檔案末端追加：

```ts
// True exactly when the stored document has no combo state yet: this flag is
// written by every item delivery and by nothing else.
const NO_COMBO_YET = { $eq: [{ $ifNull: ["$hasGiftImageUrl", null] }, null] };

describe("buildGiftUpsertOps", () => {
  it("gap-fills complementary fields and states every required one", () => {
    const [op] = buildGiftUpsertOps(
      mergeGiftActions([], [giftTicker()], CTX, PRICES)
    );

    expect(op).toMatchObject({
      updateOne: { filter: { id: "gift-1" }, upsert: true },
    });
    const stage = (op as any).updateOne.update[0].$set;
    // A pipeline update bypasses mongoose schema defaults, so every required
    // field has to be spelled out here or the inserted document is invalid.
    expect(stage.authorType).toEqual({
      $ifNull: ["$authorType", { $literal: MessageAuthorType.Other }],
    });
    expect(stage.currency).toEqual({
      $ifNull: ["$currency", { $literal: "JEWEL" }],
    });
    expect(stage.originVideoId).toEqual({
      $ifNull: ["$originVideoId", { $literal: "9hFxGFgx8Pc" }],
    });
    expect(stage.originChannelId).toEqual({
      $ifNull: ["$originChannelId", { $literal: "UCchannel" }],
    });
    expect(stage.timestamp).toEqual({
      $ifNull: [
        "$timestamp",
        { $literal: new Date("2026-08-09T00:00:05.000Z") },
      ],
    });
  });

  it("omits complementary fields this write knows nothing about", () => {
    const [op] = buildGiftUpsertOps(
      mergeGiftActions([giftItem({})], [], CTX, PRICES)
    );
    const stage = (op as any).updateOne.update[0].$set;

    expect(stage).not.toHaveProperty("authorChannelId");
    expect(stage).not.toHaveProperty("isReplay");
  });

  it("writes a computed amount and omits the field when the price is unknown", () => {
    const [priced] = buildGiftUpsertOps(
      mergeGiftActions([], [giftTicker()], CTX, PRICES)
    );
    expect((priced as any).updateOne.update[0].$set.amount).toBe(10);

    const [unpriced] = buildGiftUpsertOps(
      mergeGiftActions([], [giftTicker()], CTX, new Map())
    );
    // Leaving the field out preserves whatever an earlier write worked out.
    expect((unpriced as any).updateOne.update[0].$set).not.toHaveProperty(
      "amount"
    );
  });

  it("replaces the whole combo group behind one freshness test", () => {
    const [op] = buildGiftUpsertOps(
      mergeGiftActions(
        [
          giftItem({
            message: "comboed x8 Heart for 80 Jewels",
            jewelCount: 80,
            comboCount: 8,
            giftImageUrl: `${PREFIX}/heart.png=w640-h640`,
          }),
        ],
        [],
        CTX,
        PRICES
      )
    );
    const stage = (op as any).updateOne.update[0].$set;
    const expectedCondition = {
      $or: [
        NO_COMBO_YET,
        { $gt: [8, { $ifNull: ["$comboCount", 1] }] },
        {
          $and: [
            { $eq: [8, { $ifNull: ["$comboCount", 1] }] },
            { $eq: [{ $ifNull: ["$jewelCount", null] }, null] },
          ],
        },
      ],
    };

    // All four move together — a stored jewelCount=10 paired with an incoming
    // comboCount=8 would make the price rebuild compute 10/8.
    for (const field of [
      "message",
      "jewelCount",
      "comboCount",
      "hasGiftImageUrl",
    ]) {
      expect(stage[field].$cond[0]).toEqual(expectedCondition);
      expect(stage[field].$cond[2]).toBe(`$${field}`);
    }
    expect(stage.message.$cond[1]).toEqual({
      $literal: "comboed x8 Heart for 80 Jewels",
    });
    expect(stage.jewelCount.$cond[1]).toEqual({ $literal: 80 });
  });

  it("clears combo fields the newer delivery does not carry", () => {
    const [op] = buildGiftUpsertOps(
      mergeGiftActions(
        [giftItem({ message: "sent Star", jewelCount: undefined })],
        [],
        CTX,
        PRICES
      )
    );
    const stage = (op as any).updateOne.update[0].$set;

    expect(stage.jewelCount.$cond[1]).toBe("$$REMOVE");
    expect(stage.comboCount.$cond[1]).toBe("$$REMOVE");
  });

  it("writes combo state onto a document that has none yet", () => {
    // A first delivery with no jewel figure ties on combo size against an
    // empty document, so without the empty-document clause the raw message
    // would never be stored at all — including every message the gift text
    // pattern failed to parse.
    const [op] = buildGiftUpsertOps(
      mergeGiftActions(
        [
          giftItem({
            message: "ギフトを贈りました",
            giftName: undefined,
            jewelCount: undefined,
          }),
        ],
        [],
        CTX,
        PRICES
      )
    );
    const stage = (op as any).updateOne.update[0].$set;

    expect(stage.message.$cond[0].$or).toContainEqual(NO_COMBO_YET);
    expect(stage.message.$cond[1]).toEqual({ $literal: "ギフトを贈りました" });
    expect(stage.hasGiftImageUrl.$cond[0].$or).toContainEqual(NO_COMBO_YET);
    expect(stage.hasGiftImageUrl.$cond[1]).toEqual({ $literal: false });
  });

  it("never lets a ticker-only write touch the combo group", () => {
    const [op] = buildGiftUpsertOps(
      mergeGiftActions([], [giftTicker()], CTX, PRICES)
    );
    const stage = (op as any).updateOne.update[0].$set;

    for (const field of [
      "message",
      "jewelCount",
      "comboCount",
      "hasGiftImageUrl",
    ]) {
      expect(stage).not.toHaveProperty(field);
    }
  });

  it("adds the jewel-figure tiebreak only when it states one", () => {
    const [withFigure] = buildGiftUpsertOps(
      mergeGiftActions([giftItem({})], [], CTX, PRICES)
    );
    expect(
      (withFigure as any).updateOne.update[0].$set.message.$cond[0].$or
    ).toHaveLength(3);

    const [withoutFigure] = buildGiftUpsertOps(
      mergeGiftActions(
        [giftItem({ message: "sent Star", jewelCount: undefined })],
        [],
        CTX,
        PRICES
      )
    );
    expect(
      (withoutFigure as any).updateOne.update[0].$set.message.$cond[0].$or
    ).toHaveLength(2);
  });
});

// Asserting the generated pipeline shape does not prove what a document ends
// up looking like, and there is no MongoDB in this test suite. This evaluates
// the handful of operators the builder emits so the write sequences below can
// be checked against real resulting state.
const MISSING = Symbol("missing");

function evalExpr(expr: unknown, doc: Record<string, unknown>): unknown {
  if (typeof expr === "string") {
    if (expr === "$$REMOVE") return MISSING;
    if (expr.startsWith("$")) {
      const value = doc[expr.slice(1)];
      return value === undefined ? MISSING : value;
    }
    return expr;
  }
  if (expr === null || typeof expr !== "object") return expr;
  const [op, arg] = Object.entries(expr as Record<string, unknown>)[0];
  const operands = () => (arg as unknown[]).map((a) => evalExpr(a, doc));
  const nullish = (v: unknown) => (v === MISSING ? null : v);
  switch (op) {
    case "$literal":
      return arg;
    case "$ifNull": {
      const [value, fallback] = operands();
      return value === MISSING || value === null ? fallback : value;
    }
    case "$cond": {
      const [condition, whenTrue, whenFalse] = arg as unknown[];
      return evalExpr(evalExpr(condition, doc) ? whenTrue : whenFalse, doc);
    }
    case "$or":
      return (arg as unknown[]).some((a) => evalExpr(a, doc) === true);
    case "$and":
      return (arg as unknown[]).every((a) => evalExpr(a, doc) === true);
    case "$eq": {
      const [a, b] = operands();
      return nullish(a) === nullish(b);
    }
    case "$gt": {
      const [a, b] = operands();
      return (a as number) > (b as number);
    }
    default:
      throw new Error(`unsupported operator ${op}`);
  }
}

/**
 * Apply one generated op to a document. Every expression reads the pre-update
 * document, matching how a single `$set` stage evaluates.
 */
function applyOp(
  doc: Record<string, unknown> | undefined,
  op: unknown
): Record<string, unknown> {
  const { filter, update } = (op as any).updateOne;
  // On insert MongoDB seeds the document from the filter's equality conditions.
  const before = { ...(doc ?? filter) };
  const after = { ...before };
  for (const [field, expr] of Object.entries(update[0].$set)) {
    const value = evalExpr(expr, before);
    if (value === MISSING) delete after[field];
    else after[field] = value;
  }
  return after;
}

function opFor(
  items: AddGiftItemAction[],
  tickers: AddGiftTickerAction[],
  priceTable = PRICES
) {
  return buildGiftUpsertOps(
    mergeGiftActions(items, tickers, CTX, priceTable)
  )[0];
}

describe("applying gift upserts in sequence", () => {
  it("converges a ticker-only write and a later item onto one document", () => {
    const afterTicker = applyOp(undefined, opFor([], [giftTicker()]));
    const afterItem = applyOp(
      afterTicker,
      opFor(
        [
          giftItem({
            message: "comboed x4 Heart for 40 Jewels",
            jewelCount: 40,
            comboCount: 4,
            giftImageUrl: `${PREFIX}/heart.png=w640-h640`,
          }),
        ],
        []
      )
    );

    expect(afterItem.id).toBe("gift-1");
    // The ticker's exclusive fields survive the item write.
    expect(afterItem.authorChannelId).toBe("UCsender");
    expect(afterItem.timestamp).toEqual(new Date("2026-08-09T00:00:05.000Z"));
    expect(afterItem.message).toBe("comboed x4 Heart for 40 Jewels");
    expect(afterItem.hasGiftImageUrl).toBe(true);
    // A unit price, never the wave's 40.
    expect(afterItem.amount).toBe(10);
  });

  it("stores an unparsed message onto a document a ticker created", () => {
    const afterTicker = applyOp(undefined, opFor([], [giftTicker()]));
    const afterItem = applyOp(
      afterTicker,
      opFor(
        [
          giftItem({
            message: "ギフトを贈りました",
            giftName: undefined,
            jewelCount: undefined,
          }),
        ],
        []
      )
    );

    expect(afterItem.message).toBe("ギフトを贈りました");
    expect(afterItem.hasGiftImageUrl).toBe(false);
  });

  it("swaps the whole combo group instead of mixing two deliveries", () => {
    const first = applyOp(
      undefined,
      opFor(
        [giftItem({ message: "sent Heart for 10 Jewels", jewelCount: 10 })],
        []
      )
    );
    expect(first.jewelCount).toBe(10);
    expect(first.comboCount).toBeUndefined();

    const second = applyOp(
      first,
      opFor(
        [
          giftItem({
            message: "comboed x8 Heart for 80 Jewels",
            jewelCount: 80,
            comboCount: 8,
          }),
        ],
        []
      )
    );

    // Keeping the old 10 next to the new 8 would make the rebuild learn 1.25.
    expect({
      jewelCount: second.jewelCount,
      comboCount: second.comboCount,
    }).toEqual({ jewelCount: 80, comboCount: 8 });
    expect(second.message).toBe("comboed x8 Heart for 80 Jewels");
  });

  it("takes a wave summary that arrives after an amount-less first delivery", () => {
    const star = `${PREFIX}/star.png=w640-h640`;
    const first = applyOp(
      undefined,
      opFor(
        [
          giftItem({
            message: "sent Star",
            giftName: "Star",
            jewelCount: undefined,
            giftImageUrl: star,
          }),
        ],
        []
      )
    );
    expect(first.jewelCount).toBeUndefined();
    expect(first.amount).toBe(2);

    const second = applyOp(
      first,
      opFor(
        [
          giftItem({
            message: "comboed x4 Star for 8 Jewels",
            giftName: "Star",
            jewelCount: 8,
            comboCount: 4,
            giftImageUrl: star,
          }),
        ],
        []
      )
    );

    expect({
      jewelCount: second.jewelCount,
      comboCount: second.comboCount,
    }).toEqual({ jewelCount: 8, comboCount: 4 });
    // Still one gift's worth, not the wave's 8.
    expect(second.amount).toBe(2);
  });

  it("fills an amount in later and never wipes one already worked out", () => {
    const noPrices = new Map<string, number>();

    const unpriced = applyOp(undefined, opFor([], [giftTicker()], noPrices));
    expect(unpriced.amount).toBeUndefined();

    const priced = applyOp(unpriced, opFor([giftItem({})], []));
    expect(priced.amount).toBe(10);

    const stillPriced = applyOp(priced, opFor([], [giftTicker()], noPrices));
    expect(stillPriced.amount).toBe(10);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/components/gift.spec.ts -t "buildGiftUpsertOps"`
Expected: FAIL，`buildGiftUpsertOps is not a function`（動態 import 解構出
`undefined`）。

- [ ] **Step 3: 寫最小實作**

在 `src/components/gift.ts` 的 import 區加入：

```ts
import type { mongo } from "mongoose";
import type { Gift } from "../models/Gift.js";
```

並在檔案末端追加：

```ts
// Driven by an `as const` tuple of `keyof Gift` so a renamed field breaks the
// build instead of silently writing nothing at runtime.
const GIFT_COMPLEMENT_FIELDS = [
  "timestamp",
  "authorName",
  "authorPhoto",
  "authorChannelId",
  "authorType",
  "giftName",
  "image",
  "assetName",
  "currency",
  "originVideoId",
  "originChannelId",
  "isReplay",
] as const satisfies readonly (keyof Gift)[];

const GIFT_COMBO_FIELDS = [
  "message",
  "jewelCount",
  "comboCount",
  "hasGiftImageUrl",
] as const satisfies readonly (keyof Gift)[];

function buildGiftUpdateStage(upsert: GiftUpsert): Record<string, unknown> {
  const stage: Record<string, unknown> = {};

  // Whoever writes first wins; a later write only fills the gaps it can. Every
  // value goes through `$literal` because a raw string starting with `$` would
  // otherwise be read as a field path.
  for (const field of GIFT_COMPLEMENT_FIELDS) {
    const value = upsert.complement[field];
    if (value === undefined) continue;
    stage[field] = { $ifNull: [`$${field}`, { $literal: value }] };
  }

  // Recomputed on every write. Omitting the field when the price is unknown
  // preserves whatever an earlier write managed to work out.
  if (upsert.amount !== undefined) {
    stage.amount = upsert.amount;
  }

  if (upsert.combo) {
    const incomingCombo = upsert.combo.comboCount ?? 1;
    const storedCombo = { $ifNull: ["$comboCount", 1] };
    const isNewer = {
      $or: [
        // Nothing stored yet — this flag is written by every item delivery and
        // by nothing else, so its absence means the document has only ever
        // seen a ticker. Without this clause a first delivery carrying neither
        // a combo count nor a jewel figure would tie against the empty
        // document and store no combo state at all, losing the raw message.
        { $eq: [{ $ifNull: ["$hasGiftImageUrl", null] }, null] },
        { $gt: [incomingCombo, storedCombo] },
        // Same wave size: prefer the delivery that states a jewel figure.
        ...(upsert.combo.jewelCount != null
          ? [
              {
                $and: [
                  { $eq: [incomingCombo, storedCombo] },
                  { $eq: [{ $ifNull: ["$jewelCount", null] }, null] },
                ],
              },
            ]
          : []),
      ],
    };

    // These four are the price rebuild's input and only make sense together, so
    // they swap as one unit rather than each gap-filling on its own.
    for (const field of GIFT_COMBO_FIELDS) {
      const value = upsert.combo[field];
      stage[field] = {
        $cond: [
          isNewer,
          value === undefined ? "$$REMOVE" : { $literal: value },
          `$${field}`,
        ],
      };
    }
  }

  return stage;
}

/**
 * One `updateOne` per gift, as an aggregation pipeline so gap-filling and the
 * all-or-nothing combo swap happen in a single atomic update — replicas write
 * the same ids concurrently.
 */
export function buildGiftUpsertOps(
  upserts: GiftUpsert[]
): mongo.AnyBulkWriteOperation[] {
  return upserts.map((upsert) => ({
    updateOne: {
      // MongoDB seeds the inserted document from this equality condition, which
      // is where the new document's `id` comes from.
      filter: { id: upsert.id },
      update: [{ $set: buildGiftUpdateStage(upsert) }],
      upsert: true,
    },
  }));
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run test -- src/components/gift.spec.ts`
Expected: PASS，28 個 test 全綠。

- [ ] **Step 5: 確認編譯與 lint**

Run: `npm run build && npm run lint`
Expected: 皆成功。

- [ ] **Step 6: Commit**

```bash
git add src/components/gift.ts src/components/gift.spec.ts
git commit -m "feat(gift): build atomic pipeline upserts for gift documents"
```

---

### Task 8: `getGiftPriceTable`（雙層快取）

**Files:**

- Modify: `src/components/gift.ts`
- Modify: `src/components/gift.spec.ts`

**已確認的前提（不需要再查）**：cache-manager 6.1.1 的 `wrap()` 在
`remainingTtl` 低於 `refreshThreshold` 時，以
`coalesceAsync(...).then(...)` 觸發重載但**不 await**，並立刻 `return value`
回傳舊的快取值（`node_modules/cache-manager/dist/index.js` 的 `shouldRefresh`
分支）。也就是 refresh 在背景進行、讀取不會被 DB 往返卡住；只有快取完全未命中
時才會 `await fnc()`。下面的 TTL 取值以此為準。

- [ ] **Step 1: 加入快取存取函式**

在 `src/components/gift.ts` 的 import 區加入：

```ts
import GiftPriceModel from "../models/GiftPrice.js";
import { getCacheInstance } from "../modules/cache.js";
```

並在檔案末端追加：

```ts
const GIFT_PRICE_CACHE_KEY = "giftPriceTable";
// Bounds how long a worker keeps serving prices the manager has already
// rebuilt. The rebuild runs every 10 minutes, so 5 minutes means a newly
// learned price reaches every worker within one rebuild cycle.
const GIFT_PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
// Verified in cache-manager 6.1.1: crossing this threshold kicks off the reload
// as a detached promise and returns the cached value straight away, so pricing
// a gift never waits on the round-trip.
const GIFT_PRICE_CACHE_REFRESH_MS = 60 * 1000;

// Built on first use rather than at module load, so merely importing this file
// does not open a Redis connection in processes that never price a gift.
let giftPriceCache: ReturnType<typeof getCacheInstance> | undefined;

function getGiftPriceCache(): ReturnType<typeof getCacheInstance> {
  return (giftPriceCache ??= getCacheInstance({
    ttl: GIFT_PRICE_CACHE_TTL_MS,
    refreshThreshold: GIFT_PRICE_CACHE_REFRESH_MS,
    // CacheableMemory's sweep interval is never unref'd and would keep the
    // process alive; expired entries are still evicted lazily on read.
    checkInterval: 0,
  }));
}

/**
 * The whole `assetName -> price` table. Assets number in the hundreds, so one
 * round-trip for everything beats a lookup per gift.
 *
 * Cached as pairs rather than as a `Map`, because the Redis layer serialises
 * through JSON and a `Map` would come back as `{}`.
 */
export async function getGiftPriceTable(): Promise<Map<string, number>> {
  const entries = await getGiftPriceCache().wrap(
    GIFT_PRICE_CACHE_KEY,
    async () => {
      const docs = await GiftPriceModel.find(
        {},
        { assetName: 1, price: 1 },
        { readPreference: "secondaryPreferred" }
      );
      return docs.map((doc): [string, number] => [doc.assetName, doc.price]);
    }
  );
  return new Map(entries);
}
```

- [ ] **Step 2: 加上快取行為的測試**

在 `src/components/gift.spec.ts` 把動態 import 的解構加上 `getGiftPriceTable`：

```ts
const {
  buildGiftUpsertOps,
  deriveGiftAmount,
  getGiftPriceTable,
  mergeGiftActions,
  parseGiftAssetName,
} = await import("./gift.js");
```

並在檔案末端追加（`find` 是檔案開頭那個 `GiftPrice` model 的 fake）：

```ts
describe("getGiftPriceTable", () => {
  beforeEach(() => {
    find.mockReset();
  });

  it("rebuilds the map from stored rows and serves repeats from cache", async () => {
    find.mockResolvedValue([
      { assetName: "heart", price: 10 },
      { assetName: "star", price: 2 },
    ]);

    const first = await getGiftPriceTable();
    const second = await getGiftPriceTable();

    expect(first).toEqual(
      new Map([
        ["heart", 10],
        ["star", 2],
      ])
    );
    // Cached as pairs and rebuilt into a Map on the way out, because the Redis
    // layer serialises through JSON and a Map would come back as {}.
    expect(second).toEqual(first);
    expect(find).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: 執行測試確認通過**

Run: `npm run test -- src/components/gift.spec.ts`
Expected: PASS，29 個 test 全綠。

- [ ] **Step 4: 確認編譯與 lint 通過**

Run: `npm run build && npm run lint`
Expected: 皆成功。

- [ ] **Step 5: Commit**

```bash
git add src/components/gift.ts src/components/gift.spec.ts
git commit -m "feat(gift): cache the jewel price table for the worker"
```

---

### Task 9: worker 整合

**Files:**

- Modify: `src/commands/worker.ts:169`（`insertOptions` 附近的 import 區）
- Modify: `src/commands/worker.ts:234-240`（`handleActions` 開頭）
- Modify: `src/commands/worker.ts:833-843`（被註解掉的 ticker case 附近）

- [ ] **Step 1: 加入 import**

在 `src/commands/worker.ts` 的 import 區（`import ChatModel …` 那一組附近）加入：

```ts
import GiftModel from "../models/Gift.js";
import {
  buildGiftUpsertOps,
  getGiftPriceTable,
  mergeGiftActions,
} from "../components/gift.js";
```

- [ ] **Step 2: 在 `handleActions` 開頭建立批次狀態**

找到 `async function handleActions(actions: Action[]) {` 這一行，把開頭改成：

```ts
  async function handleActions(actions: Action[]) {
    const groupedActions = groupBy(actions, "type");
    const actionTypes = Object.keys(groupedActions) as Action["type"][];
    // Gifts ship no timestamp of their own when their id does not decode, so
    // fall back to one reading per batch rather than per document.
    const batchReceivedAt = new Date();
    // The loop below iterates per action type, but the item and the ticker of
    // one gift have to be written together — see the gift case.
    let giftBatchHandled = false;
```

- [ ] **Step 3: 新增 gift case**

在 switch 內，於被註解掉的 `// case "addSuperStickerTickerAction":` 那一組之後、`case "unknown": {` 之前插入：

```ts
          case "addGiftItemAction":
          case "addGiftTickerAction": {
            // Both types fall through to here, but one gift's item and ticker
            // must land in a single write: webhooks only fire on inserts, so
            // writing them separately would strand the ticker's
            // authorChannelId on an update nobody reads.
            if (giftBatchHandled) break;
            giftBatchHandled = true;

            const upserts = mergeGiftActions(
              groupedActions["addGiftItemAction"] ?? [],
              groupedActions["addGiftTickerAction"] ?? [],
              {
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                isReplay,
                receivedAt: batchReceivedAt,
              },
              await getGiftPriceTable()
            );
            const ops = buildGiftUpsertOps(upserts);
            if (ops.length > 0) {
              await GiftModel.bulkWrite(ops, insertOptions);
            }
            break;
          }
```

`insertOptions` 是既有的 `{ ordered: false }`，讓 replica 併發撞出的 `11000` 交給外層既有的 `MongoBulkWriteError` catch 吞掉。

- [ ] **Step 4: 確認編譯與 lint 通過**

Run: `npm run build && npm run lint`
Expected: 皆成功。若 `groupedActions["addGiftItemAction"]` 出現型別錯誤，代表 `groupBy` 的回傳型別只含當批出現過的 key —— 此時把兩次存取改為

```ts
const giftItems = groupedActions.addGiftItemAction ?? [];
const giftTickers = groupedActions.addGiftTickerAction ?? [];
```

再傳入 `mergeGiftActions`。

- [ ] **Step 5: 確認全部測試通過**

Run: `npm test`
Expected: PASS，既有測試無退化。

- [ ] **Step 6: Commit**

```bash
git add src/commands/worker.ts
git commit -m "feat(worker): collect gift item and ticker actions"
```

---

### Task 10: 價格重建決策函式

**Files:**

- Create: `src/components/gift-price.ts`
- Create: `src/components/gift-price.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

建立 `src/components/gift-price.spec.ts`：

```ts
/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { decideGiftPriceUpdate } from "./gift-price.js";

const observation = (price: number, count: number) => ({
  assetName: "heart",
  price,
  count,
  giftName: "Heart",
});

describe("decideGiftPriceUpdate", () => {
  it("takes the first observation of an unknown asset", () => {
    expect(decideGiftPriceUpdate(undefined, observation(10, 1))).toEqual({
      action: "insert",
      price: 10,
      sampleCount: 1,
    });
  });

  it("raises confidence with the highest single-run count, never a sum", () => {
    // Rebuilds rescan the same window, so a repeat run must not inflate this.
    expect(
      decideGiftPriceUpdate({ price: 10, sampleCount: 3 }, observation(10, 1))
    ).toEqual({ action: "confirm", sampleCount: 3 });
    expect(
      decideGiftPriceUpdate({ price: 10, sampleCount: 1 }, observation(10, 4))
    ).toEqual({ action: "confirm", sampleCount: 4 });
  });

  it("lets a single observation overturn an unbacked seed", () => {
    expect(
      decideGiftPriceUpdate({ price: 10, sampleCount: 1 }, observation(12, 1))
    ).toEqual({ action: "overwrite", price: 12, sampleCount: 1 });
  });

  it("treats a hand-entered price as an unbacked seed", () => {
    expect(
      decideGiftPriceUpdate(
        { price: 500, sampleCount: 0, manual: true },
        observation(400, 1)
      )
    ).toEqual({ action: "overwrite", price: 400, sampleCount: 1 });
    // A hand-inserted row may never have gone through mongoose's default.
    expect(
      decideGiftPriceUpdate({ price: 500, manual: true }, observation(400, 1))
    ).toEqual({ action: "overwrite", price: 400, sampleCount: 1 });
  });

  it("makes a backed price cost the same weight of evidence to replace", () => {
    expect(
      decideGiftPriceUpdate({ price: 10, sampleCount: 2 }, observation(12, 1))
    ).toEqual({ action: "keep" });
    expect(
      decideGiftPriceUpdate({ price: 10, sampleCount: 2 }, observation(12, 2))
    ).toEqual({ action: "overwrite", price: 12, sampleCount: 2 });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/components/gift-price.spec.ts`
Expected: FAIL，找不到模組 `./gift-price.js`。

- [ ] **Step 3: 寫最小實作**

建立 `src/components/gift-price.ts`：

```ts
export interface GiftPriceObservation {
  assetName: string;
  /** Jewels per single gift, from a wave summary's total divided by its size. */
  price: number;
  /** How many documents in this window support this price. */
  count: number;
  giftName?: string;
}

export type GiftPriceDecision =
  | { action: "insert"; price: number; sampleCount: number }
  | { action: "confirm"; sampleCount: number }
  | { action: "overwrite"; price: number; sampleCount: number }
  | { action: "keep" };

/**
 * What this window's observation should do to the stored price.
 *
 * The first observation of a brand-new asset takes effect immediately — having
 * a price beats having none — but it is only an unbacked seed that any single
 * disagreeing observation can overturn. Once one rebuild has seen two
 * observations agree, replacing the price costs the same weight of evidence.
 * Without that tiering, one anomalous parse would pin a wrong price on an asset
 * forever, and `giftprices` is never cleaned.
 *
 * A hand-entered price sits in the unbacked tier (its `sampleCount` is 0) and
 * gets no exemption: a price that can never be corrected automatically would
 * silently stay wrong after YouTube repriced the asset.
 */
export function decideGiftPriceUpdate(
  existing:
    | { price: number; sampleCount?: number; manual?: boolean }
    | undefined,
  observation: GiftPriceObservation
): GiftPriceDecision {
  if (!existing) {
    return {
      action: "insert",
      price: observation.price,
      sampleCount: observation.count,
    };
  }
  if (existing.price === observation.price) {
    return {
      action: "confirm",
      sampleCount: Math.max(existing.sampleCount ?? 0, observation.count),
    };
  }
  const isBacked = (existing.sampleCount ?? 0) >= 2;
  if (isBacked && observation.count < 2) {
    return { action: "keep" };
  }
  return {
    action: "overwrite",
    price: observation.price,
    sampleCount: observation.count,
  };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run test -- src/components/gift-price.spec.ts`
Expected: PASS，5 個 test 全綠。

- [ ] **Step 5: Commit**

```bash
git add src/components/gift-price.ts src/components/gift-price.spec.ts
git commit -m "feat(gift-price): tier price overwrites by how well the stored value is backed"
```

---

### Task 11: 價格重建 job

**Files:**

- Modify: `src/components/gift-price.ts`
- Modify: `src/components/gift-price.spec.ts`
- Modify: `src/commands/manager.ts:1-26`

- [ ] **Step 1: 寫失敗的測試**

把 `src/components/gift-price.spec.ts` 的開頭（第 1–3 行）換成：

```ts
/// <reference types="jest" />
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

type PriceRow = {
  assetName: string;
  price: number;
  sampleCount?: number;
  manual?: boolean;
  giftName?: string;
};

const store = new Map<string, PriceRow>();
const aggregate =
  jest.fn<(pipeline: Record<string, unknown>[]) => Promise<unknown[]>>();

// A stateful stand-in for the collection: writes have to be observable by the
// next read, otherwise the idempotency test proves nothing.
const bulkWrite = jest.fn(async (ops: any[]) => {
  for (const op of ops) {
    const key = op.updateOne.filter.assetName;
    const current = store.get(key);
    const next: PriceRow = { ...(current ?? op.updateOne.update.$setOnInsert) };
    Object.assign(next, op.updateOne.update.$set);
    for (const field of Object.keys(op.updateOne.update.$unset ?? {})) {
      delete next[field as keyof PriceRow];
    }
    store.set(key, next);
  }
});

const find = jest.fn(async () => Array.from(store.values()));

jest.unstable_mockModule("../models/Gift.js", () => ({
  default: { aggregate },
}));
jest.unstable_mockModule("../models/GiftPrice.js", () => ({
  default: { find, bulkWrite },
}));

const { decideGiftPriceUpdate, rebuildGiftPrices } =
  await import("./gift-price.js");
```

並在檔案末端追加：

```ts
// Rows come back in whatever order the group stage produced; picking the
// winner must not depend on that order.
function windowRows(
  rows: { assetName: string; price: number; count: number; giftName?: string }[]
) {
  aggregate.mockResolvedValue(
    rows.map((row) => ({
      _id: { assetName: row.assetName, price: row.price },
      count: row.count,
      giftName: row.giftName ?? "Heart",
    }))
  );
}

describe("rebuildGiftPrices", () => {
  beforeEach(() => {
    store.clear();
    aggregate.mockReset();
    bulkWrite.mockClear();
    find.mockClear();
  });

  it("learns a price for an asset it has never seen", async () => {
    windowRows([{ assetName: "heart", price: 10, count: 3 }]);

    await rebuildGiftPrices();

    expect(store.get("heart")).toEqual({
      assetName: "heart",
      price: 10,
      sampleCount: 3,
      giftName: "Heart",
    });
  });

  it("keeps the most-supported price when a window disagrees with itself", async () => {
    windowRows([
      { assetName: "heart", price: 7, count: 1 },
      { assetName: "heart", price: 10, count: 5 },
    ]);

    await rebuildGiftPrices();

    expect(store.get("heart")?.price).toBe(10);
  });

  it("leaves everything untouched when rerun over an unchanged window", async () => {
    windowRows([{ assetName: "heart", price: 10, count: 3 }]);
    await rebuildGiftPrices();
    const afterFirst = { ...store.get("heart")! };

    await rebuildGiftPrices();

    expect(store.get("heart")).toEqual(afterFirst);
  });

  it("never forgets an asset that is absent from this window", async () => {
    store.set("kami", { assetName: "kami", price: 300, sampleCount: 2 });
    windowRows([{ assetName: "heart", price: 10, count: 1 }]);

    await rebuildGiftPrices();

    expect(store.get("kami")).toEqual({
      assetName: "kami",
      price: 300,
      sampleCount: 2,
    });
  });

  it("clears the manual flag once observations back the value", async () => {
    store.set("kami", {
      assetName: "kami",
      price: 300,
      sampleCount: 0,
      manual: true,
    });
    windowRows([{ assetName: "kami", price: 300, count: 2, giftName: "Kami" }]);

    await rebuildGiftPrices();

    expect(store.get("kami")).toEqual({
      assetName: "kami",
      price: 300,
      sampleCount: 2,
      giftName: "Kami",
    });
  });

  it("corrects a stale hand-entered price from a single observation", async () => {
    store.set("kami", {
      assetName: "kami",
      price: 500,
      sampleCount: 0,
      manual: true,
    });
    windowRows([{ assetName: "kami", price: 300, count: 1, giftName: "Kami" }]);

    await rebuildGiftPrices();

    expect(store.get("kami")).toMatchObject({ price: 300, sampleCount: 1 });
    expect(store.get("kami")).not.toHaveProperty("manual");
  });

  it("does not write at all when the window yields nothing", async () => {
    windowRows([]);

    await rebuildGiftPrices();

    expect(bulkWrite).not.toHaveBeenCalled();
  });

  it("only learns from deliveries whose own chat item carried the image", async () => {
    windowRows([]);

    await rebuildGiftPrices();

    // A document whose assetName came from a ticker can hold a unit price in
    // jewelCount, and dividing that by comboCount would learn a price several
    // times too low — so the sweep must never see those documents at all.
    const [pipeline] = aggregate.mock.calls[0] as [Record<string, unknown>[]];
    expect(pipeline[0].$match).toEqual({
      hasGiftImageUrl: true,
      assetName: { $exists: true },
      jewelCount: { $exists: true },
      comboCount: { $gt: 0 },
    });
  });

  it("orders the sweep so the recorded display name is the latest one", async () => {
    windowRows([]);

    await rebuildGiftPrices();

    // `$last: "$giftName"` only means "most recently seen" if the documents
    // arrive at the group stage in time order.
    const [pipeline] = aggregate.mock.calls[0] as [Record<string, unknown>[]];
    expect(pipeline[1]).toEqual({ $sort: { timestamp: 1 } });
    expect((pipeline[2] as any).$group.giftName).toEqual({
      $last: "$giftName",
    });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run test -- src/components/gift-price.spec.ts`
Expected: FAIL，`rebuildGiftPrices is not a function`。

- [ ] **Step 3: 寫最小實作**

在 `src/components/gift-price.ts` 的最上方加入 import：

```ts
import assert from "node:assert";
import type { mongo } from "mongoose";
import GiftModel from "../models/Gift.js";
import GiftPriceModel from "../models/GiftPrice.js";
import { setIfDefine } from "../util.js";
import type { Application } from "../modules/application.js";
import type { AgendaModule } from "../modules/schedule.js";
```

並在檔案末端追加：

```ts
// A price can only be read off a wave summary, and gifts are deleted two hours
// after their stream ends, so the window has to be swept often enough that an
// observation is not lost before it is ever seen.
const GIFT_PRICE_REBUILD_INTERVAL = "10 minutes";

export default function giftPrice(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  agenda.define("gift price rebuild", rebuildGiftPrices);
  void agenda.every(GIFT_PRICE_REBUILD_INTERVAL, "gift price rebuild");
}

/**
 * Unit prices supported by the documents currently in the collection, one entry
 * per asset: whichever price the most documents agree on.
 *
 * `hasGiftImageUrl: true` is load-bearing. An asset name can also come from a
 * ticker's sticker url, and on those documents `jewelCount` may be a unit price
 * rather than a wave total — dividing it would learn a price several times too
 * low and the cache would spread that to every later gift.
 */
export async function collectGiftPriceObservations(): Promise<
  GiftPriceObservation[]
> {
  const rows = await GiftModel.aggregate<{
    _id: { assetName: string; price: number };
    count: number;
    giftName?: string;
  }>(
    [
      {
        $match: {
          hasGiftImageUrl: true,
          assetName: { $exists: true },
          jewelCount: { $exists: true },
          comboCount: { $gt: 0 },
        },
      },
      // `$last` below only means "the most recently observed display name" if
      // the documents reach the group stage in time order; without this sort
      // it would pick whatever the storage engine happened to emit last.
      { $sort: { timestamp: 1 } },
      {
        $group: {
          _id: {
            assetName: "$assetName",
            price: { $divide: ["$jewelCount", "$comboCount"] },
          },
          count: { $sum: 1 },
          giftName: { $last: "$giftName" },
        },
      },
    ],
    { readPreference: "secondaryPreferred" }
  );

  const best = new Map<string, GiftPriceObservation>();
  for (const row of rows) {
    const { assetName, price } = row._id;
    const current = best.get(assetName);
    // Most-supported price wins. The lower price settles a tie so that
    // rerunning over an unchanged window always lands on the same value —
    // relying on the group stage's output order would not.
    if (
      current &&
      (current.count > row.count ||
        (current.count === row.count && current.price <= price))
    ) {
      continue;
    }
    best.set(assetName, {
      assetName,
      price,
      count: row.count,
      giftName: row.giftName,
    });
  }
  return Array.from(best.values());
}

/**
 * Fold this window's observations into the price table.
 *
 * Only ever adds or corrects: gifts are pruned two hours after a stream ends,
 * so recomputing the table from the window would wipe every asset that nobody
 * happened to send lately.
 *
 * Plain update operators rather than an aggregation pipeline — a pipeline
 * update skips mongoose's schema defaults and `createdAt`, and this job has no
 * concurrent writer (Agenda's lock admits one instance), so read-then-write is
 * safe and the tiering reads better in TypeScript than in `$cond`.
 */
export async function rebuildGiftPrices(): Promise<void> {
  const observations = await collectGiftPriceObservations();
  if (observations.length === 0) return;

  // The whole table, not just the assets in this window: it is the same few
  // hundred rows the worker already caches, and reading it in one go keeps the
  // tiering decisions in plain TypeScript.
  const existingDocs = await GiftPriceModel.find(
    {},
    { assetName: 1, price: 1, sampleCount: 1, manual: 1 },
    { readPreference: "secondaryPreferred" }
  );
  const existingByAsset = new Map(
    existingDocs.map((doc) => [doc.assetName, doc])
  );

  const bulk: mongo.AnyBulkWriteOperation[] = [];
  for (const observation of observations) {
    const existing = existingByAsset.get(observation.assetName);
    const decision = decideGiftPriceUpdate(existing, observation);

    if (decision.action === "keep") {
      console.log(
        `<!> [GIFT PRICE] keeping ${observation.assetName} at ${existing?.price}; ` +
          `${observation.count} observation(s) suggested ${observation.price}`
      );
      continue;
    }
    if (decision.action === "overwrite") {
      console.log(
        `<!> [GIFT PRICE] ${observation.assetName} ${existing?.price} -> ` +
          `${decision.price} (${observation.count} observation(s))`
      );
    }

    bulk.push({
      updateOne: {
        filter: { assetName: observation.assetName },
        update: {
          $set: {
            ...(decision.action === "confirm" ? {} : { price: decision.price }),
            sampleCount: decision.sampleCount,
            ...setIfDefine("giftName", observation.giftName),
          },
          $setOnInsert: { assetName: observation.assetName },
          // Observations now back this value, so it is no longer hand-entered.
          $unset: { manual: "" },
        },
        upsert: true,
      },
    });
  }

  if (bulk.length > 0) {
    await GiftPriceModel.bulkWrite(bulk);
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run test -- src/components/gift-price.spec.ts`
Expected: PASS，14 個 test 全綠。

- [ ] **Step 5: 在 manager 註冊這個 component**

修改 `src/commands/manager.ts`，在 import 區加入（維持字母順序，放在 `cleanup` 之後）：

```ts
import giftPrice from "../components/gift-price.js";
```

並在 `runManager()` 中，於 `videoStats(app);` 之前加入：

```ts
giftPrice(app);
```

- [ ] **Step 6: 確認編譯、lint 與全部測試通過**

Run: `npm run build && npm run lint && npm test`
Expected: 皆成功。

- [ ] **Step 7: Commit**

```bash
git add src/components/gift-price.ts src/components/gift-price.spec.ts src/commands/manager.ts
git commit -m "feat(gift-price): rebuild the jewel price table from observed combo waves"
```

---

### Task 12: VideoStats 整合

**Files:**

- Modify: `src/components/video-stats.ts:1-27`（import 區）
- Modify: `src/components/video-stats.ts:34-68`（`messageTypes`）

- [ ] **Step 1: 加入 import**

在 `src/components/video-stats.ts` 的 model import 群組中（`import ChatModel …` 之後）加入：

```ts
import GiftModel from "../models/Gift.js";
```

- [ ] **Step 2: 新增 messageTypes 項目**

在 `messageTypes` 陣列的 `MessageType.SuperSticker` 項目之後追加：

```ts
  {
    messageType: MessageType.Gift,
    model: GiftModel,
    // Jewels are not a fiat currency, so no jpy conversion; and authorChannelId
    // is missing on all but the highest-priced gifts, so no user counts.
    calcAmount: true,
  },
```

`message_total` 與 `purchase_amount_total` 兩條 cron 因此自動產生。Gift 文件固定帶 `authorType = "other"` 與 `currency = "JEWEL"`，所以 `labels` 與 `metrics.ts` 的 `authorType` 守衛都不需要改動。

- [ ] **Step 3: 確認編譯與 lint 通過**

Run: `npm run build && npm run lint`
Expected: 皆成功。

- [ ] **Step 4: 確認全部測試通過**

Run: `npm test`
Expected: PASS，既有測試無退化。

- [ ] **Step 5: Commit**

```bash
git add src/components/video-stats.ts
git commit -m "feat(video-stats): count gifts and total their jewel amounts"
```

---

### Task 13: cleanup 整合

**Files:**

- Modify: `src/components/cleanup.ts:1-22`（import 區）
- Modify: `src/components/cleanup.ts:35-48`（`cleanVideos`）

- [ ] **Step 1: 加入 import**

在 `src/components/cleanup.ts` 的 model import 群組中（`import Chat from "../models/Chat.js";` 之後）加入：

```ts
import Gift from "../models/Gift.js";
```

- [ ] **Step 2: 在 `cleanVideos` 加入刪除**

在 `cleanVideos` 內，於 `await Chat.deleteMany(...)` 之前插入一行：

```ts
await Gift.deleteMany({ originVideoId: { $in: videoIds } });
```

`giftprices` 不刪 —— 它是跨直播累積的知識庫，不屬於任何一支影片。

- [ ] **Step 3: 確認編譯、lint 與全部測試通過**

Run: `npm run build && npm run lint && npm test`
Expected: 皆成功。

- [ ] **Step 4: Commit**

```bash
git add src/components/cleanup.ts
git commit -m "feat(cleanup): drop gift documents alongside the other messages"
```

---

### Task 14: webhook / track / DM 整合

**Files:**

- Modify: `src/data/track.ts:132-139`、`src/data/track.ts:157-164`、`src/data/track.ts:224-231`
- Modify: `src/components/youtube-dm-operator.ts:11-18`
- Modify: `src/data/webhook.ts:66-79`
- Modify: `src/data/webhook.ts:539-563`

- [ ] **Step 1: 在三個 chat preset 的 `colls` 加入 gifts**

在 `src/data/track.ts` 中，`chats`、`chatsOtherChannels`、`followedChats` 三個 preset 的 `colls` 陣列，於 `"superstickers"` 之後各加入一行 `"gifts",`。例如 `chats`：

```ts
          colls: [
            ...(withoutNormalChats ? [] : ["chats"]),
            "superchats",
            "superstickers",
            "gifts",
            "memberships",
            "milestones",
            "membershipgiftpurchases",
            "membershipgifts",
          ],
```

**`moderatorChats` 不要加。** 它 match `isModerator: true`，而 gift 文件沒有任何 badge 欄位，永遠不會命中 —— 加進去只會白開一條 change stream，再對每一筆 gift 做無用的比對。

`"gifts"` 不受 `withoutNormalChats` 影響，比照 `"superchats"` 恆包含。

- [ ] **Step 2: 在 DM_COLLS 加入 gifts**

在 `src/components/youtube-dm-operator.ts` 的 `DM_COLLS`，於 `"superstickers"` 之後加入：

```ts
const DM_COLLS = [
  "superchats",
  "superstickers",
  "gifts",
  "memberships",
  "milestones",
  "membershipgiftpurchases",
  "membershipgifts",
];
```

- [ ] **Step 3: 在 `getMessage()` 加入 gifts 分支**

在 `src/data/webhook.ts` 的 `getMessage()` 中，於 `if (parameters.collection === "superstickers")` 之前插入：

```ts
if (parameters.collection === "gifts") {
  // Only reached for ticker-only documents; anything with a chat item has
  // already returned its raw text above.
  return parameters.giftName ? `送出了 ${parameters.giftName}` : "送出了禮物";
}
```

- [ ] **Step 4: 在 embed fields 加入 gifts 分支**

在 `src/data/webhook.ts` 的 `discord-embed-chats` 模板中，把整段 fields 三元
判斷（從 `...(["superchats", "superstickers"].includes(...)` 起，到與 `footer:`
相鄰的 `: {}),` 為止）**整段換成**下面這段：

```ts
          ...(["superchats", "superstickers"].includes(parameters.collection)
            ? {
                fields: [
                  {
                    name:
                      parameters.collection === "superchats"
                        ? "SuperChat"
                        : "SuperSticker",
                    value: `${parameters.currency} ${parameters.amount}, ${parameters.color}, tier ${parameters.significance}`,
                    inline: true,
                  },
                ],
              }
            : parameters.collection === "gifts"
              ? {
                  fields: [
                    {
                      name: "Gift",
                      value: parameters.amount
                        ? `${parameters.giftName ?? "Gift"}, ${parameters.amount} Jewels`
                        : (parameters.giftName ?? "Gift"),
                      inline: true,
                    },
                  ],
                }
              : parameters.collection === "milestones"
                ? {
                    fields: [
                      {
                        name: "Milestone",
                        value: `${
                          parameters.level ? `${parameters.level}, ` : ""
                        }since ${parameters.since}`,
                        inline: true,
                      },
                    ],
                  }
                : {}),
```

`milestones` 分支的內容與原本完全相同，只是往內縮了一層。`parameters.image`
已是通用處理，禮物圖會自動出現在 embed。

- [ ] **Step 5: 確認編譯、lint、format 與全部測試通過**

Run: `npm run build && npm run lint && npm run format:check && npm test`
Expected: 皆成功。若 `format:check` 失敗，執行 `npm run format` 後重跑。

- [ ] **Step 6: Commit**

```bash
git add src/data/track.ts src/components/youtube-dm-operator.ts src/data/webhook.ts
git commit -m "feat(webhook): route gift documents to track and dm subscriptions"
```

---

## 完成後的整體驗證

- [ ] **Step 1: 全套驗證**

Run: `npm run build && npm run lint && npm run format:check && npm test`
Expected: 全部通過。

- [ ] **Step 2: 確認規格引用沒有洩漏進程式碼**

Run:

```bash
grep -nE '§|\bspec\b|\bplan\b|Task [0-9]|Layer [0-9]' src/components/gift.ts src/components/gift-price.ts src/models/Gift.ts src/models/GiftPrice.ts src/components/gift.spec.ts src/components/gift-price.spec.ts
```

Expected: 無輸出。

- [ ] **Step 3: 部署後確認 partial index 真的建起來了**

只有這一項需要一個實際跑起來的環境，因此擺在最後而不是綁在 Task 2 上。

`autoIndex` 失敗時 mongoose 會吞掉錯誤，程式會以為索引存在而照常運作 —— 唯一
的徵兆是價格重建的掃描退化成全表掃。服務啟動後在 MongoDB 上執行：

```js
db.gifts.getIndexes();
```

Pass 條件：輸出含有 `assetName_1`，其 `partialFilterExpression` 與 model 宣告的
四個條件一致；且服務啟動日誌**沒有** `[mongoose] autoIndex failed for gifts`
（這行警告來自 `attachIndexWarningListeners()`）。任一條不符就停下來處理，不要
帶著缺索引上線。
