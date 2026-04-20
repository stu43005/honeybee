import type { DocumentType } from "@typegoose/typegoose";
import { isEqual } from "lodash";
import { WEBHOOK_RESULT_FOLLOW_TTL_MS } from "../../constants.js";
import type { Webhook } from "../../models/Webhook.js";
import WebhookResultModel from "../../models/WebhookResult.js";

export type WebhookResultIdentifier = {
  webhookId: string;
  coll: string;
  docId: string;
};

export type ClaimDecision =
  | { action: "send" }
  | { action: "skip"; reason: string };

/**
 * Idempotent claim for a webhook delivery. Upserts a WebhookResult record
 * keyed by (webhookId, coll, docId) and decides whether the current event
 * should actually be sent, based on prior delivery state:
 *
 *   - If upsertedCount === 1 (fresh insert): action = "send"
 *   - If existing record has a non-null `response`:
 *       - For a non-followUpdate webhook: action = "skip"
 *         (the target has already been notified; further events are duplicates)
 *       - For a followUpdate webhook with identical body: action = "skip"
 *         (body unchanged since last successful send, no reason to re-send)
 *       - For a followUpdate webhook with different body: action = "send"
 *   - If existing record has no response yet (stall recovery or concurrent
 *     in-flight worker): action = "send"
 *
 * method/url/body are written in $setOnInsert to satisfy the WebhookResult
 * schema's required:true constraint on these fields. They are ALSO re-written
 * in the post-send $set performed by sendDiscordWebhook / sendWebhook so that
 * subsequent followUpdate comparisons use the LAST sent body, not the body
 * that happened to trigger the first insert. Without the post-send re-write,
 * every follow-update event would compare against the same original body and
 * deduplication would break after the second event.
 *
 * A conservative fallback `expireAt` is set on insert so that records created
 * by this upsert but never followed by a successful send (e.g. the HTTP call
 * fails and is never retried) are eventually reclaimed by the TTL index
 * rather than accumulating indefinitely.
 */
export async function claimWebhookResult(
  webhook: DocumentType<Webhook>,
  resultIdentifier: WebhookResultIdentifier,
  method: string,
  url: string,
  body: unknown
): Promise<ClaimDecision> {
  const fallbackExpireAt = new Date(Date.now() + WEBHOOK_RESULT_FOLLOW_TTL_MS);

  const updateResult = await WebhookResultModel.updateOne(
    resultIdentifier,
    {
      $setOnInsert: {
        ...resultIdentifier,
        method,
        url,
        body,
        expireAt: fallbackExpireAt,
      },
    },
    { upsert: true }
  );

  if (updateResult.upsertedCount === 1) {
    // Fresh insert, never seen — go ahead and send
    return { action: "send" };
  }

  const existing = await WebhookResultModel.findOne(resultIdentifier)
    .lean()
    .exec();

  if (existing?.response) {
    if (!webhook.followUpdate) {
      return { action: "skip", reason: "already-sent-non-follow" };
    }
    if (isEqual(existing.body, body)) {
      return { action: "skip", reason: "follow-update-body-unchanged" };
    }
    // follow-update, body changed → proceed
  }
  // no response yet (stall recovery) → proceed
  return { action: "send" };
}
