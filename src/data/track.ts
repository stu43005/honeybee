import type { FlattenMaps } from "mongoose";
import type { Track } from "../models/Track.js";
import { IsNotShortQuery, IsShortQuery } from "../models/Video.js";
import type { Webhook } from "../models/Webhook.js";

type TrackFeaturesConfig = {
  description?: string;
  transform?: (
    track: Track
  ) => Partial<Pick<FlattenMaps<Webhook>, ConfigredWebhookFields>> | null;
  defaultFeature?: boolean;
};

export const trackFeatures: Readonly<Record<string, TrackFeaturesConfig>> =
  Object.freeze({
    streams: {
      description: `Post when channels are live`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        const onlyActualStart =
          track.enabledFeatures.includes("onlyActualStart");
        const premieres = track.enabledFeatures.includes("premieres");
        return {
          colls: ["videos"],
          match: {
            channelId: getChannelIdFilter(track.trackChannels),
            status: {
              $in: ["live", "past", "missing"],
            },
            uploadedVideo: { $ne: true },
            ...(onlyActualStart ? { actualStart: { $exists: true } } : {}),
            ...(premieres ? {} : { premiere: { $ne: true } }),
            ...getMemberVideosFilter(track),
          },
          followUpdate: true,
          templatePreset: "discord-embed-video",
        };
      },
      defaultFeature: true,
    },
    onlyActualStart: {
      description: `[Option] Only post when the actual start, instead of scheduled time`,
    },
    uploads: {
      description: `Post when channels upload a new video`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        return {
          colls: ["videos"],
          match: {
            channelId: getChannelIdFilter(track.trackChannels),
            uploadedVideo: true,
            ...getIncludeShortsFilter(track),
            ...getMemberVideosFilter(track),
          },
          followUpdate: true,
          templatePreset: "discord-embed-video",
        };
      },
      defaultFeature: true,
    },
    premieres: {
      description: `Post when premiere start`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        const streams = track.enabledFeatures.includes("streams");
        if (streams) return null;
        const onlyActualStart =
          track.enabledFeatures.includes("onlyActualStart");
        return {
          colls: ["videos"],
          match: {
            channelId: getChannelIdFilter(track.trackChannels),
            status: {
              $in: ["live", "past", "missing"],
            },
            uploadedVideo: { $ne: true },
            ...(onlyActualStart ? { actualStart: { $exists: true } } : {}),
            premiere: true,
            ...getMemberVideosFilter(track),
          },
          followUpdate: true,
          templatePreset: "discord-embed-video",
        };
      },
      defaultFeature: true,
    },
    upcoming: {
      description: `Post when upcoming videos are scheduled`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        const uploads = track.enabledFeatures.includes("uploads");
        const premieres = track.enabledFeatures.includes("premieres");
        return {
          colls: ["videos"],
          match: {
            channelId: getChannelIdFilter(track.trackChannels),
            status: "upcoming",
            ...(uploads ? {} : { uploadedVideo: { $ne: true } }),
            ...(premieres ? {} : { premiere: { $ne: true } }),
            ...getMemberVideosFilter(track),
          },
          followUpdate: true,
          templatePreset: "discord-embed-video",
        };
      },
      defaultFeature: true,
    },
    memberVideos: {
      description: `[Option] Include membership-only videos`,
      defaultFeature: true,
    },
    nonMemberVideos: {
      description: `[Option] Include non-membership videos`,
      defaultFeature: true,
    },
    includeShorts: {
      description: `[Option] Include shorts videos`,
      defaultFeature: true,
    },
    includeNonShorts: {
      description: `[Option] Include normal videos`,
      defaultFeature: true,
    },
    chats: {
      description: `Post when tracked channels sends a message on thare owned channel`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        const withoutNormalChats =
          track.enabledFeatures.includes("withoutNormalChats");
        return {
          colls: [
            ...(withoutNormalChats ? [] : ["chats"]),
            "superchats",
            "superstickers",
            "gifts",
            "memberships",
            "milestones",
            "membershipgiftpurchases",
            "membershipgifts",
          ],
          match: {
            authorChannelId: getChannelIdFilter(track.trackChannels),
            originChannelId: getChannelIdFilter(track.trackChannels),
            isReplay: { $ne: true },
          },
          templatePreset: "discord-embed-chats",
        };
      },
    },
    chatsOtherChannels: {
      description: `Post when tracked channels sends a message on other channels`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        const withoutNormalChats =
          track.enabledFeatures.includes("withoutNormalChats");
        return {
          colls: [
            ...(withoutNormalChats ? [] : ["chats"]),
            "superchats",
            "superstickers",
            "gifts",
            "memberships",
            "milestones",
            "membershipgiftpurchases",
            "membershipgifts",
          ],
          match: {
            authorChannelId: getChannelIdFilter(track.trackChannels),
            originChannelId: getChannelIdFilter(track.trackChannels, true),
            isReplay: { $ne: true },
          },
          templatePreset: "discord-embed-chats",
        };
      },
    },
    moderatorChats: {
      description: `Post when moderator sends a message on tracked channel`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        const chats = track.enabledFeatures.includes("chats");
        const followedChats = track.enabledFeatures.includes("followedChats");
        const withoutNormalChats =
          track.enabledFeatures.includes("withoutNormalChats");
        const chatBlocklist = new Set([
          ...(chats ? track.trackChannels : []),
          ...(followedChats ? track.chatFollowlist : []),
          ...track.chatBlocklist,
        ]);
        return {
          colls: [
            ...(withoutNormalChats ? [] : ["chats"]),
            "superchats",
            "superstickers",
            "gifts",
            "memberships",
            "milestones",
            "membershipgiftpurchases",
            "membershipgifts",
          ],
          match: {
            ...(chatBlocklist.size > 0
              ? { authorChannelId: { $nin: Array.from(chatBlocklist) } }
              : {}),
            originChannelId: getChannelIdFilter(track.trackChannels),
            isModerator: true,
            isReplay: { $ne: true },
          },
          templatePreset: "discord-embed-chats",
        };
      },
    },
    followedChats: {
      description: `Post when followed sender sends a message on tracked channel`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        const withoutNormalChats =
          track.enabledFeatures.includes("withoutNormalChats");
        const chatFollowlist = new Set(track.chatFollowlist);
        if (track.enabledFeatures.includes("chats")) {
          track.trackChannels.forEach((channelId) =>
            chatFollowlist.delete(channelId)
          );
        }
        if (chatFollowlist.size === 0) return null;
        return {
          colls: [
            ...(withoutNormalChats ? [] : ["chats"]),
            "superchats",
            "superstickers",
            "gifts",
            "memberships",
            "milestones",
            "membershipgiftpurchases",
            "membershipgifts",
          ],
          match: {
            authorChannelId: { $in: Array.from(chatFollowlist) },
            originChannelId: getChannelIdFilter(track.trackChannels),
            isReplay: { $ne: true },
          },
          templatePreset: "discord-embed-chats",
        };
      },
    },
    withoutNormalChats: {
      description: `[Option] Don't post normal chats, only superchats, memberships, etc.`,
    },
    polls: {
      description: `Post when tracked channels create a poll`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        return {
          colls: ["polls"],
          match: {
            originChannelId: getChannelIdFilter(track.trackChannels),
          },
          followUpdate: true,
          templatePreset: "discord-embed-polls",
        };
      },
    },
    modechanges: {
      description: `Post when tracked channels change the chat mode`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        return {
          colls: ["modechanges"],
          match: {
            originChannelId: getChannelIdFilter(track.trackChannels),
            isReplay: { $ne: true },
          },
          templatePreset: "discord-embed-modechanges",
        };
      },
    },
    raids: {
      description: `Post when someone raids the tracked channels`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        return {
          colls: ["raids"],
          match: {
            originChannelId: getChannelIdFilter(track.trackChannels),
          },
          followUpdate: true,
          templatePreset: "discord-embed-raids",
        };
      },
    },
    raidsOutgoing: {
      description: `Post when tracked channels raids to other channels`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        const onlyOne = track.trackChannels.length === 1;
        return {
          colls: ["raids"],
          match: {
            sourceChannelId: getChannelIdFilter(track.trackChannels),
            ...(onlyOne
              ? {}
              : {
                  originChannelId: getChannelIdFilter(
                    track.trackChannels,
                    true
                  ),
                }),
          },
          followUpdate: true,
          templatePreset: "discord-embed-raids-outgoing",
        };
      },
    },
  } satisfies Record<string, TrackFeaturesConfig>);

