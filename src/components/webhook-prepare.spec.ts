/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { AxiosError } from "axios";
import { prepareWebhook } from "./webhook-prepare.js";

function httpError(status: number): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    "ERR_BAD_REQUEST",
    undefined,
    {},
    { status } as never
  );
}

function networkError(): AxiosError {
  // No response object — mirrors DNS/timeout/connection-refused failures.
  return new AxiosError("connect ECONNREFUSED", "ECONNREFUSED", undefined, {});
}

describe("prepareWebhook discord-dm skip", () => {
  afterEach(() => jest.restoreAllMocks());

  it("does not probe or mutate DM webhooks", async () => {
    const axiosInstance = { get: jest.fn() } as any;
    const save = jest.fn();
    const webhook = {
      insertUrl: "discord-dm://discord-1",
      failedAttempts: 0,
      enabled: true,
      save,
    } as any;

    await prepareWebhook(webhook, axiosInstance);

    expect(axiosInstance.get).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(webhook.failedAttempts).toBe(0);
    expect(webhook.enabled).toBe(true);
    expect(webhook.lastChecked).toBeUndefined();
  });

  it("probes and saves a normal HTTP webhook", async () => {
    const axiosInstance = {
      get: jest.fn(() => Promise.resolve({})),
    } as any;
    const save = jest.fn(() => Promise.resolve(undefined));
    const webhook = {
      insertUrl: "https://discord.com/api/webhooks/1/abc",
      failedAttempts: 0,
      enabled: true,
      save,
    } as any;

    await prepareWebhook(webhook, axiosInstance);

    expect(axiosInstance.get).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("prepareWebhook connectivity classification", () => {
  afterEach(() => jest.restoreAllMocks());

  function makeWebhook(overrides: Record<string, unknown> = {}) {
    return {
      insertUrl: "https://example.com/webhook",
      failedAttempts: 5,
      enabled: true,
      save: jest.fn(() => Promise.resolve(undefined)),
      ...overrides,
    } as any;
  }

  it("treats 405 Method Not Allowed as reachable (POST-only endpoint)", async () => {
    const axiosInstance = {
      get: jest.fn(() => Promise.reject(httpError(405))),
    } as any;
    const webhook = makeWebhook();

    await prepareWebhook(webhook, axiosInstance);

    expect(webhook.failedAttempts).toBe(0);
    expect(webhook.enabled).toBe(true);
    expect(webhook.lastSuccess).toBeInstanceOf(Date);
    expect(webhook.lastChecked).toBeInstanceOf(Date);
    expect(webhook.save).toHaveBeenCalledTimes(1);
  });

  it("counts 404 Not Found as a failed attempt (endpoint gone)", async () => {
    const axiosInstance = {
      get: jest.fn(() => Promise.reject(httpError(404))),
    } as any;
    const webhook = makeWebhook({ failedAttempts: 5 });

    await prepareWebhook(webhook, axiosInstance);

    expect(webhook.failedAttempts).toBe(6);
    expect(webhook.enabled).toBe(true);
    expect(webhook.lastSuccess).toBeUndefined();
  });

  it("counts 410 Gone as a failed attempt", async () => {
    const axiosInstance = {
      get: jest.fn(() => Promise.reject(httpError(410))),
    } as any;
    const webhook = makeWebhook({ failedAttempts: 0 });

    await prepareWebhook(webhook, axiosInstance);

    expect(webhook.failedAttempts).toBe(1);
  });

  it("counts a network error (no response) as a failed attempt", async () => {
    const axiosInstance = {
      get: jest.fn(() => Promise.reject(networkError())),
    } as any;
    const webhook = makeWebhook({ failedAttempts: 0 });

    await prepareWebhook(webhook, axiosInstance);

    expect(webhook.failedAttempts).toBe(1);
    expect(webhook.enabled).toBe(true);
  });

  it("disables the webhook after 24 failed attempts", async () => {
    const axiosInstance = {
      get: jest.fn(() => Promise.reject(networkError())),
    } as any;
    const webhook = makeWebhook({ failedAttempts: 23 });

    await prepareWebhook(webhook, axiosInstance);

    expect(webhook.failedAttempts).toBe(24);
    expect(webhook.enabled).toBe(false);
  });
});
