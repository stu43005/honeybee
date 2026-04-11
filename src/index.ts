#!/usr/bin/env node

import yargs from "yargs";

process.on("unhandledRejection", (err) => {
  console.log("CLI got unhandledRejection", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.log("CLI got uncaughtException", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("Keyboard interrupt");
  process.exit(0);
});

void yargs(process.argv.slice(2))
  .scriptName("honeybee")
  .command("scheduler", "start scheduler", {}, async () => {
    const { runScheduler } = await import("./commands/scheduler.js");
    await runScheduler();
  })
  .command("worker", "start worker", {}, async () => {
    const { runWorker } = await import("./commands/worker.js");
    await runWorker();
  })
  .command("discord-bot", "start discord bot", {}, async () => {
    const { runDiscordBot } = await import("./commands/discord-bot.js");
    await runDiscordBot();
  })
  .command("webhook", "start webhook service", {}, async () => {
    const { runWebhook } = await import("./commands/webhook.js");
    await runWebhook();
  })
  .command("crawler", "start crawler", {}, async () => {
    const { runCrawler } = await import("./commands/crawler.js");
    await runCrawler();
  })
  .command("manager", "start manager", {}, async () => {
    const { runManager } = await import("./commands/manager.js");
    await runManager();
  })
  .command("metrics", "Prometheus metrics endpoint", {}, async () => {
    const { metrics } = await import("./commands/metrics.js");
    await metrics();
  })
  .demandCommand(1).argv;
