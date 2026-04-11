import type { DocumentType } from "@typegoose/typegoose";
import { DefaultRestOptions, hyperlink, time } from "discord.js";
import { VideoStatus } from "holodex.js";
import moment from "moment-timezone";
import path from "node:path";
import ChannelModel, { Channel } from "../models/Channel.js";
import { Video } from "../models/Video.js";
import type { Webhook } from "../models/Webhook.js";
import { abbreviate, secondsToHms, setIfDefine } from "../util.js";

export function checkIsDiscordWebhookUrl(url: string): boolean {
  return url.startsWith(DefaultRestOptions.api + "/webhooks/");
}

export const defaultUpdateUrl = (parameters: Record<string, any>): string => {
  if (parameters.insertUrl && checkIsDiscordWebhookUrl(parameters.insertUrl)) {
    const url = new URL(parameters.insertUrl);
    url.pathname = path.posix.join(
      url.pathname,
      `./messages/${parameters.previousResponse.id}`
    );
    url.searchParams.delete("wait");
    return url.toString();
  }
  return parameters.insertUrl;
};

export const defaultInsertMethod = "POST";
export const defaultUpdateMethod = "PATCH";

const MAX_EMBED_TITLE = 256;

export const templatePreset: Readonly<
  Record<string, (parameters: Record<string, any>) => any>
