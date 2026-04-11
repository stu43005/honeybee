import assert from "assert";
import { createClient, RedisClientType } from "redis";
import { REDIS_URI } from "../constants.js";
import type { Module } from "./module.js";

export class RedisModule implements Module {
  name = "redis";
  redis: RedisClientType;

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
    await this.redis.disconnect();
  }

  async healthCheck(): Promise<boolean> {
    await this.redis.ping();
    return true;
  }
}
