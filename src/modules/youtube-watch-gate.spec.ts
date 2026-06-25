import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
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
    (
      _script: string,
      o: { keys: string[]; arguments: string[] }
    ): Promise<number> => {
      if (state.throwEval) return Promise.reject(new Error("eval rejected"));
      const now = Number(o.arguments[0]);
      if (o.keys.length === 1) {
        // claim: arguments=[now, interval, ttl]
        const interval = Number(o.arguments[1]);
        const nextAllowed =
          store[o.keys[0]] != null ? Number(store[o.keys[0]]) : 0;
        if (now >= nextAllowed) {
          store[o.keys[0]] = String(now + interval);
          return Promise.resolve(-1);
        }
        return Promise.resolve(nextAllowed);
      }
      // penalize: arguments=[now, cooldown, ttl]
      const cooldown = Number(o.arguments[1]);
      const current = store[o.keys[0]] != null ? Number(store[o.keys[0]]) : 0;
      const target = now + cooldown;
      if (target > current) store[o.keys[0]] = String(target);
      if (store[o.keys[1]] != null) return Promise.resolve(0);
      store[o.keys[1]] = "1";
      return Promise.resolve(1);
    }
  );
  const fakeRedis = {
    get isReady() {
      return state.isReady;
    },
    eval: evalMock,
  };
  const sleep = jest.fn((ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted)
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    state.time += ms; // advance virtual clock
    return Promise.resolve();
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

  it("3. budget exhausted (global key future, no local cooldown) → false + SATURATED, key unchanged", async () => {
    const { gate, store, state } = makeHarness();
    // Future-date the GLOBAL key directly (NOT via penalize, which would also set
    // localCooldownUntilMs and make acquire return false before the wait loop).
    const t0 = state.time;
    const futureValue = String(t0 + YOUTUBE_WATCH_COOLDOWN_MS); // >> MAX_WAIT
    store[GATE_KEY] = futureValue;
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      false
    );
    expect(store[GATE_KEY]).toBe(futureValue); // never claimed
    expect(warnCount("[YT GATE SATURATED]")).toBe(1);
  });

  it("4. abort during wait resolves false (not reject); pre-aborted skips eval", async () => {
    // abort mid-wait
    const store: Record<string, string> = { [GATE_KEY]: String(2_000_000) };
    const evalMock = jest.fn(() => Promise.resolve(Number(store[GATE_KEY]))); // always future
    const controller = new AbortController();
    const sleep = jest.fn((): Promise<void> => {
      controller.abort();
      return Promise.reject(new DOMException("Aborted", "AbortError"));
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
        sleep: jest.fn(() => Promise.resolve()),
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
    const { gate, store, state } = makeHarness();
    // Future-date the global key far enough that it stays unclaimable across all
    // the clock advances in this test (no local cooldown involved).
    store[GATE_KEY] = String(state.time + 10 * YOUTUBE_WATCH_COOLDOWN_MS);
    await gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS); // SATURATED #1
    await gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS); // throttled (same window)
    expect(warnCount("[YT GATE SATURATED]")).toBe(1);
    state.time += YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS;
    await gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS); // SATURATED #2
    expect(warnCount("[YT GATE SATURATED]")).toBe(2);
  });

  it("14. concurrent demand exceeding budget → all skip, saturation observable", async () => {
    // Simulate JOB_CONCURRENCY × replica concurrent first-replica updates hitting
    // a globally-saturated gate: every acquire must skip (false), and the skips
    // must be observable via [YT GATE SATURATED] (rate-limited, not silent).
    const { gate, store, state } = makeHarness();
    store[GATE_KEY] = String(state.time + 10 * YOUTUBE_WATCH_COOLDOWN_MS);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)
      )
    );
    expect(results.every((r) => r === false)).toBe(true);
    expect(warnCount("[YT GATE SATURATED]")).toBeGreaterThanOrEqual(1);
  });

  it("15. mid-wait disconnect (eval rejects while not ready) is classified degraded", async () => {
    // acquire starts ready, blocks on a future key, then the connection drops
    // DURING the wait and the next eval rejects. That is classified as degraded,
    // not EVAL ERROR (which is reserved for "rejected while still connected").
    let time = 1_000_000;
    let isReady = true;
    let evalCalls = 0;
    const fakeRedis = {
      get isReady() {
        return isReady;
      },
      eval: jest.fn((): Promise<number> => {
        evalCalls += 1;
        if (evalCalls === 1)
          return Promise.resolve(time + YOUTUBE_WATCH_COOLDOWN_MS); // block (future)
        return Promise.reject(new Error("connection lost")); // eval after the disconnect
      }),
    };
    const sleep = jest.fn((ms: number): Promise<void> => {
      isReady = false; // connection dropped mid-wait
      time += ms;
      return Promise.resolve();
    });
    const gate = new YoutubeWatchGate(fakeRedis as never, {
      now: () => time,
      sleep,
    });
    await expect(gate.acquire(YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS)).resolves.toBe(
      false
    );
    expect(warnCount("[YT GATE DEGRADED]")).toBe(1);
    expect(warnCount("[YT GATE EVAL ERROR]")).toBe(0);
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
    const { gate } = makeHarness();
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
