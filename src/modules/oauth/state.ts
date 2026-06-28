import { randomBytes } from "node:crypto";
import type { RedisClientType } from "redis";
import { OAUTH_STATE_TTL_MS } from "../../constants.js";

export type OAuthMethod = "google" | "discord";
export interface OAuthState {
  discordUserId: string;
  method: OAuthMethod;
}

let client: RedisClientType | null = null;

export function initOAuthStateStore(redis: RedisClientType): void {
  client = redis;
}

function getClient(): RedisClientType {
  if (!client) throw new Error("OAuth state store not initialized");
  return client;
}

function key(state: string): string {
  return `youtube-dm-oauth:${state}`;
}

export function randomState(): string {
  return randomBytes(32).toString("hex");
}

export async function putOAuthState(
  state: string,
  data: OAuthState
): Promise<void> {
  await getClient().set(key(state), JSON.stringify(data), {
    PX: OAUTH_STATE_TTL_MS,
  });
}

export async function getOAuthState(state: string): Promise<OAuthState | null> {
  const raw = await getClient().get(key(state));
  return raw ? (JSON.parse(raw) as OAuthState) : null;
}

export async function delOAuthState(state: string): Promise<void> {
  await getClient().del(key(state));
}
