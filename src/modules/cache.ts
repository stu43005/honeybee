import KeyvRedis from "@keyv/redis";
import { createCache } from "cache-manager";
import { CacheableMemory } from "cacheable";
import { Keyv } from "keyv";
import { REDIS_URI } from "../constants.js";

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

export function getCacheInstance(
  options?: CacheOptions
): ReturnType<typeof createCache> {
  const stores: Keyv[] = [
    //  High performance in-memory cache with LRU and TTL
    new Keyv({
      store: new CacheableMemory({
        ttl: options?.memoryTtl ?? options?.ttl ?? 60_000,
        lruSize: options?.lruSize,
        useClone: options?.useClone,
        checkInterval: options?.checkInterval ?? 60_000,
      }),
    }),
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