> = Object.freeze({
  "discord-simple-text": (parameters) => {
    return {
      username: parameters.authorName,
      avatar_url: parameters.authorPhoto,
      content: `${parameters.authorName}：${getMessage(parameters)}`,
    };
  },
  "discord-embed-chats": (parameters) => {
    return {
      embeds: [
        {
          ...(parameters.authorName
            ? {
                author: {
                  name: parameters.authorName,
                  url: Channel.getUrl(parameters.authorChannelId),
                  icon_url: parameters.authorPhoto,
                },
              }
            : {}),
          title: `To ${parameters.channel.name} • At ${parameters.timeCode}`,
          url: Video.getUrl(parameters.originVideoId, parameters.timeSecond),
          thumbnail: {
            url: Video.getVideoThumbnails(parameters.originVideoId).medium,
          },
          description: getMessage(parameters),
          ...(["superchats", "superstickers"].includes(parameters.collection)
            ? {
                fields: [
                  {
                    name:
                      parameters.collection === "superchats"
                        ? "SuperChat"
                        : "SuperSticker",
                    value: `${parameters.currency} ${parameters.amount}, ${parameters.color}, tier ${parameters.significance}`,
                    inline: true,
                  },
                ],
              }
            : parameters.collection === "milestones"
              ? {
                  fields: [
                    {
                      name: "Milestone",
                      value: `${
                        parameters.level ? `${parameters.level}, ` : ""
                      }since ${parameters.since}`,
                      inline: true,
                    },
                  ],
                }
              : {}),
          footer: {
            text: parameters.video.title,
            icon_url: parameters.channel.avatarUrl,
          },
          timestamp: parameters.timestamp,
          ...setIfDefine("color", getEmbedColor(parameters)),
          ...(parameters.image
            ? {
                image: {
                  url: parameters.image,
                },
              }
            : {}),
        },
      ],
    };
  },
  "discord-embed-chats-minimum": (parameters) => {
    return {
      embeds: [
        {
          ...(parameters.authorName
            ? {
                author: {
                  name: parameters.authorName,
                  url: Channel.getUrl(parameters.authorChannelId),
                  icon_url: parameters.authorPhoto,
                },
              }
            : {}),
          description: getMessage(parameters),
          timestamp: parameters.timestamp,
          ...setIfDefine("color", getEmbedColor(parameters)),
          ...(parameters.image
            ? {
                image: {
                  url: parameters.image,
                },
              }
            : {}),
        },
      ],
    };
  },
  "discord-embed-polls": (parameters) => {
    return {
      embeds: [
        {
          author: {
            name: parameters.channel.name,
            url: Channel.getUrl(parameters.channel.id),
            icon_url: parameters.channel.avatarUrl,
          },
          title:
            `Poll • At ${parameters.createdAtTimeCode} ~ ${parameters.timeCode}` +
            (parameters.voteCount ? ` • ${parameters.voteCount} votes` : "") +
            (parameters.finished ? ` • Completed` : ""),
          url: Video.getUrl(parameters.originVideoId, parameters.timeSecond),
          thumbnail: {
            url: Video.getVideoThumbnails(parameters.originVideoId).medium,
          },
          description: `${
            parameters.question ?? "(empty question)"
          }\n${parameters.choices
            .map(
              (choice: any) =>
                choice.text +
                (choice.voteRatio
                  ? ` (${Math.floor(choice.voteRatio * 1000) / 10}%)`
                  : "")
            )
            .join("\n")}`,
          footer: {
            text: parameters.video.title,
            icon_url: parameters.channel.avatarUrl,
          },
          timestamp: parameters.timestamp,
        },
      ],
    };
  },
  "discord-embed-modechanges": (parameters) => {
    return {
      embeds: [
        {
          author: {
            name: parameters.channel.name,
            url: Channel.getUrl(parameters.originChannelId),
            icon_url: parameters.channel.avatarUrl,
          },
          title: `Mode changed • At ${parameters.timeCode}`,
          url: Video.getUrl(parameters.originVideoId, parameters.timeSecond),
          thumbnail: {
            url: Video.getVideoThumbnails(parameters.originVideoId).medium,
          },
          description: parameters.description ?? "unknown",
          fields: [
            {
              name: "Enabled",
              value: parameters.enabled,
              inline: true,
            },
            {
              name: "Mode",
              value: parameters.mode,
              inline: true,
            },
          ],
          footer: {
            text: parameters.video.title,
            icon_url: parameters.channel.avatarUrl,
          },
          timestamp: parameters.timestamp,
        },
      ],
    };
  },
  "discord-embed-raids": (parameters) => {
    return {
      embeds: [
        {
          author: {
            name: parameters.sourceChannel?.name || parameters.sourceName,
            ...(parameters.sourceChannelId
              ? {
                  url: Channel.getUrl(parameters.sourceChannelId),
                }
              : {}),
            icon_url:
              parameters.sourceChannel?.avatarUrl || parameters.sourcePhoto,
          },
          title: `Raid Incoming • At ${parameters.timeCode}`,
          url: Video.getUrl(parameters.originVideoId, parameters.timeSecond),
          thumbnail: {
            url: Video.getVideoThumbnails(parameters.originVideoId).medium,
          },
          description: `${
            parameters.sourceChannel?.name || parameters.sourceName
          } and their viewers just joined. Say hello!`,
          ...(parameters.sourceVideoId
            ? {
                fields: [
                  {
                    name: "Link",
                    value: hyperlink(
                      "Source Video",
                      Video.getUrl(parameters.sourceVideoId)
                    ),
                    inline: true,
                  },
                ],
              }
            : {}),
          footer: {
            text:
              parameters.video?.title ||
              parameters.channel?.name ||
              parameters.originName,
            icon_url: parameters.channel?.avatarUrl || parameters.originPhoto,
          },
          timestamp: parameters.timestamp,
        },
      ],
    };
  },
  "discord-embed-raids-outgoing": (parameters) => {
    return {
      embeds: [
        {
          author: {
            name: parameters.channel?.name || parameters.originName,
            ...(parameters.originChannelId
              ? {
                  url: Channel.getUrl(parameters.originChannelId),
                }
              : {}),
            icon_url: parameters.channel?.avatarUrl || parameters.originPhoto,
          },
          title: `Raid Outgoing`,
          ...(parameters.sourceVideoId
            ? {
                url: Video.getUrl(parameters.sourceVideoId),
                thumbnail: {
                  url: Video.getVideoThumbnails(parameters.sourceVideoId)
                    .medium,
                },
              }
            : {}),
          description: `Sending you to ${
            parameters.channel?.name || parameters.originName
          }`,
          fields: [
            {
              name: "Link",
              value: hyperlink(
                "Target Video",
                Video.getUrl(parameters.originVideoId)
              ),
              inline: true,
            },
          ],
          footer: {
            text:
              parameters.sourceVideo?.title ||
              parameters.sourceChannel?.name ||
              parameters.sourceName,
            icon_url:
              parameters.sourceChannel?.avatarUrl || parameters.sourcePhoto,
          },
          timestamp: parameters.timestamp,
        },
      ],
    };
  },
  "discord-embed-video": (parameters) => {
    const liveColor = 0xff0000;
    const inactiveColor = 0x870000;
    const uploadColor = 0xff9100;
    const creationColor = 0xff9500;

    const shortTitle = abbreviate(parameters.title ?? "", MAX_EMBED_TITLE);
    const shortDescription = abbreviate(parameters.description ?? "", 150);
    const memberNotice: string = parameters.memberLimited
      ? "Members-only content.\n"
      : "";

    if (
      (parameters.uploadedVideo ||
        parameters.status === VideoStatus.Upcoming) &&
      parameters.webhook?.createdAt &&
      moment(parameters.webhook.createdAt).isAfter(parameters.createdAt)
    ) {
      // do not post video from before webhook was created
      return;
    }

    if (
      parameters.uploadedVideo &&
      ((!parameters.previousResponse &&
        moment.tz().diff(parameters.availableAt, "hours", true) > 3) ||
        (parameters.previousResponse &&
          moment.tz().diff(parameters.availableAt, "hours", true) > 24))
    ) {
      return;
    }

    if (
      parameters.status === VideoStatus.Live &&
      !parameters.actualStart &&
      moment.tz().diff(parameters.availableAt, "hours", true) > 24 &&
      !parameters.previousResponse
    ) {
      // status is live but not actually started
      return;
    }

    if (
      parameters.status === VideoStatus.Past &&
      !parameters.uploadedVideo &&
      ((parameters.actualEnd &&
        moment.tz().diff(parameters.actualEnd, "hours", true) > 24) ||
        !parameters.previousResponse)
    ) {
      return;
    }

    if (
      parameters.status === VideoStatus.Missing &&
      !parameters.uploadedVideo &&
      (moment
        .tz()
        .diff(
          new Date(
            Math.max(
              parameters.availableAt,
              parameters.actualEnd ?? parameters.availableAt,
              parameters.hbEnd ?? parameters.availableAt
            )
          ),
          "hours",
          true
        ) > 24 ||
        !parameters.previousResponse)
    ) {
      return;
    }

    if (parameters.uploadedVideo) {
      // uploaded video
      const videoLength: string = parameters.duration
        ? secondsToHms(parameters.duration)
        : "unknown";
      const short: string =
        parameters.duration && parameters.duration < 60 ? " (short)" : "";

      return {
        embeds: [
          {
            author: {
              name: `${parameters.channel.name} posted a new video on YouTube!`,
              url: Channel.getUrl(parameters.channelId),
              icon_url: parameters.channel.avatarUrl,
            },
            title: shortTitle,
            url: Video.getUrl(parameters.id),
            description:
              memberNotice + `Video description: ${shortDescription}`,
            footer: {
              text: `YouTube Upload: ${videoLength}${short}`,
            },
            image: {
              url: Video.getVideoThumbnails(parameters.id).maxres,
            },
            color: uploadColor,
            timestamp: toTimestamp(parameters.availableAt),
          },
        ],
      };
    }

    // stream or premiere
    const premiere: boolean = parameters.premiere ?? false;

    switch (parameters.status) {
      case VideoStatus.Upcoming: {
        const timestamp = parameters.scheduledStart ?? parameters.publishedAt;
        const eta = time(timestamp, "R");
        return {
          embeds: [
            {
              author: {
                name: `${parameters.channel.name} scheduled a new stream!`,
                url: Channel.getUrl(parameters.channelId),
                icon_url: parameters.channel.avatarUrl,
              },
              title: shortTitle,
              url: Video.getUrl(parameters.id),
              thumbnail: {
                url: Video.getVideoThumbnails(parameters.id).medium,
              },
              description: `Stream scheduled to start: ${eta}\n\nVideo description: ${shortDescription}`,
              footer: {
                text: "Scheduled start time ",
              },
              color: creationColor,
              timestamp: toTimestamp(timestamp),
            },
          ],
        };
      }
      case VideoStatus.Live: {
        const sinceStr: string = parameters.actualStart ? " since " : " ";
        const liveMessage: string = premiere
          ? " is premiering a new video!"
          : parameters.actualStart
            ? " is live."
            : " went live!";
        const timestamp = parameters.actualStart ?? parameters.scheduledStart;
        return {
          embeds: [
            {
              author: {
                name: `${parameters.channel.name}${liveMessage} 🔴`,
                url: Channel.getUrl(parameters.channelId),
                icon_url: parameters.channel.avatarUrl,
              },
              title: shortTitle,
              url: Video.getUrl(parameters.id),
              description:
                memberNotice + `Video description: ${shortDescription}`,
              footer: {
                text: `Live on YouTube${sinceStr}`,
              },
              image: {
                url: Video.getVideoThumbnails(parameters.id).maxres,
              },
              color: premiere ? uploadColor : liveColor,
              timestamp: toTimestamp(timestamp),
            },
          ],
        };
      }
      case VideoStatus.Past:
      case VideoStatus.Missing: {
        const vodMessage: string = !parameters.actualStart
          ? " never started this stream."
          : premiere
            ? " premiered a new video on YouTube!"
            : " was live.";
        const durationStr: string = premiere
          ? "premiere"
          : secondsToHms(parameters.duration);
        const timestamp = parameters.actualEnd ?? parameters.timestamp;
        return {
          embeds: [
            {
              author: {
                name: `${parameters.channel.name}${vodMessage}`,
                url: Channel.getUrl(parameters.channelId),
                icon_url: parameters.channel.avatarUrl,
              },
              title: shortTitle,
              url: Video.getUrl(parameters.id),
              thumbnail: {
                url: Video.getVideoThumbnails(parameters.id).medium,
              },
              description: !parameters.actualStart
                ? "Live stream has never started."
                : parameters.deleted
                  ? "No VOD is available."
                  : memberNotice + `Video available: [${durationStr}]`,
              footer: {
                text: "Stream ended",
              },
              color: premiere ? uploadColor : inactiveColor,
              timestamp: toTimestamp(timestamp),
            },
          ],
        };
      }
    }
  },
});

