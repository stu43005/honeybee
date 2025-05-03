import type { AppCommand } from "./command";
import { CrawlCommand } from "./mod/crawl";
import { SetChannelCommand } from "./mod/set-channel";
import { SetVideoCommand } from "./mod/set-video";
import { TrackCommand } from "./track/track";
import { UntrackCommand } from "./track/untrack";

export const commands: AppCommand[] = [
  new CrawlCommand(),
  new SetChannelCommand(),
  new SetVideoCommand(),
  new TrackCommand(),
  new UntrackCommand(),
];

commands.sort((a, b) => (a.metadata.name > b.metadata.name ? 1 : -1));
