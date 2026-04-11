import type { DocumentType } from "@typegoose/typegoose";
import { DefaultRestOptions, Routes } from "discord.js";
import type { FlattenMaps } from "mongoose";
import assert from "node:assert";
import { configredWebhookFields, trackFeatures } from "../data/track.js";
import TrackModel, { type Track } from "../models/Track.js";
import WebhookModel, { type Webhook } from "../models/Webhook.js";
import type { Application } from "../modules/application.js";
import type { AgendaModule } from "../modules/schedule.js";

export default function trackOperator(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  agenda.define("transform tracks", transformTracks);
  void agenda.every("1 hour", "transform tracks");
}

async function transformTracks() {
  for await (const track of TrackModel.find()) {
    await transformTrack(track);
  }
  for await (const webhook of WebhookModel.aggregate([
    {
      $match: {
        track: { $ne: null },
      },
    },
    {
      $lookup: {
        from: "tracks",
        localField: "track",
        foreignField: "_id",
        as: "trackDoc",
      },
    },
    {
      $match: {
        trackDoc: { $size: 0 },
      },
    },
  ])) {
    if (!webhook.track) continue;
    const track = await TrackModel.findById(webhook.track);
    if (!track) {
      await WebhookModel.deleteOne({ _id: webhook._id });
    }
  }
}

export async function transformTrack(
  track: DocumentType<Track>
): Promise<void> {
  const enabledFeatures: string[] = [];
  for (const webhook of transformTrackToWebhooks(track)) {
    enabledFeatures.push(webhook.feature!);
    await WebhookModel.updateOne(
      {
        track: track._id,
        feature: webhook.feature,
      },
      {
        $unset: {
          ...Object.fromEntries(
            configredWebhookFields
              .filter(
                (field) => !(field in webhook) || webhook[field] === undefined
              )
              .map((field) => [field, ""])
          ),
          updateUrl: "",
          insertMethod: "",
          updateMethod: "",
        },
        $set: webhook,
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );
  }
  await WebhookModel.deleteMany({
    track: track._id,
    feature: { $nin: enabledFeatures },
  });
}

function* transformTrackToWebhooks(track: DocumentType<Track>) {
  const insertUrl = new URL(
    DefaultRestOptions.api + Routes.webhook(track.clientId, track.token)
  );
  insertUrl.searchParams.set("wait", "true");
  if (track.threadId) {
    insertUrl.searchParams.set("thread_id", track.threadId);
  }

  for (const feature of track.enabledFeatures) {
    const webhook = trackFeatures[feature]?.transform?.(track) as
      | FlattenMaps<Webhook>
      | null
      | undefined;
    if (webhook) {
      webhook.track = track._id;
      webhook.feature = feature;
      webhook.insertUrl = insertUrl.toString();
      yield webhook;
    }
  }
}
