import type { AppCommand } from "./command";
import { CrawlCommand } from "./mod/crawl";
import { SetChannelCommand } from "./mod/set-channel";

export const commands: AppCommand[] = [
  new SetChannelCommand(),
  new CrawlCommand(),
];

commands.sort((a, b) => (a.metadata.name > b.metadata.name ? 1 : -1));
