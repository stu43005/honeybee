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
