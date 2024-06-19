import type { DocumentType } from "@typegoose/typegoose";
import axios, { AxiosError } from "axios";
import https from "https";
import jsonTemplates, { type JsonTemplate } from "json-templates";
import mongoose, { mongo } from "mongoose";
import NodeCache from "node-cache";
import { setInterval } from "node:timers/promises";
import pProps from "p-props";
import { isMatching } from "ts-pattern";
import {
  defaultInsertMethod,
  defaultUpdateMethod,
  defaultUpdateUrl,
  templatePreset,
} from "../data/webhook";
import ChannelModel from "../models/Channel";
import VideoModel from "../models/Video";
import WebhookModel, { type Webhook } from "../models/Webhook";
import WebhookResultModel from "../models/WebhookResult";
import { initMongo } from "../modules/db";
import { flatObjectKey, secondsToHms, setIfDefine } from "../util";

const axiosInstance = axios.create({
  timeout: 4000,
  httpsAgent: new https.Agent({
    keepAlive: true,
  }),
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

const cache = new NodeCache({ stdTTL: 60, useClones: false });

function getCache<T>(key: string, factory: (key: string) => T): T {
  let data = cache.get<T>(key);
  if (typeof data === "undefined") {
    data = factory(key);
    cache.set(key, data);
  }
  return data;
}
function getVideo(videoId?: string) {
  return videoId
    ? getCache(videoId, (id) => VideoModel.findByVideoId(id).exec())
    : null;
}
function getChannel(channelId?: string) {
  return channelId
    ? getCache(channelId, (id) => ChannelModel.findByChannelId(id).exec())
    : null;
}
async function getWebhookResult(
  resultKey: Record<string, any>,
  data: mongo.ChangeStreamDocument
) {
  {
    const result = await WebhookResultModel.findOne(resultKey).exec();
    if (result?.response || data.operationType === "insert") {
      return result;
    }
  }
  const timeout = AbortSignal.timeout(3000);
  for await (const _ of setInterval(300)) {
    const result = await WebhookResultModel.findOne(resultKey).exec();
    if (result?.response) {
      return result;
    }
    if (timeout.aborted && result) {
      return result;
    }
    if (timeout.aborted) {
      break;
    }
  }
  return null;
}
function doc2Json(doc: Promise<DocumentType<any> | null> | null) {
  return doc?.then((doc) => doc?.toJSON());
}

async function handleChange(
  webhook: Webhook,
  data: mongo.ChangeStreamDocument
) {
  if (!("documentKey" in data)) return;
  if (!("fullDocument" in data) || !data.fullDocument) {
    webhookLog(webhook, "<!> [ERROR] missing fullDocument", data.documentKey);
    return;
  }

  // webhookLog(webhook, "receive change", data.documentKey);

  const video = getVideo(data.fullDocument.originVideoId);
  const channel =
    getChannel(data.fullDocument.channelId) ??
    getChannel(data.fullDocument.originChannelId) ??
    video?.then((video) => getChannel(video?.channelId)) ??
    null;
  const authorChannel = getChannel(data.fullDocument.authorChannelId);
  const sourceVideo = getVideo(data.fullDocument.sourceVideoId);
  const sourceChannel = getChannel(data.fullDocument.sourceChannelId);

  const timestamp: Date = data.fullDocument.timestamp ?? new Date();
  const timeSecond = video?.then((video) =>
    !video?.actualStart || video.actualStart > timestamp
      ? 0
      : Math.floor((timestamp.getTime() - video.actualStart.getTime()) / 1000)
  );
  const timeCode = timeSecond?.then((timeSecond) => secondsToHms(timeSecond));

  const resultKey = {
    webhookId: webhook._id.toHexString(),
    coll: data.ns.coll,
    docId: data.documentKey._id.toHexString(),
  };

  const previousResult = webhook.followUpdate
    ? getWebhookResult(resultKey, data)
    : null;
  const previousResponse = previousResult?.then((result) => result?.response);

  const getJsonTemplate = getWebhookTemplateCache(webhook);
  const parameters: Record<string, any> = await pProps({
    collection: data.ns.coll,
    insertUrl: webhook.insertUrl,
    ...data.fullDocument,
    timestamp: timestamp.toISOString(),
    timeSecond: timeSecond,
    timeCode: timeCode,
    video: doc2Json(video),
    channel: doc2Json(channel),
    authorChannel: doc2Json(authorChannel),
    sourceVideo: doc2Json(sourceVideo),
    sourceChannel: doc2Json(sourceChannel),
    previousResponse: previousResponse,
  });
  const hasPreviousResponse = !!parameters.previousResponse;

  if (webhook.filter && !isMatching(webhook.filter, parameters)) {
    return;
  }

  let method: string | null = null;
  let url: string | null = null;
  if (data.operationType === "replace" && hasPreviousResponse) {
    if (webhook.replaceMethod) method ??= webhook.replaceMethod;
    if (webhook.replaceUrl)
      url ??= getJsonTemplate("replaceUrl", webhook.replaceUrl)(parameters);
  }
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
      : data.fullDocument;

  await WebhookResultModel.updateOne(
    resultKey,
    {
      $setOnInsert: resultKey,
      $set: {
        method: method,
        url: url,
        body: body,
      },
    },
    { upsert: true }
  );

  try {
    const timeout = AbortSignal.timeout(10_000);
    const res = await axiosInstance.request({
      method,
      url,
      data: body,
      signal: timeout,
    });

    if (webhook.followUpdate) {
      await WebhookResultModel.updateOne(resultKey, {
        $set: {
          statusCode: res.status,
          response: res.data,
        },
      });
    } else {
      await WebhookResultModel.deleteOne(resultKey);
    }
  } catch (error) {
    if (error instanceof AxiosError) {
      await WebhookResultModel.updateOne(resultKey, {
        $set: {
          statusCode: error.response?.status,
          response: error.response?.data,
        },
      });
    }
  }
}

const changeStreams = new Map<string, mongo.ChangeStream>();

async function removeWebhook(data: string | { _id: mongo.ObjectId }) {
  const id = typeof data === "string" ? data : data._id.toHexString();
  const previous = changeStreams.get(id);
  if (previous) {
    try {
      await previous.close();
      previous.removeAllListeners();
      changeStreams.delete(id);
      return previous.resumeToken;
    } catch (error) {
      webhookLog(
        data,
        "<!> [FATAL] Unable to close the previous change stream.",
        error
      );
      process.exit(1);
    }
  }
}

async function setupWebhook(webhook: DocumentType<Webhook>) {
  // validation
  {
    const error = webhook.validateSync();
    if (error) {
      webhookLog(
        webhook,
        "<!> [ERROR] The format of the webhook is incorrect.",
        error
      );
      return;
    }
  }
  try {
    const id = webhook._id.toHexString();

    // close previous change stream
    const resumeAfter = await removeWebhook(id);

    if (webhook.enabled === false) {
      webhookLog(webhook, "webhook disabled, skip.");
      return;
    }

    const conn = mongoose.connection;
    const changeStream = conn.watch(
      [
        {
          $match: flatObjectKey({
            operationType: webhook.followUpdate
              ? { $in: ["insert", "update", "replace"] }
              : "insert",
            ns: {
              coll: { $in: webhook.colls },
            },
            ...setIfDefine("fullDocument", webhook.match),
          }),
        },
      ],
      {
        resumeAfter,
        fullDocument: "updateLookup",
      }
    );
    changeStream.on("change", async (data) => {
      try {
        await handleChange(webhook, data);
      } catch (error) {
        webhookLog(webhook, "<!> [ERROR]", error);
      }
    });
    changeStreams.set(id, changeStream);
  } catch (error) {
    webhookLog(webhook, "<!> [FATAL] Unable to watch change stream.", error);
    process.exit(1);
  }
}

export async function runWebhook() {
  const disconnectFromMongo = await initMongo();

  process.on("SIGTERM", async (s) => {
    console.log("quitting webhook (SIGTERM) ...");

    try {
      await disconnectFromMongo();
    } catch (err) {
      console.log("webhook failed to shut down gracefully", err);
    }

    process.exit(0);
  });

  WebhookModel.watch(
    [
      {
        $match: {
          operationType: { $in: ["insert", "update", "replace", "delete"] },
        },
      },
    ],
    {
      fullDocument: "updateLookup",
    }
  ).on("change", (data: mongo.ChangeStreamDocument<Webhook>) => {
    webhookLog(data, data.operationType.toUpperCase());
    switch (data.operationType) {
      case "insert":
      case "update":
      case "replace": {
        if (data.fullDocument) {
          setupWebhook(new WebhookModel(data.fullDocument));
        } else {
          webhookLog(data, "<!> [FATAL] missing webhook's fullDocument");
          process.exit(1);
        }
        break;
      }
      case "delete": {
        removeWebhook(data.documentKey);
        break;
      }
    }
  });

  for await (const webhook of WebhookModel.find({ enabled: { $ne: false } })) {
    webhookLog(webhook, "START");
    await setupWebhook(webhook);
  }

  console.log("webhook is ready");
}
