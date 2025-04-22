#!/usr/bin/env node

import yargs from "yargs";
import {
  cleanup,
  cleanupBuilder,
} from "./commands/cleanup";
import { runCrawler } from "./commands/crawler";
import { runDiscordBot } from "./commands/discord-bot";
import { metrics } from "./commands/metrics";
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
  .command("discord-bot", "start discord bot", runDiscordBot)
  .command("webhook", "start webhook service", runWebhook)
  .command("crawler", "start crawler", runCrawler)
  .command("metrics", "Prometheus metrics endpoint", metrics)
  .command("cleanup", "cleanup ended streams", cleanupBuilder, cleanup)
  .demandCommand(1).argv;
