import type { Arguments, Argv } from "yargs";
import { initMongo } from "../modules/db";
import { getHolodex } from "../modules/holodex";
import Channel from "../models/Channel";

interface AddChannelOptions {
  channelId: string;
}

export function addChannelBuilder(yargs: Argv): Argv<AddChannelOptions> {
  return yargs.option("channelId", {
    alias: "c",
    describe: "add channel to extra crawl",
    type: "string",
    demandOption: true,
  });
}

export async function addChannel(argv: Arguments<AddChannelOptions>) {
  const disconnectFromMongo = await initMongo();
  const holoapi = getHolodex();

  const holodexChannel = await holoapi.getChannel(argv.channelId);
  const channel = await Channel.updateFromHolodex(holodexChannel);
  channel.extraCrawl = true;
  await channel.save();

  await disconnectFromMongo();
}
