import { isDocument, type DocumentType } from "@typegoose/typegoose";
import { google, type youtube_v3 } from "googleapis";
import { VideoStatus } from "holodex.js";
import moment from "moment-timezone";
import assert from "node:assert";
import { GOOGLE_API_KEY, YOUTUBE_API_TIMEOUT_MS } from "../constants.js";
import { HoneybeeStatus } from "../interfaces.js";
import ChannelModel, { type Channel } from "../models/Channel.js";
import VideoModel, {
  type DiscoveredVideo,
  type Video,
} from "../models/Video.js";

let youtubeApi: youtube_v3.Youtube | undefined;

export function getYoutubeApi() {
  if (!youtubeApi) {
    assert(GOOGLE_API_KEY, "GOOGLE_API_KEY should be defined.");

    youtubeApi = google.youtube({
      version: "v3",
      auth: GOOGLE_API_KEY,
      // gaxios has no default timeout (it only builds an AbortSignal when one
      // is passed), so without this a hung request never lets the job that made
      // it finish. This is the only place a client is built, so one line covers
      // every YouTube API call.
      timeout: YOUTUBE_API_TIMEOUT_MS,
    });
  }

  return youtubeApi;
}

export async function updateVideoFromYoutube(
  targetVideos: string[]
): Promise<DocumentType<Video>[]> {
  const utcDate = moment.tz("UTC");
  if (!targetVideos.length) return [];

  const youtube = getYoutubeApi();
  const response = await youtube.videos.list({
    part: [
      "snippet",
      "status",
      "contentDetails",
      "liveStreamingDetails",
      "statistics",
    ],
    id: targetVideos,
    hl: "ja",
    fields:
      "items(id,snippet(channelId,title,description,publishedAt,liveBroadcastContent),contentDetails(licensedContent,contentRating/ytRating,duration),status(uploadStatus,embeddable,privacyStatus),liveStreamingDetails,statistics(viewCount,likeCount))",
    maxResults: 50,
  });
  // A resolved response with no items means every requested id is gone
  // (deleted / private / nonexistent) — API/quota errors throw before here — so
  // fall through and let the per-video loop mark the missing ids deleted.
  const ytVideoItems = response?.data?.items ?? [];

  const result: DocumentType<Video>[] = [];
  const needUpdateChannels: string[] = [];
  for (const targetVideo of targetVideos) {
    try {
      const ytInfo = ytVideoItems.find(
        (ytVideoItem) => ytVideoItem.id === targetVideo
      );
      const existing = await VideoModel.findByVideoId(targetVideo);
      // A never-before-seen id that YouTube omits (deleted / private / nonexistent)
      // has no channel/title to persist and is not a video we track — skip it
      // instead of creating an invalid phantom record that would fail validation.
      if (!ytInfo && !existing) continue;
      const video = existing ?? new VideoModel({ id: targetVideo });
      if (ytInfo) {
        if (ytInfo.snippet?.channelId)
          video.channelId = ytInfo.snippet.channelId;
        if (ytInfo.snippet?.title) video.title = ytInfo.snippet.title;
        if (ytInfo.snippet?.description)
          video.description = ytInfo.snippet.description;
        if (ytInfo.snippet?.publishedAt)
          video.publishedAt = new Date(ytInfo.snippet.publishedAt);
        if (ytInfo.statistics?.likeCount)
          video.likes = Math.max(
            video.likes ?? 0,
            +ytInfo.statistics.likeCount
          );

        if (ytInfo.liveStreamingDetails) {
          // live stream
          video.scheduledStart = ytInfo.liveStreamingDetails.scheduledStartTime
            ? new Date(ytInfo.liveStreamingDetails.scheduledStartTime)
            : undefined;
          video.actualStart = ytInfo.liveStreamingDetails.actualStartTime
            ? new Date(ytInfo.liveStreamingDetails.actualStartTime)
            : undefined;
          video.actualEnd = ytInfo.liveStreamingDetails.actualEndTime
            ? new Date(ytInfo.liveStreamingDetails.actualEndTime)
            : undefined;
          if (ytInfo.liveStreamingDetails.concurrentViewers) {
            video.viewers = +ytInfo.liveStreamingDetails.concurrentViewers;
            video.maxViewers = Math.max(
              video.maxViewers ?? 0,
              +ytInfo.liveStreamingDetails.concurrentViewers
            );
          }
          if (video.actualEnd) {
            video.status = VideoStatus.Past;
          } else if (video.actualStart) {
            if (
              ytInfo.liveStreamingDetails.concurrentViewers === undefined &&
              utcDate.isAfter(moment(video.actualStart).add(2, "days"))
            ) {
              // assume that a Livestream is LIVE for more than 2 days without any viewers is MISSING.
              video.status = VideoStatus.Missing;
            } else {
              video.status = VideoStatus.Live;
            }
          } else if (video.scheduledStart) {
            if (utcDate.isSameOrAfter(video.scheduledStart)) {
              if (
                utcDate.isAfter(moment(video.scheduledStart).add(2, "days")) &&
                !video.isFreeChat()
              ) {
                // assume a live that is overslept for 48 hours is 'Missing'
                video.status = VideoStatus.Missing;
              } else {
                video.status = VideoStatus.Live;
              }
            } else {
              video.status = VideoStatus.Upcoming;
            }
          } else {
            if (utcDate.isAfter(moment(video.publishedAt).add(5, "days"))) {
              video.status = VideoStatus.Missing;
            } else {
              video.status = VideoStatus.Upcoming;
            }
          }
        } else {
          // uploaded video
          video.status = VideoStatus.Past;
          video.uploadedVideo = true;
        }
        if (video.actualEnd && video.actualStart) {
          video.duration = moment(video.actualEnd).diff(
            video.actualStart,
            "seconds"
          );
        }
        if (ytInfo.contentDetails?.duration && !video.duration) {
          const ytDuration = moment
            .duration(ytInfo.contentDetails.duration)
            .as("seconds");
          if (ytDuration > 0) {
            video.duration = ytDuration;
          }
        }
        video.premiere =
          video.premiere ||
          ((ytInfo.snippet?.liveBroadcastContent === "upcoming" ||
            ytInfo.snippet?.liveBroadcastContent === "live") &&
            ytInfo.status?.uploadStatus === "processed");
        video.memberLimited =
          ytInfo.statistics && ytInfo.statistics.viewCount === undefined;
        video.privacyStatus = ytInfo.status
          ?.privacyStatus as Video["privacyStatus"];
        video.uploadStatus = ytInfo.status
          ?.uploadStatus as Video["uploadStatus"];
        if (video.deleted) {
          video.deleted = false;
          video.detectedDeletionAt = undefined;
        }
      } else {
        video.status = VideoStatus.Missing;
        if (!video.deleted) video.detectedDeletionAt = new Date();
        video.deleted = true;
      }

      if (video.channelId && !video.channel) {
        const channel = await ChannelModel.findByChannelId(video.channelId);
        if (channel) {
          video.channel = channel;
        } else {
          needUpdateChannels.push(video.channelId);
        }
      }
      if (video.channel && isDocument(video.channel)) {
        if (video.channel.hbIgnore) video.hbIgnore = true;
      }

      video.duration ??= 0;
      video.availableAt =
        video.actualStart ??
        video.scheduledStart ??
        video.publishedAt ??
        video.availableAt ??
        new Date();
      video.crawledAt = new Date();
      video.hbStatus ??= HoneybeeStatus.Created;
      // YouTube omitting the id is the one fact worth persisting here, and the
      // document may lack required fields because of how it was created (an
      // upsert bypasses validators). Validating would reject this write and
      // leave the document in its old state, so it would be picked up again on
      // every round forever.
      await video.save({ validateBeforeSave: !!ytInfo });
      result.push(video);
    } catch (error) {
      // One bad document must not cost the rest of the batch its update.
      console.error(
        `[updateVideoFromYoutube] failed to update ${targetVideo}:`,
        error
      );
    }
  }

  await updateChannelFromYoutube(needUpdateChannels);
  return result;
}

