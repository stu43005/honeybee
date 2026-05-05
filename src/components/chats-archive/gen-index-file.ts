import assert from "node:assert";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import moment from "moment";
import { VideoStatus } from "holodex.js";
import { CHAT_ARCHIVE_DIR } from "../../constants.js";
import VideoModel from "../../models/Video.js";
import { archiveVideo } from "./archive-video.js";
import { genChannelIndexFile } from "./gen-channel-index-file.js";
import { recalcVideoHbStats } from "../video-stats.js";
import { renderIndexShell } from "./templates/IndexPage.js";
import { renderVideoCard } from "./templates/VideoCard.js";

export async function genIndexFile({
  isDirect = false,
}: { isDirect?: boolean } = {}): Promise<void> {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  const outputFilePath = path.join(CHAT_ARCHIVE_DIR, "index.html");
  await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });
  const ws = fs.createWriteStream(`${outputFilePath}.tmp`, {
    encoding: "utf-8",
  });

  const [head, between, tail] = await renderIndexShell();
  ws.write(head);

  const channelIds = new Set<string>();

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
    ws.write(
      await renderVideoCard({
        video,
        channel: await video.getChannel(),
        basePath: "",
        hbStats: video.hbStats,
      })
    );
    if (isDirect) await archiveVideo(video.id);
  }

  ws.write(between);

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
    ws.write(
      await renderVideoCard({
        video,
        channel: await video.getChannel(),
        basePath: "",
        hbStats: video.hbStats,
      })
    );
    if (isDirect) await archiveVideo(video.id);
  }

  ws.end(tail);
  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);

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
