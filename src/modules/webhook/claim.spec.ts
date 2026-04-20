/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { claimWebhookResult } from "./claim.js";
import WebhookResultModel from "../../models/WebhookResult.js";

type FakeExisting = {
  response?: unknown;
  body?: unknown;
};

const identifier = { webhookId: "w1", coll: "chats", docId: "d1" };

function mockUpsert(upsertedCount: number) {
  return jest.spyOn(WebhookResultModel, "updateOne").mockResolvedValue({
    acknowledged: true,
    upsertedCount,
    upsertedId: upsertedCount === 1 ? ("fake-id" as never) : null,
    matchedCount: upsertedCount === 0 ? 1 : 0,
    modifiedCount: 0,
  } as never);
}

function mockFindOne(existing: FakeExisting | null) {
  return jest.spyOn(WebhookResultModel, "findOne").mockReturnValue({
    lean: () => ({
      exec: () => Promise.resolve(existing),
    }),
  } as never);
}

describe("claimWebhookResult", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 'send' on fresh upsert (upsertedCount=1)", async () => {
    mockUpsert(1);
    const decision = await claimWebhookResult(
      { followUpdate: false } as never,
      identifier,
      "POST",
      "https://example.com",
      { content: "v1" }
    );
    expect(decision).toEqual({ action: "send" });
  });

  it("returns 'skip' when non-follow and response already present", async () => {
    mockUpsert(0);
    mockFindOne({ response: { ok: true }, body: { content: "anything" } });
    const decision = await claimWebhookResult(
      { followUpdate: false } as never,
      identifier,
      "POST",
      "https://example.com",
      { content: "v2" }
    );
    expect(decision).toEqual({
      action: "skip",
      reason: "already-sent-non-follow",
    });
  });

  it("returns 'skip' when follow-update and body unchanged", async () => {
    mockUpsert(0);
    mockFindOne({ response: { ok: true }, body: { content: "v1" } });
    const decision = await claimWebhookResult(
      { followUpdate: true } as never,
      identifier,
      "POST",
      "https://example.com",
      { content: "v1" }
    );
    expect(decision).toEqual({
      action: "skip",
      reason: "follow-update-body-unchanged",
    });
  });

  it("returns 'send' when follow-update and body differs from last sent", async () => {
    mockUpsert(0);
    mockFindOne({ response: { ok: true }, body: { content: "v1" } });
    const decision = await claimWebhookResult(
      { followUpdate: true } as never,
      identifier,
      "POST",
      "https://example.com",
      { content: "v2" }
    );
    expect(decision).toEqual({ action: "send" });
  });

  it("returns 'send' when record exists but response is not yet written (stall recovery)", async () => {
    mockUpsert(0);
    mockFindOne({ body: { content: "v1" } }); // no response field
    const decision = await claimWebhookResult(
      { followUpdate: false } as never,
      identifier,
      "POST",
      "https://example.com",
      { content: "v1" }
    );
    expect(decision).toEqual({ action: "send" });
  });
});
