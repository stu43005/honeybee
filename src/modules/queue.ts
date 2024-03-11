import assert from "assert";
import Queue from "bee-queue";
import type { Video } from "holodex.js";
import redis from "redis";

export interface Job {
  videoId: string;
  stream: Video;
}

// feature flags
const QUEUE_NAME = "honeybee";
const REDIS_URI = process.env.REDIS_URI;

export function getQueueInstance(args: any = {}) {
  assert(REDIS_URI);

  return new Queue<Job>(QUEUE_NAME, {
    redis: redis.createClient(REDIS_URI),
    stallInterval: 30 * 1000, // 30sec
    ...args,
  });
}
