/// <reference types="jest" />
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
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
const {
  buildGiftUpsertOps,
  deriveGiftAmount,
  getGiftPriceTable,
  mergeGiftActions,
  parseGiftAssetName,
} = await import("./gift.js");

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
    // The ticker chip's own renderer id, deliberately different from the id
    // the gift is keyed by — that one lives on `contents`.
    id: "ticker-chip-1",
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
    // Keyed by the gift's id, not by the ticker chip's own renderer id.
    expect(merged[0].id).toBe("gift-1");
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
