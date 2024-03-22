import {
  Action,
  Masterchat,
  MasterchatError,
  Membership as MCMembership,
  stringify,
  YTEmojiRun,
} from "@stu43005/masterchat";
import axios from "axios";
import BeeQueue from "bee-queue";
import { Video } from "holodex.js";
import https from "https";
import mongoose from "mongoose";
import { FetchError } from "node-fetch";
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
import VideoModel from "../models/Video";
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
import { type Raid } from "../models/Raid";
import RemoveChatActionModel, {
  type RemoveChatAction,
} from "../models/RemoveChatAction";
import SuperChatModel, { type SuperChat } from "../models/SuperChat";
import SuperStickerModel, { type SuperSticker } from "../models/SuperSticker";
import {
  currencyToJpyAmount,
  getCurrencymapItem,
} from "../modules/currency-convert";
import { initMongo } from "../modules/db";
import { getQueueInstance } from "../modules/queue";
import { groupBy, setIfDefine } from "../util";

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
  job: BeeQueue.Job<HoneybeeJob>
): Promise<HoneybeeResult> {
  const { videoId } = job.data;
  const stream = new Video(job.data.stream);
  const { channelId } = stream;

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
    console.log(`${videoId} ${channelId} -`, ...obj);
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
                  authorChannelId: action.authorChannelId,
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
                  const currency = getCurrencymapItem(action.currency);
                  const jpy = await currencyToJpyAmount(
                    action.amount,
                    action.currency
                  );
                  return {
                    timestamp: action.timestamp,
                    id: action.id,
                    authorName: action.authorName,
                    authorChannelId: action.authorChannelId,
                    amount: action.amount,
                    jpyAmount: jpy.amount,
                    currency: currency.code,
                    text: action.stickerText,
                    // significance: action.significance,
                    // color: action.color,
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
            const payload: Membership[] = groupedActions[type].map(
              (action) => ({
                id: action.id,
                level: action.level,
                since: action.membership?.since,
                authorName: action.authorName!,
                authorChannelId: action.authorChannelId,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                timestamp: action.timestamp,
              })
            );
            await MembershipModel.insertMany(payload, insertOptions);
            break;
          }
          case "addMembershipMilestoneItemAction": {
            const payload: Milestone[] = groupedActions[type].map((action) => {
              const normMessage =
                action.message && action.message.length > 0
                  ? stringify(action.message, stringifyOptions)
                  : null;

              return {
                id: action.id,
                level: action.level,
                duration: action.duration,
                since: action.membership?.since,
                message: normMessage,
                authorName: action.authorName,
                authorChannelId: action.authorChannelId,
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
                          authorChannelId: item.authorChannelId,
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
                  authorChannelId: action.authorChannelId,
                  membership: normMembership,
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
                return {
                  id: action.id,
                  timestamp: action.timestamp,
                  authorName: action.authorName,
                  authorChannelId: action.authorChannelId,
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
                sourceName: action.sourceName,
                originVideoId: mc.videoId,
                originChannelId: mc.channelId,
                timestamp: new Date(),
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
          case "addOutgoingRaidBannerAction": {
            const payload: Raid[] = groupedActions[type].map((action) => {
              return {
                id: action.actionId,
                sourceVideoId: mc.videoId,
                sourceChannelId: mc.channelId,
                sourceName: mc.channelName,
                originVideoId: action.targetVideoId,
                originChannelId: action.targetId,
                timestamp: new Date(),
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
          // case "showTooltipAction":
          // case "addViewerEngagementMessageAction":
          // case "showPanelAction":
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

  job.reportProgress(stats);
  videoLog(`START`);

  // iterate over live chat
  let actionCount = 0;
  try {
    await VideoModel.updateFromMasterchat(mc);

    for await (const { actions } of mc.iterate()) {
      if (actions.length === 0) continue;
      await handleActions(actions);

      actionCount += actions.length;
      // 8k messages / per 10m: every 30s
      if (actionCount >= 400) {
        actionCount = 0;
        try {
          await VideoModel.updateFromMasterchat(mc);
        } catch (err) {
          videoLog("<!> [STATS UPDATE ERROR]", err);
        }
      }
    }
  } catch (err) {
    if (err instanceof MasterchatError) {
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
            `chat is disabled OR archived stream (start_scheduled: ${stream.scheduledStart.toISOString()})`
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

    // change delay backoff time to 30 sec
    job.backoff("fixed", 30 * 1000);

    // unrecognized errors
    videoLog("<!> [FATAL]", err);
    throw err;
  }

  videoLog(`END`);
  return { error: null, result: stats };
}

// collect live chat and save to mongodb
export async function runWorker() {
  const disconnectFromMongo = await initMongo();
  const queue = getQueueInstance({ activateDelayedJobs: true });

  process.on("SIGTERM", async () => {
    console.log("quitting worker (SIGTERM) ...");

    try {
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

  queue.process<HoneybeeResult>(JOB_CONCURRENCY, handleJob);
}
