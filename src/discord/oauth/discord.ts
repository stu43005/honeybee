import axios from "axios";
import {
  DISCORD_OAUTH_CLIENT_ID,
  DISCORD_OAUTH_CLIENT_SECRET,
  PUBLIC_BASE_URL,
} from "../../constants.js";

const API = "https://discord.com/api";

export function discordRedirectUri(): string {
  return `${PUBLIC_BASE_URL}/oauth/youtube-dm/discord/callback`;
}

export function buildDiscordAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: DISCORD_OAUTH_CLIENT_ID ?? "",
    response_type: "code",
    scope: "identify connections",
    redirect_uri: discordRedirectUri(),
    state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export async function exchangeDiscordCode(code: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: DISCORD_OAUTH_CLIENT_ID ?? "",
    client_secret: DISCORD_OAUTH_CLIENT_SECRET ?? "",
    grant_type: "authorization_code",
    code,
    redirect_uri: discordRedirectUri(),
  });
  const res = await axios.post(`${API}/oauth2/token`, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return res.data.access_token as string;
}

export async function fetchDiscordUserId(accessToken: string): Promise<string> {
  const res = await axios.get(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data.id as string;
}

export async function fetchVerifiedYoutubeChannels(
  accessToken: string
): Promise<{ channelId: string; title: string }[]> {
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
