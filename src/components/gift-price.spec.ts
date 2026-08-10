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
