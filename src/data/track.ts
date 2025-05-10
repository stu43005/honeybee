import type { FlattenMaps } from "mongoose";
import type { Track } from "../models/Track";
import { IsNotShortQuery, IsShortQuery } from "../models/Video";
import type { Webhook } from "../models/Webhook";

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
        const uploads =
          track.enabledFeatures.includes("uploads") &&
          Object.keys(getIncludeShortsFilter(track)).length === 0;
        const premieres = track.enabledFeatures.includes("premieres");
        return {
          colls: ["videos"],
          match: {
            channelId: getChannelIdFilter(track),
            status: {
              $in: ["live", "past", "missing"],
            },
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
    uploads: {
      description: `Post when channels upload a new video`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        const includeShortsFilter = getIncludeShortsFilter(track);
        const streams = track.enabledFeatures.includes("streams");
        if (streams && Object.keys(includeShortsFilter).length === 0)
          return null;
        return {
          colls: ["videos"],
          match: {
            channelId: getChannelIdFilter(track),
            uploadedVideo: true,
            ...includeShortsFilter,
            ...getMemberVideosFilter(track),
          },
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
        return {
          colls: ["videos"],
          match: {
            channelId: getChannelIdFilter(track),
            status: {
              $in: ["live", "past", "missing"],
            },
            uploadedVideo: { $ne: true },
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
            channelId: getChannelIdFilter(track),
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
      description: `Include membership-only videos`,
      defaultFeature: true,
    },
    nonMemberVideos: {
      description: `Include non-membership videos`,
      defaultFeature: true,
    },
    includeShorts: {
      description: `Include shorts videos`,
      defaultFeature: true,
    },
    includeNonShorts: {
      description: `Include normal videos`,
      defaultFeature: true,
    },
    chats: {
      description: `Post when tracked channels sends a message on thare owned channel`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        const chatsOtherChannels =
          track.enabledFeatures.includes("chatsOtherChannels");
        return {
          colls: [
            "chats",
            "superchats",
            "superstickers",
            "memberships",
            "milestones",
            "membershipgiftpurchases",
            "membershipgifts",
          ],
          match: {
            authorChannelId: getChannelIdFilter(track),
            ...(chatsOtherChannels
              ? {}
              : { originChannelId: getChannelIdFilter(track) }),
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
        const chats = track.enabledFeatures.includes("chats");
        if (chats) return null;
        return {
          colls: [
            "chats",
            "superchats",
            "superstickers",
            "memberships",
            "milestones",
            "membershipgiftpurchases",
            "membershipgifts",
          ],
          match: {
            authorChannelId: getChannelIdFilter(track),
            originChannelId: getChannelIdFilter(track, true),
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
        const chatBlocklist = [
          ...(chats ? track.trackChannels : []),
          ...track.chatBlocklist,
        ];
        return {
          colls: [
            "chats",
            "superchats",
            "superstickers",
            "memberships",
            "milestones",
            "membershipgiftpurchases",
            "membershipgifts",
          ],
          match: {
            ...(chatBlocklist.length > 0
              ? { authorChannelId: { $nin: chatBlocklist } }
              : {}),
            originChannelId: getChannelIdFilter(track),
            isModerator: true,
            isReplay: { $ne: true },
          },
          templatePreset: "discord-embed-chats",
        };
      },
    },
    polls: {
      description: `Post when tracked channels create a poll`,
      transform: (track) => {
        if (track.trackChannels.length === 0) return null;
        return {
          colls: ["polls"],
          match: {
            originChannelId: getChannelIdFilter(track),
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
            originChannelId: getChannelIdFilter(track),
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
            originChannelId: getChannelIdFilter(track),
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
        return {
          colls: ["raids"],
          match: {
            sourceChannelId: getChannelIdFilter(track),
          },
          followUpdate: true,
          templatePreset: "discord-embed-raids-outgoing",
        };
      },
    },
  } satisfies Record<string, TrackFeaturesConfig>);

function getChannelIdFilter(track: Track, reverse = false) {
  if (track.trackChannels.length === 0) {
    return null;
  }
  if (track.trackChannels.length === 1) {
    if (reverse) {
      return {
        $ne: track.trackChannels[0],
      };
    }
    return track.trackChannels[0];
  }
  if (reverse) {
    return {
      $nin: track.trackChannels,
    };
  }
  return {
    $in: track.trackChannels,
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
