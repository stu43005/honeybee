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
