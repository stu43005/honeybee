import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import VideoModel, { type Video } from "../../../models/Video.js";
import type { Command } from "../command.js";

export class SetVideoCommand implements Command {
  public metadata = new SlashCommandBuilder()
    .setName("set-video")
    .setDescription("Modify video settings")
    .addStringOption((builder) =>
      builder
        .setName("video-id")
        .setDescription("The Youtube videoId")
        .setRequired(true)
    )
    .addBooleanOption((builder) =>
      builder
        .setName("is-ignore")
        .setDescription("Whether to ignore the video.")
    )
    .toJSON();

  public async execute(intr: ChatInputCommandInteraction): Promise<void> {
    const videoId = intr.options.getString("video-id", true);

    let video = await VideoModel.findByVideoId(videoId);
    if (!video) {
      await intr.reply({
        content: "Cannot find the video.",
        ephemeral: true,
      });
      return;
    }

    let modified = false;

    // Extract the keys of boolean properties of Video
    type VideoBooleanKeys = {
      [K in keyof Video]: Video[K] & {} extends Boolean ? K : never;
    }[keyof Video] & {};
    function setBoolean(key: VideoBooleanKeys, valueKey: string) {
      const value = intr.options.getBoolean(valueKey);
      if (video && key && value !== null) {
        video[key] = value;
        modified = true;
      }
    }
    setBoolean("hbIgnore", "is-ignore");

    if (modified) {
      await video.save();
      await intr.reply({
        content: "Successfully modified video settings.",
        ephemeral: true,
      });
    } else {
      await intr.reply({
        content: "No video settings have been modified.",
        ephemeral: true,
      });
    }
  }
}