function applyYoutubeChannelInfo(
  channel: DocumentType<Channel>,
  ytInfo: youtube_v3.Schema$Channel
): void {
  if (ytInfo.snippet?.title) channel.name = ytInfo.snippet.title;
  if (ytInfo.snippet?.customUrl) channel.customUrl = ytInfo.snippet.customUrl;
  if (ytInfo.snippet?.description)
    channel.description = ytInfo.snippet.description;
  if (ytInfo.snippet?.thumbnails?.high?.url)
    channel.avatarUrl = ytInfo.snippet.thumbnails.high.url;
  if (ytInfo.brandingSettings?.image?.bannerExternalUrl)
    channel.bannerUrl = ytInfo.brandingSettings.image.bannerExternalUrl;
  if (ytInfo.snippet?.publishedAt)
    channel.publishedAt = new Date(ytInfo.snippet.publishedAt);
  if (ytInfo.statistics?.viewCount)
    channel.viewCount = Number(ytInfo.statistics.viewCount);
  if (ytInfo.statistics?.videoCount)
    channel.videoCount = Number(ytInfo.statistics.videoCount);
  if (ytInfo.statistics?.subscriberCount)
    channel.subscriberCount = Number(ytInfo.statistics.subscriberCount);
  if (channel.deleted) channel.deleted = false;
}

