/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { prepareWebhook } from "./webhook-prepare.js";

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
