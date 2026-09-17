import axios from "axios";
import assert from "node:assert";
import crypto from "node:crypto";
import {
  PUBLIC_BASE_URL,
  PUBSUB_REQUEST_TIMEOUT_MS,
  YOUTUBE_PUBSUB_SECRET,
} from "../../constants.js";

const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const TOPIC_PREFIX = "https://www.youtube.com/xml/feeds/videos.xml?channel_id=";

/**
 * Every variant carries its own literal `kind`, so impossible combinations
 * cannot be constructed: only `throttled` has the two statuses that mean "back
 * off", and `timeout` / `network` have no status at all because no response
 * arrived.
 */
export type SubscribeResult =
  | { ok: true }
  | { ok: false; kind: "throttled"; status: 429 | 503; message: string }
  | { ok: false; kind: "http"; status: number; message: string }
  | { ok: false; kind: "timeout"; message: string }
  | { ok: false; kind: "network"; message: string };

export function topicForChannel(channelId: string): string {
  return `${TOPIC_PREFIX}${channelId}`;
}

export function channelIdFromTopic(topic: string | undefined): string | null {
  if (!topic || !topic.startsWith(TOPIC_PREFIX)) return null;
  const channelId = topic.slice(TOPIC_PREFIX.length);
  return channelId.length > 0 ? channelId : null;
}

/**
 * The hub's verification GET carries no signature, so the only thing that can
 * authenticate it is something unguessable that we put into the callback URL
 * ourselves and the hub echoes back verbatim. Derived from the existing secret,
 * so this needs no new environment variable.
 */
export function getCallbackToken(): string {
  assert(YOUTUBE_PUBSUB_SECRET, "YOUTUBE_PUBSUB_SECRET should be defined.");
  return crypto
    .createHmac("sha256", YOUTUBE_PUBSUB_SECRET)
    .update("pubsub-callback")
    .digest("hex")
    .slice(0, 32);
}

export function getCallbackUrl(): string {
  assert(PUBLIC_BASE_URL, "PUBLIC_BASE_URL should be defined.");
  return new URL(
    `./notifications/youtube/${getCallbackToken()}`,
    PUBLIC_BASE_URL
  ).toString();
}

/**
 * Sends one subscribe request. Every failure is caught and classified here, so
 * the caller always gets a value back: an unhandled rejection would be taken by
 * the process-wide unhandledRejection handler, which exits.
 */
export async function requestSubscription(
  channelId: string
): Promise<SubscribeResult> {
  try {
    assert(YOUTUBE_PUBSUB_SECRET, "YOUTUBE_PUBSUB_SECRET should be defined.");
    // Building the form is inside the try as well: getCallbackUrl() throws a
    // TypeError when PUBLIC_BASE_URL is not a valid URL, and that also has to
    // come back as a value rather than propagate.
    const form = new URLSearchParams({
      "hub.callback": getCallbackUrl(),
      "hub.mode": "subscribe",
      "hub.topic": topicForChannel(channelId),
      "hub.secret": YOUTUBE_PUBSUB_SECRET,
    });

    await axios.post(HUB_URL, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: PUBSUB_REQUEST_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        return { ok: false, kind: "timeout", message: error.message };
      }
      const status = error.response?.status;
      if (status === undefined) {
        return { ok: false, kind: "network", message: error.message };
      }
      if (status === 429 || status === 503) {
        return { ok: false, kind: "throttled", status, message: error.message };
      }
      return { ok: false, kind: "http", status, message: error.message };
    }
    return {
      ok: false,
      kind: "network",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
