import { setTimeout as sleep } from "node:timers/promises";
import {
  PUBSUB_RENEW_BATCH_SIZE,
  PUBSUB_REQUEST_SPACING_MS,
} from "../../constants.js";
import ChannelModel from "../../models/Channel.js";
import { requestSubscription } from "./hub-client.js";

/**
 * One renewal round: pick the channels whose subscription is near expiry (or
 * was never established) and send a subscribe request for each.
 *
 * The batch size and the per-request timeout together bound the worst-case time
 * spent on hub requests well below agenda's lockLifetime, which is why this
 * needs no job.touch(). That bound covers the hub side only: the candidate
 * query and the timestamp writes wait on MongoDB, which has no operation
 * timeout configured anywhere in this project.
 */
export async function renewPubsubSubscriptions(): Promise<void> {
  const candidates = await ChannelModel.findPubsubRenewalCandidates(
    PUBSUB_RENEW_BATCH_SIZE
  );

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];

    // Stamped before the request goes out: the hub sometimes verifies before it
    // answers the POST, and stamping first is what keeps a legitimate
    // verification inside the accepted window. It is also written regardless of
    // the outcome, so a channel that always fails drops to the back of the
    // queue instead of holding the front of it and starving real renewals.
    await ChannelModel.updateOne(
      { id: channel.id },
      { $set: { pubsubRequestedAt: new Date() } }
    );
    console.log(`Subscribing: [${channel.id}] ${channel.name}`);

    const result = await requestSubscription(channel.id);
    if (!result.ok) {
      if (result.kind === "throttled") {
        // Throttling is usually global, so continuing would only keep failing.
        // The remaining candidates are left for the next round.
        console.warn(
          `Pubsub subscribe throttled at [${channel.id}] (status=${result.status}); stopping this round`
        );
        return;
      }
      console.warn(
        `Pubsub subscribe failed for [${channel.id}] (${result.kind}): ${result.message}`
      );
      continue;
    }

    if (index < candidates.length - 1) {
      await sleep(PUBSUB_REQUEST_SPACING_MS);
    }
  }
}
