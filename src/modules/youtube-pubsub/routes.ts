import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import crypto from "node:crypto";
import {
  PUBSUB_DEFAULT_LEASE_MS,
  PUBSUB_MAX_LEASE_MS,
  PUBSUB_REQUEST_COOLDOWN_MS,
  YOUTUBE_PUBSUB_SECRET,
} from "../../constants.js";
import ChannelModel from "../../models/Channel.js";
import VideoModel from "../../models/Video.js";
import { updateVideoFromYoutube } from "../youtube.js";
import { parseNotification } from "./atom.js";
import { channelIdFromTopic, getCallbackToken } from "./hub-client.js";

type TokenParams = { token: string };

type HubQuery = {
  "hub.mode"?: string;
  "hub.topic"?: string;
  "hub.challenge"?: string;
  "hub.lease_seconds"?: string;
};

function tokenMatches(candidate: string): boolean {
  const expected = Buffer.from(getCallbackToken());
  const actual = Buffer.from(candidate ?? "");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * The lease the hub reports is only used once validated: a bogus value must not
 * be able to push a channel out of renewal indefinitely.
 */
function leaseMsFrom(raw: string | undefined): number {
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return PUBSUB_DEFAULT_LEASE_MS;
  }
  return Math.min(seconds * 1000, PUBSUB_MAX_LEASE_MS);
}

async function handleVerification(
  request: FastifyRequest<{ Params: TokenParams; Querystring: HubQuery }>,
  reply: FastifyReply
): Promise<void> {
  if (!tokenMatches(request.params.token)) {
    console.warn("Pubsub verification with an unknown callback token");
    reply.code(404).type("text/plain").send("not found");
    return;
  }

  const mode = request.query["hub.mode"];
  const channelId = channelIdFromTopic(request.query["hub.topic"]);

  if (mode === "denied") {
    // Logged only: pubsubRequestedAt has already been stamped, and the cooldown
    // is the back-off.
    console.warn(`Pubsub subscription denied: ${channelId ?? "unknown topic"}`);
    reply.code(200).type("text/plain").send("ok");
    return;
  }

  // This service never unsubscribes on purpose, so an unsubscribe verification
  // is not something we should confirm.
  if (mode !== "subscribe" || !channelId) {
    console.warn(
      `Pubsub verification rejected (mode=${mode ?? "none"}, topic=${
        request.query["hub.topic"] ?? "none"
      })`
    );
    reply.code(404).type("text/plain").send("not found");
    return;
  }

  // Only channels we really asked about recently are accepted: this GET carries
  // no signature, so the request window is the only thing that correlates it
  // with a subscription we initiated.
  const channel = await ChannelModel.findOne({
    id: channelId,
    pubsubRequestedAt: {
      $gte: new Date(Date.now() - PUBSUB_REQUEST_COOLDOWN_MS),
    },
  });
  if (!channel) {
    console.warn(
      `Pubsub verification for an unrequested channel: ${channelId}`
    );
    reply.code(404).type("text/plain").send("not found");
    return;
  }

  const challenge = request.query["hub.challenge"] ?? "";
  // Answer the challenge first, store the expiry after. The other order leaves
  // a stored expiry for a subscription the hub never established whenever the
  // response fails to arrive, and the WebSub protocol does not require a hub to
  // retry a verification.
  reply.code(200).type("text/plain").send(challenge);

  const expiresAt = new Date(
    Date.now() + leaseMsFrom(request.query["hub.lease_seconds"])
  );
  try {
    await ChannelModel.updateOne(
      { id: channelId },
      { $set: { pubsubExpiresAt: expiresAt } }
    );
    console.log(
      `Subscribed: ${channelId} (expires=${expiresAt.toISOString()})`
    );
  } catch (error) {
    // A failed write only means this channel gets renewed once more after the
    // cooldown, which the hub handles idempotently.
    console.warn(`Pubsub expiry write failed for ${channelId}:`, error);
  }
}

/**
 * Recomputes the HMAC of the delivered body with hub.secret and compares it
 * with X-Hub-Signature. The algorithm comes from the header (`sha1=` /
 * `sha256=`); an algorithm we cannot construct counts as a mismatch.
 */
