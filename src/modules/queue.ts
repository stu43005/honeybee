import assert from "assert";
import Queue from "bee-queue";
import { REDIS_URI, SHUTDOWN_TIMEOUT } from "../constants";
import type { HoneybeeJob } from "../interfaces";
import type { Module } from "./module";

type QueueTypes = {
  honeybee: HoneybeeJob;
};

export class QueueModule<T extends keyof QueueTypes> implements Module {
  name: string;
  queue: Queue<QueueTypes[T]>;

  constructor(queueName: T, args: any = {}) {
    this.name = `queue-${queueName}`;
    assert(REDIS_URI, "REDIS_URI should be defined.");
    this.queue = new Queue(queueName, {
      redis: {
        url: REDIS_URI,
      },
      stallInterval: 30 * 1000, // 30sec
      ...args,
    });
  }

  async init(): Promise<void> {
    await this.queue.ready();
  }

  async close(): Promise<void> {
    await this.queue.close(SHUTDOWN_TIMEOUT);
  }

  async healthCheck(): Promise<boolean> {
    await this.queue.checkHealth();
    return true;
  }
}
