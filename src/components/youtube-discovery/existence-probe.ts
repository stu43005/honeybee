import { VideoStatus } from "holodex.js";
import { setTimeout as sleep } from "node:timers/promises";
import {
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE,
} from "../../constants.js";
import VideoModel from "../../models/Video.js";
import { probeVideo } from "./oembed.js";

/**
 * One existence-probe round over both buckets.
 *
 * Only videos YouTube stopped returning are probed. The other way a video ends
 * up Missing is a timeout heuristic — a stream that never started, or one that
 * stopped without being ended — and those videos are still on YouTube, so an
 * existence probe would answer 200 every single time, flip them back to New,
 * and have the state machine put them straight back to Missing. Those go
 * through `crawler youtube update`'s candidate list instead, where videos.list
 * can actually see whether the stream changed.
 */
export async function probeMissingVideos(): Promise<void> {
  // One `now` for both queries, so the two buckets are split on exactly the
  // same boundary and no video can fall between them.
  const now = new Date();
  // Two buckets, because videos that vanished long ago vastly outnumber recent
  // ones and a single query would let them take every slot.
  const buckets = await Promise.all([
    VideoModel.findExistenceProbeCandidates(
      true,
      YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE,
      now
    ),
    VideoModel.findExistenceProbeCandidates(
      false,
      YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE,
      now
    ),
  ]);
  const candidates = buckets.flat();

  for (let index = 0; index < candidates.length; index++) {
    const video = candidates[index];

    // Only a 200 is evidence the video came back. Everything else — still
    // missing, malformed id, unanswered question, or a probe that threw — means
    // the same thing here: nothing to restore, so just move it to the back of
    // the rotation.
    let restore = false;
    try {
      restore = (await probeVideo(video.id)).kind === "present";
    } catch (error) {
      console.warn(`Existence probe failed for [${video.id}]:`, error);
    }

    // Pinned to the state the query returned. A probe takes a round trip, and
    // in that window pubsub can request a re-hydration or another path can
    // restore the video; writing unconditionally would erase either one. No
    // match means somebody else got there first with a newer view, so the
    // result is simply dropped rather than retried.
    const filter = {
      id: video.id,
      status: VideoStatus.Missing,
      deleted: true,
      crawledAt: video.crawledAt,
    };

    try {
      await VideoModel.updateOne(
        filter,
        restore
          ? {
              // Back to New with no crawledAt, which is how the existing
              // crawler job is asked to hydrate it.
              $set: { status: VideoStatus.New, crawledAt: null },
              $unset: { deleted: "", detectedDeletionAt: "" },
            }
          : { $set: { crawledAt: new Date() } }
      );
    } catch (error) {
      // Its own guard: a rejected write must not end the round and cost every
      // remaining candidate its turn.
      console.warn(`Existence probe could not write [${video.id}]:`, error);
    }

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}
