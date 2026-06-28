import { DiscordAPIError, RESTJSONErrorCodes, type Client } from "discord.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import ChannelModel from "../../models/Channel.js";
import YoutubeDmBindingModel, {
  BindingLimitError,
  BindingTransformPendingError,
} from "../../models/YoutubeDmBinding.js";
import type { Application } from "../application.js";
import type { Module } from "../module.js";
import { RedisModule } from "../redis.js";
import { DiscordProvider } from "./discord.js";
import { GoogleProvider } from "./google.js";
import {
  IdentityMismatchError,
  type OAuthChannel,
  type OAuthProvider,
} from "./provider.js";
import {
  OAuthStateStore,
  randomState,
  type OAuthMethod,
} from "./state-store.js";

type Query = { code?: string; state?: string };

function page(reply: FastifyReply, status: number, message: string) {
  reply
    .code(status)
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><meta charset="utf-8"><body>${message}</body>`);
}

export class OAuthModule implements Module {
  public readonly name = "oauth";
  public readonly google = new GoogleProvider();
  public readonly discord = new DiscordProvider();
  private readonly stateStore: OAuthStateStore;

  constructor(
    private readonly app: Application,
    private readonly client: Client
  ) {
    // Resolve redis and build the state store before registering routes so no
    // startup race exists. RedisModule must be app.use'd before this module.
    const redisModule = this.app.get<RedisModule>("redis");
    if (!redisModule) {
      throw new Error(
        "OAuthModule: RedisModule must be registered before OAuthModule"
      );
    }
    this.stateStore = new OAuthStateStore(redisModule.redis);

    // Routes must be registered before HttpServerModule.init() calls listen().
    // Registering here in the constructor ensures they are in place before init.
    const server = this.app.http.server;
    server.get("/oauth/youtube-dm/google/callback", (req, reply) =>
      this.handleCallback(
        this.google,
        req as FastifyRequest<{ Querystring: Query }>,
        reply
      )
    );
    server.get("/oauth/youtube-dm/discord/callback", (req, reply) =>
      this.handleCallback(
        this.discord,
        req as FastifyRequest<{ Querystring: Query }>,
        reply
      )
    );
  }

  async beginAuth(method: OAuthMethod, discordUserId: string): Promise<string> {
    const provider = method === "google" ? this.google : this.discord;
    const state = randomState();
    await this.stateStore.put(state, { discordUserId, method });
    return provider.buildAuthUrl(state);
  }

  private async handleCallback(
    provider: OAuthProvider,
    request: FastifyRequest<{ Querystring: Query }>,
    reply: FastifyReply
  ): Promise<void> {
    const { code, state } = request.query;
    if (!code || !state) {
      page(reply, 400, "缺少授權參數。");
      return;
    }
    const data = await this.stateStore.get(state);
    if (!data || data.method !== provider.method) {
      page(reply, 400, "授權連結已失效或不正確，請重新發起。");
      return;
    }
    // Single-use state: consume before any network call so replay attacks are
    // rejected even if the subsequent exchange fails.
    await this.stateStore.del(state);
    try {
      const channels = await provider.listChannels(code, data);
      if (channels.length === 0) {
        page(reply, 400, provider.emptyMessage);
        return;
      }
      await this.applyBinding(data.discordUserId, channels, reply);
    } catch (error) {
      if (error instanceof IdentityMismatchError) {
        page(reply, 403, "授權者身分與發起者不符，已拒絕綁定。");
        return;
      }
      page(reply, 500, "授權處理失敗，請重新發起。");
    }
  }

  private async applyBinding(
    discordUserId: string,
    channels: OAuthChannel[],
    reply: FastifyReply
  ): Promise<void> {
    // Seed Channel documents so /list shows names immediately after binding.
    for (const { channelId, title } of channels) {
      const existing = await ChannelModel.findByChannelId(channelId);
      if (!existing) {
        await ChannelModel.create({ id: channelId, name: title });
      }
    }

    let pending = false;
    try {
      await YoutubeDmBindingModel.bindChannels(
        discordUserId,
        channels.map((c) => c.channelId)
      );
    } catch (error) {
      if (error instanceof BindingLimitError) {
        page(reply, 400, "超過上限、未綁定。請先解除部分頻道後再試。");
        return;
      } else if (error instanceof BindingTransformPendingError) {
        // The binding was written but the downstream transform failed; the
        // caller gets a truthful "saved, taking effect shortly" message.
        pending = true;
      } else {
        page(reply, 500, "綁定處理失敗，請重新發起。");
        return;
      }
    }

    const binding = await YoutubeDmBindingModel.findOne({ discordUserId });
    const channelIds = binding?.channelIds ?? [];
    const delivered = await this.sendBindingDm(discordUserId, channelIds);

    if (pending) {
      page(
        reply,
        200,
        delivered
          ? "已儲存，稍後生效，已私訊你頻道清單，可關閉此頁。"
          : "已儲存，稍後生效；但目前無法私訊你，請開啟私訊權限，否則將收不到通知。"
      );
    } else {
      page(
        reply,
        200,
        delivered
          ? "綁定成功、已生效，已私訊你頻道清單，可關閉此頁。"
          : "綁定成功、已生效，但目前無法私訊你——請在 Discord 開啟「允許來自伺服器成員的私訊」後重新發起，否則將收不到通知。"
      );
    }
  }

  async sendBindingDm(
    discordUserId: string,
    channelIds: string[]
  ): Promise<boolean> {
    try {
      const lines = await ChannelModel.renderBoundChannelLines(channelIds);
      const content = `✅ 已完成 YouTube → Discord 私訊綁定。目前綁定的頻道：\n${lines.join(
        "\n"
      )}`;
      const user = await this.client.users.fetch(discordUserId);
      await user.send({ content });
      return true;
    } catch (error) {
      const code =
        error instanceof DiscordAPIError
          ? error.code
          : (error as { code?: unknown })?.code;
      if (code !== RESTJSONErrorCodes.CannotSendMessagesToThisUser) {
        console.warn(`[oauth] binding DM to ${discordUserId} failed:`, error);
      }
      return false;
    }
  }
}
