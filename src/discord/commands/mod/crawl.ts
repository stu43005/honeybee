import { toVideoId } from "@stu43005/masterchat";
import {
  hyperlink,
  inlineCode,
  SlashCommandBuilder,
  unorderedList,
  type ChatInputCommandInteraction,
} from "discord.js";
import { updateVideoFromYoutube } from "../../../modules/youtube";
import type { Command } from "../command";

export class CrawlCommand implements Command {
  public metadata = new SlashCommandBuilder()
    .setName("crawl")
    .setDescription("Notices or recrawls video.")
    .addStringOption((builder) =>
      builder
        .setName("video")
        .setDescription(
          "videoId or link. Can provide multiple, separated by spaces."
        )
        .setRequired(true)
    )
    .toJSON();

  public async execute(intr: ChatInputCommandInteraction): Promise<void> {
    const inputVideos = intr.options.getString("video", true).split(/\s/g);
    const videoIds = inputVideos
      .map((str) => toVideoId(str))
      .filter((videoId) => videoId !== undefined);
    if (!videoIds.length) {
      await intr.reply({
        content: `Invalid video.`,
        ephemeral: true,
      });
      return;
    }

    const videos = await updateVideoFromYoutube(videoIds);
    const successed = videos.filter((video) => !video.deleted);
    if (successed.length) {
      await intr.reply({
        content:
          `Successfully recrawl ${successed.length} videos:\n` +
          unorderedList(
            successed.map(
              (video) =>
                `${inlineCode(video.id)} - ${hyperlink(
                  video.title,
                  video.getUrl()
                )}`
            )
          ),
      });
      return;
    }

    await intr.reply({
      content: "Cannot find the video.",
      ephemeral: true,
    });
  }
}
