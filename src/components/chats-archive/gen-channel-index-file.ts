import assert from "node:assert";
import fsp from "node:fs/promises";
import path from "node:path";
import { CHAT_ARCHIVE_DIR } from "../../constants.js";
import ChannelModel from "../../models/Channel.js";
import VideoModel from "../../models/Video.js";
import { archiveVideo } from "./archive-video.js";
import { recalcVideoHbStats } from "../video-stats.js";
import { buildVideoSummary } from "./build-video-summary.js";

export async function genChannelIndexFile(
  channelId: string,
  { isDirect = false }: { isDirect?: boolean } = {}
): Promise<void> {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");

  const channel = await ChannelModel.findByChannelId(channelId);
  if (!channel) return;

  let count = 0;
  const summaries: Array<Record<string, unknown>> = [];
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
    summaries.push(await buildVideoSummary(video, { includeChannel: false }));
    if (isDirect) await archiveVideo(video.id, { isDirect: true });
    count++;
  }

  const dataChannelPath = path.join(
    CHAT_ARCHIVE_DIR,
    "data",
    "channels",
    `${channelId}.json`
  );
  await fsp.mkdir(path.dirname(dataChannelPath), { recursive: true });

  if (count === 0) {
    await fsp.rm(`${dataChannelPath}.tmp`, { force: true });
    return;
  }

  const channelJson: Record<string, unknown> = {
    id: channel.id,
    name: channel.name,
  };
  if (channel.avatarUrl !== undefined && channel.avatarUrl !== null) {
    channelJson.avatarUrl = channel.avatarUrl;
  }
  channelJson.videos = summaries;
  await fsp.rm(`${dataChannelPath}.tmp`, { force: true });
  await fsp.writeFile(
    `${dataChannelPath}.tmp`,
    JSON.stringify(channelJson) + "\n",
    "utf-8"
  );
  await fsp.rename(`${dataChannelPath}.tmp`, dataChannelPath);
}
