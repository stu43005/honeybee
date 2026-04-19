import BeeQueue from "bee-queue";
import { WatchError, type RedisClientType } from "redis";
import {
  REDIS_URI,
  WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS,
} from "../../constants.js";
import type { WebhookJob } from "../../interfaces.js";

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
