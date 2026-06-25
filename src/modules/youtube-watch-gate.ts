import { setTimeout as sleepPromise } from "node:timers/promises";
import type { RedisClientType } from "redis";
import {
  YOUTUBE_WATCH_COOLDOWN_MS,
  YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS,
  YOUTUBE_WATCH_GATE_KEY_TTL_MS,
  YOUTUBE_WATCH_INTERVAL_MS,
} from "../constants.js";
import type { Module } from "./module.js";

const GATE_KEY = "hb:yt:watch:gate";
const COOLDOWN_LOG_KEY = "hb:yt:watch:cooldown-log";

// KEYS[1] = gate key; ARGV = [now, intervalMs, ttlMs].
// Returns -1 when the slot is claimed (key advanced to now+interval),
// otherwise the future nextAllowedAtMs so the caller can sleep until then.
const CLAIM_SCRIPT = `
local nextAllowed = tonumber(redis.call('GET', KEYS[1])) or 0
local now = tonumber(ARGV[1])
if now >= nextAllowed then
  redis.call('SET', KEYS[1], now + tonumber(ARGV[2]), 'PX', tonumber(ARGV[3]))
  return -1
else
  return nextAllowed
end
`;

// KEYS[1] = gate key, KEYS[2] = cooldown-log flag; ARGV = [now, cooldownMs, ttlMs].
// Pushes the gate to max(current, now+cooldown). Returns 1 the first time in a
// cooldown episode (flag freshly SET NX), else 0 — used for a once-per-episode log.
const PENALIZE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1])) or 0
local now = tonumber(ARGV[1])
local cooldown = tonumber(ARGV[2])
local target = now + cooldown
if target > current then
  redis.call('SET', KEYS[1], target, 'PX', tonumber(ARGV[3]))
end
local fresh = redis.call('SET', KEYS[2], '1', 'NX', 'PX', cooldown)
if fresh then return 1 else return 0 end
`;

export interface YoutubeWatchGateDeps {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  sleepPromise(ms, undefined, { signal }).then(() => undefined);

/**
 * Cross-pod rate gate for YouTube watch-page requests. Owns no Redis
 * connection — the shared client is injected and its lifecycle belongs to
 * RedisModule / Application. acquire()/penalize() never reject: every failure
 * path resolves false, fail-closed, so stats updates skip while chat collection
 * is unaffected.
 */
export class YoutubeWatchGate implements Module {
  name = "youtube-watch-gate";

  private localCooldownUntilMs = 0;
  private lastDegradedLogAtMs = 0;
  private lastEvalErrorLogAtMs = 0;
  private lastSaturatedLogAtMs = 0;
  private wasDegraded = false;

  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly redis: RedisClientType,
    deps: YoutubeWatchGateDeps = {}
  ) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  async acquire(maxWaitMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.now() < this.localCooldownUntilMs) return false;
    if (!this.redis.isReady) {
      this.maybeLogDegraded();
      return false;
    }
    if (this.wasDegraded) {
      console.warn("[YT GATE] recovered; resumed global coordination");
      this.wasDegraded = false;
      this.lastDegradedLogAtMs = 0;
    }
    const deadline = this.now() + maxWaitMs;
    for (;;) {
      if (signal?.aborted) return false;
      let result: number;
      try {
        result = Number(
          await this.redis.eval(CLAIM_SCRIPT, {
            keys: [GATE_KEY],
            arguments: [
              String(this.now()),
              String(YOUTUBE_WATCH_INTERVAL_MS),
              String(YOUTUBE_WATCH_GATE_KEY_TTL_MS),
            ],
          })
        );
      } catch (err) {
        // EVAL failed while connected (ACL/scripting disabled, script error):
        // distinct alert so this never silently disables all stats. A drop in
        // connection mid-wait flips isReady false → classify as degraded instead
        // (not an EVAL ERROR), so the cause is reported and recovery is tracked.
        if (this.redis.isReady) this.maybeLogEvalError(err);
        else this.maybeLogDegraded();
        return false;
      }
      if (result === -1) return true;
      const delay = result - this.now();
      if (delay <= 0) continue;
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        this.maybeLogSaturated();
        return false;
      }
      try {
        await this.sleep(Math.min(delay, remaining), signal);
      } catch {
        return false; // AbortError from the abortable sleep
      }
    }
  }

  async penalize(): Promise<boolean> {
    this.localCooldownUntilMs = this.now() + YOUTUBE_WATCH_COOLDOWN_MS;
    if (!this.redis.isReady) return false;
    try {
      const fresh = Number(
        await this.redis.eval(PENALIZE_SCRIPT, {
          keys: [GATE_KEY, COOLDOWN_LOG_KEY],
          arguments: [
            String(this.now()),
            String(YOUTUBE_WATCH_COOLDOWN_MS),
            String(YOUTUBE_WATCH_GATE_KEY_TTL_MS),
          ],
        })
      );
      if (fresh === 1) {
        console.warn(
          `entering YouTube watch rate-limit cooldown for ${Math.round(
            YOUTUBE_WATCH_COOLDOWN_MS / 1000
          )}s`
        );
      }
      return true;
    } catch (err) {
      this.maybeLogEvalError(err);
      return false;
    }
  }

  private maybeLogDegraded(): void {
    this.wasDegraded = true;
    const now = this.now();
    if (
      now - this.lastDegradedLogAtMs >=
      YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS
    ) {
      this.lastDegradedLogAtMs = now;
      console.warn(
        "<!> [YT GATE DEGRADED] redis not ready; skipping stats updates"
      );
    }
  }

  private maybeLogEvalError(err: unknown): void {
    const now = this.now();
    if (
      now - this.lastEvalErrorLogAtMs >=
      YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS
    ) {
      this.lastEvalErrorLogAtMs = now;
      console.warn(
        `<!> [YT GATE EVAL ERROR] eval failed while connected: ${err}`
      );
    }
  }

  private maybeLogSaturated(): void {
    const now = this.now();
    if (
      now - this.lastSaturatedLogAtMs >=
      YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS
    ) {
      this.lastSaturatedLogAtMs = now;
      console.warn(
        "<!> [YT GATE SATURATED] global rate budget exhausted; stats updates delayed"
      );
    }
  }
}
