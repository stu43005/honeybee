import BeeQueue from "bee-queue";
import { REDIS_URI } from "../../constants.js";
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