function signatureMatches(header: string, body: string): boolean {
  if (!YOUTUBE_PUBSUB_SECRET) return false;
  const separator = header.indexOf("=");
  if (separator <= 0) return false;
  const algorithm = header.slice(0, separator).toLowerCase();
  const signature = header.slice(separator + 1).toLowerCase();

  let digest: string;
  try {
    digest = crypto
      .createHmac(algorithm, YOUTUBE_PUBSUB_SECRET)
      .update(body)
      .digest("hex");
  } catch {
    return false;
  }

  const expected = Buffer.from(digest, "hex");
  const actual = Buffer.from(signature, "hex");
  if (actual.length === 0 || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

async function handleNotification(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const body = typeof request.body === "string" ? request.body : "";
  const signature = request.headers["x-hub-signature"];

  if (typeof signature !== "string" || signature.length === 0) {
    console.warn("Pubsub notification without a signature");
    reply.code(403).type("text/plain").send("forbidden");
    return;
  }
  if (!signatureMatches(signature, body)) {
    // 200 rather than 4xx: a non-2xx only makes the hub retry the same
    // notification up to its own limit (a failed delivery does not unsubscribe
    // us), and an invalid notification can never become valid.
    console.warn("Pubsub notification signature mismatch");
    reply.code(200).type("text/plain").send("ok");
    return;
  }

  const entries = parseNotification(body);
  if (!entries) {
    console.warn("Pubsub notification body is not a feed");
    reply.code(200).type("text/plain").send("ok");
    return;
  }

  // First phase: touch the database only, and write every video in the body.
  const newVideoIds: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "video") continue;
    try {
      const result = await VideoModel.noticeFromNotification({
        video: { id: entry.videoId, title: entry.title },
        channel: { id: entry.channelId },
      });
      const channelLabel = entry.channelName
        ? `${entry.channelName} (${entry.channelId})`
        : entry.channelId;
      if (result.upsertedCount > 0) {
        console.log(
          `Pubsub: ${channelLabel} new video: [${entry.videoId}] ${entry.title}`
        );
        newVideoIds.push(entry.videoId);
      } else if (result.modifiedCount > 0) {
        console.log(
          `Pubsub: ${channelLabel} already seen this video: [${entry.videoId}] ${entry.title}`
        );
      }
    } catch (error) {
      // 500 so the hub redelivers. Nothing else rediscovers an ordinary upload
      // that never reached the videos collection: every candidate query needs
      // the document to exist already, and the Holodex polls only cover
      // streams. Redelivery is safe because noticeFromNotification upserts.
      console.error(
        `Pubsub notification write failed for [${entry.videoId}]:`,
        error
      );
      reply.code(500).type("text/plain").send("write failed");
      return;
    }
  }

  reply.code(200).type("text/plain").send("ok");

  // Second phase, after the response: fetch metadata for the new videos. This
  // awaits the YouTube Data API, and inside the loop above one slow call would
  // keep later entries out of the database. It must be caught as well — an
  // unhandled rejection after the response would still exit the process.
  if (newVideoIds.length > 0) {
    try {
      await updateVideoFromYoutube(newVideoIds);
    } catch (error) {
      console.warn(
        `Pubsub metadata fetch failed for [${newVideoIds.join(", ")}]:`,
        error
      );
    }
  }
}

// The callback plugin form, not an async one: an async plugin that never awaits
// fails @typescript-eslint/require-await, which lint treats as an error.
// `fastify.register(pubsubRoutes)` still returns a thenable either way.
export const pubsubRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  // With parseAs: "string" the parser's second argument is the raw body, and
  // whatever it hands to its own done() becomes request.body — passing the raw
  // string through is exactly what the HMAC has to be computed over, so no
  // separate rawBody is needed. The callback parser form is used because a
  // parser written as an async function with no await would fail
  // @typescript-eslint/require-await. Registered inside the scope that
  // register() creates, so it does not affect any other route.
  fastify.addContentTypeParser<string>(
    ["application/atom+xml", "text/xml"],
    { parseAs: "string" },
    (_request, body, parsed) => parsed(null, body)
  );

  fastify.get<{ Params: TokenParams; Querystring: HubQuery }>(
    "/notifications/youtube/:token",
    handleVerification
  );

  fastify.post("/notifications/youtube/:token", handleNotification);

  // The tokenless legacy path. Changing the callback URL makes the hub keep the
  // existing subscriptions alongside the new ones, and keeping this path is
  // what stops their deliveries from breaking the moment this ships. A delivery
  // authenticates itself with its signature, so this handler does not check the
  // token. Removable once every old lease has expired (at most 5 days).
  fastify.post("/notifications/youtube", handleNotification);

  done();
};
