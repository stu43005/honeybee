import axios from "axios";
import {
  DISCORD_OAUTH_CLIENT_ID,
  DISCORD_OAUTH_CLIENT_SECRET,
  PUBLIC_BASE_URL,
} from "../../constants.js";
import {
  IdentityMismatchError,
  type OAuthChannel,
  type OAuthProvider,
} from "./provider.js";
import type { OAuthState } from "./state-store.js";

const API = "https://discord.com/api";

export class DiscordProvider implements OAuthProvider {
  readonly method = "discord" as const;
  readonly emptyMessage = "你的 Discord 沒有已驗證的 YouTube 連結。";

  private redirectUri(): string {
    return `${PUBLIC_BASE_URL}/oauth/youtube-dm/discord/callback`;
  }

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: DISCORD_OAUTH_CLIENT_ID ?? "",
      response_type: "code",
      scope: "identify connections",
      redirect_uri: this.redirectUri(),
      state,
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: DISCORD_OAUTH_CLIENT_ID ?? "",
      client_secret: DISCORD_OAUTH_CLIENT_SECRET ?? "",
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
    });
    const res = await axios.post(`${API}/oauth2/token`, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return res.data.access_token as string;
  }

  async fetchUserId(accessToken: string): Promise<string> {
    const res = await axios.get(`${API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.data.id as string;
  }

  async fetchVerifiedChannels(accessToken: string): Promise<OAuthChannel[]> {
    const res = await axios.get(`${API}/users/@me/connections`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const connections = (res.data ?? []) as {
      type: string;
      id: string;
      name: string;
      verified: boolean;
    }[];
    return connections
      .filter((c) => c.type === "youtube" && c.verified)
      .map((c) => ({ channelId: c.id, title: c.name }));
  }

  async listChannels(code: string, state: OAuthState): Promise<OAuthChannel[]> {
    const token = await this.exchangeCode(code);
    const authorizerId = await this.fetchUserId(token);
    if (authorizerId !== state.discordUserId) {
      throw new IdentityMismatchError();
    }
    return this.fetchVerifiedChannels(token);
  }
}
