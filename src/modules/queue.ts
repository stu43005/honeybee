import assert from "assert";
import Queue from "bee-queue";
import redis from "redis";
import type { HoneybeeJob } from "../interfaces";

// feature flags
const QUEUE_NAME = "honeybee";
const REDIS_URI = process.env.REDIS_URI;

export function getQueueInstance(args: any = {}) {
  assert(REDIS_URI, "REDIS_URI should be defined.");

  return new Queue<HoneybeeJob>(QUEUE_NAME, {
    redis: redis.createClient(REDIS_URI),
    stallInterval: 30 * 1000, // 30sec
    ...args,
  });
}
