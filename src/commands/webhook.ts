import type { DocumentType } from "@typegoose/typegoose";
import axios, { AxiosError } from "axios";
import {
  HTTPError,
  REST,
  RequestMethod,
  Routes,
  type RouteLike,
} from "discord.js";
import jsonTemplates, { type JsonTemplate } from "json-templates";
import { isEqual } from "lodash-es";
import { mongo } from "mongoose";
import assert from "node:assert";
import http from "node:http";
import https from "node:https";
import { setInterval, setTimeout } from "node:timers/promises";
import pProps from "p-props";
import {
  WEBHOOK_RESULT_FOLLOW_TTL_MS,
  WEBHOOK_RESULT_NON_FOLLOW_TTL_MS,
} from "../constants.js";
import {
  checkIsDiscordDmUrl,
  checkIsDiscordWebhookUrl,
  defaultInsertMethod,
  defaultUpdateMethod,
  defaultUpdateUrl,
  fixLongText,
  templatePreset,
} from "../data/webhook.js";
import type { WebhookJob } from "../interfaces.js";
import ChannelModel from "../models/Channel.js";
import VideoModel, { Video } from "../models/Video.js";
import WebhookModel, { type Webhook } from "../models/Webhook.js";
import WebhookResultModel from "../models/WebhookResult.js";
import YoutubeDmBindingModel from "../models/YoutubeDmBinding.js";
import { Application } from "../modules/application.js";
import { getCacheInstance } from "../modules/cache.js";
import { type WatcherResultDocument } from "../modules/collection-watcher.js";
import {
  documentLog,
  getModelByCollectionName,
  importAllModels,
  MongodbModule,
} from "../modules/db.js";
import { RedisModule } from "../modules/redis.js";
import { isMatching } from "../modules/matching.js";
import {
  claimWebhookResult,
  type WebhookResultIdentifier,
} from "../modules/webhook/claim.js";
import { WebhookChangeStreamModule } from "../modules/webhook/changestream.js";
import { WebhookPartitionModule } from "../modules/webhook/partition.js";
import {
  WebhookQueueConsumerModule,
  WebhookQueueProducerModule,
} from "../modules/webhook/queue.js";
import { secondsToHms } from "../util.js";

const axiosInstance = axios.create({
  timeout: 4000,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});
const discordRest = new REST();

// Bot-token REST client used only for DM delivery (auth: true). Separate from the
// webhook-delivery `discordRest` (auth: false with self-authenticating URLs).
export const dmRest = new REST();

// Caches the per-user DM channel id so we don't recreate it on every event.
export const dmChannelCache = getCacheInstance({ ttl: 60 * 60 * 1000 });

const cache = getCacheInstance({
  ttl: 300_000,
  refreshThreshold: 30_000,
});

export async function dmConsentAllowed(
  discordUserId: string,
  authorChannelId: string
): Promise<boolean> {
  const binding = await YoutubeDmBindingModel.findOne({
    discordUserId,
  }).setOptions({ readPreference: "primary" });
  return !!binding && binding.channelIds.includes(authorChannelId);
}

