import assert from "assert";
import Queue from "bee-queue";
import type { HoneybeeJob } from "../interfaces";

const REDIS_URI = process.env.REDIS_URI;

type QueueTypes = {
  "honeybee": HoneybeeJob;
}

export function getQueueInstance<T extends keyof QueueTypes>(queueName: T, args: any = {}): Queue<QueueTypes[T]> {
  assert(REDIS_URI, "REDIS_URI should be defined.");

  return new Queue(queueName, {
    redis: {
      url: REDIS_URI,
    },
    stallInterval: 30 * 1000, // 30sec
    ...args,
  });
}
