import jsonTemplates from "json-templates";
import { setIfDefine } from "../util";

export const defaultUpdateUrl = jsonTemplates(
  "{{insertUrl}}/messages/{{previousResponse.id}}"
);
export const defaultInsertMethod = "POST";
export const defaultUpdateMethod = "PATCH";

export const templatePreset: Readonly<
  Record<string, (parameters: Record<string, any>) => any>
> = Object.freeze({
  "discord-simple-text": jsonTemplates({
    username: "{{authorName}}",
    avatar_url: "{{authorPhoto}}",
    content: "{{authorName}}：{{message:(wordless)}}",
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
            `Poll • At ${parameters.timeCode}` +
            (parameters.voteCount ? ` • ${parameters.voteCount} votes` : ""),
          url: `https://youtu.be/${parameters.originVideoId}?t=${parameters.timeSecond}`,
          thumbnail: {
            url: `https://i.ytimg.com/vi/${parameters.originVideoId}/mqdefault.jpg`,
          },
          description: `${parameters.question}\n${parameters.choices
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
  "discord-embed-raids": jsonTemplates({
    embeds: [
      {
        author: {
          name: "{{sourceName}}",
          url: "https://www.youtube.com/channel/{{sourceChannelId}}",
          icon_url: "{{sourcePhoto}}",
        },
        title: "Raid Event • At {{timeCode}}",
        url: "https://youtu.be/{{originVideoId}}?t={{timeSecond}}",
        thumbnail: {
          url: "https://i.ytimg.com/vi/{{originVideoId}}/mqdefault.jpg",
        },
        description:
          "{{sourceName:unknow}} and their viewers just joined. Say hello!",
        footer: {
          text: "{{video.title}}",
          icon_url: "{{channel.avatarUrl}}",
        },
        timestamp: "{{timestamp}}",
      },
    ],
  }),
});

function getMessage(parameters: Record<string, any>) {
  if (parameters.message)
    return parameters.message.replace(/[\uFFF9\uFFFB]/g, "");
  if (parameters.text) return parameters.text;
  if (parameters.collection === "memberships") {
    return parameters.level ? `歡迎加入 ${parameters.level}` : "新會員";
  }
  if (parameters.collection === "membershipgifts") {
    return `獲得了 ${parameters.senderName} 送出的會籍`;
  }
  if (parameters.collection === "membershipgiftpurchases") {
    return `送出了 ${parameters.amount} 個「${parameters.channelName}」的會籍`;
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