export async function sendDiscordDm(
  url: string,
  authorChannelId: string,
  body: any,
  webhook: DocumentType<Webhook>,
  resultIdentifier: WebhookResultIdentifier
) {
  const discordUserId = url.slice("discord-dm://".length);

  // Delivery-time consent: skip if the channel is no longer bound (closes the
  // unbind window down to this read-to-send gap).
  if (!(await dmConsentAllowed(discordUserId, authorChannelId))) {
    documentLog(
      webhook,
      `[dm-consent-skip] ${discordUserId} no longer bound to ${authorChannelId}`
    );
    return;
  }

  const payload: Record<string, unknown> = { embeds: body.embeds };
  if (body.content) payload.content = body.content;

  const ttlMs = webhook.followUpdate
    ? WEBHOOK_RESULT_FOLLOW_TTL_MS
    : WEBHOOK_RESULT_NON_FOLLOW_TTL_MS;

  const sendOnce = async () => {
    const dmChannelId = await dmChannelCache.wrap(
      `dm-channel-${discordUserId}`,
      async () => {
        const dm = (await dmRest.request({
          fullRoute: Routes.userChannels(),
          method: RequestMethod.Post,
          body: { recipient_id: discordUserId },
          auth: true,
        })) as { id: string };
        return dm.id;
      }
    );
    return dmRest.request({
      fullRoute: Routes.channelMessages(dmChannelId),
      method: RequestMethod.Post,
      body: payload,
      auth: true,
    });
  };

  try {
    let response;
    try {
      response = await sendOnce();
    } catch (error) {
      // Cached DM channel may be stale (404) — clear it (awaited) and rebuild once.
      if ((error as { status?: number }).status === 404) {
        await dmChannelCache.del(`dm-channel-${discordUserId}`);
        response = await sendOnce();
      } else {
        throw error;
      }
    }

    const setFields: Record<string, unknown> = {
      method: "POST",
      url,
      body: payload,
      response,
      statusCode: 200,
    };
    const unsetFields: Record<string, unknown> = { error: "" };
    if (ttlMs !== null) {
      setFields.expireAt = new Date(Date.now() + ttlMs);
    } else {
      unsetFields.expireAt = "";
    }
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: setFields,
      $unset: unsetFields,
    });
  } catch (error) {
    const status = (error as { status?: number }).status ?? -1;
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: { statusCode: status, error: `${error}` },
    });
    // Terminal (cannot DM this user) -> swallow so bee-queue marks the job done.
    // Transient (5xx / unknown) -> rethrow so the worker handler retries.
    if (status !== 403 && status !== 404) {
      throw error;
    }
  } finally {
    void cache.del(createWebhookResultCacheKey(resultIdentifier));
  }
}

async function sendDiscordWebhook(
  method: string,
  url: string,
  body: any,
  webhook: Webhook,
  resultIdentifier: WebhookResultIdentifier
) {
  const uri = new URL(url);
  uri.searchParams.set("wait", "true");

  const ttlMs = webhook.followUpdate
    ? WEBHOOK_RESULT_FOLLOW_TTL_MS
    : WEBHOOK_RESULT_NON_FOLLOW_TTL_MS;

  try {
    const response = await discordRest.request({
      fullRoute: uri.pathname.replace(/^\/api/, "") as RouteLike,
      method: method.toUpperCase() as RequestMethod,
      body: body,
      query: uri.searchParams,
      auth: false,
    });

    // On success, overwrite method/url/body along with response/statusCode.
    // body must be re-written here (not only in $setOnInsert) so that subsequent
    // follow-update events compare against the LAST sent body via
    // isEqual(existing.body, newBody). If body were only written on insert, the
    // comparison would always be against the first-ever body and subsequent
    // updates would never deduplicate correctly.
    const setFields: Record<string, unknown> = {
      method,
      url,
      body,
      response,
      statusCode: 200,
    };
    const unsetFields: Record<string, unknown> = { error: "" };
    if (ttlMs !== null) {
      setFields.expireAt = new Date(Date.now() + ttlMs);
    } else {
      unsetFields.expireAt = "";
    }
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: setFields,
      $unset: unsetFields,
    });
  } catch (error) {
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: {
        statusCode: error instanceof HTTPError ? error.status : -1,
        error: `${error}`,
      },
    });
  } finally {
    void cache.del(createWebhookResultCacheKey(resultIdentifier));
  }
}

