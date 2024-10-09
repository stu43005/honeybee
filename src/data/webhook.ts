import { time } from "@discordjs/formatters";
import type { DocumentType } from "@typegoose/typegoose";
import { VideoStatus } from "holodex.js";
import jsonTemplates from "json-templates";
import moment from "moment";
import path from "node:path";
import ChannelModel from "../models/Channel";
import type { Webhook } from "../models/Webhook";
import { abbreviate, secondsToHms, setIfDefine } from "../util";

export const defaultUpdateUrl = (parameters: Record<string, any>): string => {
  const url = new URL(parameters.insertUrl);
  url.pathname = path.posix.join(
    url.pathname,
    `./messages/${parameters.previousResponse.id}`
  );
  url.searchParams.delete("wait");
  return url.toString();
};

export const defaultInsertMethod = "POST";
export const defaultUpdateMethod = "PATCH";

const MAX_EMBED_TITLE = 256;

export const templatePreset: Readonly<
  Record<string, (parameters: Record<string, any>) => any>
> = Object.freeze({
  "discord-simple-text": jsonTemplates({
    username: "{{authorName}}",
    avatar_url: "{{authorPhoto}}",
    content: "{{authorName}}：{{message:(wordless message)}}",
  }),
  "discord-embed-chats": (parameters) => {
    return {
      embeds: [
        {
          ...(parameters.authorName
            ? {
                author: {
                  name: parameters.authorName,
                  url: `https://www.youtube.com/channel/${parameters.authorChannelId}`,
                  icon_url: parameters.authorPhoto,
                },
              }
            : {}),
          title: `To ${parameters.channel.name} • At ${parameters.timeCode}`,
          url: `https://youtu.be/${parameters.originVideoId}?t=${parameters.timeSecond}`,
          thumbnail: {
            url: `https://i.ytimg.com/vi/${parameters.originVideoId}/mqdefault.jpg`,
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
                  url: `https://www.youtube.com/channel/${parameters.authorChannelId}`,
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
            url: `https://www.youtube.com/channel/${parameters.channel.channelId}`,
            icon_url: parameters.channel.avatarUrl,
          },
          title:
            `Poll • At ${parameters.createdAtTimeCode} ~ ${parameters.timeCode}` +
            (parameters.voteCount ? ` • ${parameters.voteCount} votes` : "") +
            (parameters.finished ? ` • Completed` : ""),
          url: `https://youtu.be/${parameters.originVideoId}?t=${parameters.timeSecond}`,
          thumbnail: {
            url: `https://i.ytimg.com/vi/${parameters.originVideoId}/mqdefault.jpg`,
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
  "discord-embed-modechanges": jsonTemplates({
    embeds: [
      {
        author: {
          name: "{{channel.name}}",
          url: "https://www.youtube.com/channel/{{channel.channelId}}",
          icon_url: "{{channel.avatarUrl}}",
        },
        title: "Mode changed • At {{timeCode}}",
        url: "https://youtu.be/{{originVideoId}}?t={{timeSecond}}",
        thumbnail: {
          url: "https://i.ytimg.com/vi/{{originVideoId}}/mqdefault.jpg",
        },
        description: "{{description:unknow}}",
        fields: [
          {
            name: "Enabled",
            value: "{{enabled}}",
            inline: true,
          },
          {
            name: "Mode",
            value: "{{mode}}",
            inline: true,
          },
        ],
        footer: {
          text: "{{video.title}}",
          icon_url: "{{channel.avatarUrl}}",
        },
        timestamp: "{{timestamp}}",
      },
    ],
  }),
  "discord-embed-raids": (parameters) => {
    return {
      embeds: [
        {
          author: {
            name: parameters.sourceName,
            ...(parameters.sourceChannelId
              ? {
                  url: `https://www.youtube.com/channel/${parameters.sourceChannelId}`,
                }
              : {}),
            icon_url: parameters.sourcePhoto,
          },
          title: `Raid Event • At ${parameters.timeCode}`,
          url: `https://youtu.be/${parameters.originVideoId}?t=${parameters.timeSecond}`,
          thumbnail: {
            url: `https://i.ytimg.com/vi/${parameters.originVideoId}/mqdefault.jpg`,
          },
          description: `${parameters.sourceName} and their viewers just joined. Say hello!`,
          ...(parameters.sourceVideoId
            ? {
                fields: [
                  {
                    name: "Link",
                    value: `[Source Video](https://youtu.be/${parameters.sourceVideoId})`,
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
        },
      ],
    };
  },
  "discord-embed-video": (parameters) => {
    const liveColor = 0xff0000;
    const inactiveColor = 0x870000;
    const uploadColor = 0xff9100;
    const creationColor = 0xff9500;

    const shortTitle = abbreviate(parameters.title, MAX_EMBED_TITLE);
    const shortDescription = abbreviate(parameters.description, 150);
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

    if (parameters.uploadedVideo) {
      // uploaded video
      if (moment.tz().diff(parameters.publishedAt, "hours", true) > 3) {
        // do not post old video
        return;
      }

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
              url: `https://www.youtube.com/channel/${parameters.channel.id}`,
              icon_url: parameters.channel.avatarUrl,
            },
            title: shortTitle,
            url: `https://youtu.be/${parameters.id}`,
            description:
              memberNotice + `Video description: ${shortDescription}`,
            footer: {
              text: `YouTube Upload: ${videoLength}${short}`,
            },
            image: {
              url: `https://i.ytimg.com/vi/${parameters.id}/maxresdefault.jpg`,
            },
            color: uploadColor,
            timestamp: parameters.availableAt,
          },
        ],
      };
    }

    // stream or premiere
    const premiere: boolean = parameters.premiere ?? false;

    switch (parameters.status) {
      case VideoStatus.Upcoming: {
        const eta = time(parameters.scheduledStart, "R");
        return {
          embeds: [
            {
              author: {
                name: `${parameters.channel.name} scheduled a new stream!`,
                url: `https://www.youtube.com/channel/${parameters.channel.id}`,
                icon_url: parameters.channel.avatarUrl,
              },
              title: shortTitle,
              url: `https://youtu.be/${parameters.id}`,
              thumbnail: {
                url: `https://i.ytimg.com/vi/${parameters.id}/mqdefault.jpg`,
              },
              description: `Stream scheduled to start: ${eta}\n\nVideo description: ${shortDescription}`,
              footer: {
                text: "Scheduled start time ",
              },
              color: creationColor,
              timestamp: parameters.scheduledStart,
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
        return {
          embeds: [
            {
              author: {
                name: `${parameters.channel.name}${liveMessage} 🔴`,
                url: `https://www.youtube.com/channel/${parameters.channel.id}`,
                icon_url: parameters.channel.avatarUrl,
              },
              title: shortTitle,
              url: `https://youtu.be/${parameters.id}`,
              description:
                memberNotice + `Video description: ${shortDescription}`,
              footer: {
                text: `Live on YouTube${sinceStr}`,
              },
              image: {
                url: `https://i.ytimg.com/vi/${parameters.id}/maxresdefault.jpg`,
              },
              color: premiere ? uploadColor : liveColor,
              timestamp: parameters.actualStart ?? parameters.scheduledStart,
            },
          ],
        };
      }
      case VideoStatus.Past:
      case VideoStatus.Missing: {
        const vodMessage: string = premiere
          ? " premiered a new video on YouTube!"
          : " was live.";
        const durationStr: string = premiere
          ? "premiere"
          : secondsToHms(parameters.duration);
        return {
          embeds: [
            {
              author: {
                name: `${parameters.channel.name}${vodMessage}`,
                url: `https://www.youtube.com/channel/${parameters.channel.id}`,
                icon_url: parameters.channel.avatarUrl,
              },
              title: shortTitle,
              url: `https://youtu.be/${parameters.id}`,
              thumbnail: {
                url: `https://i.ytimg.com/vi/${parameters.id}/mqdefault.jpg`,
              },
              description: parameters.deleted
                ? "No VOD is available."
                : memberNotice + `Video available: [${durationStr}]`,
              footer: {
                text: "Stream ended",
              },
              color: premiere ? uploadColor : inactiveColor,
              timestamp: parameters.actualEnd ?? parameters.timestamp,
            },
          ],
        };
      }
    }
  },
});

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
    return `送出了 ${parameters.amount} 個「${parameters.channelName}」的會籍`;
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
  "organization-Hololive": async (webhook) => {
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
