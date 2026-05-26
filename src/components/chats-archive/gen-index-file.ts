import assert from "node:assert";
import fsp from "node:fs/promises";
import path from "node:path";
import moment from "moment";
import { VideoStatus } from "holodex.js";
import { CHAT_ARCHIVE_DIR } from "../../constants.js";
import VideoModel from "../../models/Video.js";
import { archiveVideo } from "./archive-video.js";
import { genChannelIndexFile } from "./gen-channel-index-file.js";
import { recalcVideoHbStats } from "../video-stats.js";
import { buildVideoSummary } from "./build-video-summary.js";

export async function genIndexFile({
  isDirect = false,
}: { isDirect?: boolean } = {}): Promise<void> {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");

  const channelIds = new Set<string>();
  const liveSummaries: Array<Record<string, unknown>> = [];
  const pastSummaries: Array<Record<string, unknown>> = [];

  for await (let video of VideoModel.findLiveVideos(48)
    .sort({ availableAt: 1 })
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    if (
      video.status === VideoStatus.Live &&
      !video.actualStart &&
      video.scheduledStart &&
      moment.tz("UTC").isAfter(moment(video.scheduledStart).add(2, "days"))
    )
      continue;

    if (isDirect) {
      await recalcVideoHbStats([video.id]);
      const updated = await VideoModel.findByVideoId(video.id);
      if (updated) video = updated;
    }
    channelIds.add(video.channelId);
    liveSummaries.push(await buildVideoSummary(video));
    if (isDirect) await archiveVideo(video.id, { isDirect: true });
  }

  for await (let video of VideoModel.findRecentlyEndedVideos(48)
    .sort({ availableAt: -1 })
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    if (
      video.status === VideoStatus.Missing &&
      video.scheduledStart &&
      moment.tz("UTC").isBefore(video.scheduledStart)
    )
      continue;
    if (isDirect) {
      await recalcVideoHbStats([video.id]);
      const updated = await VideoModel.findByVideoId(video.id);
      if (updated) video = updated;
    }
    channelIds.add(video.channelId);
    pastSummaries.push(await buildVideoSummary(video));
    if (isDirect) await archiveVideo(video.id, { isDirect: true });
  }

  const dataIndexPath = path.join(CHAT_ARCHIVE_DIR, "data", "index.json");
  await fsp.mkdir(path.dirname(dataIndexPath), { recursive: true });
  await fsp.rm(`${dataIndexPath}.tmp`, { force: true });
  await fsp.writeFile(
    `${dataIndexPath}.tmp`,
    JSON.stringify({ live: liveSummaries, past: pastSummaries }) + "\n",
    "utf-8"
  );
  await fsp.rename(`${dataIndexPath}.tmp`, dataIndexPath);

  for (const channelId of channelIds) {
    try {
      await genChannelIndexFile(channelId, { isDirect });
    } catch (error) {
      console.error(
        `Failed to generate channel index for ${channelId}:`,
        error
      );
    }
  }
}
