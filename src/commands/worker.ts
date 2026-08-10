import {
  AbortError,
  Action,
  Masterchat,
  MasterchatError,
  Membership as MCMembership,
  stringify,
  YTEmojiRun,
} from "@stu43005/masterchat";
import axios, { isAxiosError } from "axios";
import BeeQueue from "bee-queue";
import moment from "moment-timezone";
import mongoose from "mongoose";
import { FetchError } from "node-fetch";
import assert from "node:assert";
import https from "node:https";
import { setInterval, setTimeout } from "node:timers/promises";
import {
  JOB_CONCURRENCY,
  YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS,
} from "../constants.js";
import {
  ErrorCode,
  HoneybeeResult,
  HoneybeeStats,
  MessageAuthorType,
  type HoneybeeJob,
} from "../interfaces.js";
import {
  buildGiftUpsertOps,
  getGiftPriceTable,
  mergeGiftActions,
} from "../components/gift.js";
import BanActionModel, { type BanAction } from "../models/BanAction.js";
import BannerActionModel, {
  type BannerAction,
} from "../models/BannerAction.js";
import ChatModel, { type Chat } from "../models/Chat.js";
import ErrorLogModel, { type ErrorLog } from "../models/ErrorLog.js";
import GiftModel from "../models/Gift.js";
import MembershipModel, { type Membership } from "../models/Membership.js";
import MembershipGiftModel, {
  type MembershipGift,
} from "../models/MembershipGift.js";
import MembershipGiftPurchaseModel, {
  type MembershipGiftPurchase,
} from "../models/MembershipGiftPurchase.js";
import MilestoneModel, { type Milestone } from "../models/Milestone.js";
import ModeChangeModel, { type ModeChange } from "../models/ModeChange.js";
import PlaceholderModel, { type Placeholder } from "../models/Placeholder.js";
import PollModel, { type Poll } from "../models/Poll.js";
import RaidModel, { type Raid } from "../models/Raid.js";
import RemoveChatActionModel, {
  type RemoveChatAction,
} from "../models/RemoveChatAction.js";
import SuperChatModel, { type SuperChat } from "../models/SuperChat.js";
import SuperStickerModel, {
  type SuperSticker,
} from "../models/SuperSticker.js";
import VideoModel from "../models/Video.js";
import { Application } from "../modules/application.js";
import {
  currencyToJpyAmount,
  getCurrencymapItem,
} from "../modules/currency-convert.js";
import { MongodbModule } from "../modules/db.js";
import { QueueModule } from "../modules/queue.js";
import { YoutubeWatchGate } from "../modules/youtube-watch-gate.js";
import { RedisModule } from "../modules/redis.js";
import ChannelModel from "../models/Channel.js";
import { updateChannelByHandle } from "../modules/youtube.js";
import { groupBy, pipeSignal, setIfDefine } from "../util.js";

const { MongoError, MongoBulkWriteError } = mongoose.mongo;

/**
 * A YouTube 429 reaches us as a raw AxiosError: masterchat's own rate-limit
 * detection (err.code === "429") never matches an AxiosError (whose code is
 * ERR_BAD_REQUEST), so it does not wrap it. We deliberately do NOT treat
 * masterchat's AccessDeniedError (generic "denied") as 429 — a private /
 * region-blocked video must not poison the shared global cooldown.
 */
export function is429(err: unknown): boolean {
  return isAxiosError(err) && err.response?.status === 429;
}

/**
 * Classify a stats-update failure and react. A 429 records the global cooldown
 * via the gate (every pod backs off); the gate has already set this pod's local
 * backoff, so on a failed Redis record we surface one warning instead of going
 * silent. Aborts/cancels are ignored; everything else is logged.
 */
export async function reportStatsUpdateError(
  err: unknown,
  gate: YoutubeWatchGate,
  log: (...args: unknown[]) => void
): Promise<void> {
  if (err instanceof AbortError || axios.isCancel(err)) {
    return; // ignore
  }
  if (is429(err)) {
    const recorded = await gate.penalize();
    if (!recorded) {
      log(
        "<!> [STATS UPDATE ERROR] 429 detected; global cooldown not recorded (local backoff active)"
      );
    }
    return;
  }
  if (isAxiosError(err)) {
    // only log the error message instead of the whole error object to avoid logging sensitive info like API key
    log(`<!> [STATS UPDATE ERROR] ${err}`);
    return;
  }
  log("<!> [STATS UPDATE ERROR]", err);
}