export async function updateChannelFromYoutube(
  targetChannels: string[]
): Promise<DocumentType<Channel>[]> {
  if (!targetChannels.length) return [];

  const youtube = getYoutubeApi();
  const response = await youtube.channels.list({
    part: ["snippet", "contentDetails", "statistics", "brandingSettings"],
    id: targetChannels,
    hl: "ja",
    maxResults: 50,
  });
  // A resolved response with no items means every requested id is gone
  // (deleted / private / nonexistent) — API/quota errors throw before here — so
  // fall through and let the per-channel loop mark the missing ids deleted.
  const ytChannelItems = response?.data?.items ?? [];

  const result: DocumentType<Channel>[] = [];
  for (const targetChannel of targetChannels) {
    try {
      const ytInfo = ytChannelItems.find(
        (ytChannelItem) => ytChannelItem.id === targetChannel
      );
      const existing = await ChannelModel.findByChannelId(targetChannel);
      // A never-before-seen id that YouTube omits has no name to persist and is
      // not a channel we track — skip it instead of creating an invalid phantom
      // record that would fail validation.
      if (!ytInfo && !existing) continue;
      const channel = existing ?? new ChannelModel({ id: targetChannel });
      if (ytInfo) {
        applyYoutubeChannelInfo(channel, ytInfo);
      } else {
        channel.deleted = true;
      }
      channel.crawledAt = new Date();
      // Same reason as the video path: a channel inserted by a validator-
      // bypassing upsert can lack the required name, and validating would reject
      // this write and leave it stuck in the candidate list forever.
      await channel.save({ validateBeforeSave: !!ytInfo });
      result.push(channel);
    } catch (error) {
      // This function runs at the end of the video update, so an escaping
      // error would also drop a batch of videos that already saved fine.
      console.error(
        `[updateChannelFromYoutube] failed to update ${targetChannel}:`,
        error
      );
    }
  }

  return result;
}

export async function updateChannelByHandle(
  handle: string
): Promise<DocumentType<Channel> | null> {
  const youtube = getYoutubeApi();
  const response = await youtube.channels.list({
    part: ["snippet", "contentDetails", "statistics", "brandingSettings"],
    forHandle: handle,
    hl: "ja",
    maxResults: 1,
  });
  const ytInfo = response?.data?.items?.[0];
  if (!ytInfo?.id) return null;

  const channel =
    (await ChannelModel.findByChannelId(ytInfo.id)) ??
    new ChannelModel({ id: ytInfo.id });

  applyYoutubeChannelInfo(channel, ytInfo);
  channel.crawledAt = new Date();
  await channel.save();
  return channel;
}

