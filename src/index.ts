#!/usr/bin/env node

import yargs from "yargs";
import { addChannel, addChannelBuilder } from "./commands/channel";
import {
  cleanup,
  cleanupBuilder,
  removeDuplicatedActions,
} from "./commands/cleanup";
import { runCrawler } from "./commands/crawler";
import { health } from "./commands/health";
import { inspect } from "./commands/inspect";
import { runManager } from "./commands/manager";
import { metrics } from "./commands/metrics";
import { migrate } from "./commands/migrate";
import { runScheduler } from "./commands/scheduler";
import { runWebhook } from "./commands/webhook";
import { runWorker } from "./commands/worker";

process.on("unhandledRejection", (err) => {
  console.log("CLI got unhandledRejection", err);
  process.exit(1);
});

process.on("uncaughtException", async (err) => {
  console.log("CLI got uncaughtException", err);
  process.exit(1);
});

process.on("SIGINT", (err) => {
  console.log("Keyboard interrupt");
  process.exit(0);
});

yargs(process.argv.slice(2))
  .scriptName("honeybee")
  .command("scheduler", "start scheduler", runScheduler)
  .command("worker", "start worker", runWorker)
  .command("manager", "start manager", runManager)
  .command("webhook", "start webhook service", runWebhook)
  .command("crawler", "start crawler", runCrawler)
  .command("health", "show real-time cluster status", health)
  .command("metrics", "Prometheus metrics endpoint", metrics)
  .command("cleanup", "cleanup ended streams", cleanupBuilder, cleanup)
  .command("cleanupDupes", "remove duplicated actions", removeDuplicatedActions)
  .command("channel add", "add channel", addChannelBuilder, addChannel)
  .command("migrate", "migrate datetime format", migrate)
  .command("inspect", "migrate datetime format", inspect)
  .demandCommand(1).argv;
