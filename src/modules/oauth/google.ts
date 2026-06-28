import { google as googleapis, type youtube_v3 } from "googleapis";
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  PUBLIC_BASE_URL,
} from "../../constants.js";
import type { OAuthChannel, OAuthProvider } from "./provider.js";
import type { OAuthState } from "./state-store.js";

const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];

export class GoogleProvider implements OAuthProvider {
  readonly method = "google" as const;
  readonly emptyMessage = "找不到可綁定的 YouTube 頻道。";

  private redirectUri(): string {
    return `${PUBLIC_BASE_URL}/oauth/youtube-dm/google/callback`;
  }

  private oauthClient() {
    return new googleapis.auth.OAuth2({
      clientId: GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: this.redirectUri(),
    });
  }

  buildAuthUrl(state: string): string {
    return this.oauthClient().generateAuthUrl({
      access_type: "online",
      scope: SCOPES,
      state,
    });
  }

  // Page through all owned channels (mine: true). Exposed so tests can stub the
  // googleapis round-trip without hitting the network.
  async listOwnedChannels(code: string): Promise<youtube_v3.Schema$Channel[]> {
    const client = this.oauthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const youtube = googleapis.youtube({ version: "v3", auth: client });
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

  async listChannels(
    code: string,
    _state: OAuthState
  ): Promise<OAuthChannel[]> {
    const items = await this.listOwnedChannels(code);
    return items
      .filter((i) => !!i.id)
      .map((i) => ({
        channelId: i.id as string,
        title: i.snippet?.title ?? "Unknown channel",
      }));
  }
}

// Temporary compatibility exports for callers still importing the old
// function API; kept until every caller uses GoogleProvider directly.
const _google = new GoogleProvider();
export const buildGoogleAuthUrl = (state: string) =>
  _google.buildAuthUrl(state);
export const fetchGoogleChannels = (code: string) =>
  _google.listChannels(code, { discordUserId: "", method: "google" });
