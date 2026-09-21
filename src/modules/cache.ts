import KeyvRedis from "@keyv/redis";
import { createCache } from "cache-manager";
import { CacheableMemory } from "cacheable";
import { Keyv } from "keyv";
import { REDIS_URI } from "#constants.js";

type CacheOptions = {
  // cache-manager
  ttl?: number;
  refreshThreshold?: number;
  nonBlocking?: boolean;

  // memory
  memoryTtl?: number | string;
  useClone?: boolean;
  lruSize?: number;
  checkInterval?: number;
};

/**
 * Stops the memory store's expiry sweep from holding the event loop open.
 *
 * The sweep is housekeeping — it drops entries nobody will read again, which a
 * plain `get` would have dropped anyway — so it must never be the reason a
 * process stays alive. cacheable starts it inside the constructor with a
 * referenced `setInterval`, and one of those is enough to pin the process:
 * every module that builds a cache at import time then keeps node running by
 * itself, which is how a jest worker comes to pass every test and hang.
 *
 * The handle is private to the class and has no accessor, hence the cast;
 * `stopIntervalCheck()` is public but ends the sweep rather than unreferencing
 * it. The field holds `0` until a sweep actually starts (`checkInterval: 0`
 * leaves it there), so the value is narrowed rather than assumed.
 */
function unreferenceExpirySweep(memory: CacheableMemory): void {
  const { _interval: sweep } = memory as unknown as {
    _interval: NodeJS.Timeout | number;
  };
  if (typeof sweep === "object") sweep.unref();
}

export function getCacheInstance(
  options?: CacheOptions
): ReturnType<typeof createCache> {
  const memory = new CacheableMemory({
    ttl: options?.memoryTtl ?? options?.ttl ?? 60_000,
    lruSize: options?.lruSize,
    useClone: options?.useClone,
    checkInterval: options?.checkInterval ?? 60_000,
  });
  unreferenceExpirySweep(memory);

  const stores: Keyv[] = [
    //  High performance in-memory cache with LRU and TTL
    new Keyv({ store: memory }),
  ];
  if (REDIS_URI && options?.useClone !== false) {
    stores.push(
      //  Redis Store
      new Keyv({
        store: new KeyvRedis(REDIS_URI),
      })
    );
  }

  // Multiple stores
  const cache = createCache({
    ttl: options?.ttl,
    refreshThreshold: options?.refreshThreshold,
    nonBlocking: options?.nonBlocking ?? true,
    stores: stores,
  });
  return cache;
}
