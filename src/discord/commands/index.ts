import type { AppCommand } from "./command";
import { CrawlCommand } from "./mod/crawl";
import { SetChannelCommand } from "./mod/set-channel";
import { SetVideoCommand } from "./mod/set-video";

export const commands: AppCommand[] = [
  new CrawlCommand(),
  new SetChannelCommand(),
  new SetVideoCommand(),
];

commands.sort((a, b) => (a.metadata.name > b.metadata.name ? 1 : -1));
