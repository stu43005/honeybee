import type {
  AddGiftItemAction,
  AddGiftTickerAction,
} from "@stu43005/masterchat";
import type { mongo } from "mongoose";
import { MessageAuthorType } from "../interfaces.js";
import type { Gift } from "../models/Gift.js";
import GiftPriceModel from "../models/GiftPrice.js";
import { getCacheInstance } from "../modules/cache.js";

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
    id: (item?.id ?? contents?.id)!,
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
    // A ticker's own `id` belongs to the ticker chip renderer; the id it shares
    // with the chat item is the one on `contents`.
    const entry = byId.get(ticker.contents.id) ?? {};
    entry.ticker = ticker;
    byId.set(ticker.contents.id, entry);
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