function emojiHandler(run: YTEmojiRun) {
  const { emoji } = run;

  // https://codepoints.net/specials
  // const term =
  //   emoji.isCustomEmoji || emoji.emojiId === ""
  //     ? `\uFFF9${emoji.shortcuts[emoji.shortcuts.length - 1]}\uFFFA${
  //         emoji.image.thumbnails[0].url
  //       }\uFFFB`
  //     : emoji.emojiId;
  const term =
    emoji.isCustomEmoji || emoji.emojiId === ""
      ? `\uFFF9${emoji.shortcuts[emoji.shortcuts.length - 1]}\uFFFB`
      : emoji.emojiId;
  return term;
}

function normalizeMembership(membership?: MCMembership) {
  return membership ? (membership.since ?? "new") : undefined;
}

function authorTypeLabelmap(
  action: {
    isOwner?: boolean;
    isModerator?: boolean;
    isVerified?: boolean;
    membership?: string;
  },
  defaultType = MessageAuthorType.Other
): MessageAuthorType {
  if (action.isOwner) return MessageAuthorType.Owner;
  if (action.isModerator) return MessageAuthorType.Moderator;
  if (action.membership) return MessageAuthorType.Member;
  if (action.isVerified) return MessageAuthorType.Verified;
  return defaultType;
}

const stringifyOptions = {
  spaces: false,
  emojiHandler,
  // textHandler: (run: YTTextRun): string => {
  //   let text = escapeMarkdown(run.text);
  //   if (run.navigationEndpoint) {
  //     const url = endpointToUrl(run.navigationEndpoint);
  //     if (url) {
  //       text = hyperlink(text, url);
  //     }
  //   }
  //   if (run.bold) {
  //     text = bold(text);
  //   }
  //   if (run.italics) {
  //     text = italic(text);
  //   }
  //   return text;
  // },
};
const insertOptions = { ordered: false };

async function resolveRaidName(name: string): Promise<string> {
  if (!name.startsWith("@")) return name;
  try {
    const channel = await ChannelModel.findByHandle(name);
    if (channel) return channel.name;
    const fetched = await updateChannelByHandle(name);
    if (fetched) return fetched.name;
  } catch {
    // best-effort: return raw name on any failure
  }
  return name;
}

