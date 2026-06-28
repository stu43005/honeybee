import type { OAuthMethod, OAuthState } from "./state-store.js";

export interface OAuthChannel {
  channelId: string;
  title: string;
}

export interface OAuthProvider {
  readonly method: OAuthMethod;
  /** User-facing message shown when listChannels returns no bindable channels. */
  readonly emptyMessage: string;
  buildAuthUrl(state: string): string;
  /** Exchanges the code and returns the channels to bind. */
  listChannels(code: string, state: OAuthState): Promise<OAuthChannel[]>;
}

/** Thrown by a provider when the authorizer's identity != the state's user. */
export class IdentityMismatchError extends Error {}
