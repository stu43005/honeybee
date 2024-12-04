import type { DocumentType } from "@typegoose/typegoose";
import axios, { AxiosError } from "axios";
import {
  HTTPError,
  REST,
  type RequestMethod,
  type RouteLike,
} from "discord.js";
import http from "http";
import https from "https";
import jsonTemplates, { type JsonTemplate } from "json-templates";
import { groupBy, isEqual } from "lodash";
import { mongo } from "mongoose";
import { setInterval, setTimeout } from "node:timers/promises";
import pProps from "p-props";
import PQueue from "p-queue";
import {
  checkIsDiscordWebhookUrl,
  defaultInsertMethod,
  defaultUpdateMethod,
  defaultUpdateUrl,
  fixLongText,
  matchPresets,
  templatePreset,
} from "../data/webhook";
import ChannelModel from "../models/Channel";
import VideoModel, { Video } from "../models/Video";
import WebhookModel, { type Webhook } from "../models/Webhook";
import WebhookResultModel from "../models/WebhookResult";
import { getCacheInstance } from "../modules/cache";
import { type WatcherResultDocument } from "../modules/collection-watcher";
import {
  getModelByCollectionName,
  importAllModels,
  initMongo,
} from "../modules/db";
import { isMatching } from "../modules/matching";
import { getAgenda } from "../modules/schedule";
import { flatObjectKey, secondsToHms, setIfDefine } from "../util";

const debug = false;

const axiosInstance = axios.create({
  timeout: 4000,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});
const discordRest = new REST();

const cache = getCacheInstance({
  ttl: 300_000,
  refreshThreshold: 30_000,
});

function webhookLog(
  data: mongo.ChangeStreamDocument | mongo.Document | string,
  ...obj: any
) {
  let id: unknown;
  if (typeof data === "string") {
    id = data;
  } else if ("documentKey" in data) {
    id =
      data.documentKey._id instanceof mongo.BSON.ObjectId
        ? data.documentKey._id.toHexString()
        : data.documentKey._id;
  } else {
    id =
      data._id instanceof mongo.BSON.ObjectId
        ? data._id.toHexString()
        : data._id;
  }
  console.log(`${id} -`, ...obj);
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
  try {
    const response = await discordRest.request({
      fullRoute: uri.pathname.replace(/^\/api/, "") as RouteLike,
      method: method.toUpperCase() as RequestMethod,
      body: body,
      query: uri.searchParams,
      auth: false,
    });

    if (webhook.followUpdate) {
      await WebhookResultModel.updateOne(resultIdentifier, {
        $set: {
          response: response,
        },
      });
    } else {
      await WebhookResultModel.deleteOne(resultIdentifier);
    }
  } catch (error) {
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: {
        statusCode: error instanceof HTTPError ? error.status : -1,
        error: `${error}`,
      },
    });
  } finally {
    cache.del(createWebhookResultCacheKey(resultIdentifier));
  }
}

async function sendWebhook(
  method: string,
  url: string,
  body: any,
  webhook: Webhook,
  resultIdentifier: WebhookResultIdentifier
) {
  try {
    const timeout = AbortSignal.timeout(10000);
    const res = await axiosInstance.request({
      method,
      url,
      data: body,
      signal: timeout,
    });

    if (webhook.followUpdate) {
      await WebhookResultModel.updateOne(resultIdentifier, {
        $set: {
          statusCode: res.status,
          response: res.data,
        },
      });
    } else {
      await WebhookResultModel.deleteOne(resultIdentifier);
    }
  } catch (error) {
    await WebhookResultModel.updateOne(resultIdentifier, {
      $set: {
        statusCode: error instanceof AxiosError ? error.response?.status : -1,
        error: `${error}`,
      },
    });
  } finally {
    cache.del(createWebhookResultCacheKey(resultIdentifier));
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
      .exec()
      .then((doc) => doc?.toJSON() ?? null)
  );
}
function getChannel(channelId?: string) {
  if (!channelId) return null;
  return cache.wrap(channelId, () =>
    ChannelModel.findByChannelId(channelId)
      .exec()
      .then((doc) => doc?.toJSON() ?? null)
  );
}

