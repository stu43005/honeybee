import { randomBytes } from "node:crypto";
import type { RedisClientType } from "redis";
import { OAUTH_STATE_TTL_MS } from "../../constants.js";

export type OAuthMethod = "google" | "discord";
export interface OAuthState {
  discordUserId: string;
  method: OAuthMethod;
}

function key(state: string): string {
  return `youtube-dm-oauth:${state}`;
}

export function randomState(): string {
  return randomBytes(32).toString("hex");
}

export class OAuthStateStore {
  constructor(private readonly redis: RedisClientType) {}

  async put(state: string, data: OAuthState): Promise<void> {
    await this.redis.set(key(state), JSON.stringify(data), {
      PX: OAUTH_STATE_TTL_MS,
    });
  }

  async get(state: string): Promise<OAuthState | null> {
    const raw = await this.redis.get(key(state));
    return raw ? (JSON.parse(raw) as OAuthState) : null;
  }

  async del(state: string): Promise<void> {
    await this.redis.del(key(state));
  }
}
