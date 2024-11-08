export enum HoneybeeStatus {
  Created = "Created",
  Stalled = "Stalled",
  Progress = "Progress",
  Finished = "Finished",
  Retrying = "Retrying",
  Failed = "Failed",
}

export enum MessageType {
  Milestone = "milestone",
  Membership = "membership",
  MembershipGift = "membershipGift",
  MembershipGiftPurchase = "membershipGiftPurchase",
  SuperChat = "superChat",
  SuperSticker = "superSticker",
  Chat = "chat",
}

export enum MessageAuthorType {
  Owner = "owner",
  Moderator = "moderator",
  Member = "member",
  Verified = "verified",
  Other = "other",
}

export enum ErrorCode {
  MembersOnly = "MEMBERS_ONLY",
  Private = "PRIVATE",
  Unavailable = "UNAVAILABLE",
  Ban = "BAN",
  Unknown = "UNKNOWN",
  Aborted = "ABORTED",
}

export enum UploadStatus {
  Deleted = "deleted",
  Failed = "failed",
  Processed = "processed",
  Rejected = "rejected",
  Uploaded = "uploaded",
}

export enum PrivacyStatus {
  Private = "private",
  Public = "public",
  Unlisted = "unlisted",
}

export interface HoneybeeJob {
  videoId: string;
  /**
   * 1, 2, 3, ...
   */
  replica: number;
  defaultBackoffDelay: number;
}

export interface HoneybeeResult {
  error: ErrorCode | null;
  result?: HoneybeeStats;
}

export interface HoneybeeStats {
  handled: number;
  errors: number;
}
