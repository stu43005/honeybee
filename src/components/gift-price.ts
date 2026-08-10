import assert from "node:assert";
import type { mongo } from "mongoose";
import GiftModel from "../models/Gift.js";
import GiftPriceModel from "../models/GiftPrice.js";
import { setIfDefine } from "../util.js";
import type { Application } from "../modules/application.js";
import type { AgendaModule } from "../modules/schedule.js";

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
 * observations agree, overturning the price takes two agreeing observations of
 * its own.
 *
 * The bar is that fixed count, not the stored `sampleCount` — `sampleCount`
 * only separates the unbacked tier from the backed one. Requiring a challenger
 * to out-count whatever the stored value accumulated would make a well
 * observed price nearly impossible to replace: gifts are pruned two hours
 * after a stream ends, so a window only ever holds recent observations and
 * their count tracks traffic. A repriced asset would then keep serving the old
 * price indefinitely, and nothing else ever corrects this table.
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
