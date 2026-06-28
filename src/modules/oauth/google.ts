import { google as googleapis, type youtube_v3 } from "googleapis";
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  PUBLIC_BASE_URL,
} from "../../constants.js";

const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];

export function googleRedirectUri(): string {
  return `${PUBLIC_BASE_URL}/oauth/youtube-dm/google/callback`;
}

function oauthClient() {
  return new googleapis.auth.OAuth2({
    clientId: GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: googleRedirectUri(),
  });
}

export function buildGoogleAuthUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "online",
    scope: SCOPES,
    state,
  });
}

export async function listOwnedChannels(
  code: string
): Promise<youtube_v3.Schema$Channel[]> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const youtube = googleapis.youtube({ version: "v3", auth: client });
  // Page through all owned channels (mine: true) so we never silently omit any.
  const items: youtube_v3.Schema$Channel[] = [];
  let pageToken: string | undefined;
  do {
    const res = await youtube.channels.list({
      mine: true,
      part: ["snippet"],
      maxResults: 50,
      pageToken,
    });
    items.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return items;
}

export async function fetchGoogleChannels(
  code: string,
  listFn: (
    code: string
  ) => Promise<youtube_v3.Schema$Channel[]> = listOwnedChannels
): Promise<{ channelId: string; title: string }[]> {
  const items = await listFn(code);
  return items
    .filter((i) => !!i.id)
    .map((i) => ({
      channelId: i.id as string,
      title: i.snippet?.title ?? "Unknown channel",
    }));
}
