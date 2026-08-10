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
//
// Not `async`, even though the real methods are: an async body with no `await`
// trips `@typescript-eslint/require-await` (on via `recommendedTypeChecked`).
// The callers await the return either way, and awaiting a plain value resolves
// immediately.
const bulkWrite = jest.fn((ops: any[]) => {
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

const find = jest.fn(() => Array.from(store.values()));

jest.unstable_mockModule("../models/Gift.js", () => ({
  default: { aggregate },
}));
jest.unstable_mockModule("../models/GiftPrice.js", () => ({
  default: { find, bulkWrite },
}));

const { decideGiftPriceUpdate, rebuildGiftPrices } =
  await import("./gift-price.js");

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
