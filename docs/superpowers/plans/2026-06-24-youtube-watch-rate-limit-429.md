# YouTube watch-page 429 cross-pod rate limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-process YouTube watch-page rate limiter with a Redis-backed gate that coordinates request pacing across all worker pods and makes every pod back off together on a 429.

**Architecture:** A new `YoutubeWatchGate` module holds a single "next-allowed timestamp" key in shared Redis and drives it with two atomic Lua `EVAL` scripts (`acquire` claim + `penalize` cooldown). The worker registers a `RedisModule` (with a new non-blocking option so a gate-only Redis outage never blocks startup or fails liveness) and injects its client into the gate. Stats updates go through `gate.acquire()` (bounded-blocking) and report 429s via `gate.penalize()`.

**Tech Stack:** TypeScript (ESM, NodeNext), node-redis v4 (`redis@4.6.13` / `@redis/client@1.5.14`) Lua `EVAL`, Jest (ts-jest ESM), Typegoose/Mongoose (existing), Bee-Queue (existing).

**Source of truth:** `docs/superpowers/specs/2026-06-23-youtube-watch-rate-limit-429-design.md`.

---

## File Structure

**Create:**

- `src/modules/youtube-watch-gate.ts` — the `YoutubeWatchGate` module: `acquire()` / `penalize()`, the two Lua scripts, process-local backoff/log-throttle state, and the three rate-limited observability logs. Owns no Redis connection (client injected).
- `src/modules/youtube-watch-gate.spec.ts` — gate unit tests (stateful Redis fake + injected clock/sleep).
- `src/modules/redis.spec.ts` — `RedisModule` `nonBlockingConnect` option tests.
- `src/commands/worker.spec.ts` — `is429()` pure-function tests.

**Modify:**

- `src/constants.ts` — add five `YOUTUBE_WATCH_*` constants (two env-overridable).
- `src/modules/redis.ts` — add the optional `nonBlockingConnect` constructor option.
- `src/commands/worker.ts` — register `RedisModule` + `YoutubeWatchGate`, thread the gate into `handleJob`, rewrite `updateVideoStats` to use the gate, add exported `is429()`, drop the old limiter import.

**Delete:**

- `src/modules/rate-limiter.ts` — superseded by the gate (only `worker.ts` imports it).

**Tooling commands used in this plan:**

- Single test file: `NODE_OPTIONS='--experimental-vm-modules' npx jest <path>`
- Type check: `npm run build`
- Lint: `npm run lint`

---

### Task 1: Add rate-limit constants

**Files:**

- Modify: `src/constants.ts` (append new exports; file is currently 99 lines)

- [ ] **Step 1: Add the five constants**

Append to the end of `src/constants.ts` (after the existing `WEBHOOK_RESULT_FOLLOW_TTL_MS` export). Use the existing `Number(process.env.X ?? default)` idiom (matches `JOB_CONCURRENCY` on line 9):

```ts
// --- YouTube watch-page rate gate (src/modules/youtube-watch-gate.ts) ---

// Global (across ALL worker pods) minimum interval between watch-page requests.
// Pre-change was per-pod 1/s; 3 pods sharing one egress IP ≈ 3 req/s to YouTube.
// A global 1 req/s removes that 3x amplification. Env-overridable for tuning.
export const YOUTUBE_WATCH_INTERVAL_MS = Number(
  process.env.YOUTUBE_WATCH_INTERVAL_MS ?? 1000
);

// After a 429 every pod pauses watch-page requests for this long so YouTube's
// rate-limit window can cool down. 1 minute aligns with the stats-update period
// (skipping one cycle suffices to recover).
export const YOUTUBE_WATCH_COOLDOWN_MS = 60 * 1000;

// Redis TTL for the gate key. Clearly larger than the cooldown so the cooldown
// never lapses mid-window because the key expired (mirrors the `* 3` convention
// of WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS).
export const YOUTUBE_WATCH_GATE_KEY_TTL_MS = YOUTUBE_WATCH_COOLDOWN_MS * 3;

// Upper bound on how long a single acquire() queues for a free slot. 5s (= 5
// intervals) absorbs steady-state concurrent queueing; far below COOLDOWN_MS
// (skip rather than burn the job during a cooldown) and far below
// SHUTDOWN_TIMEOUT (45s), and the wait is abortable. Env-overridable for tuning.
export const YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS = Number(
  process.env.YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS ?? 5000
);

// Minimum interval shared by the gate's three rate-limited alert logs (degraded
// / eval-error / saturated). 1 minute keeps a sustained anomaly observable
// without flooding (versus logging on every acquire).
export const YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS = 60 * 1000;
```

