import { google, type youtube_v3 } from "googleapis";
import { VideoStatus } from "holodex.js";
import moment from "moment-timezone";
import assert from "node:assert";
import { GOOGLE_API_KEY } from "../constants";
import { HoneybeeStatus } from "../interfaces";
import ChannelModel from "../models/Channel";
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

  const needUpdateChannels: string[] = [];
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

    if (video.channelId && !video.channel) {
      const channel = await ChannelModel.findByChannelId(video.channelId);
      if (channel) {
        video.channel = channel;
      } else {
        needUpdateChannels.push(video.channelId);
      }
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
    await video.save();
  }

  await updateChannelFromYoutube(needUpdateChannels);
}

export async function updateChannelFromYoutube(targetChannels: string[]) {
  if (!targetChannels.length) return;

  const youtube = getYoutubeApi();
  const response = await youtube.channels.list({
    part: ["snippet", "contentDetails", "statistics", "brandingSettings"],
    id: targetChannels,
    hl: "ja",
    maxResults: 50,
  });
  const ytChannelItems = response?.data?.items;
  if (!ytChannelItems?.length) return;

  for (const targetChannel of targetChannels) {
    const channel =
      (await ChannelModel.findByChannelId(targetChannel)) ??
      new ChannelModel({ id: targetChannel });
    const ytInfo = ytChannelItems.find(
      (ytChannelItem) => ytChannelItem.id === targetChannel
    );
    if (ytInfo) {
      if (ytInfo.snippet?.title) channel.name = ytInfo.snippet.title;
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
    }
    channel.crawledAt = new Date();
    await channel.save();
  }
}
