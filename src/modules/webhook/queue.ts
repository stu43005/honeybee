import BeeQueue from "bee-queue";
import { WatchError, type RedisClientType } from "redis";
import {
  REDIS_URI,
  SHUTDOWN_TIMEOUT,
  WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS,
  WEBHOOK_FOLLOW_UPDATE_COOLDOWN_MS,
  WEBHOOK_WORKER_CONCURRENCY,
} from "../../constants.js";
import type { WebhookJob } from "../../interfaces.js";
import type { Application } from "../application.js";
import type { Module } from "../module.js";
import { RedisModule } from "../redis.js";

const QUEUE_NAME = "webhook";

/**
 * Creates the shared bee-queue instance used by producers (enqueue) and
 * consumers (startWorker). The Redis settings mirror the existing QueueModule
 * pattern but add `removeOnFailure` and `activateDelayedJobs`:
 *
 * - `removeOnFailure: true` — without it, a permanently failed job keeps its
 *   id in `bq:webhook:jobs` forever, making coalesce permanently dedupe any
 *   future event for the same (webhookId, coll, docId).
 * - `activateDelayedJobs: true` — defaults to false in bee-queue. Without it,
 *   delayed jobs are saved to the `delayed` sorted set but never promoted to
 *   the waiting queue, so they never fire.
 */
export function createWebhookQueue(
  opts: { isWorker: boolean } = { isWorker: false }
): BeeQueue<WebhookJob> {
  return new BeeQueue<WebhookJob>(QUEUE_NAME, {
    redis: { url: REDIS_URI },
    removeOnSuccess: true,
    removeOnFailure: true, // 必要：否則失敗 job 的 ID 會永久佔用 jobs hash
    activateDelayedJobs: true, // 必要：否則 delayed job 永遠不會被觸發
    stallInterval: 30_000,
    isWorker: opts.isWorker,
  });
}

/**
 * In-flight detection for scheduleAndEnqueue's coalesce decision.
 * In `removeOnSuccess:true + removeOnFailure:true` mode, `getJob(id) !== null`
 * precisely means the id is still in `bq:webhook:jobs` hash, i.e. the job is
 * in one of {waiting, delayed, active, stalling, retrying} states.
 *
 * Do NOT use `job.status` for this check. bee-queue stores the status string
 * inside the job's serialized data; it is written once at construction (as
 * "created") and not updated when the job is pushed to waiting, promoted to
 * active, or moved between internal sets. For any job that has not yet
 * completed, `getJob(id).status === "created"` regardless of queue position,
 * so using it to infer queue state is wrong. The only reliable signal is
 * whether `getJob(id)` returns a non-null Job or null.
 */
export async function isJobInFlight(
  queue: BeeQueue<WebhookJob>,
  jobId: string
): Promise<boolean> {
  const job = await queue.getJob(jobId);
  return job !== null;
}

export function buildJobId(job: WebhookJob): string {
  return `${job.webhookId}:${job.coll}:${job.docId}`;
}

export function buildNextKey(jobId: string): string {
  return `webhook:next:${jobId}`;
}

export type ScheduleResult =
  | "immediate"
  | "delayed"
  | "coalesced"
  | "fallback-delayed";

/**
 * Atomically decide whether to enqueue immediately, delay, coalesce, or fall
 * back, and perform the corresponding bee-queue save(). Uses Redis
 * WATCH/MULTI/EXEC for optimistic concurrency on the per-job nextKey.
 *
 * Invariant: any two successive worker trigger times (delayUntil for delayed
 * branch, save time for immediate branch) for the same (webhookId, coll,
 * docId) differ by ≥ cooldown.
 *
 * node-redis v4 behaviour: when a WATCHed key changes before EXEC, `multi.exec()`
 * rejects with `WatchError` — it does NOT return null like ioredis. We catch
 * WatchError to retry and rethrow other errors.
 */
export async function scheduleAndEnqueue(
  queue: BeeQueue<WebhookJob>,
  redis: RedisClientType,
  job: WebhookJob,
  now: number,
  cooldown: number
): Promise<ScheduleResult> {
  const jobId = buildJobId(job);
  const nextKey = buildNextKey(jobId);
  let lastNextAllowed = 0;
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await redis.watch(nextKey);
    const raw = await redis.get(nextKey);
    const nextAllowed = raw === null ? 0 : parseInt(raw, 10);
    lastNextAllowed = nextAllowed;

    // In-flight check: getJob(id) !== null means id is still in bq:webhook:jobs
    if (await isJobInFlight(queue, jobId)) {
      await redis.unwatch();
      return "coalesced";
    }

    if (now >= nextAllowed) {
      const multi = redis.multi();
      multi.set(nextKey, String(now + cooldown), {
        PX: WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS,
      });
      try {
        await multi.exec();
      } catch (err) {
        if (err instanceof WatchError) continue; // WATCH triggered, retry
        throw err;
      }

      await queue.createJob(job).setId(jobId).save();
      return "immediate";
    }

    const delay = nextAllowed - now;
    const multi = redis.multi();
    multi.set(nextKey, String(nextAllowed + cooldown), {
      PX: WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS,
    });
    try {
      await multi.exec();
    } catch (err) {
      if (err instanceof WatchError) continue;
      throw err;
    }

    await queue
      .createJob(job)
      .setId(jobId)
      .delayUntil(now + delay)
      .save();
    return "delayed";
  }

  // Fallback: 5 retries exhausted. Use best-effort unconditional SET to advance
  // nextKey (avoids stale value breaking the ≥cooldown invariant after the
  // fallback job completes) then push a delayed job. setId-dedup handles the
  // race with other instances' winning saves.
  const fallbackNextAllowed = Math.max(
    lastNextAllowed + cooldown,
    now + cooldown * 2
  );
  await redis.set(nextKey, String(fallbackNextAllowed), {
    PX: WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS,
  });
  await queue
    .createJob(job)
    .setId(jobId)
    .delayUntil(now + cooldown)
    .save();
  return "fallback-delayed";
}