- [ ] **Step 2: Type-check and lint**

Run: `npm run build`
Expected: compiles with no errors.

Run: `npm run lint`
Expected: no new lint errors.

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat(constants): add YouTube watch-page rate-gate constants"
```

---

### Task 2: Add `nonBlockingConnect` option to `RedisModule`

A best-effort consumer (the gate) must not let a Redis outage block worker startup or fail `/healthz` liveness. When `nonBlockingConnect: true`, `init()` does not `await connect()` (node-redis's default `reconnectStrategy` retries the initial connect forever in the background), `healthCheck()` returns `true` without `ping()` (so `/healthz` — used as worker startup+liveness probe — never fails on this module), and `close()` stops the background reconnect in every connection state without throwing. Default (`false`) keeps the existing `await connect()` / `ping()` behavior so webhook and other services are unchanged.

**Files:**

- Modify: `src/modules/redis.ts` (currently 57 lines)
- Test: `src/modules/redis.spec.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/modules/redis.spec.ts`:

```ts
import {
  describe,
  expect,
  it,
  jest,
  beforeAll,
  beforeEach,
} from "@jest/globals";

// constants.ts asserts REDIS_URI at construct time; define it before importing.
process.env.REDIS_URI = "redis://localhost:6379";

// Controllable fake redis client; createClient is mocked to return it.
type FakeClient = {
  isOpen: boolean;
  isReady: boolean;
  connect: jest.Mock<() => Promise<void>>;
  disconnect: jest.Mock<() => Promise<void>>;
  ping: jest.Mock<() => Promise<string>>;
  duplicate: jest.Mock;
  on: jest.Mock;
  handlers: Record<string, Array<(...a: unknown[]) => void>>;
  emit: (event: string, ...args: unknown[]) => void;
};

let fake: FakeClient;

function makeFake(): FakeClient {
  const handlers: FakeClient["handlers"] = {};
  const f: FakeClient = {
    isOpen: false,
    isReady: false,
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ping: jest.fn<() => Promise<string>>().mockResolvedValue("PONG"),
    duplicate: jest.fn(),
    handlers,
    on: jest.fn((event: string, cb: (...a: unknown[]) => void) => {
      (handlers[event] ??= []).push(cb);
      return f;
    }) as unknown as jest.Mock,
    emit: (event: string, ...args: unknown[]) =>
      (handlers[event] ?? []).forEach((h) => h(...args)),
  };
  return f;
}

jest.unstable_mockModule("redis", () => ({
  createClient: jest.fn(() => fake),
}));

const { RedisModule } = await import("./redis.js");

beforeEach(() => {
  fake = makeFake();
});