async function handleJob(
  job: BeeQueue.Job<HoneybeeJob>,
  globalSignal: AbortSignal,
  gate: YoutubeWatchGate
): Promise<HoneybeeResult> {
  const { videoId, replica, mode = "live" } = job.data;
  assert(replica, "No specified replica.");
  const isFirstReplica = replica === 1;
  const isReplay = mode === "replay" || undefined;
  const video = await VideoModel.findByVideoId(videoId);
  assert(video, "Unable to find the video.");
  assert(video.getReplicas() >= replica, "Stop replica");
  const { channelId } = video;
  const { name: channelName, avatarUrl: channelAvatarUrl } =
    await video.getChannel();

  if (video.hbIgnore) {
    throw new Error("This video is ignored.");
  }
  if (isReplay && !video.isNeedReplay()) {
    throw new Error("No need to record the replay.");
  }

  // Control cancel all operations
  const cancelController = new AbortController();
  // Control whether to stop the job
  const stopController = new AbortController();
  pipeSignal(globalSignal, cancelController);
  pipeSignal(stopController.signal, cancelController);

  const mc = new Masterchat(videoId, channelId, {
    mode: mode,
    axiosInstance: axios.create({
      timeout: 4000,
      httpsAgent: new https.Agent({
        keepAlive: true,
      }),
    }),
  });
  const stats: HoneybeeStats = { handled: 0, errors: 0 };

  function videoLog(...obj: any) {
    console.log(`${videoId} ${channelId} ${replica} -`, ...obj);
  }

  function refreshStats(actions: Action[]) {
    stats.handled += actions.length;
    job.reportProgress(stats);
  }

  async function handleActions(actions: Action[]) {
    const groupedActions = groupBy(actions, "type");
    const actionTypes = Object.keys(groupedActions) as Action["type"][];
    // Gifts ship no timestamp of their own when their id does not decode, so
    // fall back to one reading per batch rather than per document.
    const batchReceivedAt = new Date();
    // The loop below iterates per action type, but the item and the ticker of
    // one gift have to be written together — see the gift case.
    let giftBatchHandled = false;

    for (const type of actionTypes) {
      try {
        switch (type) {
          case "addChatItemAction": {
            const payload: Chat[] = groupedActions[type].map((action) => {
              const normMessage = stringify(action.message!, stringifyOptions);
              const normMembership = normalizeMembership(action.membership);
              return {
                timestamp: action.timestamp,
                id: action.id,
                message: normMessage,
                authorName: action.authorName,
                authorPhoto: action.authorPhoto,
                authorChannelId: action.authorChannelId,
                authorType: authorTypeLabelmap({
                  membership: normMembership,
                  isVerified: action.isVerified,
                  isOwner: action.isOwner,
                  isModerator: action.isModerator,
                }),
                membership: normMembership,
                isVerified: action.isVerified,
                isOwner: action.isOwner,
                isModerator: action.isModerator,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                isReplay,
              };
            });
            await ChatModel.insertMany(payload, insertOptions);
            break;
          }
          case "addSuperChatItemAction": {
            const payload = await Promise.all(
              groupedActions[type].map(async (action): Promise<SuperChat> => {
                const normMessage =
                  action.message && action.message.length > 0
                    ? stringify(action.message, stringifyOptions)
                    : null;
                const normMembership = normalizeMembership(action.membership);
                const currency = getCurrencymapItem(action.currency);
                const jpy = await currencyToJpyAmount(
                  action.amount,
                  action.currency
                );
                return {
                  timestamp: action.timestamp,
                  id: action.id,
                  message: normMessage,
                  amount: action.amount,
                  jpyAmount: jpy.amount,
                  currency: currency.code,
                  significance: action.significance,
                  color: action.color,
                  authorName: action.authorName,
                  authorPhoto: action.authorPhoto,
                  authorChannelId: action.authorChannelId,
                  authorType: authorTypeLabelmap({
                    membership: normMembership,
                    isVerified: action.isVerified,
                    isOwner: action.isOwner,
                    isModerator: action.isModerator,
                  }),
                  membership: normMembership,
                  isVerified: action.isVerified,
                  isOwner: action.isOwner,
                  isModerator: action.isModerator,
                  originVideoId: mc.videoId,
                  originChannelId: mc.channelId,
                  isReplay,
                };
              })
            );
            await SuperChatModel.insertMany(payload, insertOptions);
            break;
          }
          case "addSuperStickerItemAction": {
            const payload = await Promise.all(
              groupedActions[type].map(
                async (action): Promise<SuperSticker> => {
                  const normMembership = normalizeMembership(action.membership);
                  const currency = getCurrencymapItem(action.currency);
                  const jpy = await currencyToJpyAmount(
                    action.amount,
                    action.currency
                  );
                  return {
                    timestamp: action.timestamp,
                    id: action.id,
                    authorName: action.authorName,
                    authorPhoto: action.authorPhoto,
                    authorChannelId: action.authorChannelId,
                    authorType: authorTypeLabelmap({
                      membership: normMembership,
                      isVerified: action.isVerified,
                      isOwner: action.isOwner,
                      isModerator: action.isModerator,
                    }),
                    membership: normMembership,
                    isVerified: action.isVerified,
                    isOwner: action.isOwner,
                    isModerator: action.isModerator,
                    amount: action.amount,
                    jpyAmount: jpy.amount,
                    currency: currency.code,
                    text: action.stickerText,
                    image: action.stickerUrl,
                    significance: action.significance,
                    color: action.color,
                    originVideoId: mc.videoId,
                    originChannelId: mc.channelId,
                    isReplay,
                  };
                }
              )
            );
            await SuperStickerModel.insertMany(payload, insertOptions);
            break;
          }
          case "removeChatItemAction":
          case "markChatItemAsDeletedAction": {
            const payload: RemoveChatAction[] = groupedActions[type].map(
              (action) => ({
                targetId: action.targetId,
                retracted: "retracted" in action ? action.retracted : undefined,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                timestamp: action.timestamp,
                isReplay,
              })
            );
            await RemoveChatActionModel.insertMany(payload, insertOptions);
            break;
          }
          case "removeChatItemByAuthorAction":
          case "markChatItemsByAuthorAsDeletedAction": {
            const payload: BanAction[] = groupedActions[type].map((action) => ({
              channelId: action.channelId,
              originVideoId: mc.videoId,
              originChannelId: mc.channelId,
              timestamp: action.timestamp,
              isReplay,
            }));
            await BanActionModel.insertMany(payload, insertOptions);
            break;
          }
          case "addMembershipItemAction": {
            const payload: Membership[] = groupedActions[type].map((action) => {
              const normMembership = normalizeMembership(action.membership);
              return {
                id: action.id,
                level: action.level,
                since: action.membership?.since,
                authorName: action.authorName,
                authorPhoto: action.authorPhoto,
                authorChannelId: action.authorChannelId,
                authorType: authorTypeLabelmap(
                  {
                    membership: normMembership,
                    isVerified: action.isVerified,
                    isOwner: action.isOwner,
                    isModerator: action.isModerator,
                  },
                  MessageAuthorType.Member
                ),
                membership: normMembership,
                isVerified: action.isVerified,
                isOwner: action.isOwner,
                isModerator: action.isModerator,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                timestamp: action.timestamp,
                isReplay,
              };
            });
            await MembershipModel.insertMany(payload, insertOptions);
            break;
          }
          case "addMembershipMilestoneItemAction": {
            const payload: Milestone[] = groupedActions[type].map((action) => {
              const normMessage =
                action.message && action.message.length > 0
                  ? stringify(action.message, stringifyOptions)
                  : null;
              const normMembership = normalizeMembership(action.membership);

              return {
                id: action.id,
                level: action.level,
                duration: action.duration,
                since: action.membership?.since,
                message: normMessage,
                authorName: action.authorName,
                authorPhoto: action.authorPhoto,
                authorChannelId: action.authorChannelId,
                authorType: authorTypeLabelmap(
                  {
                    membership: normMembership,
                    isVerified: action.isVerified,
                    isOwner: action.isOwner,
                    isModerator: action.isModerator,
                  },
                  MessageAuthorType.Member
                ),
                membership: normMembership,
                isVerified: action.isVerified,
                isOwner: action.isOwner,
                isModerator: action.isModerator,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                timestamp: action.timestamp,
                isReplay,
              };
            });
            await MilestoneModel.insertMany(payload, insertOptions);
            break;
          }
          case "addBannerAction": {
            const payload: BannerAction[] = groupedActions[type].map(
              (action) => {
                const normTitle = stringify(action.title, stringifyOptions);
                const normMessage = stringify(action.message, stringifyOptions);
                const normMembership = normalizeMembership(action.membership);
                return {
                  timestamp: action.timestamp,
                  actionId: action.id,
                  title: normTitle,
                  rawTitle: action.title,
                  message: normMessage,
                  authorName: action.authorName,
                  authorPhoto: action.authorPhoto,
                  authorChannelId: action.authorChannelId,
                  membership: normMembership,
                  isVerified: action.isVerified,
                  isOwner: action.isOwner,
                  isModerator: action.isModerator,
                  originVideoId: mc.videoId,
                  originChannelId: mc.channelId,
                  isReplay,
                };
              }
            );

            await BannerActionModel.insertMany(payload, insertOptions);
            break;
          }
          case "modeChangeAction": {
            const timestamp = new Date();
            const payload: ModeChange[] = groupedActions[type].map((action) => {
              return {
                timestamp,
                mode: action.mode,
                enabled: action.enabled,
                description: action.description,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                isReplay,
              };
            });

            await ModeChangeModel.insertMany(payload, insertOptions);
            break;
          }
          case "addPlaceholderItemAction": {
            const payload: Placeholder[] = groupedActions[type].map(
              (action) => {
                return {
                  timestamp: action.timestamp,
                  id: action.id,
                  originVideoId: mc.videoId,
                  originChannelId: mc.channelId,
                  isReplay,
                };
              }
            );

            await PlaceholderModel.insertMany(payload, insertOptions);
            break;
          }
          case "replaceChatItemAction": {
            const replacementItems = groupedActions[type].map(
              (act) => act.replacementItem
            );
            const groupedItems = groupBy(replacementItems, "type");
            const itemTypes = Object.keys(groupedItems) as Action["type"][];

            for (const itemType of itemTypes) {
              switch (itemType) {
                case "addChatItemAction": {
                  const payload: Chat[] = groupedItems[itemType].map((item) => {
                    const normMessage = stringify(
                      item.message!,
                      stringifyOptions
                    );
                    const normMembership = normalizeMembership(item.membership);
                    return {
                      timestamp: item.timestamp,
                      id: item.id,
                      message: normMessage,
                      authorName: item.authorName,
                      authorPhoto: item.authorPhoto,
                      authorChannelId: item.authorChannelId,
                      authorType: authorTypeLabelmap({
                        membership: normMembership,
                        isVerified: item.isVerified,
                        isOwner: item.isOwner,
                        isModerator: item.isModerator,
                      }),
                      membership: normMembership,
                      isVerified: item.isVerified,
                      isOwner: item.isOwner,
                      isModerator: item.isModerator,
                      originVideoId: mc.videoId,
                      originChannelId: mc.channelId,
                      isReplay,
                    };
                  });
                  // videoLog("replaceChat:", payload?.length);
                  await ChatModel.insertMany(payload, insertOptions);
                  break;
                }
                case "addSuperChatItemAction": {
                  const payload = await Promise.all(
                    groupedItems[itemType].map(
                      async (item): Promise<SuperChat> => {
                        const normMessage =
                          item.message && item.message.length > 0
                            ? stringify(item.message, stringifyOptions)
                            : null;
                        const normMembership = normalizeMembership(
                          item.membership
                        );
                        const currency = getCurrencymapItem(item.currency);
                        const jpy = await currencyToJpyAmount(
                          item.amount,
                          item.currency
                        );
                        return {
                          timestamp: item.timestamp,
                          id: item.id,
                          message: normMessage,
                          amount: item.amount,
                          jpyAmount: jpy.amount,
                          currency: currency.code,
                          significance: item.significance,
                          color: item.color,
                          authorName: item.authorName,
                          authorPhoto: item.authorPhoto,
                          authorChannelId: item.authorChannelId,
                          authorType: authorTypeLabelmap({
                            membership: normMembership,
                            isVerified: item.isVerified,
                            isOwner: item.isOwner,
                            isModerator: item.isModerator,
                          }),
                          membership: normMembership,
                          isVerified: item.isVerified,
                          isOwner: item.isOwner,
                          isModerator: item.isModerator,
                          originVideoId: mc.videoId,
                          originChannelId: mc.channelId,
                          isReplay,
                        };
                      }
                    )
                  );
                  videoLog("<!> replaceSuperChat:", payload);
                  // TODO replaceSuperChat
                  await SuperChatModel.insertMany(payload, insertOptions);
                  break;
                }
                case "addPlaceholderItemAction": {
                  const payload: Placeholder[] = groupedItems[itemType].map(
                    (item) => {
                      return {
                        timestamp: item.timestamp,
                        id: item.id,
                        originVideoId: mc.videoId,
                        originChannelId: mc.channelId,
                        isReplay,
                      };
                    }
                  );
                  // videoLog("<!> replacePlaceholder:", payload.length);
                  await PlaceholderModel.insertMany(payload, insertOptions);
                }
              }
            }
            break;
          }
          case "showPollPanelAction": {
            if (isReplay) break;
            const payload: Poll[] = groupedActions[type].map((action) => {
              return {
                id: action.id,
                question: action.question,
                choices: action.choices.map((choice) => ({
                  text: stringify(choice.text, stringifyOptions),
                })),
                pollType: action.pollType,
                finished: false,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
              };
            });
            await PollModel.insertMany(payload, insertOptions);
            break;
          }
          case "updatePollAction": {
            if (isReplay) break;
            const payload: Poll[] = groupedActions[type].map((action) => {
              return {
                id: action.id,
                ...setIfDefine("question", action.question),
                choices: action.choices.map((choice) => ({
                  text: stringify(choice.text, stringifyOptions),
                  voteRatio: choice.voteRatio,
                })),
                pollType: action.pollType,
                voteCount: action.voteCount,
                finished: false,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
              };
            });
            await PollModel.bulkWrite(
              payload.map((poll) => ({
                updateOne: {
                  filter: { id: poll.id },
                  update: { $set: poll },
                  upsert: true,
                },
              }))
            );
            break;
          }
          case "addPollResultAction": {
            if (isReplay) break;
            const bulk = groupedActions[type].map((action) => {
              return {
                updateOne: {
                  filter: {
                    originVideoId: mc.videoId,
                    originChannelId: mc.channelId,
                    finished: false,
                  },
                  update: {
                    $set: {
                      finished: true,
                    },
                    $max: {
                      voteCount: action.voteCount,
                    },
                  },
                },
              };
            });
            await PollModel.bulkWrite(bulk);
            break;
          }
          case "membershipGiftPurchaseAction": {
            const payload: MembershipGiftPurchase[] = groupedActions[type].map(
              (action) => {
                const normMembership = normalizeMembership(action.membership);
                return {
                  id: action.id,
                  timestamp: action.timestamp,
                  authorName: action.authorName,
                  authorPhoto: action.authorPhoto,
                  authorChannelId: action.authorChannelId,
                  authorType: authorTypeLabelmap({
                    membership: normMembership,
                    isVerified: action.isVerified,
                    isOwner: action.isOwner,
                    isModerator: action.isModerator,
                  }),
                  membership: normMembership,
                  isVerified: action.isVerified,
                  isOwner: action.isOwner,
                  isModerator: action.isModerator,
                  amount: action.amount,
                  originVideoId: mc.videoId,
                  originChannelId: mc.channelId,
                  isReplay,
                };
              }
            );
            await MembershipGiftPurchaseModel.insertMany(
              payload,
              insertOptions
            );
            break;
          }
          case "membershipGiftRedemptionAction": {
            const payload: MembershipGift[] = groupedActions[type].map(
              (action) => {
                const normMembership = normalizeMembership(action.membership);
                return {
                  id: action.id,
                  timestamp: action.timestamp,
                  authorName: action.authorName,
                  authorPhoto: action.authorPhoto,
                  authorChannelId: action.authorChannelId,
                  authorType: authorTypeLabelmap(
                    {
                      membership: normMembership,
                      isVerified: action.isVerified,
                      isOwner: action.isOwner,
                      isModerator: action.isModerator,
                    },
                    MessageAuthorType.Member
                  ),
                  membership: normMembership,
                  isVerified: action.isVerified,
                  isOwner: action.isOwner,
                  isModerator: action.isModerator,
                  senderName: action.senderName,
                  originVideoId: mc.videoId,
                  originChannelId: mc.channelId,
                  isReplay,
                };
              }
            );
            await MembershipGiftModel.insertMany(payload, insertOptions);
            break;
          }
          case "addIncomingRaidBannerAction": {
            if (isReplay) break;
            const payload: Raid[] = await Promise.all(
              groupedActions[type].map(async (action) => {
                return {
                  id: action.actionId,
                  targetId: action.targetId,
                  // sourceVideoId: ,
                  // sourceChannelId: ,
                  sourceName: await resolveRaidName(action.sourceName),
                  sourcePhoto: action.sourcePhoto,
                  originVideoId: mc.videoId,
                  originChannelId: mc.channelId,
                  originName: channelName,
                  originPhoto: channelAvatarUrl,
                  timestamp: new Date(),
                };
              })
            );
            await RaidModel.bulkWrite(
              payload.map((raid) => ({
                updateOne: {
                  filter: {
                    originVideoId: raid.originVideoId,
                    sourceName: raid.sourceName,
                  },
                  update: { $set: raid },
                  upsert: true,
                },
              }))
            );
            break;
          }
          case "addOutgoingRaidBannerAction": {
            if (isReplay) break;
            const payload: Raid[] = await Promise.all(
              groupedActions[type].map(async (action) => {
                return {
                  outgoingId: action.actionId,
                  outgoingTargetId: action.targetId,
                  sourceVideoId: mc.videoId,
                  sourceChannelId: mc.channelId,
                  sourceName: channelName,
                  sourcePhoto: channelAvatarUrl,
                  originVideoId: action.targetVideoId,
                  // originChannelId: ,
                  originName: await resolveRaidName(action.targetName),
                  originPhoto: action.targetPhoto,
                  timestamp: new Date(),
                };
              })
            );
            await RaidModel.bulkWrite(
              payload.map((raid) => ({
                updateOne: {
                  filter: {
                    originVideoId: raid.originVideoId,
                    sourceName: raid.sourceName,
                  },
                  update: { $set: raid },
                  upsert: true,
                },
              }))
            );
            for (const raid of payload) {
              await VideoModel.noticeFromRaid(raid);
            }
            break;
          }
          // case "addCallForQuestionsBannerAction":
          // case "addChatSummaryBannerAction":
          // case "showTooltipAction":
          // case "addViewerEngagementMessageAction":
          // case "closePanelAction":
          // case "removeBannerAction":
          // case "addMembershipTickerAction":
          // case "addSuperChatTickerAction":
          // case "addSuperStickerTickerAction":
          // case "moderationMessageAction":
          //   break;
          case "addGiftItemAction":
          case "addGiftTickerAction": {
            // Both types fall through to here, but one gift's item and ticker
            // must land in a single write: webhooks only fire on inserts, so
            // writing them separately would strand the ticker's
            // authorChannelId on an update nobody reads.
            if (giftBatchHandled) break;
            giftBatchHandled = true;

            const upserts = mergeGiftActions(
              groupedActions["addGiftItemAction"] ?? [],
              groupedActions["addGiftTickerAction"] ?? [],
              {
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                isReplay,
                receivedAt: batchReceivedAt,
              },
              await getGiftPriceTable()
            );
            const ops = buildGiftUpsertOps(upserts);
            if (ops.length > 0) {
              await GiftModel.bulkWrite(ops, insertOptions);
            }
            break;
          }
          case "unknown": {
            const payload = groupedActions[type]
              .filter((action) => {
                // Ignore the payload with only the clickTrackingParams field.
                if (
                  action.payload &&
                  typeof action.payload === "object" &&
                  Object.keys(action.payload).length === 1 &&
                  "clickTrackingParams" in action.payload
                ) {
                  return false;
                }
                return true;
              })
              .map((action): ErrorLog => {
                return {
                  timestamp: new Date(),
                  originVideoId: mc.videoId,
                  originChannelId: mc.channelId,
                  error: type,
                  payload: action.payload,
                };
              });
            if (payload.length > 0) await ErrorLogModel.insertMany(payload);
            break;
          }
          case "parserError": {
            const payload = groupedActions[type].map((action): ErrorLog => {
              return {
                timestamp: new Date(),
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                error: type,
                message: `${action.error}`,
                stack:
                  action.error instanceof Error
                    ? action.error.stack
                    : undefined,
                payload: action.payload,
              };
            });
            await ErrorLogModel.insertMany(payload);
            break;
          }
          // default: {
          //   const _exhaust: never = type;
          //   break;
          // }
        }
      } catch (err) {
        // insertedDocs: []
        // result: BulkWriteResult,
        // writeErrors: WriteError
        // code: number
        stats.errors += 1;

        if (err instanceof MongoError) {
          if (err instanceof MongoBulkWriteError && err.code === 11000) {
            const errorCount = Array.isArray(err.writeErrors)
              ? err.writeErrors.length
              : 1;
            videoLog(
              `DUPES ${errorCount} while handling ${
                (err.result?.insertedCount ?? 0) + errorCount
              } ${type}s`
            );
            continue;
          } else {
            videoLog(
              `<!> Unrecognized mongo error: code=${err.code} msg=${err.errmsg} labels=${err.errorLabels} type=${type}`
            );
          }
        } else if (err instanceof FetchError) {
          // getaddrinfo ENOTFOUND mongo
          videoLog("<!> FetchError", err, type);
        } else if (err instanceof Error) {
          videoLog("<!> Unrecognized Error", err, err.stack, type);
          process.exit(1);
        }

        throw err;
      }
    }

    // fancy logging
    refreshStats(actions);
  }

  async function updateVideoStats() {
    try {
      if (isReplay) return; // do not update stats for replay mode
      if (replica > 1) return; // only update stats in the first replica
      // Bounded-blocking global gate; cancelController.signal lets graceful
      // shutdown release the wait immediately. false → cooldown / degraded /
      // abort / budget exhausted: skip this update (next cycle retries).
      if (
        !(await gate.acquire(
          YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS,
          cancelController.signal
        ))
      ) {
        return;
      }
      await VideoModel.updateFromMasterchat(mc);
    } catch (err) {
      await reportStatsUpdateError(err, gate, videoLog);
    }
  }

  // Delayed start of replica > 1
  for (let i = 0; i < replica - 1; i++) {
    job.reportProgress(stats);
    await setTimeout(1000);
  }

  job.reportProgress(stats);
  videoLog(`START`);

  const updateStatsCounter = {
    actionCount: 0,
    lastUpdateAt: moment.tz("UTC"),
  };
  const autoscaleState = {
    lastChatAt: moment.tz("UTC"),
    scaleUpAt: moment.tz("UTC"),
  };

  (async () => {
    // replay chat does not need to calculate replica
    if (isReplay) return;

    for await (const _ of setInterval(60_000, null, {
      signal: cancelController.signal,
    })) {
      try {
        const video = await VideoModel.findByVideoId(videoId);
        if (!video) continue;

        if (video.hbIgnore) {
          stopController.abort(new Error("This video is ignored."));
          continue;
        }

        if (isFirstReplica) {
          // update video stats every 200 action or over 1 hour
          // 2k messages / per 10m: every 1m
          if (
            updateStatsCounter.actionCount >= 200 ||
            moment
              .tz("UTC")
              .subtract(1, "hour")
              .isAfter(updateStatsCounter.lastUpdateAt)
          ) {
            updateStatsCounter.actionCount = 0;
            updateStatsCounter.lastUpdateAt = moment.tz("UTC");
            await updateVideoStats();
          }
        } else {
          // check replica
          if (video.getReplicas() < replica) {
            stopController.abort(new Error("Stop replica"));
          }
        }
      } catch (err) {
        videoLog("<!> [ERROR]", err);
      }
    }
  })().catch(() => void 0);

  try {
    void updateVideoStats();

    // iterate over live chat
    for await (const { actions } of mc.iterate({
      signal: cancelController.signal,
    })) {
      if (actions.length > 0) {
        await handleActions(actions);

        updateStatsCounter.actionCount += actions.length;
        autoscaleState.lastChatAt = moment(
          Math.max(
            autoscaleState.lastChatAt.valueOf(),
            ...actions
              .filter((action) => action.type === "addChatItemAction")
              .map((action) => action.timestamp.valueOf())
          )
        );
      }
    }
  } catch (err) {
    if (err instanceof MasterchatError) {
      if (job.data.defaultBackoffDelay) {
        job.backoff("fixed", job.data.defaultBackoffDelay);
      }
      switch (err.code) {
        case "membersOnly": {
          // let the scheduler ignore this stream from index
          videoLog(`members-only stream`);
          return { error: ErrorCode.MembersOnly };
        }
        case "denied": {
          return { error: ErrorCode.Ban };
        }
        case "disabled": {
          // immediately fail so that the scheduler can push the job to delayed queue
          // TODO: handle when querying archived stream
          throw new Error(
            `chat is disabled OR archived stream (start_scheduled: ${video.scheduledStart?.toISOString()})`
          );
        }
        case "unavailable": {
          videoLog("unavailable");
          return { error: ErrorCode.Unavailable, result: stats };
        }
        case "private": {
          videoLog("private");
          return { error: ErrorCode.Private, result: stats };
        }
      }
    }

    if (err instanceof AbortError || axios.isCancel(err)) {
      if (stopController.signal.aborted) {
        videoLog(`END (Stop by signal)`);
        return { error: ErrorCode.Aborted, result: stats };
      }
      job.backoff("immediate");
      videoLog("<!> [ABORTED]");
      throw new Error("worker exiting");
    }

    // change delay backoff time to 30 sec
    job.backoff("fixed", 30 * 1000);

    // unrecognized errors
    videoLog("<!> [FATAL]", err);
    throw err;
  } finally {
    await updateVideoStats();
    if (!cancelController.signal.aborted) {
      cancelController.abort(new Error("Job exiting"));
    }
  }

  videoLog(`END`);
  return { error: null, result: stats };
}

// collect live chat and save to mongodb
export async function runWorker() {
  const exitController = new AbortController();
  const app = new Application();
  app.use(new MongodbModule());
  const redisModule = app.use(new RedisModule({ nonBlockingConnect: true }));
  const gate = app.use(new YoutubeWatchGate(redisModule.redis));
  const { queue } = app.use(
    new QueueModule("honeybee", { activateDelayedJobs: true })
  );
  app.use({
    name: "exit-signal",
    close(s) {
      exitController.abort(new Error(`Received ${s}`));
      return Promise.resolve();
    },
  });

  queue.on("ready", () => {
    console.log(`worker is ready (concurrency: ${JOB_CONCURRENCY})`);
  });

  // Redis related error
  queue.on("error", (err) => {
    // code: 'EHOSTUNREACH'
    // code: 'UNCERTAIN_STATE'
    console.log("queue got error:", (err as any)?.code, err.message);
    process.exit(1);
  });

  queue.process<HoneybeeResult>(JOB_CONCURRENCY, (job) =>
    handleJob(job, exitController.signal, gate)
  );

  await app.init();
}