type WebhookResultIdentifier = {
  webhookId: string;
  coll: string;
  docId: string;
};
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
    cache.del(cacheKey);
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
    cache.del(cacheKey);
    if (timeout.aborted) {
      break;
    }
  }
  return null;
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

  if (checkIsDiscordWebhookUrl(url)) {
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

  await WebhookResultModel.updateOne(
    resultIdentifier,
    {
      $setOnInsert: resultIdentifier,
      $set: {
        method: method,
        url: url,
        body: body,
      },
    },
    { upsert: true }
  );
  cache.del(createWebhookResultCacheKey(resultIdentifier));

  if (checkIsDiscordWebhookUrl(url)) {
    await sendDiscordWebhook(method, url, body, webhook, resultIdentifier);
  } else {
    await sendWebhook(method, url, body, webhook, resultIdentifier);
  }
}

function validateWebhook(webhook: DocumentType<Webhook>) {
  // validation
  const error = webhook.validateSync();
  if (error) {
    webhookLog(
      webhook,
      "<!> [ERROR] The format of the webhook is incorrect.",
      error
    );
    return false;
  }
  return true;
}

export async function runWebhook() {
  await importAllModels();
  const disconnectFromMongo = await initMongo();
  const agenda = getAgenda();
  const pqueue = new PQueue({ concurrency: 1 });

  const changeStreams = new Map<string, mongo.ChangeStream>();
  const bufferChange = new Map<
    string,
    {
      webhook: DocumentType<Webhook>;
      data?: WatcherResultDocument;
    }
  >();

  process.on("SIGTERM", async (s) => {
    console.log("quitting webhook (SIGTERM) ...");

    try {
      webhooksChangeStream?.close();
      pqueue.clear();
      await pqueue.onIdle();
      for (const coll of changeStreams.keys()) {
        await removeWebhook(coll);
      }
      await agenda.drain();
      await disconnectFromMongo();
    } catch (err) {
      console.log("webhook failed to shut down gracefully", err);
    }

    process.exit(0);
  });

  const prepareAllWebhooks = "webhook prepare webhooks";
  agenda.define(prepareAllWebhooks, async (): Promise<void> => {
    const webhooks = await WebhookModel.findEnabled();
    for (const webhook of webhooks) {
      // Check if the webhook is still valid
      webhook.failedAttempts ??= 0;
      try {
        await axiosInstance.get(webhook.insertUrl, {
          timeout: 60_000,
        });
        webhook.lastSuccess = new Date();
        webhook.failedAttempts = 0;
        webhook.enabled = true;
      } catch (error) {
        webhookLog(
          webhook,
          "<!> [ERROR] Unable to connect to the webhook",
          error
        );
        webhook.failedAttempts += 1;

        // Disable webhook after 24 failed attempts to prevent excessive retries.
        if (webhook.failedAttempts >= 24) {
          webhook.enabled = false;
        }
      }
      webhook.lastChecked = new Date();

      // Prepare webhook match
      try {
        if (webhook.matchPreset && matchPresets[webhook.matchPreset]) {
          const match = await matchPresets[webhook.matchPreset](webhook);
          if (JSON.stringify(webhook.match) !== JSON.stringify(match)) {
            webhookLog(webhook, "change match");
            webhook.match = match;
          }
        }
      } catch (error) {
        webhookLog(webhook, "<!> [ERROR] Unable to prepare webhook", error);
      }

      await webhook.save();
      await setTimeout(1000);
    }
  });

  await agenda.start();
  agenda.every("1 hour", prepareAllWebhooks);

  global.setInterval(() => {
    for (const [key, { webhook, data }] of bufferChange) {
      bufferChange.delete(key);
      if (data) {
        processWebhookEvent(webhook, data).catch((error) => {
          webhookLog(webhook, "<!> [ERROR]", error);
        });
      }
    }
  }, 5000);

  function prepareWebhookEvent(
    webhook: DocumentType<Webhook>,
    data: WatcherResultDocument
  ) {
    try {
      if (!webhook.followUpdate && data.operationType === "update")
        return false;
      if (webhook.match && !isMatching(data.fullDocument, webhook.match))
        return false;

      if (webhook.followUpdate) {
        const cacheKey = createWebhookResultCacheKey(
          createWebhookResultIdentifier(webhook, data)
        );
        if (bufferChange.has(cacheKey)) {
          // buffer change
          bufferChange.set(cacheKey, { webhook, data });
          return false;
        } else {
          // mark next record as buffer
          bufferChange.set(cacheKey, { webhook });
        }
      }

      return true;
    } catch (error) {
      webhookLog(webhook, "<!> [ERROR]", error);
      return false;
    }
  }

  async function removeWebhook(coll: string) {
    const previous = changeStreams.get(coll);
    if (previous) {
      try {
        await previous.close();
        previous.removeAllListeners();
        changeStreams.delete(coll);
        return previous.resumeToken;
      } catch (error) {
        webhookLog(
          coll,
          "<!> [FATAL] Unable to close the previous change stream.",
          error
        );
        process.exit(1);
      }
    }
  }

  async function setupWebhook(coll: string, webhooks: DocumentType<Webhook>[]) {
    try {
      // close previous change stream
      const resumeAfter = await removeWebhook(coll);

      const model = getModelByCollectionName(coll);
      if (!model) {
        webhookLog(
          coll,
          `<!> [ERROR] Unable to get model (unknown collection "${coll}")`
        );
        return;
      }
      const changeStream = model.watch(
        [
          {
            $match: {
              $or: webhooks.map((webhook) =>
                flatObjectKey({
                  operationType: webhook.followUpdate
                    ? { $in: ["insert", "update"] }
                    : "insert",
                  ...setIfDefine("fullDocument", webhook.match),
                })
              ),
            },
          },
        ],
        {
          resumeAfter: resumeAfter,
          fullDocument: "updateLookup",
        }
      );
      changeStream.on(
        "change",
        (changeStreamData: mongo.ChangeStreamDocument) => {
          if (
            changeStreamData.operationType !== "insert" &&
            changeStreamData.operationType !== "update"
          ) {
            return;
          }
          if (!("documentKey" in changeStreamData)) return;
          if (
            !("fullDocument" in changeStreamData) ||
            !changeStreamData.fullDocument
          ) {
            webhookLog(
              coll,
              "<!> [ERROR] missing fullDocument",
              changeStreamData.documentKey
            );
            return;
          }

          const data: WatcherResultDocument = {
            documentKey: changeStreamData.documentKey,
            fullDocument: new model(changeStreamData.fullDocument),
            operationType: changeStreamData.operationType,
            ns: changeStreamData.ns,
          };

          for (const webhook of webhooks) {
            if (prepareWebhookEvent(webhook, data)) {
              processWebhookEvent(webhook, data).catch((error) => {
                webhookLog(webhook, "<!> [ERROR]", error);
              });
            }
          }
        }
      );
      changeStreams.set(coll, changeStream);
      webhookLog(coll, "start listening");
    } catch (error) {
      webhookLog(
        coll,
        "<!> [FATAL] Unable to create collection watcher.",
        error
      );
      process.exit(1);
    }
  }

  async function setupWebhooks() {
    try {
      await setTimeout(5000);
      const allWebhooks = await WebhookModel.findEnabled(!debug);
      const groups = groupBy(
        allWebhooks
          .filter(validateWebhook)
          .flatMap((webhook) =>
            webhook.colls.map((coll) => ({ webhook, coll }))
          ),
        ({ coll }) => coll
      );
      for (const entry of Object.entries(groups)) {
        const coll = entry[0];
        const webhooks = entry[1].map(({ webhook }) => webhook);
        await setupWebhook(coll, webhooks);
      }
      // Stop unnecessary changestreams
      for (const coll of changeStreams.keys()) {
        if (!(coll in groups)) {
          await removeWebhook(coll);
        }
      }
    } catch (error) {
      webhookLog("global", "<!> [FATAL] Unable to setup webhooks.", error);
      process.exit(1);
    }
  }

  const webhooksChangeStream = WebhookModel.watch([
    {
      $match: {
        operationType: { $in: ["insert", "update", "replace", "delete"] },
      },
    },
  ]).on("change", (data: mongo.ChangeStreamDocument<Webhook>) => {
    webhookLog(data, data.operationType.toUpperCase());
    if (pqueue.size < 2) pqueue.add(() => setupWebhooks());
  });

  await pqueue.add(() => setupWebhooks());
  console.log("webhook is ready");
}
