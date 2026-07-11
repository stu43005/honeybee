import type { Job } from "agenda";
import type { DocumentType } from "@typegoose/typegoose";
import { VideoStatus } from "holodex.js";
import VideoModel, { type Video } from "../../models/Video.js";
import { buildVideoSummary } from "./build-video-summary.js";
import { dataFilePath, writeDataFile } from "./write-data-file.js";

// A stream that has just gone live lingers on the upcoming page for this long
// after its availableAt, so viewers who saw it as upcoming can still find it.
const RECENTLY_STARTED_WINDOW_MS = 10 * 60 * 1000;

type VideoDoc = DocumentType<Video>;

// Each entry is a video summary (see build-video-summary.ts) with a shared base
// of always-present keys plus optional fields including viewers/maxViewers/likes.
interface RealtimeIndex {
  snapshotAt: string; // ISO 8601 instant this file was generated
  live: Record<string, unknown>[]; // status "live", sorted desc by viewers
}

interface UpcomingIndex {
  snapshotAt: string; // ISO 8601 instant this file was generated
  upcoming: Record<string, unknown>[]; // status "upcoming", soonest first
  recentlyStarted: Record<string, unknown>[]; // status "live", started <10 min ago, newest first
}

function byIdAsc(a: VideoDoc, b: VideoDoc): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function summarize(
  videos: VideoDoc[]
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const video of videos) out.push(await buildVideoSummary(video));
  return out;
}

export async function buildRealtimeIndex(
  videos: VideoDoc[],
  snapshotAt: Date
): Promise<RealtimeIndex> {
  const live = videos
    .filter((video) => video.status === VideoStatus.Live)
    .sort((a, b) => (b.viewers ?? 0) - (a.viewers ?? 0) || byIdAsc(a, b));
  return { snapshotAt: snapshotAt.toISOString(), live: await summarize(live) };
}

export async function buildUpcomingIndex(
  videos: VideoDoc[],
  snapshotAt: Date
): Promise<UpcomingIndex> {
  const cutoff = snapshotAt.getTime() - RECENTLY_STARTED_WINDOW_MS;
  const upcomingDocs = videos
    .filter((video) => video.status === VideoStatus.Upcoming)
    .sort(
      (a, b) =>
        a.availableAt.getTime() - b.availableAt.getTime() || byIdAsc(a, b)
    );
  const recentlyStartedDocs = videos
    .filter(
      (video) =>
        video.status === VideoStatus.Live &&
        video.availableAt.getTime() >= cutoff
    )
    .sort(
      (a, b) =>
        b.availableAt.getTime() - a.availableAt.getTime() || byIdAsc(a, b)
    );
  return {
    snapshotAt: snapshotAt.toISOString(),
    upcoming: await summarize(upcomingDocs),
    recentlyStarted: await summarize(recentlyStartedDocs),
  };
}

/** Fetch the current live + upcoming set (bounded to the next 48h). */
export async function queryLiveVideos(): Promise<VideoDoc[]> {
  const videos: VideoDoc[] = [];
  for await (const video of VideoModel.findLiveVideos(48)
    .populate("channel")
    .setOptions({ readPreference: "secondaryPreferred" })) {
    videos.push(video);
  }
  return videos;
}

/**
 * Fetch the current live/upcoming set once, then publish `realtime.json` and
 * `upcoming.json` independently. Each file gets its own `snapshotAt` taken just
 * before it is built, and its own atomic write; readers must treat each file's
 * `snapshotAt` as authoritative for that file only and must not join the two.
 * The optional `job` renews the Agenda lock between the two writes so a slow
 * run cannot let its lock lapse mid-run.
 */
export async function genRealtimeAndUpcomingFiles(job?: Job): Promise<void> {
  const videos = await queryLiveVideos();
  const realtime = await buildRealtimeIndex(videos, new Date());
  await writeDataFile(dataFilePath("realtime.json"), realtime);
  await job?.touch();
  const upcoming = await buildUpcomingIndex(videos, new Date());
  await writeDataFile(dataFilePath("upcoming.json"), upcoming);
}
