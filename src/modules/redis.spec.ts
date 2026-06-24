import { describe, expect, it, jest, beforeEach } from "@jest/globals";

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
