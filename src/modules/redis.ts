import assert from "assert";
import { createClient, RedisClientType } from "redis";
import { REDIS_URI } from "../constants.js";
import type { Module } from "./module.js";

export class RedisModule implements Module {
  name = "redis";
  redis: RedisClientType;
  private _subscriber?: RedisClientType;

  constructor() {
    assert(REDIS_URI, "REDIS_URI should be defined.");
    this.redis = createClient({
      url: REDIS_URI,
    });
  }

  async init(): Promise<void> {
    await this.redis.connect();
  }

  async close(): Promise<void> {
    if (this._subscriber?.isOpen) {
      try {
        await this._subscriber.disconnect();
      } catch {
        // ignore during shutdown
      }
    }
    await this.redis.disconnect();
  }

  async healthCheck(): Promise<boolean> {
    await this.redis.ping();
    return true;
  }

  /**
   * Returns a connected Redis subscriber connection. Redis subscribe mode is
   * exclusive — a connection in subscribe state cannot execute any other
   * command — so consumers that need pub/sub must use a dedicated connection
   * separate from the main command connection (this.redis).
   *
   * Lazy-initialized on first call and reused for all subsequent calls;
   * lifecycle (disconnect on RedisModule.close) is owned here, so consumers
   * MUST NOT call disconnect() on the returned client. Consumers SHOULD
   * unsubscribe() from their own channels in their close() to clean up
   * listeners — the underlying connection stays alive for any other consumer.
   */
  async getSubscriber(): Promise<RedisClientType> {
    if (!this._subscriber) {
      this._subscriber = this.redis.duplicate();
      await this._subscriber.connect();
    }
    return this._subscriber;
  }
}
