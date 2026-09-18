import { setTimeout as sleep } from "node:timers/promises";
import {
  YOUTUBE_DISCOVERY_REQUEST_SPACING_MS,
  YOUTUBE_MEMBERS_POLL_BATCH_SIZE,
  YOUTUBE_MEMBERS_PROBE_BATCH_SIZE,
  YOUTUBE_MEMBERS_PROBE_RETRY_MS,
  YOUTUBE_MEMBERS_PROBE_TTL_MS,
} from "../../constants.js";
import ChannelModel from "../../models/Channel.js";
import { updateVideoFromPlaylist } from "../../modules/youtube.js";
import { probePlaylist, type OembedResult } from "./oembed.js";

/**
 * A channel's members-only uploads playlist id. YouTube derives it from the
 * channel id: UC<suffix> owns UU<suffix> for public uploads and UUMO<suffix>
 * for members-only ones.
 */
function membersPlaylistId(channelId: string): string {
  return `UUMO${channelId.slice(2)}`;
}

/**
 * Phase one: find out which channels have a members-only playlist at all.
 * Costs no quota, so it can run over every subscribed channel; its whole
 * purpose is to keep the quota-spending phase below from wasting slots on
 * channels that have no such playlist.
 */
async function probeRound(now: Date): Promise<number> {
  const candidates = await ChannelModel.findMembersProbeCandidates(
    YOUTUBE_MEMBERS_PROBE_BATCH_SIZE,
    now
  );

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];

    // probePlaylist classifies its own failures into a result, but catching
    // anyway keeps an unexpected throw from skipping the deadline write below.
    // Without a deadline the channel stays at the head of the queue and
    // reclaims a probe slot every round.
    let result: OembedResult = {
      kind: "unknown",
      message: "probe did not run",
    };
    try {
      result = await probePlaylist(membersPlaylistId(channel.id));
      // Neither an answer nor a thrown error — log it, or a sustained oEmbed
      // outage (every candidate coming back inconclusive) looks identical to a
      // quiet round where nothing new showed up.
      if (result.kind !== "present" && result.kind !== "absent") {
        console.warn(
          `Members probe for [${channel.id}] was inconclusive (${result.kind})` +
            (result.kind === "unknown" ? `: ${result.message}` : "")
        );
      }
    } catch (error) {
      console.warn(`Members probe failed for [${channel.id}]:`, error);
    }

    // The deadline carries the answer's shelf life. Only `present` and
    // `absent` are answers, and they are good for a week because whether a
    // channel offers memberships almost never changes.
    //
    // Everything else — a malformed-id 400, a 5xx, a timeout — taught us
    // nothing, so it may only defer the question by an hour and must leave
    // any existing verdict alone. Both halves matter: the scan phase ignores
    // channels without a `true` verdict, so a week-long deferral would hide a
    // channel's members-only videos for a week after one transient failure,
    // and on first rollout every channel takes exactly that path. Writing a
    // verdict here instead would be worse still — repeated failures could
    // keep renewing an expired "no memberships" answer indefinitely.
    const conclusive = result.kind === "present" || result.kind === "absent";
    const update: { membersProbeNextAt: Date; hasMembersPlaylist?: boolean } =
      conclusive
        ? {
            membersProbeNextAt: new Date(
              now.getTime() + YOUTUBE_MEMBERS_PROBE_TTL_MS
            ),
            hasMembersPlaylist: result.kind === "present",
          }
        : {
            membersProbeNextAt: new Date(
              now.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS
            ),
          };

    try {
      await ChannelModel.updateOne({ id: channel.id }, { $set: update });
    } catch (error) {
      console.warn(`Members probe could not stamp [${channel.id}]:`, error);
    }

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }

  return candidates.length;
}

/**
 * Phase two: read the members-only playlists. This is the only part of the
 * discovery subsystem that spends quota, one unit per channel, which is why the
 * batch size alone determines the daily cost.
 */
async function scanRound(now: Date): Promise<void> {
  const candidates = await ChannelModel.findMembersPollCandidates(
    YOUTUBE_MEMBERS_POLL_BATCH_SIZE
  );

  for (let index = 0; index < candidates.length; index++) {
    const channel = candidates[index];
    let outOfQuota = false;

    try {
      const result = await updateVideoFromPlaylist(
        membersPlaylistId(channel.id)
      );

      if (!result.ok && result.kind === "quotaExceeded") {
        // Quota is global state: every remaining channel would fail the same
        // way, so the round stops after this one.
        console.warn(
          `Members poll stopped at [${channel.id}]: ${result.message}`
        );
        outOfQuota = true;
      } else if (!result.ok) {
        console.warn(
          `Members poll failed for [${channel.id}] (${result.kind}): ${result.message}`
        );
      }
    } catch (error) {
      // updateVideoFromPlaylist classifies API failures into a result, but it
      // can still throw before it gets there — getYoutubeApi() asserts on a
      // missing key, for one. Catching separately is what lets the stamp below
      // still run.
      console.warn(`Members poll failed for [${channel.id}]:`, error);
    }

    // Its own try, outside the one above. This channel was attempted and its
    // unit is already spent — quota failures included — so it must move to the
    // back of the rotation like any other; only channels never reached keep
    // their place at the front. Its own failure must not escape either, or one
    // rejected write would end the round.
    try {
      await ChannelModel.updateOne(
        { id: channel.id },
        { $set: { membersCrawledAt: now } }
      );
    } catch (error) {
      console.warn(`Members poll could not stamp [${channel.id}]:`, error);
    }

    if (outOfQuota) return;

    if (index < candidates.length - 1) {
      await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
    }
  }
}

/** One members round: probe for playlists that exist, then read the known ones. */
export async function pollMembersPlaylists(): Promise<void> {
  const now = new Date();
  const probed = await probeRound(now);
  // The two phases hit different hosts but share this process's outbound
  // budget, so the gap applies across the seam too when both actually sent
  // something.
  if (probed > 0) await sleep(YOUTUBE_DISCOVERY_REQUEST_SPACING_MS);
  await scanRound(now);
}
