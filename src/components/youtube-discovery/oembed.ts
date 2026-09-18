import axios from "axios";
import { YOUTUBE_OEMBED_TIMEOUT_MS } from "../../constants.js";

const OEMBED_URL = "https://www.youtube.com/oembed";

/**
 * What one probe learned. The four outcomes are kept apart because the two
 * callers need different things from them:
 *
 * - `present` — 200, and only 200. The target is really there.
 * - `absent`  — 404. A real answer: YouTube will not serve this.
 * - `invalid` — 400. The id is malformed. Unreachable like `absent`, but it
 *   says nothing about whether a *well-formed* id would have existed, so the
 *   membership probe must not turn it into a lasting verdict.
 * - `unknown` — anything else, including transport failures. The question went
 *   unanswered; a failed request is not evidence that anything is gone.
 */
export type OembedResult =
  | { kind: "present" }
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "unknown"; message: string };

function oembedUrl(target: string): string {
  // URLSearchParams percent-encodes the nested "?v=" / "?list=", which a plain
  // template string would leave as a second query parameter.
  const params = new URLSearchParams({ url: target, format: "json" });
  return `${OEMBED_URL}?${params.toString()}`;
}

async function probe(target: string): Promise<OembedResult> {
  try {
    const response = await axios.get(oembedUrl(target), {
      timeout: YOUTUBE_OEMBED_TIMEOUT_MS,
      // Resolve for every status so the classification below is the single
      // place that decides, instead of axios throwing for some and not others.
      validateStatus: () => true,
    });
    // Exactly 200. This endpoint has only ever been observed answering 200 for
    // a reachable target, and treating some other 2xx as presence would
    // resurrect a video or grant a week-long positive verdict on no evidence.
    if (response.status === 200) return { kind: "present" };
    if (response.status === 404) return { kind: "absent" };
    if (response.status === 400) return { kind: "invalid" };
    return {
      kind: "unknown",
      message: `unexpected status ${response.status}`,
    };
  } catch (error) {
    // With validateStatus above, reaching here means no response arrived at
    // all — a timeout, DNS failure, socket reset.
    return {
      kind: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Whether a video is currently reachable on YouTube. */
export function probeVideo(videoId: string): Promise<OembedResult> {
  return probe(`https://www.youtube.com/watch?v=${videoId}`);
}

/** Whether a playlist exists and is publicly addressable. */
export function probePlaylist(playlistId: string): Promise<OembedResult> {
  return probe(`https://www.youtube.com/playlist?list=${playlistId}`);
}
