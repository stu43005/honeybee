import {
  AbortError,
  Action,
  Masterchat,
  MasterchatError,
  Membership as MCMembership,
  stringify,
  YTEmojiRun,
} from "@stu43005/masterchat";
import axios from "axios";
import BeeQueue from "bee-queue";
import moment from "moment-timezone";
import mongoose from "mongoose";
import { FetchError } from "node-fetch";
import assert from "node:assert";
import https from "node:https";
import { setInterval, setTimeout } from "node:timers/promises";
import { JOB_CONCURRENCY, SHUTDOWN_TIMEOUT } from "../constants";
import {
  ErrorCode,
  HoneybeeResult,
  HoneybeeStats,
  type HoneybeeJob,
} from "../interfaces";
import BanActionModel, { type BanAction } from "../models/BanAction";
import BannerActionModel, { type BannerAction } from "../models/BannerAction";
import ChatModel, { type Chat } from "../models/Chat";
import ErrorLogModel, { type ErrorLog } from "../models/ErrorLog";
import MembershipModel, { type Membership } from "../models/Membership";
import MembershipGiftModel, {
  type MembershipGift,
} from "../models/MembershipGift";
import MembershipGiftPurchaseModel, {
  type MembershipGiftPurchase,
} from "../models/MembershipGiftPurchase";
import MilestoneModel, { type Milestone } from "../models/Milestone";
import ModeChangeModel, { type ModeChange } from "../models/ModeChange";
import PlaceholderModel, { type Placeholder } from "../models/Placeholder";
import PollModel, { type Poll } from "../models/Poll";
import RaidModel, { type Raid } from "../models/Raid";
import RemoveChatActionModel, {
  type RemoveChatAction,
} from "../models/RemoveChatAction";
import SuperChatModel, { type SuperChat } from "../models/SuperChat";
import SuperStickerModel, { type SuperSticker } from "../models/SuperSticker";
import VideoModel from "../models/Video";
import { ActionCounter } from "../modules/action-counter";
import {
  currencyToJpyAmount,
  getCurrencymapItem,
} from "../modules/currency-convert";
import { initMongo } from "../modules/db";
import { getQueueInstance } from "../modules/queue";
import { updateVideoFromYoutube } from "../modules/youtube";
import { groupBy, pipeSignal, setIfDefine } from "../util";

const { MongoError, MongoBulkWriteError } = mongoose.mongo;

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
  return membership ? membership.since ?? "new" : undefined;
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