async function sendWebhook(
  method: string,
  url: string,
  body: any,
  webhook: Webhook,
  resultIdentifier: WebhookResultIdentifier
) {
  const ttlMs = webhook.followUpdate
    ? WEBHOOK_RESULT_FOLLOW_TTL_MS
    : WEBHOOK_RESULT_NON_FOLLOW_TTL_MS;

  try {
    const timeout = AbortSignal.timeout(10000);
    const res = await axiosInstance.request({
      method,
      url,
      data: body,
      signal: timeout,
    });

    const setFields: Record<string, unknown> = {
      method,
      url,
      body,
      response: res.data,
      statusCode: res.status,
    };
    const unsetFields: Record<string, unknown> = { error: "" };
    if (ttlMs !== null) {
      setFields.expireAt = new Date(Date.now() + ttlMs);
    } else {
      unsetFields.expireAt = "";
    }
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: setFields,
      $unset: unsetFields,
    });
  } catch (error) {
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: {
        statusCode: error instanceof AxiosError ? error.response?.status : -1,
        error: `${error}`,
      },
    });
  } finally {
    void cache.del(createWebhookResultCacheKey(resultIdentifier));
  }
}

const jsonTemplateCache = new WeakMap<
  Webhook,
  Map<string, JsonTemplate<any>>
>();
function getWebhookTemplateCache(webhook: Webhook) {
  const templateMap =
    jsonTemplateCache.get(webhook) ?? new Map<string, JsonTemplate<any>>();
  jsonTemplateCache.set(webhook, templateMap);
  return (key: string, atemplate: any) => {
    const template = templateMap.get(key) ?? jsonTemplates(atemplate);
    templateMap.set(key, template);
    return template;
  };
}

function getVideo(videoId?: string) {
  if (!videoId) return null;
  return cache.wrap(videoId, () =>
    VideoModel.findByVideoId(videoId)
      .setOptions({ readPreference: "secondaryPreferred" })
      .exec()
      .then((doc) => doc?.toJSON() ?? null)
  );
}
function getChannel(channelId?: string) {
  if (!channelId) return null;
  return cache.wrap(channelId, () =>
    ChannelModel.findByChannelId(channelId)
      .setOptions({ readPreference: "secondaryPreferred" })
      .exec()
      .then((doc) => doc?.toJSON() ?? null)
  );
}

function createWebhookResultIdentifier(
  webhook: DocumentType<Webhook>,
  data: WatcherResultDocument
): WebhookResultIdentifier {
  return {
    webhookId: webhook._id.toHexString(),
    coll: data.ns.coll,
    docId: data.documentKey._id.toHexString(),
  };
}
function createWebhookResultCacheKey(
  resultIdentifier: WebhookResultIdentifier
) {
  return `WebhookResult-${JSON.stringify(resultIdentifier)}`;
}
async function getWebhookResult(
  resultIdentifier: WebhookResultIdentifier,
  data: WatcherResultDocument
) {
  const cacheKey = createWebhookResultCacheKey(resultIdentifier);
  {
    const result = await cache.wrap(cacheKey, () =>
      WebhookResultModel.findOne(resultIdentifier)
        .exec()
        .then((doc) => doc?.toJSON() ?? null)
    );
    if (result?.response || data.operationType === "insert") {
      return result;
    }
    void cache.del(cacheKey);
  }
  const timeout = AbortSignal.timeout(3000);
  for await (const _ of setInterval(300)) {
    const result = await cache.wrap(cacheKey, () =>
      WebhookResultModel.findOne(resultIdentifier)
        .exec()
        .then((doc) => doc?.toJSON() ?? null)
    );
    if (result?.response) {
      return result;
    }
    if (timeout.aborted && result) {
      return result;
    }
    void cache.del(cacheKey);
    if (timeout.aborted) {
      break;
    }
  }
  return null;
}

