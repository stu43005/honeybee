import type { DocumentType } from "@typegoose/typegoose";
import { VideoStatus } from "holodex.js";
import moment from "moment";
import type { Channel } from "../../../models/Channel.js";
import type { Video } from "../../../models/Video.js";
import VideoModel from "../../../models/Video.js";
import { formatCurrency, getVideoPath } from "./format.js";

export interface VideoCardProps {
  video: DocumentType<Video>;
  channel: DocumentType<Channel>;
  basePath: string;
  hbStats:
    | {
        totalSuperChatAmountJpy?: number;
        totalMembers?: number;
        totalGifts?: number;
      }
    | undefined;
}

function StatusText({ video }: { video: DocumentType<Video> }) {
  switch (video.status) {
    case VideoStatus.Upcoming:
      if (video.scheduledStart) {
        return (
          <>
            Start at{" "}
            <time datetime={video.scheduledStart.toISOString()}>
              {moment(video.scheduledStart)
                .tz("Asia/Tokyo")
                .format("YYYY-MM-DD HH:mm")}
            </time>
          </>
        );
      }
      return <>Upcoming</>;
    case VideoStatus.Live:
      return <span style="color: red; font-weight: 500;">Live Now</span>;
    case VideoStatus.Past:
    case VideoStatus.Missing:
      return (
        <>
          Published at{" "}
          <time datetime={video.availableAt.toISOString()}>
            {moment(video.availableAt)
              .tz("Asia/Tokyo")
              .format("YYYY-MM-DD HH:mm")}
          </time>
        </>
      );
    default:
      return <></>;
  }
}

function VideoCard(props: VideoCardProps) {
  const { video, channel, basePath, hbStats } = props;
  const totalSuperChatAmountJpy = hbStats?.totalSuperChatAmountJpy ?? 0;
  const totalMembers = hbStats?.totalMembers ?? 0;
  const totalGifts = hbStats?.totalGifts ?? 0;
  const videoHref = `${basePath}${getVideoPath(video)}`;
  const channelHref = `${basePath}${video.channelId}/index.html`;
  return (
    <div class="col">
      <div class="card">
        <a href={videoHref}>
          <img
            src={VideoModel.getVideoThumbnails(video).medium}
            class="card-img-top"
            alt="Video Thumbnail"
            loading="lazy"
          />
        </a>
        <div class="row g-0 align-items-center">
          <div class="col-md-auto">
            <img
              src={channel.avatarUrl}
              alt="Channel Thumbnail"
              style="height: 48px; width: 48px; border-radius: 50%; margin: 8px;"
              loading="lazy"
            />
          </div>
          <div class="col">
            <div class="card-body" style="padding-left: 0;">
              <h5
                class="card-title"
                style="font-size: 1rem; line-height: 1.25rem; max-height: 2.5rem; white-space: normal; overflow: hidden; text-overflow: ellipsis; word-break: break-all; word-break: break-word; hyphens: auto; -webkit-line-clamp: 2; -webkit-box-orient: vertical;"
              >
                <a href={videoHref}>{video.title}</a>
              </h5>
              <p
                class="card-text"
                style="font-size: .875rem; margin-bottom: 0;"
              >
                <a href={channelHref}>{channel.name}</a>
              </p>
              <p class="card-text">
                <small class="text-body-secondary">
                  <StatusText video={video} />
                </small>
              </p>
            </div>
          </div>
        </div>
        <div
          class="card-footer text-body-secondary text-center"
          style="font-size: 0.875rem;"
        >
          SC: {formatCurrency(totalSuperChatAmountJpy, "JPY")}, Members:{" "}
          {totalMembers.toLocaleString()}, Gifts: {totalGifts.toLocaleString()}
        </div>
      </div>
    </div>
  );
}

export async function renderVideoCard(props: VideoCardProps): Promise<string> {
  return await Promise.resolve(<VideoCard {...props} />);
}