function toTimestamp(date: Date | string): string {
  if (date instanceof Date) return date.toISOString();
  return date;
}

/**
 * Fix long text by inserting zero-width space
 */
export function fixLongText(text: string): string {
  const words = text.match(/\b\w+\b|./g);
  if (!words) return text;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.length >= 20) {
      const parts = word.match(/.{1,10}/g);
      if (parts) {
        words[i] = parts.join("\u200b");
      }
    }
  }
  return words.join("");
}

function getMessage(parameters: Record<string, any>) {
  if (parameters.message)
    return parameters.message.replace(/[\uFFF9\uFFFB]/g, "");
  if (parameters.collection === "memberships") {
    return parameters.level ? `歡迎加入 ${parameters.level}` : "新會員";
  }
  if (parameters.collection === "membershipgifts") {
    return `獲得了 ${parameters.senderName} 送出的會籍`;
  }
  if (parameters.collection === "membershipgiftpurchases") {
    return parameters.channelName
      ? `送出了 ${parameters.amount} 個「${parameters.channelName}」的會籍`
      : `送出了 ${parameters.amount} 個會籍`;
  }
  if (parameters.collection === "superstickers") {
    return `[Sticker]:${parameters.text}:`;
  }
  if (parameters.collection === "superchats") {
    return "(wordless superchat)";
  }
  if (parameters.collection === "milestones") {
    return "(wordless milestone)";
  }
  return "(wordless message)";
}

