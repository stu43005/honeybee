import type { AppCommand } from "./command.js";
import { CrawlCommand } from "./mod/crawl.js";
import { SetChannelCommand } from "./mod/set-channel.js";
import { SetVideoCommand } from "./mod/set-video.js";
import { TrackCommand } from "./track/track.js";

export const commands: AppCommand[] = [
  new CrawlCommand(),
  new SetChannelCommand(),
  new SetVideoCommand(),
  new TrackCommand(),
];

commands.sort((a, b) => (a.metadata.name > b.metadata.name ? 1 : -1));
