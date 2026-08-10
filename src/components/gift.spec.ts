/// <reference types="jest" />
import { describe, expect, it, jest } from "@jest/globals";
import type {
  AddGiftItemAction,
  AddGiftTickerAction,
} from "@stu43005/masterchat";
import { MessageAuthorType } from "../interfaces.js";

// Read at module load by src/constants.ts, so it has to be set before anything
// pulls the cache module in. Empty keeps getCacheInstance memory-only.
process.env.REDIS_URI = "";

const find = jest.fn<() => Promise<{ assetName: string; price: number }[]>>();

jest.unstable_mockModule("../models/GiftPrice.js", () => ({
  default: { find },
}));

// Dynamic import so the mock above is registered first — the project's ESM
// Jest setup has no hoisted jest.mock.
const { deriveGiftAmount, mergeGiftActions, parseGiftAssetName } =
  await import("./gift.js");

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