export function getChannelIdFilter(channelIds: string[], reverse = false) {
  if (channelIds.length === 0) {
    return null;
  }
  if (channelIds.length === 1) {
    if (reverse) {
      return {
        $ne: channelIds[0],
      };
    }
    return channelIds[0];
  }
  if (reverse) {
    return {
      $nin: channelIds,
    };
  }
  return {
    $in: channelIds,
  };
}

function getIncludeShortsFilter(track: Track) {
  const includeShorts = track.enabledFeatures.includes("includeShorts");
  const includeNonShorts = track.enabledFeatures.includes("includeNonShorts");
  return {
    ...(includeShorts && !includeNonShorts
      ? IsShortQuery
      : !includeShorts && includeNonShorts
        ? IsNotShortQuery
        : {}),
  };
}

function getMemberVideosFilter(track: Track) {
  const memberVideos = track.enabledFeatures.includes("memberVideos");
  const nonMemberVideos = track.enabledFeatures.includes("nonMemberVideos");
  return {
    ...(memberVideos && !nonMemberVideos
      ? { memberLimited: true }
      : !memberVideos && nonMemberVideos
        ? { memberLimited: { $ne: true } }
        : {}),
  };
}

export const allTrackFeatures = Object.freeze(
  Object.entries(trackFeatures).map(([name]) => name)
);

export const defaultTrackFeatures = Object.freeze(
  Object.entries(trackFeatures)
    .filter(([, value]) => value.defaultFeature)
    .map(([name]) => name)
);

export const configredWebhookFields = Object.freeze([
  "colls",
  "match",
  "matchPreset",
  "filter",
  "followUpdate",
  "templatePreset",
  "template",
] satisfies (keyof FlattenMaps<Webhook>)[]);
type ConfigredWebhookFields = (typeof configredWebhookFields)[number];