async function handleJob(
  job: BeeQueue.Job<HoneybeeJob>,
  globalSignal: AbortSignal
): Promise<HoneybeeResult> {
  const { videoId, replica } = job.data;
  assert(replica, "No specified replica.");
  const isFirstReplica = replica === 1;
  const video = await VideoModel.findByVideoId(videoId);
  assert(video, "Unable to find the video.");
  assert(video.getReplicas() >= replica, "Stop replica");
  const { channelId } = video;
  const { name: channelName, avatarUrl: channelAvatarUrl } =
    await video.getChannel();

  // Control cancel all operations
  const cancelController = new AbortController();
  // Control whether to stop the job
  const stopController = new AbortController();
  pipeSignal(globalSignal, cancelController);
  pipeSignal(stopController.signal, cancelController);

  const mc = new Masterchat(videoId, channelId, {
    mode: "live",
    axiosInstance: axios.create({
      timeout: 4000,
      httpsAgent: new https.Agent({
        keepAlive: true,
      }),
    }),
  });
  let stats: HoneybeeStats = { handled: 0, errors: 0 };

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
                membership: normMembership,
                isVerified: action.isVerified,
                isOwner: action.isOwner,
                isModerator: action.isModerator,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
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
                  membership: normMembership,
                  isVerified: action.isVerified,
                  isOwner: action.isOwner,
                  isModerator: action.isModerator,
                  originVideoId: mc.videoId,
                  originChannelId: mc.channelId,
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
                membership: normMembership,
                isVerified: action.isVerified,
                isOwner: action.isOwner,
                isModerator: action.isModerator,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                timestamp: action.timestamp,
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
                membership: normMembership,
                isVerified: action.isVerified,
                isOwner: action.isOwner,
                isModerator: action.isModerator,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                timestamp: action.timestamp,
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
                      membership: normMembership,
                      isVerified: item.isVerified,
                      isOwner: item.isOwner,
                      isModerator: item.isModerator,
                      originVideoId: mc.videoId,
                      originChannelId: mc.channelId,
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
                          membership: normMembership,
                          isVerified: item.isVerified,
                          isOwner: item.isOwner,
                          isModerator: item.isModerator,
                          originVideoId: mc.videoId,
                          originChannelId: mc.channelId,
                        };
                      }
                    )
                  );
                  videoLog("<!> replaceSuperChat:", payload);
                  // TODO replaceSuperChat
                  // await SuperChatModel.insertMany(payload, insertOptions);
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
            const payload: Poll[] = groupedActions[type].map((action) => {
              return {
                id: action.id,
                question: action.question,
                choices: action.choices.map((choice) => ({
                  text: stringify(choice.text, stringifyOptions),
                })),
                pollType: action.pollType,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
              };
            });
            await PollModel.insertMany(payload, insertOptions);
            break;
          }
          case "updatePollAction": {
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
          // case "addPollResultAction": {
          //   const payload: Poll[] = groupedActions[type].map((action) => {
          //     return {
          //       id: action.id,
          //       question: action.question
          //         ? stringify(action.question, stringifyOptions)
          //         : undefined,
          //       voteCount: action.total,
          //       choices: action.choices.map((choice) => ({
          //         text: stringify(choice.text, stringifyOptions),
          //         voteRatio: parseFloat(choice.votePercentage) / 100,
          //       })),
          //       originVideoId: mc.videoId,
          //       originChannelId: mc.channelId,
          //     };
          //   });
          //   await PollModel.bulkWrite(
          //     payload.map((poll) => ({
          //       updateOne: {
          //         filter: { id: poll.id },
          //         update: { $set: poll },
          //         upsert: true,
          //       },
          //     }))
          //   );
          //   break;
          // }
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
                  membership: normMembership,
                  isVerified: action.isVerified,
                  isOwner: action.isOwner,
                  isModerator: action.isModerator,
                  amount: action.amount,
                  originVideoId: mc.videoId,
                  originChannelId: mc.channelId,
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
                  membership: normMembership,
                  isVerified: action.isVerified,
                  isOwner: action.isOwner,
                  isModerator: action.isModerator,
                  senderName: action.senderName,
                  originVideoId: mc.videoId,
                  originChannelId: mc.channelId,
                };
              }
            );
            await MembershipGiftModel.insertMany(payload, insertOptions);
            break;
          }
          case "addIncomingRaidBannerAction": {
            const payload: Raid[] = groupedActions[type].map((action) => {
              return {
                id: action.actionId,
                // sourceVideoId: ,
                // sourceChannelId: ,
                sourceName: action.sourceName,
                sourcePhoto: action.sourcePhoto,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                originPhoto: channelAvatarUrl,
                timestamp: new Date(),
              };
            });
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
            const payload: Raid[] = groupedActions[type].map((action) => {
              return {
                outgoingId: action.actionId,
                sourceVideoId: mc.videoId,
                sourceChannelId: mc.channelId,
                sourceName: channelName,
                sourcePhoto: channelAvatarUrl,
                originVideoId: action.targetVideoId,
                // originChannelId: ,
                originPhoto: action.targetPhoto,
                timestamp: new Date(),
              };
            });
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
            await updateVideoFromYoutube(
              payload.map((raid) => raid.originVideoId)
            );
            break;
          }
          // case "showTooltipAction":
          // case "addViewerEngagementMessageAction":
          // case "closePanelAction":
          // case "removeBannerAction":
          // case "addMembershipTickerAction":
          // case "addSuperChatTickerAction":
          // case "addSuperStickerTickerAction":
          // case "moderationMessageAction":
          //   break;
          case "unknown": {
            const payload: ErrorLog[] = groupedActions[type].map((action) => {
              return {
                timestamp: new Date(),
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                error: type,
                payload: action.payload,
              };
            });
            await ErrorLogModel.insertMany(payload);
            break;
          }
          case "parserError": {
            const payload: ErrorLog[] = groupedActions[type].map((action) => {
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
      await VideoModel.updateFromMasterchat(mc);
    } catch (err) {
      if (err instanceof AbortError || axios.isCancel(err)) {
        // ignore
      } else {
        videoLog("<!> [STATS UPDATE ERROR]", err);
      }
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
  const actionCounter = new ActionCounter();

  (async () => {
    for await (const _ of setInterval(5000, null, {
      signal: cancelController.signal,
    })) {
      try {
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

          const video = await VideoModel.findByVideoId(videoId);
          switch (video?.getReplicas()) {
            case 1: {
              const recentActions = actionCounter.countRecentActions(moment.duration(1, "minute"));
              if (recentActions >= 600) {
                // scale up
                videoLog(`scale up`);
                video.hbReplica = 2;
                await video.save();
              }
              break;
            }
            case 2: {
              const recentActions = actionCounter.countRecentActions(moment.duration(10, "minute")) / 10;
              if (recentActions < 300) {
                // scale down
                videoLog(`scale down`);
                video.hbReplica = 1;
                await video.save();
              }
              break;
            }
          }
        } else {
          // check replica
          const video = await VideoModel.findByVideoId(videoId);
          if (video && video.getReplicas() < replica) {
            stopController.abort(new Error("Stop replica"));
          }
        }
      } catch (err) {
        videoLog("<!> [ERROR]", err);
      }
    }
  })().catch(() => void 0);

  try {
    await updateVideoStats();

    // iterate over live chat
    for await (const { actions } of mc.iterate({
      signal: cancelController.signal,
    })) {
      if (actions.length > 0) {
        await handleActions(actions);

        updateStatsCounter.actionCount += actions.length;
        actionCounter.addActions(actions.length);
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
        return { error: null, result: stats };
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
  const disconnectFromMongo = await initMongo();
  const queue = getQueueInstance({ activateDelayedJobs: true });

  process.on("SIGTERM", async (s) => {
    console.log("quitting worker (SIGTERM) ...");

    try {
      exitController.abort(new Error(`Received ${s}`));
      await queue.close(SHUTDOWN_TIMEOUT);
      await disconnectFromMongo();
    } catch (err) {
      console.log("worker failed to shut down gracefully", err);
    }

    process.exit(0);
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
    handleJob(job, exitController.signal)
  );
}
