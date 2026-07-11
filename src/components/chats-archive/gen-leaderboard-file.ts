import type { Job } from "agenda";
import type { DocumentType } from "@typegoose/typegoose";
import moment from "moment-timezone";
import type { FilterQuery } from "mongoose";
import VideoModel, { type Video } from "../../models/Video.js";
import { buildVideoSummary } from "./build-video-summary.js";
import { dataFilePath, writeDataFile } from "./write-data-file.js";

export type LeaderboardMetric = "maxViewers" | "likes";

const METRICS: readonly LeaderboardMetric[] = ["maxViewers", "likes"];
const LEADERBOARD_SIZE = 50;
const JST = "Asia/Tokyo";

// URL-friendly directory name for each metric.
const METRIC_DIR: Record<LeaderboardMetric, string> = {
  maxViewers: "maxviewers",
  likes: "likes",
};

type VideoDoc = DocumentType<Video>;

// Each entry is a video summary (see build-video-summary.ts); the ranked metric
// field (maxViewers or likes) is always present and > 0 for entries.
interface Leaderboard {
  date: string; // "YYYY-MM-DD" in JST — the day this file ranks
  snapshotAt: string; // ISO 8601 instant this file was generated
  metric: LeaderboardMetric; // which field entries are ranked by
  entries: Record<string, unknown>[]; // top 50, sorted desc by metric
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
 * Mongo filter for the streams eligible for one JST day + metric: available
 * that day, a positive metric value, and not an uploaded or ignored video.
 */
export function leaderboardFilter(
  date: string,
  metric: LeaderboardMetric
): FilterQuery<Video> {
  const { start, end } = jstDayRangeUtc(date);
  const filter: FilterQuery<Video> = {
    availableAt: { $gte: start, $lt: end },
    uploadedVideo: { $ne: true },
    hbIgnore: { $ne: true },
  };
  filter[metric] = { $gt: 0 };
  return filter;
}

export async function buildLeaderboard(
  date: string,
  metric: LeaderboardMetric,
  videos: VideoDoc[],
  snapshotAt: Date
): Promise<Leaderboard> {
  const ranked = [...videos]
    .sort(
      (a, b) =>
        (b[metric] ?? 0) - (a[metric] ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    .slice(0, LEADERBOARD_SIZE);
  const entries: Record<string, unknown>[] = [];
  for (const video of ranked) entries.push(await buildVideoSummary(video));
  return { date, snapshotAt: snapshotAt.toISOString(), metric, entries };
}

/** Fetch the streams eligible for one JST day + metric. */
export async function queryLeaderboardVideos(
  date: string,
  metric: LeaderboardMetric
): Promise<VideoDoc[]> {
  const videos: VideoDoc[] = [];
  for await (const video of VideoModel.find(leaderboardFilter(date, metric))
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    videos.push(video);
  }
  return videos;
}

/** Regenerate one leaderboard file for a single JST date + metric. */
export async function genLeaderboardFile(
  date: string,
  metric: LeaderboardMetric
): Promise<void> {
  const videos = await queryLeaderboardVideos(date, metric);
  const leaderboard = await buildLeaderboard(date, metric, videos, new Date());
  await writeDataFile(
    dataFilePath("leaderboard", METRIC_DIR[metric], `${date}.json`),
    leaderboard
  );
}

/**
 * Refresh today + yesterday (JST) for both metrics. Both dates derive from one
 * captured `now` so the pair cannot straddle JST midnight between two reads.
 * The optional `job` renews the Agenda lock after each file so a slow run
 * cannot let its lock lapse mid-run.
 */
export async function genDailyLeaderboards(job?: Job): Promise<void> {
  const now = moment.tz(JST);
  const today = now.clone().format("YYYY-MM-DD");
  const yesterday = now.clone().subtract(1, "day").format("YYYY-MM-DD");
  for (const date of [today, yesterday]) {
    for (const metric of METRICS) {
      await genLeaderboardFile(date, metric);
      await job?.touch();
    }
  }
}
