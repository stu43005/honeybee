import type { Job } from "agenda";
import type { DocumentType } from "@typegoose/typegoose";
import moment from "moment-timezone";
import type { FilterQuery } from "mongoose";
import VideoModel, { type Video } from "../../models/Video.js";
import { buildVideoSummary } from "./build-video-summary.js";
import { dataFilePath, writeDataFile } from "./write-data-file.js";

const JST = "Asia/Tokyo";

type VideoDoc = DocumentType<Video>;

// Each entry is a video summary (see build-video-summary.ts); the full list of a
// JST day's started streams, availableAt-descending. The frontend re-sorts.
interface DailyVideos {
  date: string; // "YYYY-MM-DD" in JST — the day this file lists
  snapshotAt: string; // ISO 8601 instant this file was generated
  videos: Record<string, unknown>[];
}

/** UTC `[start, end)` instants covering the given `YYYY-MM-DD` JST calendar day. */
export function jstDayRangeUtc(date: string): { start: Date; end: Date } {
  const startOfDay = moment.tz(date, "YYYY-MM-DD", JST).startOf("day");
  return {
    start: startOfDay.toDate(),
    end: startOfDay.clone().add(1, "day").toDate(),
  };
}

/**
 * Mongo filter for the streams listed on one JST day: available that day, having
 * actually started (`actualStart` set), and not an uploaded or ignored video.
 */
export function dailyVideosFilter(date: string): FilterQuery<Video> {
  const { start, end } = jstDayRangeUtc(date);
  return {
    availableAt: { $gte: start, $lt: end },
    actualStart: { $exists: true, $ne: null },
    uploadedVideo: { $ne: true },
    hbIgnore: { $ne: true },
  };
}

function byIdAsc(a: VideoDoc, b: VideoDoc): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export async function buildDailyVideos(
  date: string,
  videos: VideoDoc[],
  snapshotAt: Date
): Promise<DailyVideos> {
  const sorted = [...videos].sort(
    (a, b) => b.availableAt.getTime() - a.availableAt.getTime() || byIdAsc(a, b)
  );
  const out: Record<string, unknown>[] = [];
  for (const video of sorted) out.push(await buildVideoSummary(video));
  return { date, snapshotAt: snapshotAt.toISOString(), videos: out };
}

/** Fetch the started, non-upcoming streams available on one JST day. */
export async function queryDailyVideos(date: string): Promise<VideoDoc[]> {
  const videos: VideoDoc[] = [];
  for await (const video of VideoModel.find(dailyVideosFilter(date))
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    videos.push(video);
  }
  return videos;
}

/** Regenerate the daily-videos file for a single JST date. */
export async function genDailyVideosFile(date: string): Promise<void> {
  const snapshotAt = new Date();
  const videos = await queryDailyVideos(date);
  const daily = await buildDailyVideos(date, videos, snapshotAt);
  await writeDataFile(dataFilePath("daily-videos", `${date}.json`), daily);
}

/**
 * Refresh today + yesterday (JST). Both dates derive from one captured `now` so
 * the pair cannot straddle JST midnight between two reads. The optional `job`
 * renews the Agenda lock after each file.
 */
export async function genDailyVideos(job?: Job): Promise<void> {
  const now = moment.tz(JST);
  const today = now.clone().format("YYYY-MM-DD");
  const yesterday = now.clone().subtract(1, "day").format("YYYY-MM-DD");
  for (const date of [today, yesterday]) {
    await genDailyVideosFile(date);
    await job?.touch();
  }
}
