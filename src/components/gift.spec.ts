/// <reference types="jest" />
import { describe, expect, it, jest } from "@jest/globals";

// Read at module load by src/constants.ts, so it has to be set before anything
// pulls the cache module in. Empty keeps getCacheInstance memory-only.
process.env.REDIS_URI = "";

const find = jest.fn<() => Promise<{ assetName: string; price: number }[]>>();

jest.unstable_mockModule("../models/GiftPrice.js", () => ({
  default: { find },
}));

// Dynamic import so the mock above is registered first — the project's ESM
// Jest setup has no hoisted jest.mock.
const { deriveGiftAmount, parseGiftAssetName } = await import("./gift.js");

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
