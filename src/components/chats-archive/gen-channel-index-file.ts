import assert from "node:assert";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CHAT_ARCHIVE_DIR } from "../../constants.js";
import ChannelModel from "../../models/Channel.js";
import VideoModel from "../../models/Video.js";
import { archiveVideo } from "./archive-video.js";
import { recalcVideoHbStats } from "../video-stats.js";
import { renderChannelIndexShell } from "./templates/ChannelIndexPage.js";
import { renderVideoCard } from "./templates/VideoCard.js";

export async function genChannelIndexFile(
  channelId: string,
  { isDirect = false }: { isDirect?: boolean } = {}
): Promise<void> {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  const outputFilePath = path.join(CHAT_ARCHIVE_DIR, channelId, "index.html");
  await fsp.mkdir(path.dirname(outputFilePath), { recursive: true });

  const channel = await ChannelModel.findByChannelId(channelId);
  if (!channel) return;

  const ws = fs.createWriteStream(`${outputFilePath}.tmp`, {
    encoding: "utf-8",
  });

  const [head, tail] = await renderChannelIndexShell({ channel });
  ws.write(head);

  let count = 0;
  for await (let video of VideoModel.find({
    channelId,
    uploadedVideo: { $ne: true },
  })
    .sort({ availableAt: -1 })
    .limit(100)
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    if (isDirect) {
      await recalcVideoHbStats([video.id]);
      const updated = await VideoModel.findByVideoId(video.id);
      if (updated) video = updated;
    }
    ws.write(
      await renderVideoCard({
        video,
        channel: await video.getChannel(),
        basePath: "../",
        hbStats: video.hbStats,
      })
    );
    if (isDirect) await archiveVideo(video.id);
    count++;
  }

  ws.end(tail);

  if (count === 0) {
    await fsp.unlink(`${outputFilePath}.tmp`);
    return;
  }
  await fsp.rename(`${outputFilePath}.tmp`, outputFilePath);
}
