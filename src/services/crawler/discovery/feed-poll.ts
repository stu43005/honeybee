import type { Job } from "agenda";
import axios from "axios";
import { setTimeout as sleep } from "node:timers/promises";
import {
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_FEED_POLL_ABORT_AFTER_FAILURES,
  YOUTUBE_FEED_POLL_ATTEMPTS,
  YOUTUBE_FEED_POLL_BATCH_SIZE,
  YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS,
  YOUTUBE_FEED_TIMEOUT_MS,
} from "#constants.js";
import ChannelModel from "#models/Channel.js";
import VideoModel, { type DiscoveredVideo } from "#models/Video.js";
import { parseNotification } from "../atom.js";

// Note the missing "/xml" compared with the pubsub topic url: that one is a
// static document describing the hub and carries no entries at all. This is the
// address of the real per-channel feed.
const FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";

/** One channel's feed read, and how many requests it took to get there. */
type FeedFetch =
  | { ok: true; body: string; attempts: number }
  | { ok: false; error: unknown; attempts: number };

// The server answered, and not with a 2xx. A timeout or a dropped connection
// rejects without a response.
function isHttpFailure(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response !== undefined;
}

/**
 * Reads one channel's feed, asking again after an http failure until
 * YOUTUBE_FEED_POLL_ATTEMPTS requests have been made.
 *
 * Every day around 01:00-07:00 UTC the feed's origin answers most requests with
 * 404 or 500, whoever sends them, and it fails request by request rather than
 * channel by channel, so asking again has a fair chance. The url stays as it is:
 * an edge cache hit is the one answer that stays reliable during the outage. A
 * timeout or a dropped connection is not asked again; it may already have taken
 * the whole timeout, and it is not what the outage looks like.
 */
async function fetchFeed(channelId: string): Promise<FeedFetch> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await axios.get<string>(`${FEED_URL}${channelId}`, {
        timeout: YOUTUBE_FEED_TIMEOUT_MS,
        // Without this axios would try to guess, and an XML body can come back
        // parsed into an object that the Atom parser cannot read.
        responseType: "text",
      });
      return { ok: true, body: response.data, attempts: attempt };
    } catch (error) {
      if (attempt >= YOUTUBE_FEED_POLL_ATTEMPTS || !isHttpFailure(error)) {
        return { ok: false, error, attempts: attempt };
      }
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}

// One line per failed channel, for its last attempt only. An http failure is
// reduced to its message: the rejected error carries the config, the request,
// the socket and the HTML error page Google served — around a hundred lines
// each — and the status line is all of it that says anything, while the daily
// outage brings these by the hundred. Anything else is a bug rather than the
// network, and its stack is the only way to place it.
function warnFailure(channelId: string, attempts: number, error: unknown) {
  console.warn(
    `Feed poll failed for [${channelId}] after ${attempts} attempts:`,
    axios.isAxiosError(error) ? error.message : error
  );
}

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
 * A run of channels that each used every attempt and still got an http failure
 * ends the round early. When the origin is refusing nearly everything, carrying
 * on would only spend the batch and the log on that. The channels left untried
 * keep their old stamp, so the next round starts with them.
 *
 * Retries make a round's length depend on how quickly failures come back, so
 * when agenda hands its `job` in, the lock is renewed between channels once a
 * minute has passed.
 */
export async function pollChannelFeeds(job?: Job): Promise<void> {
  // Taken before the candidate query: agenda's lock has been running since the
  // job started, and the query's time counts against it too.
  let touchedAt = Date.now();
  const candidates = await ChannelModel.findFeedPollCandidates(
    YOUTUBE_FEED_POLL_BATCH_SIZE
  );

  // Channels in a row whose last attempt came back with an http status. Only a
  // status says the feed's origin itself is refusing; a timeout or a dropped
  // connection says nothing about it, so those leave the count where it was.
  let consecutiveHttpFailures = 0;

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];

    if (Date.now() - touchedAt >= YOUTUBE_FEED_POLL_TOUCH_INTERVAL_MS) {
      // Not caught. agenda throws here once it has cancelled this run, and
      // going on would be work done without the lock. Channels already handled
      // are stamped and the rest lead the next round, as after an early stop.
      await job?.touch();
      touchedAt = Date.now();
    }

    const fetched = await fetchFeed(channel.id);
    if (fetched.ok) {
      // Any 2xx means the origin is serving us, whatever the body turns out to
      // be and whether or not the write below succeeds.
      consecutiveHttpFailures = 0;
      // One channel's failure must not cost the rest of the round theirs.
      try {
        const entries = parseNotification(fetched.body);
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
        warnFailure(channel.id, fetched.attempts, error);
      }
    } else {
      if (isHttpFailure(fetched.error)) {
        consecutiveHttpFailures++;
      }
      warnFailure(channel.id, fetched.attempts, fetched.error);
    }

    // Its own try, for two reasons. It must run even when the channel failed —
    // a channel that always fails would otherwise stay at the head of the
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
