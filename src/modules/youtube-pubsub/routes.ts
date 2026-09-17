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
} from "../../constants.js";
import ChannelModel from "../../models/Channel.js";
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

// The callback plugin form, not an async one: an async plugin that never awaits
// fails @typescript-eslint/require-await, which lint treats as an error.
// `fastify.register(pubsubRoutes)` still returns a thenable either way.
export const pubsubRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  fastify.get<{ Params: TokenParams; Querystring: HubQuery }>(
    "/notifications/youtube/:token",
    handleVerification
  );

  done();
};
