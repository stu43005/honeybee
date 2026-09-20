import { XMLParser } from "fast-xml-parser";

export interface VideoEntry {
  type: "video";
  videoId: string;
  channelId: string;
  title: string;
  link?: string;
  channelName?: string;
  published?: Date;
  updated?: Date;
}

export interface DeletedEntry {
  type: "deleted";
  videoId?: string;
}

export type NotificationEntry = VideoEntry | DeletedEntry;

const DELETED_REF_PREFIX = "yt:video:";

// removeNSPrefix turns yt:videoId / at:deleted-entry into videoId /
// deleted-entry; ignoreAttributes: false is what exposes a link's href;
// parseTagValue: false keeps every text node a string, otherwise a title or id
// like "2026" would arrive as a number.
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  parseTagValue: false,
});

// A repeated element is an array and a single one is an object, so both shapes
// have to go down the same path.
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object" && "#text" in value) {
    return text((value as Record<string, unknown>)["#text"]);
  }
  return undefined;
}

function date(value: unknown): Date | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Parses the body of one PubSubHubbub notification into an array of entries.
 * Returns null when the body is not a feed (or not well-formed XML).
 *
 * Video entries come first, in feed order, and deletions follow: the two are
 * different element names, so their original interleaving cannot be recovered
 * after parsing.
 */
export function parseNotification(xml: string): NotificationEntry[] | null {
  let parsed: unknown;
  try {
    // The second argument is the validation switch. Passing true validates with
    // default options and throws on malformed input; omitting it skips
    // validation entirely, and an unclosed or mismatched document would then be
    // parsed into a plausible-looking result.
    parsed = parser.parse(xml, true);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const feed = (parsed as Record<string, unknown>).feed;
  if (!feed || typeof feed !== "object") return null;
  const feedObject = feed as Record<string, unknown>;

  const entries: NotificationEntry[] = [];

  for (const raw of asArray(feedObject.entry)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const videoId = text(entry.videoId);
    const channelId = text(entry.channelId);
    const title = text(entry.title);
    // Without these three there is no valid video document to write (title is
    // required and an empty string fails the validator), so skipping beats
    // writing a document that can never be saved again.
    if (!videoId || !channelId || !title) continue;
    const author = (entry.author ?? {}) as Record<string, unknown>;
    const link = (asArray(entry.link)[0] ?? {}) as Record<string, unknown>;
    entries.push({
      type: "video",
      videoId,
      channelId,
      title,
      link: text(link["@_href"]),
      channelName: text(author.name),
      published: date(entry.published),
      updated: date(entry.updated),
    });
  }

  for (const raw of asArray(feedObject["deleted-entry"])) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const ref = text(entry["@_ref"]);
    entries.push({
      type: "deleted",
      videoId: ref?.startsWith(DELETED_REF_PREFIX)
        ? ref.slice(DELETED_REF_PREFIX.length)
        : undefined,
    });
  }

  return entries;
}
