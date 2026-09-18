import axios from "axios";
import { setTimeout as sleep } from "node:timers/promises";
import {
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_FEED_POLL_BATCH_SIZE,
  YOUTUBE_FEED_TIMEOUT_MS,
} from "../../constants.js";
import ChannelModel from "../../models/Channel.js";
import VideoModel, { type DiscoveredVideo } from "../../models/Video.js";
import { parseNotification } from "../../modules/youtube-pubsub/atom.js";

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
 */
export async function pollChannelFeeds(): Promise<void> {
  const candidates = await ChannelModel.findFeedPollCandidates(
    YOUTUBE_FEED_POLL_BATCH_SIZE
  );

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];
    try {
      const response = await axios.get<string>(`${FEED_URL}${channel.id}`, {
        timeout: YOUTUBE_FEED_TIMEOUT_MS,
        // Without this axios would try to guess, and an XML body can come back
        // parsed into an object that the Atom parser cannot read.
        responseType: "text",
      });
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
      // One channel's failure must not cost the rest of the round theirs.
      console.warn(`Feed poll failed for [${channel.id}]:`, error);
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

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}
