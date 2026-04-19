import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { RedisClientType } from "redis";
import {
  WEBHOOK_PARTITION_HEARTBEAT_MS,
  WEBHOOK_PARTITION_TTL_MS,
  WEBHOOK_REBALANCE_DEBOUNCE_MS,
} from "../../constants.js";
import type { Application } from "../application.js";
import type { Module } from "../module.js";
import { RedisModule } from "../redis.js";

/**
 * Deterministic uint32 hash of a collection name.
 * Used by assignInstance() to map collections to instances.
 * MD5 is used for distribution only, not security.
 */
export function hashCollection(collName: string): number {
  const digest = createHash("md5").update(collName).digest();
  return digest.readUInt32BE(0);
}

/**
 * Pure function: given a collection name and a list of active instance IDs,
 * deterministically returns the instance responsible for that collection.
 * Instance list is sorted internally for stability.
 */
export function assignInstance(
  collName: string,
  instanceIds: readonly string[]
): string {
  if (instanceIds.length === 0) {
    throw new Error("assignInstance: no active instances");
  }
  const sorted = [...instanceIds].sort();
  return sorted[hashCollection(collName) % sorted.length];
}

const INSTANCE_KEY_PREFIX = "webhook:instance:";
const REBALANCE_CHANNEL = "webhook:rebalance";

function generateInstanceId(): string {
  return `${hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

interface InstanceMetadata {
  instanceId: string;
  hostname: string;
  pid: number;
  startedAt: number;
  version: string;
}

/**
 * Tracks the live set of webhook instances via per-instance Redis keys with
 * TTL (acts as a heartbeat) and broadcasts/listens for rebalance signals via
 * Redis pub/sub. Emits "rebalance" event whenever the active instance set
 * changes or a rebalance broadcast arrives. Consumers should recompute their
 * assigned collections via getAssignedCollections(allColls).
 *
 * Dependencies (obtained in init() via app.get):
 *   - RedisModule: provides both the main command connection (set/get/del/
 *     scan/publish) via redisModule.redis and the shared pub/sub subscriber
 *     connection via redisModule.getSubscriber(). RedisModule owns both
 *     connections' lifecycles, so this module does NOT call createClient or
 *     disconnect() — only subscribe()/unsubscribe() on its own channel.
 */
export class WebhookPartitionModule extends EventEmitter implements Module {
  public readonly name = "webhook-partition";
  public isInit = false;

  public readonly instanceId: string;
  private readonly metadata: InstanceMetadata;

  private redisModule!: RedisModule;
  private subscriber: RedisClientType | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private rebalanceDebounceTimer: NodeJS.Timeout | null = null;
  private activeInstanceIds: string[] = [];

  // Stored as a field (rather than an inline arrow at subscribe call site) so
  // we can pass the same reference to unsubscribe() during close, leaving any
  // other consumers of the shared subscriber connection unaffected.
  private readonly rebalanceListener = (): void => {
    this.scheduleRebalance();
  };

  constructor(
    private readonly app: Application,
    version = "unknown"
  ) {
    super();
    this.instanceId = generateInstanceId();
    this.metadata = {
      instanceId: this.instanceId,
      hostname: hostname(),
      pid: process.pid,
      startedAt: Date.now(),
      version,
    };
  }

  async init(): Promise<void> {
    const redisModule = this.app.get<RedisModule>("redis");
    if (!redisModule) {
      throw new Error(
        "WebhookPartitionModule.init: RedisModule must be registered before this module"
      );
    }
    this.redisModule = redisModule;
    this.subscriber = await this.redisModule.getSubscriber();

    // Subscribe to rebalance broadcasts
    await this.subscriber.subscribe(REBALANCE_CHANNEL, this.rebalanceListener);

    // Initial registration + active set load
    await this.register();
    await this.refreshActiveInstances();

    // Broadcast so other instances know we joined
    await this.redisModule.redis.publish(REBALANCE_CHANNEL, this.instanceId);

    // Start periodic heartbeat + SCAN
    this.heartbeatTimer = setInterval(() => {
      void this.tick();
    }, WEBHOOK_PARTITION_HEARTBEAT_MS);
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.rebalanceDebounceTimer) {
      clearTimeout(this.rebalanceDebounceTimer);
      this.rebalanceDebounceTimer = null;
    }
    try {
      await this.redisModule.redis.del(
        `${INSTANCE_KEY_PREFIX}${this.instanceId}`
      );
      await this.redisModule.redis.publish(REBALANCE_CHANNEL, this.instanceId);
    } catch {
      // ignore during shutdown
    }
    if (this.subscriber) {
      try {
        // Pass the specific listener reference so we don't drop other
        // consumers' callbacks on the shared subscriber connection.
        await this.subscriber.unsubscribe(
          REBALANCE_CHANNEL,
          this.rebalanceListener
        );
      } catch {
        // ignore during shutdown
      }
      this.subscriber = null;
    }
    // NOTE: do NOT disconnect this.redisModule.redis or the subscriber —
    // both are owned by RedisModule and will be closed when it shuts down.
  }

  /**
   * Given the full list of collections configured by enabled webhooks,
   * returns those assigned to this instance.
   */
  getAssignedCollections(allColls: readonly string[]): string[] {
    if (this.activeInstanceIds.length === 0) {
      return [];
    }
    return allColls.filter(
      (coll) => assignInstance(coll, this.activeInstanceIds) === this.instanceId
    );
  }

  /**
   * For tests and diagnostics.
   */
  getActiveInstanceIds(): readonly string[] {
    return this.activeInstanceIds;
  }

  private async register(): Promise<void> {
    await this.redisModule.redis.set(
      `${INSTANCE_KEY_PREFIX}${this.instanceId}`,
      JSON.stringify(this.metadata),
      { PX: WEBHOOK_PARTITION_TTL_MS }
    );
  }

  private async refreshActiveInstances(): Promise<void> {
    const ids: string[] = [];
    for await (const key of this.redisModule.redis.scanIterator({
      MATCH: `${INSTANCE_KEY_PREFIX}*`,
      COUNT: 100,
    })) {
      const id = key.slice(INSTANCE_KEY_PREFIX.length);
      ids.push(id);
    }
    ids.sort();
    const previous = this.activeInstanceIds;
    this.activeInstanceIds = ids;
    const changed =
      previous.length !== ids.length || previous.some((id, i) => id !== ids[i]);
    if (changed) {
      this.scheduleRebalance();
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.register(); // renew TTL
      await this.refreshActiveInstances();
    } catch (error) {
      console.error("[webhook-partition] tick failed:", error);
    }
  }

  private scheduleRebalance(): void {
    if (this.rebalanceDebounceTimer) return;
    this.rebalanceDebounceTimer = setTimeout(() => {
      this.rebalanceDebounceTimer = null;
      this.emit("rebalance");
    }, WEBHOOK_REBALANCE_DEBOUNCE_MS);
  }
}