function getEmbedColor(parameters: Record<string, any>) {
  if (parameters.isOwner) {
    return 0xffd600; // 台主
  }
  if (
    [
      "memberships",
      "milestones",
      "membershipgifts",
      "membershipgiftpurchases",
    ].includes(parameters.collection)
  ) {
    return 0x0f9d58; // 深綠
  }
  switch (parameters.significance) {
    case 1:
      return 0x1e88e5; // 深藍
    case 2:
      return 0x00e5ff; // 藍
    case 3:
      return 0x1de9b6; // 綠
    case 4:
      return 0xffca28; // 黃
    case 5:
      return 0xf57c00; // 橘
    case 6:
      return 0xe91e63; // 紫
    case 7:
      // case 8:
      return 0xe62117; // 紅
  }
  if (parameters.isModerator) {
    return 0x5e84f1; // 板手
  }
}

export const matchPresets: Readonly<
  Record<string, (webhook: DocumentType<Webhook>) => Promise<any>>
> = Object.freeze({
  "organization-Hololive": async (_webhook) => {
    const channels = await ChannelModel.find(
      { organization: "Hololive" },
      { id: 1 }
    ).sort({ id: 1 });
    return {
      authorChannelId: {
        $in: channels.map((channel) => channel.id),
      },
    };
  },
});
