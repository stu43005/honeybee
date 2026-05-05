import type { DocumentType } from "@typegoose/typegoose";
import moment from "moment";
import type { mongo } from "mongoose";
import path from "node:path";
import { currencyMap } from "../../../data/currency.js";
import VideoModel, { type Video } from "../../../models/Video.js";

export function formatCurrency(
  amount: number,
  currency: string,
  style: Intl.NumberFormatOptions["style"] = "currency"
): string {
  return amount.toLocaleString("ja-JP", {
    style,
    currency,
    currencyDisplay: "symbol",
    minimumFractionDigits: currencyMap[currency].decimal_digits,
    maximumFractionDigits: currencyMap[currency].decimal_digits,
  });
}

export function getVideoPath(video: DocumentType<Video>): string {
  const date = moment(video.availableAt).tz("Asia/Tokyo").format("YYYYMMDD");
  return path.join(video.channelId, `${date}_${video.id}.html`);
}

export function getTimestamp(current: DocumentType<object>): Date;
export function getTimestamp(current: DocumentType<object> | null): Date | null;
export function getTimestamp(
  current: DocumentType<object> | null
): Date | null {
  if (!current) return null;
  if ("timestamp" in current && current.timestamp instanceof Date) {
    return current.timestamp;
  }
  if ("updatedAt" in current && current.updatedAt instanceof Date) {
    return current.updatedAt;
  }
  if ("createdAt" in current && current.createdAt instanceof Date) {
    return current.createdAt;
  }
  return (current._id as mongo.BSON.ObjectId).getTimestamp();
}

export function FormattedTimestamp(props: {
  video: DocumentType<Video>;
  timestamp: Date;
}) {
  const { video, timestamp } = props;
  const timeSecond = VideoModel.getTimeSeconds(video, timestamp);
  const display = moment(timestamp)
    .tz("Asia/Tokyo")
    .format("YYYY-MM-DD HH:mm:ss");
  const time = <time datetime={timestamp.toISOString()}>{display}</time>;
  return timeSecond ? (
    <a href={VideoModel.getUrl(video, timeSecond)}>{time}</a>
  ) : (
    time
  );
}
