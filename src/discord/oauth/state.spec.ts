/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  delOAuthState,
  getOAuthState,
  initOAuthStateStore,
  putOAuthState,
  randomState,
} from "./state.js";

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve("OK" as const);
    }),
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    del: jest.fn((k: string) => Promise.resolve(store.delete(k) ? 1 : 0)),
  };
}

describe("oauth state store", () => {
  afterEach(() => jest.restoreAllMocks());

  it("put/get round-trips the payload and uses PX", async () => {
    const redis = fakeRedis();
    initOAuthStateStore(redis as any);

    await putOAuthState("st1", { discordUserId: "d1", method: "google" });
    expect(redis.set).toHaveBeenCalledWith(
      "youtube-dm-oauth:st1",
      JSON.stringify({ discordUserId: "d1", method: "google" }),
      expect.objectContaining({ PX: expect.any(Number) })
    );

    const data = await getOAuthState("st1");
    expect(data).toEqual({ discordUserId: "d1", method: "google" });
  });

  it("get returns null for a missing/expired state", async () => {
    initOAuthStateStore(fakeRedis() as any);
    expect(await getOAuthState("nope")).toBeNull();
  });

  it("del removes the state (subsequent get is null)", async () => {
    const redis = fakeRedis();
    initOAuthStateStore(redis as any);
    await putOAuthState("st2", { discordUserId: "d1", method: "discord" });
    await delOAuthState("st2");
    expect(await getOAuthState("st2")).toBeNull();
  });

  it("randomState returns a long hex string", () => {
    expect(randomState()).toMatch(/^[0-9a-f]{32,}$/);
  });
});
