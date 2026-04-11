#!/usr/bin/env node

import yargs from "yargs";
import { runCrawler } from "./commands/crawler.js";
import { runDiscordBot } from "./commands/discord-bot.js";
import { metrics } from "./commands/metrics.js";
import { runScheduler } from "./commands/scheduler.js";
import { runWebhook } from "./commands/webhook.js";
import { runWorker } from "./commands/worker.js";
import { runManager } from "./commands/manager.js";

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
  .command("manager", "start manager", runManager)
  .command("metrics", "Prometheus metrics endpoint", metrics)
  .demandCommand(1).argv;
