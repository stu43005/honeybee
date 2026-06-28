import type { FastifyReply, FastifyRequest } from "fastify";
import ChannelModel from "../../models/Channel.js";
import YoutubeDmBindingModel, {
  BindingLimitError,
  BindingTransformPendingError,
} from "../../models/YoutubeDmBinding.js";
import {
  exchangeDiscordCode,
  fetchDiscordUserId,
  fetchVerifiedYoutubeChannels,
} from "./discord.js";
import { fetchGoogleChannels } from "./google.js";
import {
  delOAuthState,
  getOAuthState,
  type OAuthMethod,
  type OAuthState,
} from "./state-store.js";

type Channel = { channelId: string; title: string };
type Query = { code?: string; state?: string };

// Injectable seam: cross-module functions are passed in (default = the real ones)
// so tests supply mocks without spying on ESM namespace exports.
export interface CallbackDeps {
  getOAuthState: (state: string) => Promise<OAuthState | null>;
  delOAuthState: (state: string) => Promise<void>;
  fetchGoogleChannels: (code: string) => Promise<Channel[]>;
  exchangeDiscordCode: (code: string) => Promise<string>;
  fetchDiscordUserId: (token: string) => Promise<string>;
  fetchVerifiedYoutubeChannels: (token: string) => Promise<Channel[]>;
}

const realDeps: CallbackDeps = {
  getOAuthState,
  delOAuthState,
  fetchGoogleChannels,
  exchangeDiscordCode,
  fetchDiscordUserId,
  fetchVerifiedYoutubeChannels,
};

function page(reply: FastifyReply, status: number, message: string) {
  reply
    .code(status)
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><meta charset="utf-8"><body>${message}</body>`);
}

// Seed Channel docs (so /list shows names immediately) then bind. The three honest
// outcomes are distinguished by the binding error type; the saved-pending string is
// defined here and only here.
export async function applyBinding(
  discordUserId: string,
  channels: Channel[],
  reply: FastifyReply
): Promise<void> {
  for (const { channelId, title } of channels) {
    const existing = await ChannelModel.findByChannelId(channelId);
    if (!existing) {
      await ChannelModel.create({ id: channelId, name: title });
    }
  }
  try {
    await YoutubeDmBindingModel.bindChannels(
      discordUserId,
      channels.map((c) => c.channelId)
    );
    page(reply, 200, "綁定成功、已生效，可關閉此頁。");
  } catch (error) {
    if (error instanceof BindingLimitError) {
      page(reply, 400, "超過上限、未綁定。請先解除部分頻道後再試。");
    } else if (error instanceof BindingTransformPendingError) {
      page(reply, 200, "已儲存，稍後生效，可關閉此頁。");
    } else {
      page(reply, 500, "綁定處理失敗，請重新發起。");
    }
  }
}

async function consumeState(
  query: Query,
  expected: OAuthMethod,
  reply: FastifyReply,
  deps: CallbackDeps
): Promise<{ discordUserId: string } | null> {
  if (!query.code || !query.state) {
    page(reply, 400, "缺少授權參數。");
    return null;
  }
  const data = await deps.getOAuthState(query.state);
  if (!data || data.method !== expected) {
    page(reply, 400, "授權連結已失效或不正確，請重新發起。");
    return null;
  }
  await deps.delOAuthState(query.state);
  return { discordUserId: data.discordUserId };
}

export async function handleGoogleCallback(
  request: FastifyRequest<{ Querystring: Query }>,
  reply: FastifyReply,
  deps: CallbackDeps = realDeps
): Promise<void> {
  const ctx = await consumeState(request.query, "google", reply, deps);
  if (!ctx) return;
  try {
    const channels = await deps.fetchGoogleChannels(request.query.code!);
    if (channels.length === 0) {
      page(reply, 400, "找不到可綁定的 YouTube 頻道。");
      return;
    }
    await applyBinding(ctx.discordUserId, channels, reply);
  } catch {
    page(reply, 500, "授權處理失敗，請重新發起。");
  }
}

export async function handleDiscordCallback(
  request: FastifyRequest<{ Querystring: Query }>,
  reply: FastifyReply,
  deps: CallbackDeps = realDeps
): Promise<void> {
  const ctx = await consumeState(request.query, "discord", reply, deps);
  if (!ctx) return;
  try {
    const token = await deps.exchangeDiscordCode(request.query.code!);
    const authorizerId = await deps.fetchDiscordUserId(token);
    if (authorizerId !== ctx.discordUserId) {
      page(reply, 403, "授權者身分與發起者不符，已拒絕綁定。");
      return;
    }
    const channels = await deps.fetchVerifiedYoutubeChannels(token);
    if (channels.length === 0) {
      page(reply, 400, "你的 Discord 沒有已驗證的 YouTube 連結。");
      return;
    }
    await applyBinding(ctx.discordUserId, channels, reply);
  } catch {
    page(reply, 500, "授權處理失敗，請重新發起。");
  }
}
