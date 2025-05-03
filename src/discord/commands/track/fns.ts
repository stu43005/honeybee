import type {
  AutocompleteInteraction,
  CategoryChildChannel,
  ChatInputCommandInteraction,
} from "discord.js";
import type { TrackKey } from "../../../models/Track";

export async function getTrackKey(
  intr: ChatInputCommandInteraction | AutocompleteInteraction
): Promise<{
  trackKey?: TrackKey;
  baseChannel?: CategoryChildChannel;
}> {
  if (!intr.guildId || !intr.channel || intr.channel.isDMBased()) {
    return {};
  }

  const baseChannel = intr.channel.isThread()
    ? intr.channel.parent
    : intr.channel;
  if (!baseChannel) {
    return {};
  }

  const trackKey: TrackKey = {
    guildId: intr.guildId!,
    channelId: baseChannel.id,
    threadId: intr.channel.isThread() ? intr.channel.id : null,
  };
  return {
    trackKey,
    baseChannel,
  };
}
