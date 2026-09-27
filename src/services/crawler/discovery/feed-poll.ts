import axios from "axios";
import { setTimeout as sleep } from "node:timers/promises";
import {
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES,
  YOUTUBE_FEED_POLL_BATCH_SIZE,
  YOUTUBE_FEED_TIMEOUT_MS,
} from "#constants.js";
import ChannelModel from "#models/Channel.js";
import VideoModel, { type DiscoveredVideo } from "#models/Video.js";
import { parseNotification } from "../atom.js";

// Note the missing "/xml" compared with the pubsub topic url: that one is a
// static document describing the hub and carries no entries at all. This is the
// address of the real per-channel feed.
const FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";

/**
 * One feed-poll round: take the least recently fetched channels, read each
 * one's RSS feed, and create whatever videos are new.
 *
 * The batch size is a constant rather than a function of how many channels are
 * subscribed. That is what makes the outbound request rate predictable: more
 * channels stretch the rotation instead of widening each round.
 *
 * Reuses the pubsub notification parser — a notification body and this feed are
 * the same Atom document, and every entry carries the videoId, channelId, title
 * and published time a document needs.
 *
 * A run of http failures ends the round early. Once the outbound address has
 * used up the feed's daily allowance every request answers 404 or 500 until
 * midnight Pacific time, and carrying on would only spend the batch and the log
 * on that. The channels left untried keep their old stamp, so the next round
 * starts with them.
 */
export async function pollChannelFeeds(): Promise<void> {
  const candidates = await ChannelModel.findFeedPollCandidates(
    YOUTUBE_FEED_POLL_BATCH_SIZE
  );

  // Failures in a row that came back with an http status. Only a status says
  // the feed backend itself is refusing; a timeout or a dropped connection says
  // nothing about it, so those leave the count where it was.
  let consecutiveHttpFailures = 0;

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];
    try {
      const response = await axios.get<string>(`${FEED_URL}${channel.id}`, {
        timeout: YOUTUBE_FEED_TIMEOUT_MS,
        // Without this axios would try to guess, and an XML body can come back
        // parsed into an object that the Atom parser cannot read.
        responseType: "text",
      });
      // Any 2xx means the backend is serving us, whatever the body turns out to
      // be and whether or not the write below succeeds.
      consecutiveHttpFailures = 0;
      const entries = parseNotification(response.data);
      if (!entries) {
        console.warn(`Feed poll: body is not a feed for [${channel.id}]`);
      } else {
        const discovered: DiscoveredVideo[] = entries.flatMap((entry) =>
          entry.type === "video"
            ? [
                {
                  videoId: entry.videoId,
                  title: entry.title,
                  channelId: entry.channelId,
                  publishedAt: entry.published,
                },
              ]
            : []
        );
        await VideoModel.noticeUnknownVideos(discovered);
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response !== undefined) {
        consecutiveHttpFailures++;
      }
      // One channel's failure must not cost the rest of the round theirs.
      //
      // An http failure is reduced to its message. The rejected error carries
      // the config, the request, the socket and the HTML error page Google
      // served — around a hundred lines each, and the status line is all of
      // it that says anything. Such failures arrive in bulk once the outbound
      // address has used up the feed's daily allowance; the early stop below is
      // what keeps that to a few lines per round. Anything else is a bug rather
      // than the network, and its stack is the only way to place it.
      console.warn(
        `Feed poll failed for [${channel.id}]:`,
        axios.isAxiosError(error) ? error.message : error
      );
    }

    // Its own try, for two reasons. It must run even when the block above threw
    // — a channel that always fails would otherwise stay at the head of the
    // rotation and consume a slot every round forever — and its own failure
    // must not escape either, or one rejected write would end the round and
    // skip every channel behind this one.
    try {
      await ChannelModel.updateOne(
        { id: channel.id },
        { $set: { feedCrawledAt: new Date() } }
      );
    } catch (error) {
      console.warn(`Feed poll could not stamp [${channel.id}]:`, error);
    }

    const remaining = candidates.length - index - 1;
    // Checked before the last-channel exit, so a batch that is refused all the
    // way through still says so rather than ending on its per-channel lines.
    if (consecutiveHttpFailures >= YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES) {
      console.warn(
        `Feed poll: stopping round after ${consecutiveHttpFailures} consecutive HTTP failures, ${remaining} channels deferred`
      );
      return;
    }
    if (remaining > 0) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}
