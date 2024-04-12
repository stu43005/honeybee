import { castBool } from "./util";

export const SHUTDOWN_TIMEOUT = 30 * 1000;
export const IGNORE_FREE_CHAT = castBool(process.env.IGNORE_FREE_CHAT ?? false);
export const JOB_CONCURRENCY = Number(process.env.JOB_CONCURRENCY ?? 1);
export const HOLODEX_API_KEY = process.env.HOLODEX_API_KEY ?? "";
export const HOLODEX_ALL_VTUBERS = "All Vtubers";
export const HOLODEX_FETCH_ORG =
  process.env.HOLODEX_FETCH_ORG ?? HOLODEX_ALL_VTUBERS;
export const HOLODEX_MAX_UPCOMING_HOURS = Number(
  process.env.HOLODEX_MAX_UPCOMING_HOURS ?? 12
);
export const CRAWLER_ROOT_URL = process.env.CRAWLER_ROOT_URL;
export const YOUTUBE_PUBSUB_SECRET = process.env.YOUTUBE_PUBSUB_SECRET;
export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