/**
 * Application module that manages the bee-queue worker lifecycle for this
 * instance. Producer-side concerns (queue connection + scheduleAndEnqueue
 * API) live in WebhookQueueProducerModule below.
 */
export class WebhookQueueConsumerModule implements Module {
  public readonly name = "webhook-queue-consumer";
  public isInit = false;

  public readonly queue: BeeQueue<WebhookJob>;
  private handler: ((job: BeeQueue.Job<WebhookJob>) => Promise<void>) | null =
    null;

  constructor() {
    this.queue = createWebhookQueue({ isWorker: true });
  }

  /**
   * Register the handler that worker runs for each incoming job. Must be
   * called before init().
   */
  setHandler(handler: (job: BeeQueue.Job<WebhookJob>) => Promise<void>): void {
    this.handler = handler;
  }

  async init(): Promise<void> {
    if (!this.handler) {
      throw new Error(
        "WebhookQueueConsumerModule.init called before setHandler"
      );
    }
    await this.queue.ready();
    this.queue.process(WEBHOOK_WORKER_CONCURRENCY, (job) => this.handler!(job));
  }

  async close(): Promise<void> {
    // bee-queue.close() stops accepting new jobs and waits up to timeout
    // for in-flight jobs to finish
    await this.queue.close(SHUTDOWN_TIMEOUT);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.queue.checkHealth();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Producer-side public API. Owns the non-worker bee-queue connection AND
 * exposes scheduleAndEnqueue() — the canonical way for upstream code (Layer 2
 * changeStream handler) to push webhook events into the queue with cooldown
 * semantics. Producer concerns (queue, redis client, cooldown defaults) live
 * here so callers don't have to thread them through.
 *
 * Dependencies:
 *   - RedisModule (looked up in init() via app.get): provides the redis client
 *     used by the underlying scheduleAndEnqueue() pure function for
 *     WATCH/MULTI/EXEC cooldown coordination.
 *
 * Registration order: must be registered AFTER RedisModule so that
 * `app.get("redis")` succeeds at init() time. The pure scheduleAndEnqueue()
 * function (above) remains exported for unit testing — production code should
 * call producerModule.scheduleAndEnqueue(job) instead.
 *
 * Shutdown ordering: LIFO close means changeStream module (registered later)
 * closes first and drains its setupQueue, so no new scheduleAndEnqueue calls
 * happen by the time this module's close() runs. The cached redis client
 * remains valid until RedisModule.close() runs (registered earlier, closes
 * later), eliminating any close-time use-after-disconnect risk.
 */
export class WebhookQueueProducerModule implements Module {
  public readonly name = "webhook-queue-producer";
  public isInit = false;

  public readonly queue: BeeQueue<WebhookJob>;
  private redis!: RedisClientType;

  constructor(private readonly app: Application) {
    this.queue = createWebhookQueue({ isWorker: false });
  }

  async init(): Promise<void> {
    const redisModule = this.app.get<RedisModule>("redis");
    if (!redisModule) {
      throw new Error(
        "WebhookQueueProducerModule.init: RedisModule must be registered before this module"
      );
    }
    this.redis = redisModule.redis;
    await this.queue.ready();
  }

  async close(): Promise<void> {
    await this.queue.close(SHUTDOWN_TIMEOUT);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.queue.checkHealth();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Producer-side public API: atomically schedule a webhook job into the queue
   * with cooldown semantics. Thin wrapper around the pure scheduleAndEnqueue
   * function (above) — the underlying algorithm is unit-tested via that pure
   * entry, and this method exists to bind the queue + redis dependencies that
   * production callers shouldn't have to know about.
   *
   * `now` and `cooldown` default to `Date.now()` and
   * `WEBHOOK_FOLLOW_UPDATE_COOLDOWN_MS` respectively for ergonomic production
   * calls; tests of the underlying algorithm exercise the pure function
   * directly with explicit args.
   */
  scheduleAndEnqueue(
    job: WebhookJob,
    now: number = Date.now(),
    cooldown: number = WEBHOOK_FOLLOW_UPDATE_COOLDOWN_MS
  ): Promise<ScheduleResult> {
    return scheduleAndEnqueue(this.queue, this.redis, job, now, cooldown);
  }
}
