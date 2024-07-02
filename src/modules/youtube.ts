import { google, type youtube_v3 } from "googleapis";
import { VideoStatus } from "holodex.js";
import moment from "moment-timezone";
import assert from "node:assert";
import { GOOGLE_API_KEY } from "../constants";
import { HoneybeeStatus, LiveViewersSource } from "../interfaces";
import LiveViewersModel from "../models/LiveViewers";
import VideoModel from "../models/Video";

let youtubeApi: youtube_v3.Youtube | undefined;

export function getYoutubeApi() {
  if (!youtubeApi) {
    assert(GOOGLE_API_KEY, "GOOGLE_API_KEY should be defined.");

    youtubeApi = google.youtube({
      version: "v3",
      auth: GOOGLE_API_KEY,
    });
  }

  return youtubeApi;
}

export async function updateVideoFromYoutube(targetVideos: string[]) {
  const utcDate = moment.tz("UTC");
  if (!targetVideos.length) return;

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
      "items(id,snippet(channelId,title,description,publishedAt),contentDetails(licensedContent,contentRating/ytRating,duration),status(uploadStatus,embeddable,privacyStatus),liveStreamingDetails,statistics/viewCount)",
    maxResults: 50,
  });
  const ytVideoItems = response?.data?.items;
  if (!ytVideoItems?.length) return;

  for (const targetVideo of targetVideos) {
    const video =
      (await VideoModel.findByVideoId(targetVideo)) ??
      new VideoModel({ id: targetVideo });
    const ytInfo = ytVideoItems.find(
      (ytVideoItem) => ytVideoItem.id === targetVideo
    );
    if (ytInfo) {
      if (ytInfo.snippet?.channelId) video.channelId = ytInfo.snippet.channelId;
      if (ytInfo.snippet?.title) video.title = ytInfo.snippet.title;
      if (ytInfo.snippet?.description)
        video.description = ytInfo.snippet.description;
      if (ytInfo.snippet?.publishedAt)
        video.publishedAt = new Date(ytInfo.snippet.publishedAt);

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
          await LiveViewersModel.create({
            originVideoId: video.id,
            originChannelId: video.channelId,
            viewers: ytInfo.liveStreamingDetails.concurrentViewers,
            source: LiveViewersSource.Youtube,
          }).catch(() => void 0);
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
            if (utcDate.isAfter(moment(video.scheduledStart).add(2, "days"))) {
              // assume a live that is overslept for 48 hours is 'Missing'
              video.status = VideoStatus.Missing;
            } else {
              // video.status = VideoStatus.Live;
              video.status = VideoStatus.Upcoming;
            }
          } else {
            video.status = VideoStatus.Upcoming;
          }
        } else {
          video.status = VideoStatus.Upcoming;
        }
      } else {
        // uploaded video
        video.status = VideoStatus.Past;
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
    } else {
      video.status = VideoStatus.Missing;
    }
    video.duration ??= 0;
    video.availableAt =
      video.actualStart ??
      video.scheduledStart ??
      video.publishedAt ??
      video.availableAt ??
      new Date();
    video.crawledAt = new Date();
    video.hbStatus = HoneybeeStatus.Created;
    await video.save();
  }
}
