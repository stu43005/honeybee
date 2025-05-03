import type { FlattenMaps } from "mongoose";
import type { Track } from "../models/Track";
import type { Webhook } from "../models/Webhook";

export const defaultTrackFeatures = Object.freeze([
  "streams",
  "uploads",
  "premieres",
]);

export const configredWebhookFields = Object.freeze([
  "colls",
  "match",
  "matchPreset",
  "filter",
  "followUpdate",
  "templatePreset",
  "template",
] satisfies (keyof FlattenMaps<Webhook>)[]);

export const trackFeatures: Readonly<
  Record<string, (track: Track) => Pick<FlattenMaps<Webhook>, typeof configredWebhookFields[number]>>
> = Object.freeze({});