async function loadJobContext(job: WebhookJob): Promise<{
  webhook: DocumentType<Webhook>;
  data: WatcherResultDocument;
} | null> {
  const webhook = await WebhookModel.findById(job.webhookId).exec();
  if (!webhook || !webhook.enabled) return null;

  const model = getModelByCollectionName(job.coll);
  if (!model) return null;

  const fullDocument = await model.findById(job.docId).exec();
  if (!fullDocument) return null;

  return {
    webhook,
    data: {
      documentKey: { _id: new mongo.BSON.ObjectId(job.docId) },
      fullDocument,
      operationType: job.operationType,
      ns: { db: model.db.name, coll: job.coll },
    } as WatcherResultDocument,
  };
}

async function processWebhookEvent(
  webhook: DocumentType<Webhook>,
  data: WatcherResultDocument
) {
  const video = getVideo(data.fullDocument.originVideoId);
  const channel =
    getChannel(data.fullDocument.channelId) ??
    getChannel(data.fullDocument.originChannelId) ??
    video?.then((video) => getChannel(video?.channelId)) ??
    null;
  const authorChannel = getChannel(data.fullDocument.authorChannelId);
  const sourceVideo = getVideo(data.fullDocument.sourceVideoId);
  const sourceChannel = getChannel(data.fullDocument.sourceChannelId);

  const timestamp: Date =
    data.fullDocument.timestamp ?? data.fullDocument.updatedAt ?? new Date();
  const timeSecond = video?.then((video) =>
    video ? Video.getTimeSeconds(video, timestamp) : 0
  );
  const timeCode = timeSecond?.then((timeSecond) => secondsToHms(timeSecond));

  const createdAt: Date | undefined = data.fullDocument.createdAt;
  const createdAtTimeCode =
    createdAt &&
    video?.then((video) =>
      secondsToHms(video ? Video.getTimeSeconds(video, createdAt) : 0)
    );

  const resultIdentifier = createWebhookResultIdentifier(webhook, data);

  const previousResult = webhook.followUpdate
    ? getWebhookResult(resultIdentifier, data)
    : null;
  const previousBody = previousResult?.then((result) => result?.body);
  const previousResponse = previousResult?.then((result) => result?.response);

  const getJsonTemplate = getWebhookTemplateCache(webhook);
  const parameters: Record<string, any> = await pProps({
    webhook: webhook.toJSON(),
    insertUrl: webhook.insertUrl,
    collection: data.ns.coll,
    ...data.fullDocument.toJSON(),
    timestamp: timestamp.toISOString(),
    timeSecond: timeSecond,
    timeCode: timeCode,
    createdAtTimeCode: createdAtTimeCode,
    video: video,
    channel: channel,
    authorChannel: authorChannel,
    sourceVideo: sourceVideo,
    sourceChannel: sourceChannel,
    previousBody: previousBody,
    previousResponse: previousResponse,
  });
  const hasPreviousResponse = !!parameters.previousResponse;

  if (webhook.filter && !isMatching(webhook.filter, parameters)) {
    return;
  }

  let method: string | null = null;
  let url: string | null = null;
  if (data.operationType !== "insert" && hasPreviousResponse) {
    if (webhook.updateMethod) method ??= webhook.updateMethod;
    if (webhook.updateUrl)
      url ??= getJsonTemplate("updateUrl", webhook.updateUrl)(parameters);
    method ??= defaultUpdateMethod;
    url ??= defaultUpdateUrl(parameters);
  }
  method ??= webhook.insertMethod ?? defaultInsertMethod;
  url ??= webhook.insertUrl;

  const body =
    webhook.templatePreset && templatePreset[webhook.templatePreset]
      ? templatePreset[webhook.templatePreset](parameters)
      : webhook.template
        ? getJsonTemplate("template", webhook.template)(parameters)
        : data.fullDocument.toJSON();

  if (!body) {
    // no message to send
    return;
  }

  if (checkIsDiscordWebhookUrl(url) || checkIsDiscordDmUrl(url)) {
    if (body.embeds && Array.isArray(body.embeds)) {
      body.embeds = body.embeds.map((embed: any) => {
        if (typeof embed?.footer?.text === "string")
          embed.footer.text = fixLongText(embed.footer.text);
        return embed;
      });
    }
  }

  if (parameters.previousBody && isEqual(parameters.previousBody, body)) {
    // no need update
    return;
  }

  const decision = await claimWebhookResult(
    webhook,
    resultIdentifier,
    method,
    url,
    body
  );
  if (decision.action === "skip") {
    documentLog(
      webhook,
      `[idempotent-skip] ${decision.reason} for ${resultIdentifier.coll}:${resultIdentifier.docId}`
    );
    return;
  }
  void cache.del(createWebhookResultCacheKey(resultIdentifier));

  if (checkIsDiscordWebhookUrl(url)) {
    await sendDiscordWebhook(method, url, body, webhook, resultIdentifier);
  } else if (checkIsDiscordDmUrl(url)) {
    await sendDiscordDm(
      url,
      data.fullDocument.authorChannelId,
      body,
      webhook,
      resultIdentifier
    );
  } else {
    await sendWebhook(method, url, body, webhook, resultIdentifier);
  }
}

