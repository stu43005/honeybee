import type { VideoRaw } from "holodex.js";

export enum HoneybeeStatus {
  Created = "Created",
  Stalled = "Stalled",
  WarmingUp = "WarmingUp",
  Progress = "Progress",
  Finished = "Finished",
  Retrying = "Retrying",
  Failed = "Failed",
}

export enum LiveViewersSource {
  Holodex = "holodex",
}

export enum ErrorCode {
  MembersOnly = "MEMBERS_ONLY",
  Private = "PRIVATE",
  Unavailable = "UNAVAILABLE",
  Ban = "BAN",
  Unknown = "UNKNOWN",
}

export interface HoneybeeJob {
  videoId: string;
  stream: VideoRaw;
}

export interface HoneybeeResult {
  error: ErrorCode | null;
  result?: HoneybeeStats;
}

export interface HoneybeeStats {
  handled: number;
  errors: number;
  isWarmingUp: boolean;
}
