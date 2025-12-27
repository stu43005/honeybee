import type { DocumentType } from "@typegoose/typegoose";
import axios, { AxiosError } from "axios";
import {
  HTTPError,
  REST,
  type RequestMethod,
  type RouteLike,
} from "discord.js";
import jsonTemplates, { type JsonTemplate } from "json-templates";
import { groupBy, isEqual } from "lodash";
import { mongo } from "mongoose";
import http from "node:http";
import https from "node:https";
import { setInterval, setTimeout } from "node:timers/promises";
import pProps from "p-props";
import PQueue from "p-queue";
import {
  checkIsDiscordWebhookUrl,
  defaultInsertMethod,
  defaultUpdateMethod,
  defaultUpdateUrl,
  fixLongText,
  templatePreset,
} from "../data/webhook";
import ChannelModel from "../models/Channel";
import VideoModel, { Video } from "../models/Video";
import WebhookModel, { type Webhook } from "../models/Webhook";
import WebhookResultModel from "../models/WebhookResult";
import { Application } from "../modules/application";
import { getCacheInstance } from "../modules/cache";
import { type WatcherResultDocument } from "../modules/collection-watcher";
import {
  documentLog,
  getModelByCollectionName,
  importAllModels,
  MongodbModule,
} from "../modules/db";
import { isMatching } from "../modules/matching";
import { flatObjectKey, secondsToHms, setIfDefine } from "../util";

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
    documentLog(
      webhook,
      "<!> [ERROR] The format of the webhook is incorrect.",
      error
    );
    return false;
  }
  return true;
}

interface CollectionSetting {
  changeStream?: mongo.ChangeStream;
  changeStreamMatch?: any;
  webhooks: DocumentType<Webhook>[];
}

export async function runWebhook() {
  await importAllModels();
  const app = new Application();
  app.use(new MongodbModule());

  const collectionSettings = new Map<string, CollectionSetting>();
  const bufferChange = new Map<
    string,
    {
      webhook: DocumentType<Webhook>;
      data?: WatcherResultDocument;
    }
  >();

  app.use({
    name: "remove-webhook",
    async close() {
      for (const coll of collectionSettings.keys()) {
        await removeWebhook(coll);
      }
    },
  });

  const pqueue = new PQueue({ concurrency: 1 });
  app.use({
    name: "p-queue",
    async close() {
      pqueue.clear();
      await pqueue.onIdle();
    },
  });

  await app.init();

  global.setInterval(() => {
    for (const [key, { webhook, data }] of bufferChange) {
      bufferChange.delete(key);
      if (data) {
        processWebhookEvent(webhook, data).catch((error) => {
          documentLog(webhook, "<!> [ERROR]", error);
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
      documentLog(webhook, "<!> [ERROR]", error);
      return false;
    }
  }

  async function closeChangeStream(
    coll: string,
    changeStream: mongo.ChangeStream
  ) {
    try {
      await changeStream.close();
      changeStream.removeAllListeners();
      return changeStream.resumeToken;
    } catch (error) {
      documentLog(
        coll,
        "<!> [FATAL] Unable to close the previous change stream.",
        error
      );
      process.exit(1);
    }
  }

  async function removeWebhook(coll: string) {
    const collectionSetting = collectionSettings.get(coll);
    if (collectionSetting) {
      collectionSettings.delete(coll);
    }
    const previous = collectionSetting?.changeStream;
    if (previous) {
      const resumeToken = await closeChangeStream(coll, previous);
      return resumeToken;
    }
  }

  async function startChangeStream(
    coll: string,
    collectionSetting: CollectionSetting
  ) {
    // close previous change stream if exists
    const resumeAfter = collectionSetting.changeStream
      ? await closeChangeStream(coll, collectionSetting.changeStream)
      : undefined;

    const model = getModelByCollectionName(coll);
    if (!model) {
      documentLog(
        coll,
        `<!> [ERROR] Unable to get model (unknown collection "${coll}")`
      );
      return;
    }
    const changeStream = model.watch(
      [{ $match: collectionSetting.changeStreamMatch }],
      {
        resumeAfter: resumeAfter,
        fullDocument: "updateLookup",
        readPreference: "secondaryPreferred",
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
          documentLog(
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

        for (const webhook of collectionSetting.webhooks) {
          if (prepareWebhookEvent(webhook, data)) {
            processWebhookEvent(webhook, data).catch((error) => {
              documentLog(webhook, "<!> [ERROR]", error);
            });
          }
        }
      }
    );
    return changeStream;
  }

  function changeStreamIsValid(changeStream?: mongo.ChangeStream) {
    return changeStream && changeStream.closed === false;
  }

  async function setupWebhook(coll: string, webhooks: DocumentType<Webhook>[]) {
    try {
      const collectionSetting: CollectionSetting = collectionSettings.get(
        coll
      ) ?? { webhooks: [] };

      const changeStreamMatch = {
        $or: webhooks.map((webhook) =>
          flatObjectKey({
            operationType: webhook.followUpdate
              ? { $in: ["insert", "update"] }
              : "insert",
            ...setIfDefine("fullDocument", webhook.match),
          })
        ),
      };

      // check if match expression is the same of previous
      if (
        changeStreamIsValid(collectionSetting.changeStream) &&
        collectionSetting.changeStreamMatch &&
        isEqual(changeStreamMatch, collectionSetting.changeStreamMatch)
      ) {
        collectionSetting.webhooks = webhooks;
        return;
      }

      collectionSetting.webhooks = webhooks;
      collectionSetting.changeStreamMatch = changeStreamMatch;
      collectionSetting.changeStream = await startChangeStream(
        coll,
        collectionSetting
      );
      if (collectionSetting.changeStream) {
        collectionSettings.set(coll, collectionSetting);
        documentLog(
          coll,
          `start listening (match length: ${changeStreamMatch.$or.length})`
        );
      }
    } catch (error) {
      documentLog(coll, "<!> [FATAL] Unable to create change stream.", error);
      process.exit(1);
    }
  }

  async function setupWebhooks() {
    try {
      await setTimeout(5000);
      const allWebhooks = await WebhookModel.findEnabled();
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
      for (const coll of collectionSettings.keys()) {
        if (!(coll in groups)) {
          await removeWebhook(coll);
        }
      }
    } catch (error) {
      documentLog("global", "<!> [FATAL] Unable to setup webhooks.", error);
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
    documentLog(data, data.operationType.toUpperCase());
    if (pqueue.size < 2) pqueue.add(() => setupWebhooks());
  });
  app.use({
    name: "webhook-change-stream",
    async close() {
      await webhooksChangeStream.close();
    },
  });

  await pqueue.add(() => setupWebhooks());
  console.log("webhook is ready");
}