describe("RedisModule nonBlockingConnect", () => {
  it("default: init awaits connect, healthCheck pings", async () => {
    let resolveConnect!: () => void;
    fake.connect.mockReturnValue(
      new Promise<void>((r) => {
        resolveConnect = r;
      })
    );
    const mod = new RedisModule();
    let initDone = false;
    const initPromise = mod.init().then(() => {
      initDone = true;
    });
    await Promise.resolve();
    expect(initDone).toBe(false); // init still awaiting connect
    resolveConnect();
    await initPromise;
    expect(initDone).toBe(true);

    fake.isReady = true;
    await expect(mod.healthCheck()).resolves.toBe(true);
    expect(fake.ping).toHaveBeenCalledTimes(1);
  });

  it("nonBlockingConnect: init does not await connect; error listener attached first", async () => {
    let resolveConnect!: () => void;
    fake.connect.mockReturnValue(
      new Promise<void>((r) => {
        resolveConnect = r;
      })
    );
    const mod = new RedisModule({ nonBlockingConnect: true });
    await mod.init(); // resolves even though connect is still pending
    expect(fake.connect).toHaveBeenCalledTimes(1);
    // 'error' listener registered before connect() so background failures
    // cannot crash the process.
    const onCalls = fake.on.mock.calls.map((c) => c[0]);
    expect(onCalls).toContain("error");
    // a background error event must not throw
    expect(() => fake.emit("error", new Error("boom"))).not.toThrow();
    resolveConnect();
  });

  it("nonBlockingConnect: healthCheck returns true without ping", async () => {
    const mod = new RedisModule({ nonBlockingConnect: true });
    await mod.init();
    fake.isReady = false; // gate Redis not connected
    await expect(mod.healthCheck()).resolves.toBe(true);
    expect(fake.ping).not.toHaveBeenCalled();
  });

  it("nonBlockingConnect: close while connect pending disconnects and awaits", async () => {
    let resolveConnect!: () => void;
    fake.connect.mockReturnValue(
      new Promise<void>((r) => {
        resolveConnect = r;
      })
    );
    const mod = new RedisModule({ nonBlockingConnect: true });
    await mod.init();
    fake.isOpen = true; // connecting/retrying → isOpen true
    const closePromise = mod.close();
    resolveConnect(); // pending connect settles
    await expect(closePromise).resolves.toBeUndefined();
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it("nonBlockingConnect: close while connect keeps failing does not reject", async () => {
    fake.connect.mockRejectedValue(new Error("gave up"));
    const mod = new RedisModule({ nonBlockingConnect: true });
    await mod.init();
    fake.isOpen = true;
    await expect(mod.close()).resolves.toBeUndefined();
  });

  it("nonBlockingConnect: close when never opened is a no-op, no disconnect", async () => {
    fake.connect.mockRejectedValue(new Error("never connected"));
    const mod = new RedisModule({ nonBlockingConnect: true });
    await mod.init();
    fake.isOpen = false; // never connected / gave up
    await expect(mod.close()).resolves.toBeUndefined();
    expect(fake.disconnect).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/redis.spec.ts`
Expected: FAIL — `RedisModule` constructor does not accept options; `nonBlockingConnect` behavior absent.

- [ ] **Step 3: Implement the option**

Replace the contents of `src/modules/redis.ts` with:

```ts
import assert from "assert";
import { createClient, RedisClientType } from "redis";
import { REDIS_URI } from "../constants.js";
import type { Module } from "./module.js";

export interface RedisModuleOptions {
  /**
   * Mark this RedisModule as a non-critical, best-effort dependency.
   * When true: init() does not `await connect()` (node-redis's default
   * reconnectStrategy retries the initial connect forever in the background),
   * healthCheck() returns true without ping() so it never fails /healthz
   * liveness, and close() stops the background reconnect in every state.
   * Default false keeps the existing blocking behavior for critical consumers.
   */
  nonBlockingConnect?: boolean;
}

export class RedisModule implements Module {
  name = "redis";
  redis: RedisClientType;
  private _subscriber?: RedisClientType;
  private nonBlockingConnect: boolean;
  private connectPromise?: Promise<void>;

  constructor(options: RedisModuleOptions = {}) {
    assert(REDIS_URI, "REDIS_URI should be defined.");
    this.nonBlockingConnect = options.nonBlockingConnect ?? false;
    this.redis = createClient({
      url: REDIS_URI,
    });
  }

  async init(): Promise<void> {
    if (this.nonBlockingConnect) {
      // Attach an 'error' listener BEFORE connect: node-redis emits 'error' on
      // every failed (re)connect attempt, and an EventEmitter 'error' with no
      // listener throws and crashes the process. Best-effort: gate Redis health
      // is surfaced via the gate's degraded log, not here.
      this.redis.on("error", () => undefined);
      // Fire-and-forget; do not block startup. The terminal catch swallows the
      // rejection that only happens if the connect is interrupted by close().
      this.connectPromise = this.redis.connect().then(
        () => undefined,
        () => undefined
      );
      return;
    }
    await this.redis.connect();
  }

  async close(): Promise<void> {
    if (this._subscriber?.isOpen) {
      try {
        await this._subscriber.disconnect();
      } catch {
        // ignore during shutdown
      }
    }
    if (this.nonBlockingConnect) {
      // connect() sets isOpen=true immediately and the initial-connect retry
      // loop runs while (isOpen && !isReady); so isOpen is true while connected
      // OR still retrying. disconnect() in that state clears isOpen, ending the
      // retry loop and closing the socket. When isOpen is false (never started
      // or gave up) disconnect() would throw ClientClosedError, so skip it.
      if (this.redis.isOpen) {
        try {
          await this.redis.disconnect();
        } catch {
          // ignore during shutdown
        }
      }
      if (this.connectPromise) {
        await this.connectPromise; // terminal-caught; settles, never rejects
      }
      return;
    }
    await this.redis.disconnect();
  }

  async healthCheck(): Promise<boolean> {
    if (this.nonBlockingConnect) {
      // Non-critical: never fail /healthz liveness on this connection.
      return true;
    }
    await this.redis.ping();
    return true;
  }

  /**
   * Returns a connected Redis subscriber connection. Redis subscribe mode is
   * exclusive — a connection in subscribe state cannot execute any other
   * command — so consumers that need pub/sub must use a dedicated connection
   * separate from the main command connection (this.redis).
   *
   * Lazy-initialized on first call and reused for all subsequent calls;
   * lifecycle (disconnect on RedisModule.close) is owned here, so consumers
   * MUST NOT call disconnect() on the returned client. Consumers SHOULD
   * unsubscribe() from their own channels in their close() to clean up
   * listeners — the underlying connection stays alive for any other consumer.
   */
  async getSubscriber(): Promise<RedisClientType> {
    if (!this._subscriber) {
      this._subscriber = this.redis.duplicate();
      await this._subscriber.connect();
    }
    return this._subscriber;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/redis.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Type-check and lint**

Run: `npm run build`
Expected: compiles with no errors.

Run: `npm run lint`
Expected: no new lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/redis.ts src/modules/redis.spec.ts
git commit -m "feat(redis): add nonBlockingConnect option for best-effort consumers"
```

---

### Task 3: Add the `YoutubeWatchGate` module

The gate owns no Redis connection (the client is injected). `acquire(maxWaitMs, signal)` runs a bounded-blocking loop driven by an atomic Lua claim script; it returns `false` (never rejects) on local cooldown, degraded Redis, abort, eval error, or budget exhaustion, logging the distinct rate-limited alert for each diagnosable cause. `penalize()` records a global cooldown via a second Lua script, returns whether Redis recorded it, sets a process-local backoff unconditionally, and emits the cooldown-entry log once per episode via a Redis `SET NX` flag. The clock and sleep are injected (default to `Date.now` / `node:timers/promises`) so the loop is deterministically testable.

**Files:**

- Create: `src/modules/youtube-watch-gate.ts`
- Test: `src/modules/youtube-watch-gate.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/youtube-watch-gate.spec.ts`:

```ts
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { YoutubeWatchGate } from "./youtube-watch-gate.js";
import {
  YOUTUBE_WATCH_INTERVAL_MS,
  YOUTUBE_WATCH_COOLDOWN_MS,
  YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS,
  YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS,
} from "../constants.js";

const GATE_KEY = "hb:yt:watch:gate";
const COOLDOWN_LOG_KEY = "hb:yt:watch:cooldown-log";

// Stateful redis fake: eval performs the real read-compare-write against an
// in-memory store, distinguishing claim (1 key) from penalize (2 keys).
function makeHarness(opts?: { isReady?: boolean; startTime?: number }) {
  const store: Record<string, string> = {};
  const state = {
    time: opts?.startTime ?? 1_000_000,
    isReady: opts?.isReady ?? true,
    throwEval: false,
  };
  const evalMock = jest.fn(
    async (
      _script: string,
      o: { keys: string[]; arguments: string[] }
    ): Promise<number> => {
      if (state.throwEval) throw new Error("eval rejected");
      const now = Number(o.arguments[0]);
      if (o.keys.length === 1) {
        // claim: arguments=[now, interval, ttl]
        const interval = Number(o.arguments[1]);
        const nextAllowed =
          store[o.keys[0]] != null ? Number(store[o.keys[0]]) : 0;
        if (now >= nextAllowed) {
          store[o.keys[0]] = String(now + interval);
          return -1;
        }
        return nextAllowed;
      }
      // penalize: arguments=[now, cooldown, ttl]
      const cooldown = Number(o.arguments[1]);
      const current = store[o.keys[0]] != null ? Number(store[o.keys[0]]) : 0;
      const target = now + cooldown;
      if (target > current) store[o.keys[0]] = String(target);
      if (store[o.keys[1]] != null) return 0;
      store[o.keys[1]] = "1";
      return 1;
    }
  );
  const fakeRedis = {
    get isReady() {
      return state.isReady;
    },
    eval: evalMock,
  };
  const sleep = jest.fn(async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    state.time += ms; // advance virtual clock
  });
  const gate = new YoutubeWatchGate(fakeRedis as never, {
    now: () => state.time,
    sleep,
  });
  return { gate, store, state, evalMock, sleep };
}

let warnSpy: jest.SpiedFunction<typeof console.warn>;
beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

function warnCount(tag: string): number {
  return warnSpy.mock.calls.filter((c) => String(c[0]).includes(tag)).length;
}

describe("YoutubeWatchGate.acquire", () => {
  it("1. steady-state claim sets nextAllowedAtMs = now + INTERVAL", async () => {
    const { gate, store, state } = makeHarness();
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      true
    );
    expect(store[GATE_KEY]).toBe(
      String(state.time + YOUTUBE_WATCH_INTERVAL_MS)
    );
  });

  it("2. bounded-blocking queues then claims after the interval", async () => {
    const { gate, store, state, sleep } = makeHarness();
    const t0 = state.time;
    await gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS); // key -> t0 + INTERVAL
    // second acquire at the same instant must wait then claim
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      true
    );
    expect(sleep).toHaveBeenCalled();
    // claimed → key advanced one more interval past the first
    expect(store[GATE_KEY]).toBe(String(t0 + 2 * YOUTUBE_WATCH_INTERVAL_MS));
  });

  it("3. budget exhausted during cooldown → false + SATURATED, key unchanged", async () => {
    const { gate, store, state } = makeHarness();
    await gate.penalize(); // key -> now + COOLDOWN (>> MAX_WAIT)
    const cooldownValue = store[GATE_KEY];
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      false
    );
    expect(store[GATE_KEY]).toBe(cooldownValue); // never claimed
    expect(warnCount("[YT GATE SATURATED]")).toBe(1);
  });

  it("4. abort during wait resolves false (not reject); pre-aborted skips eval", async () => {
    // abort mid-wait
    const store: Record<string, string> = { [GATE_KEY]: String(2_000_000) };
    const evalMock = jest.fn(async () => Number(store[GATE_KEY])); // always future
    const controller = new AbortController();
    const sleep = jest.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    const gate = new YoutubeWatchGate(
      {
        get isReady() {
          return true;
        },
        eval: evalMock,
      } as never,
      {
        now: () => 1_000_000,
        sleep,
      }
    );
    await expect(gate.acquire(5000, controller.signal)).resolves.toBe(false);
    expect(sleep).toHaveBeenCalledTimes(1);

    // pre-aborted: returns false without calling eval
    const c2 = new AbortController();
    c2.abort();
    const evalMock2 = jest.fn();
    const gate2 = new YoutubeWatchGate(
      {
        get isReady() {
          return true;
        },
        eval: evalMock2,
      } as never,
      {
        now: () => 1_000_000,
        sleep: jest.fn(),
      }
    );
    await expect(gate2.acquire(5000, c2.signal)).resolves.toBe(false);
    expect(evalMock2).not.toHaveBeenCalled();
  });

  it("9. degraded (isReady false) → false without calling eval, nothing written", async () => {
    const { gate, store, evalMock } = makeHarness({ isReady: false });
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      false
    );
    expect(evalMock).not.toHaveBeenCalled();
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("10. degraded log throttled, then recovery log on isReady flip", async () => {
    const { gate, state } = makeHarness({ isReady: false });
    await gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS); // logs DEGRADED (first)
    await gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS); // throttled, same time
    expect(warnCount("[YT GATE DEGRADED]")).toBe(1);
    state.time += YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS;
    await gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS); // logs again
    expect(warnCount("[YT GATE DEGRADED]")).toBe(2);
    // recover
    state.isReady = true;
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      true
    );
    expect(warnCount("[YT GATE] recovered")).toBe(1);
  });

  it("7. eval throws while connected → false + EVAL ERROR (throttled), not DEGRADED", async () => {
    const { gate, state } = makeHarness();
    state.throwEval = true;
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      false
    );
    await expect(gate.penalize()).resolves.toBe(false);
    expect(warnCount("[YT GATE EVAL ERROR]")).toBe(1); // throttled across both
    expect(warnCount("[YT GATE DEGRADED]")).toBe(0);

    // eval error while NOT ready is classified as degraded, not eval-error
    const h2 = makeHarness({ isReady: false });
    h2.state.throwEval = true;
    await h2.gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS);
    expect(
      h2.evalMock // never reached eval, returned at isReady gate
    ).not.toHaveBeenCalled();
  });

  it("13. sustained saturation logs once per interval", async () => {
    const { gate, state } = makeHarness();
    await gate.penalize(); // force long cooldown
    await gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS); // SATURATED #1
    await gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS); // throttled
    expect(warnCount("[YT GATE SATURATED]")).toBe(1);
    state.time += YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS;
    await gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS); // SATURATED #2
    expect(warnCount("[YT GATE SATURATED]")).toBe(2);
  });
});

