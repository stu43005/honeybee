import fastifyExpress from "@fastify/express";
import { mongoose } from "@typegoose/typegoose";
import type { Job } from "agenda";
import Fastify from "fastify";
import { setTimeout } from "timers/promises";
import YouTubeNotifier from "youtube-notification";
import { CRAWLER_ROOT_URL, YOUTUBE_PUBSUB_SECRET } from "../constants";
import Channel from "../models/Channel";
import Video from "../models/Video";
import { initMongo } from "../modules/db";
import { getAgenda } from "../modules/schedule";

export async function runCrawler() {
  const disconnectFromMongo = await initMongo();
  const agenda = getAgenda();
  const fastify = Fastify({
    logger: false,
    disableRequestLogging: true,
  });
  await fastify.register(fastifyExpress);

  process.on("SIGTERM", async () => {
    console.log("quitting crawler (SIGTERM) ...");

    try {
      await fastify.close();
      await agenda.drain();
      await disconnectFromMongo();
    } catch (err) {
      console.error("crawler failed to shut down gracefully", err);
    }
    process.exit(0);
  });

  fastify.get("/healthz", async function (request, reply) {
    if (
      mongoose.connection.readyState !== mongoose.ConnectionStates.connected
    ) {
      throw new Error("mongoose not ready.");
    }
    return "ok";
  });

  //#region youtube pubsub

  const enabledYtPubsub = !!CRAWLER_ROOT_URL;
  const ytNotifier = new YouTubeNotifier({
    hubCallback: new URL(
      "./notifications/youtube",
      CRAWLER_ROOT_URL
    ).toString(),
    secret: YOUTUBE_PUBSUB_SECRET,
    middleware: true,
  });
  fastify.use("/notifications/youtube", ytNotifier.listener());

  async function subscribeYtPubsub() {
    if (!enabledYtPubsub) return;
    const channels = await Channel.findSubscribed();
    for (const channel of channels) {
      await setTimeout(250);
      console.log(`Subscribing: [${channel.id}] ${channel.name}`);
      ytNotifier.subscribe(channel.id);
    }
  }

  const ytPubsub = "crawler youtube pubsub";
  if (enabledYtPubsub) {
    agenda.define(ytPubsub, async (job: Job): Promise<void> => {
      await subscribeYtPubsub();
    });
  }

  ytNotifier.on("subscribe", (data) => {
    console.log(`Subscribed: ${data.channel} (lease=${data.lease_seconds}s)`);
  });
  ytNotifier.on("unsubscribe", (data) => {
    console.log(`Unsubscribed: ${data.channel}`);
  });
  ytNotifier.on("denied", (data) => {
    console.log(`Subscription denied: ${data.channel}`);
  });
  ytNotifier.on("notified", async (data) => {
    console.log(
      `Pubsub: ${data.channel.name} (${data.channel.id}) new video: [${data.video.id}] ${data.video.title}`
    );
    const result = await Video.createFromNotification(data);
    if (result.modifiedCount > 0) {
      console.log(`Already seen this video: ${data.video.id}`);
    }
  });

  //#endregion youtube pubsub

  await agenda.start();
  agenda.every("12 hours", ytPubsub);

  await fastify.listen({
    port: Number(process.env.PORT || 17835),
    host: "0.0.0.0",
  });

  console.log(`crawler is ready`);
}
