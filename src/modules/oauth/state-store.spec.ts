/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  OAuthStateStore,
  delOAuthState,
  getOAuthState,
  initOAuthStateStore,
  putOAuthState,
  randomState,
} from "./state-store.js";

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

describe("OAuthStateStore", () => {
  afterEach(() => jest.restoreAllMocks());

  it("put/get round-trips the payload and uses PX", async () => {
    const redis = fakeRedis();
    const store = new OAuthStateStore(redis as any);
    await store.put("st1", { discordUserId: "d1", method: "google" });
    expect(redis.set).toHaveBeenCalledWith(
      "youtube-dm-oauth:st1",
      JSON.stringify({ discordUserId: "d1", method: "google" }),
      expect.objectContaining({ PX: expect.any(Number) })
    );
    expect(await store.get("st1")).toEqual({
      discordUserId: "d1",
      method: "google",
    });
  });

  it("get returns null for a missing state", async () => {
    expect(
      await new OAuthStateStore(fakeRedis() as any).get("nope")
    ).toBeNull();
  });

  it("del removes the state", async () => {
    const store = new OAuthStateStore(fakeRedis() as any);
    await store.put("st2", { discordUserId: "d1", method: "discord" });
    await store.del("st2");
    expect(await store.get("st2")).toBeNull();
  });

  it("randomState returns a long hex string", () => {
    expect(randomState()).toMatch(/^[0-9a-f]{32,}$/);
  });

  it("legacy module functions delegate to the initialised default instance", async () => {
    const redis = fakeRedis();
    initOAuthStateStore(redis as any);
    await putOAuthState("st3", { discordUserId: "d9", method: "google" });
    expect(await getOAuthState("st3")).toEqual({
      discordUserId: "d9",
      method: "google",
    });
    await delOAuthState("st3");
    expect(await getOAuthState("st3")).toBeNull();
  });
});
