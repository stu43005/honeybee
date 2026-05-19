import type { DocumentType } from "@typegoose/typegoose";
import type { Video } from "../../models/Video.js";

export async function buildVideoSummary(
  video: DocumentType<Video>,
  { includeChannel = true }: { includeChannel?: boolean } = {}
): Promise<Record<string, unknown>> {
  let channelObj: Record<string, unknown> | undefined;
  if (includeChannel) {
    const channel = await video.getChannel();
    channelObj = channel
      ? { id: channel.id, name: channel.name }
      : { id: video.channelId, name: video.channelId };
    if (channel?.avatarUrl !== undefined && channel?.avatarUrl !== null) {
      channelObj.avatarUrl = channel.avatarUrl;
    }
  }
  const summary: Record<string, unknown> = {
    id: video.id,
    title: video.title,
    ...(channelObj ? { channel: channelObj } : {}),
    status: video.status,
    duration: video.duration,
    availableAt: video.availableAt,
    archiveVersion: video.hbStats?.chatsArchiveVersion ?? 1,
    stats: {
      superChatTotalJpy: video.hbStats?.totalSuperChatAmountJpy ?? 0,
      memberCount: video.hbStats?.totalMembers ?? 0,
      giftCount: video.hbStats?.totalGifts ?? 0,
    },
  };
  for (const key of [
    "scheduledStart",
    "actualStart",
    "actualEnd",
    "publishedAt",
  ] as const) {
    const val = video[key];
    if (val !== undefined && val !== null) summary[key] = val;
  }
  return summary;
}