export async function runWebhook() {
  await importAllModels();

  assert(
    process.env.DISCORD_TOKEN,
    "DISCORD_TOKEN is required for DM delivery"
  );
  dmRest.setToken(process.env.DISCORD_TOKEN);

  const app = new Application();

  // Infrastructure modules — init first, close last
  app.use(new MongodbModule());
  app.use({
    name: "discord-rest-client",
    async close() {
      // wait for all pending Discord REST handlers (webhook + DM) to flush
      for (const rest of [discordRest, dmRest]) {
        for (const [, handler] of rest.handlers) {
          while (!handler.inactive) {
            await setTimeout(100);
          }
        }
      }
    },
  });
  app.use(new RedisModule());

  // Webhook-domain modules — registered in init order (first registered
  // inits first). Application.close() runs LIFO, so partition closes FIRST
  // (registered last). LIFO close order becomes:
  //   partition → changestream → consumer → producer → redis → discord → mongo
  //
  // partition closing first DELs its instance key from Redis and publishes
  // rebalance; peers notice us leaving and start reassigning collections.
  // changestream then closes our local streams and writes the final resume
  // tokens. consumer drains in-flight jobs and pending reschedules before
  // closing. producer closes after consumer, so scheduleAndEnqueue calls
  // issued during consumer.close() remain safe. The brief overlap — this
  // instance's streams still alive while peers are starting to take over —
  // is tolerated by bee-queue setId dedup plus the WebhookResult idempotency
  // layer.
  //
  // Producer needs `app` to resolve RedisModule via app.get at init() time;
  // scheduleAndEnqueue is exposed as a method on this module (queue + redis
  // dependencies are bound here, not threaded through callsites).
  const producerModule = new WebhookQueueProducerModule(app);
  // Consumer needs `app` to resolve RedisModule and producer at init() time.
  const consumerModule = new WebhookQueueConsumerModule(app);
  const changeStreamModule = new WebhookChangeStreamModule(app);
  // Partition needs `app` to resolve RedisModule for the main command
  // connection AND its shared subscriber (RedisModule.getSubscriber()).
  const partitionModule = new WebhookPartitionModule(app);

  // Worker handler (Layer 4 concern; wired here because it depends on
  // webhook.ts's processWebhookEvent which stays in this file)
  consumerModule.setHandler(async (job) => {
    try {
      const ctx = await loadJobContext(job.data);
      if (!ctx) return; // webhook or document gone
      await processWebhookEvent(ctx.webhook, ctx.data);
    } catch (error) {
      documentLog(job.data.coll, "<!> [ERROR] worker handler failed:", error);
      throw error; // let bee-queue retry
    }
  });

  app.use(producerModule);
  app.use(consumerModule);
  app.use(changeStreamModule);
  app.use(partitionModule);

  await app.init();
  console.log("webhook is ready");
}