describe("YoutubeWatchGate.penalize", () => {
  it("5. penalize sets global cooldown; acquire blocked until it lapses", async () => {
    const { gate, store, state } = makeHarness();
    await expect(gate.penalize()).resolves.toBe(true);
    expect(store[GATE_KEY]).toBe(
      String(state.time + YOUTUBE_WATCH_COOLDOWN_MS)
    );
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      false
    ); // within cooldown (also local backoff)
    state.time += YOUTUBE_WATCH_COOLDOWN_MS;
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      true
    );
  });

  it("6. penalize max-semantics: a later/earlier penalize never shortens the key", async () => {
    const { gate, store, state } = makeHarness();
    await gate.penalize(); // key = t0 + COOLDOWN
    const longCooldown = store[GATE_KEY];
    state.time -= 10_000; // pretend an earlier penalize arrives
    await gate.penalize();
    expect(store[GATE_KEY]).toBe(longCooldown); // unchanged (not shortened)
  });

  it("8. log-once flag: first penalize logs, repeat within episode does not", async () => {
    const { gate, store, state } = makeHarness();
    // simulate a fresh claim leaving nextAllowedAtMs at now + INTERVAL
    store[GATE_KEY] = String(state.time + YOUTUBE_WATCH_INTERVAL_MS);
    await expect(gate.penalize()).resolves.toBe(true); // recorded
    expect(warnCount("entering YouTube watch rate-limit cooldown")).toBe(1);
    await expect(gate.penalize()).resolves.toBe(true);
    expect(warnCount("entering YouTube watch rate-limit cooldown")).toBe(1); // flag suppresses
    expect(store[COOLDOWN_LOG_KEY]).toBe("1");
  });

  it("11. local backoff blocks acquire even when the global key looks claimable", async () => {
    const { gate, store, state } = makeHarness();
    await gate.penalize(); // sets localCooldownUntilMs = now + COOLDOWN
    delete store[GATE_KEY]; // force global to look immediately claimable
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      false
    ); // blocked by local backoff
    state.time += YOUTUBE_WATCH_COOLDOWN_MS;
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      true
    );
  });

  it("12. recorded reflects eval success; eval failure → false but local backoff set", async () => {
    const { gate, state } = makeHarness();
    await expect(gate.penalize()).resolves.toBe(true); // eval ran
    const ok = makeHarness();
    ok.state.throwEval = true;
    const before = ok.state.time;
    await expect(ok.gate.penalize()).resolves.toBe(false); // eval threw
    // local backoff still set despite eval failure
    delete ok.store[GATE_KEY];
    await expect(
      ok.gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)
    ).resolves.toBe(false);
    expect(ok.state.time).toBeGreaterThanOrEqual(before);
    // isReady === false → recorded false too
    const dn = makeHarness({ isReady: false });
    await expect(dn.gate.penalize()).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/youtube-watch-gate.spec.ts`
Expected: FAIL — module `./youtube-watch-gate.js` not found.

- [ ] **Step 3: Implement the gate**

Create `src/modules/youtube-watch-gate.ts`:

```ts
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
        // connection mid-wait flips isReady false and is classified as degraded.
        if (this.redis.isReady) this.maybeLogEvalError(err);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/modules/youtube-watch-gate.spec.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Type-check and lint**

Run: `npm run build`
Expected: compiles with no errors.

Run: `npm run lint`
Expected: no new lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube-watch-gate.ts src/modules/youtube-watch-gate.spec.ts
git commit -m "feat(worker): add Redis-backed YoutubeWatchGate cross-pod rate limiter"
```

---

### Task 4: Wire the gate into the worker and remove the per-process limiter

Register `RedisModule` (non-blocking) + `YoutubeWatchGate` in `runWorker`, thread the gate into `handleJob`, rewrite `updateVideoStats` to use `gate.acquire()` / `gate.penalize()`, add an exported pure `is429()`, drop the old limiter import, and delete `rate-limiter.ts`.

**Files:**

- Modify: `src/commands/worker.ts`
- Test: `src/commands/worker.spec.ts` (create)
- Delete: `src/modules/rate-limiter.ts`

- [ ] **Step 1: Write the failing test for `is429`**

Create `src/commands/worker.spec.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { AxiosError } from "axios";
import { AccessDeniedError } from "@stu43005/masterchat";
import { is429 } from "./worker.js";

describe("is429", () => {
  it("true only for an AxiosError with response.status === 429", () => {
    const e = new AxiosError(
      "Request failed with status code 429",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      { status: 429 } as never
    );
    expect(is429(e)).toBe(true);
  });

  it("false for masterchat AccessDeniedError (avoids cooldown poisoning)", () => {
    expect(is429(new AccessDeniedError("Rate limit exceeded: abc"))).toBe(
      false
    );
  });

  it("false for a non-429 AxiosError", () => {
    const e = new AxiosError(
      "Request failed with status code 500",
      "ERR_BAD_RESPONSE",
      undefined,
      undefined,
      { status: 500 } as never
    );
    expect(is429(e)).toBe(false);
  });

  it("false for a plain Error", () => {
    expect(is429(new Error("nope"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/commands/worker.spec.ts`
Expected: FAIL — `is429` is not exported from `./worker.js`.

- [ ] **Step 3: Update worker imports**

In `src/commands/worker.ts`, replace the limiter import on line 59:

```ts
import { youtubeRateLimiter } from "../modules/rate-limiter.js";
```

with:

```ts
import { YoutubeWatchGate } from "../modules/youtube-watch-gate.js";
import { RedisModule } from "../modules/redis.js";
```

Then add `YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS` to the existing constants import (line 18, currently `import { JOB_CONCURRENCY } from "../constants.js";`):

```ts
import {
  JOB_CONCURRENCY,
  YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS,
} from "../constants.js";
```

(`isAxiosError` is already imported on line 10; `AbortError` is already imported from `@stu43005/masterchat` on line 2.)

- [ ] **Step 4: Add the exported `is429` helper**

Add this near the top of `src/commands/worker.ts`, after the imports and before `emojiHandler` (around line 65):

```ts
/**
 * A YouTube 429 reaches us as a raw AxiosError: masterchat's own rate-limit
 * detection (err.code === "429") never matches an AxiosError (whose code is
 * ERR_BAD_REQUEST), so it does not wrap it. We deliberately do NOT treat
 * masterchat's AccessDeniedError (generic "denied") as 429 — a private /
 * region-blocked video must not poison the shared global cooldown.
 */
export function is429(err: unknown): boolean {
  return isAxiosError(err) && err.response?.status === 429;
}
```

- [ ] **Step 5: Thread the gate into `handleJob`**

Change the `handleJob` signature (line 138-141) from:

```ts
async function handleJob(
  job: BeeQueue.Job<HoneybeeJob>,
  globalSignal: AbortSignal
): Promise<HoneybeeResult> {
```

to:

```ts
async function handleJob(
  job: BeeQueue.Job<HoneybeeJob>,
  globalSignal: AbortSignal,
  gate: YoutubeWatchGate
): Promise<HoneybeeResult> {
```

- [ ] **Step 6: Rewrite `updateVideoStats` to use the gate**

Replace the existing `updateVideoStats` (lines 885-901):

```ts
async function updateVideoStats() {
  try {
    if (isReplay) return; // do not update stats for replay mode
    if (replica > 1) return; // only update stats in the first replica
    await youtubeRateLimiter.acquire();
    await VideoModel.updateFromMasterchat(mc);
  } catch (err) {
    if (err instanceof AbortError || axios.isCancel(err)) {
      // ignore
    } else if (isAxiosError(err)) {
      // only log the error message instead of the whole error object to avoid logging sensitive info like API key
      videoLog(`<!> [STATS UPDATE ERROR] ${err}`);
    } else {
      videoLog("<!> [STATS UPDATE ERROR]", err);
    }
  }
}
```

with:

```ts
async function updateVideoStats() {
  try {
    if (isReplay) return; // do not update stats for replay mode
    if (replica > 1) return; // only update stats in the first replica
    // Bounded-blocking global gate; cancelController.signal lets graceful
    // shutdown release the wait immediately. false → cooldown / degraded /
    // abort / budget exhausted: skip this update (next cycle retries).
    if (
      !(await gate.acquire(
        YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS,
        cancelController.signal
      ))
    ) {
      return;
    }
    await VideoModel.updateFromMasterchat(mc);
  } catch (err) {
    if (err instanceof AbortError || axios.isCancel(err)) {
      // ignore
    } else if (is429(err)) {
      // Record the global cooldown so every pod backs off. penalize() has
      // already set this pod's local backoff; if Redis did not record it,
      // surface a single warning so the degraded state is not silent.
      const recorded = await gate.penalize();
      if (!recorded) {
        videoLog(
          "<!> [STATS UPDATE ERROR] 429 detected; global cooldown not recorded (local backoff active)"
        );
      }
    } else if (isAxiosError(err)) {
      // only log the error message instead of the whole error object to avoid logging sensitive info like API key
      videoLog(`<!> [STATS UPDATE ERROR] ${err}`);
    } else {
      videoLog("<!> [STATS UPDATE ERROR]", err);
    }
  }
}
```

- [ ] **Step 7: Register modules and pass the gate to `queue.process`**

In `runWorker`, the current setup (lines 1044-1057) is:

```ts
export async function runWorker() {
  const exitController = new AbortController();
  const app = new Application();
  app.use(new MongodbModule());
  const { queue } = app.use(
    new QueueModule("honeybee", { activateDelayedJobs: true })
  );
  app.use({
    name: "exit-signal",
    close(s) {
      exitController.abort(new Error(`Received ${s}`));
      return Promise.resolve();
    },
  });
```

Change it to insert `RedisModule` + the gate between Mongo and Queue (so close order is LIFO-correct: exit-signal → Queue → gate → Redis → Mongo), and capture the gate:

```ts
export async function runWorker() {
  const exitController = new AbortController();
  const app = new Application();
  app.use(new MongodbModule());
  const redisModule = app.use(new RedisModule({ nonBlockingConnect: true }));
  const gate = app.use(new YoutubeWatchGate(redisModule.redis));
  const { queue } = app.use(
    new QueueModule("honeybee", { activateDelayedJobs: true })
  );
  app.use({
    name: "exit-signal",
    close(s) {
      exitController.abort(new Error(`Received ${s}`));
      return Promise.resolve();
    },
  });
```

Then update the `queue.process` call (lines 1071-1073) from:

```ts
queue.process<HoneybeeResult>(JOB_CONCURRENCY, (job) =>
  handleJob(job, exitController.signal)
);
```

to:

```ts
queue.process<HoneybeeResult>(JOB_CONCURRENCY, (job) =>
  handleJob(job, exitController.signal, gate)
);
```

- [ ] **Step 8: Run the `is429` test to verify it passes**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/commands/worker.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Delete the now-unused per-process limiter**

Confirm nothing else imports it:

Run: `grep -rn "rate-limiter" src/`
Expected: no matches (the `worker.ts` import was removed in Step 3).

Then delete the file:

```bash
git rm src/modules/rate-limiter.ts
```

- [ ] **Step 10: Type-check, lint, and run the full test suite**

Run: `npm run build`
Expected: compiles with no errors (no dangling reference to `youtubeRateLimiter` / `rate-limiter`).

Run: `npm run lint`
Expected: no new lint errors.

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest`
Expected: PASS — full suite green, including the new gate / redis / worker specs.

- [ ] **Step 11: Commit**

```bash
git add src/commands/worker.ts src/commands/worker.spec.ts src/modules/rate-limiter.ts
git commit -m "refactor(worker): replace per-process limiter with YoutubeWatchGate"
```
