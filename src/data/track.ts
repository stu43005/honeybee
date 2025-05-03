import type { Track } from "../models/Track";
import type { Webhook } from "../models/Webhook";

export const defaultTrackFeatures = Object.freeze([
  "streams",
  "uploads",
  "premieres",
]);

export const trackFeatures: Readonly<
  Record<string, (track: Track) => Webhook>
> = Object.freeze({

});
