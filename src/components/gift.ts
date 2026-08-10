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
