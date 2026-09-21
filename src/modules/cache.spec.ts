/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";

// Read at module load by src/constants.ts, so it has to be set before anything
// pulls the cache module in. Empty keeps getCacheInstance memory-only, which is
// what makes the timer assertion below about the memory store alone.
process.env.REDIS_URI = "";

const { getCacheInstance } = await import("#modules/cache.js");

/**
 * How many timers are currently holding the event loop open. Node counts only
 * referenced ones here, so an unref'd sweep does not show up.
 */
function referencedTimers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

describe("getCacheInstance", () => {
  it("runs its expiry sweep without holding the event loop open", () => {
    const before = referencedTimers();

    // Two, because the webhook service builds two at module scope and the cost
    // is per instance: one referenced timer each is enough to pin the process.
    getCacheInstance({ ttl: 60_000 });
    getCacheInstance({ ttl: 300_000 });

    // The sweep is housekeeping — it frees entries nobody will read again — so
    // it must never be the reason a process stays alive. Left referenced, any
    // module that builds a cache at import time never lets node exit: a jest
    // worker importing such a module passes every test and then hangs until it
    // is force-killed.
    expect(referencedTimers()).toBe(before);
  });

  it("still stores and reads back a value", async () => {
    const cache = getCacheInstance({ ttl: 60_000 });

    await cache.set("k", { v: 1 });

    // The timer change above must not have cost the store its actual job.
    await expect(cache.get("k")).resolves.toEqual({ v: 1 });
  });
});
