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