/**
 * Result of reading one playlist page. Returned rather than thrown so a caller
 * looping over channels can tell "this one playlist is gone" apart from "the
 * whole key is out of quota", which is the only failure that should stop a
 * round.
 */
export type PlaylistScanResult =
  | { ok: true }
  | { ok: false; kind: "quotaExceeded"; message: string }
  | { ok: false; kind: "notFound"; message: string }
  | { ok: false; kind: "error"; message: string };

/**
 * Reads the first page of a playlist and creates whatever videos are new.
 *
 * Takes a playlist id, not a channel id: the playlist is the entire input, and
 * hardcoding one channel's members-only playlist would make the function
 * useless for any other playlist.
 *
 * Does NOT hydrate metadata. `playlistItems.list` carries no
 * liveStreamingDetails, duration, uploadStatus or statistics, so the videos are
 * created bare and the existing `crawler youtube update` job fills them in
 * within its fixed budget — which is what keeps this subsystem's quota cost a
 * constant instead of scaling with how much is discovered.
 */
export async function updateVideoFromPlaylist(
  playlistId: string
): Promise<PlaylistScanResult> {
  const youtube = getYoutubeApi();
  try {
    const response = await youtube.playlistItems.list(
      {
        part: ["snippet", "contentDetails"],
        playlistId,
        maxResults: 50,
      },
      // Retries belong in this second argument; googleapis assembles its
      // request options from it alone. They are off because every attempt costs
      // a quota unit even when it fails, and the rotation is already the retry
      // — a channel that fails keeps its place in line and comes back next lap.
      { retry: false }
    );

    const entries: DiscoveredVideo[] = [];
    for (const item of response?.data?.items ?? []) {
      const videoId = item.contentDetails?.videoId;
      const title = item.snippet?.title;
      // The owner of the video, not whoever added it to the playlist. For an
      // auto-generated uploads playlist these agree, but only this one is right
      // in general.
      const channelId = item.snippet?.videoOwnerChannelId;
      if (!videoId || !title || !channelId) continue;
      const publishedAt = item.contentDetails?.videoPublishedAt;
      entries.push({
        videoId,
        title,
        channelId,
        publishedAt: publishedAt ? new Date(publishedAt) : undefined,
      });
    }

    await VideoModel.noticeUnknownVideos(entries);
    return { ok: true };
  } catch (error) {
    // gaxios puts the status on the error itself as well as on the response,
    // and googleapis-common passes its errors through unwrapped.
    const failure = error as {
      status?: number;
      response?: {
        status?: number;
        data?: { error?: { errors?: { reason?: string }[] } };
      };
    };
    const status = failure.status ?? failure.response?.status;
    const reason = failure.response?.data?.error?.errors?.[0]?.reason;
    const message = error instanceof Error ? error.message : String(error);

    // Not every 403 is a dead key. This endpoint documents
    // `playlistItemsNotAccessible` for a playlist the caller may not read,
    // which says nothing about the remaining channels — an exhausted budget is
    // the one condition that justifies abandoning the round, so it is the one
    // reason matched here. Anything else, recognised or not, is an ordinary
    // failure: continuing costs a few wasted units at worst, whereas stopping
    // on a single unreadable playlist would silently halve a round's coverage.
    if (status === 403 && reason === "quotaExceeded") {
      return { ok: false, kind: "quotaExceeded", message };
    }
    if (status === 404) return { ok: false, kind: "notFound", message };
    return { ok: false, kind: "error", message };
  }
}

export function validateChannelId(channelId: string): boolean {
  return (
    typeof channelId === "string" &&
    channelId.length === 24 &&
    channelId.startsWith("UC") &&
    /^[a-zA-Z0-9_-]+$/.test(channelId)
  );
}
