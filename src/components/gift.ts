import type {
  AddGiftItemAction,
  AddGiftTickerAction,
} from "@stu43005/masterchat";
import { MessageAuthorType } from "../interfaces.js";

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
