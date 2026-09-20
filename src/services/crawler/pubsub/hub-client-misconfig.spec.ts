/// <reference types="jest" />
import { describe, expect, it, jest } from "@jest/globals";

// Set before the import below, so constants.ts picks up this broken base URL.
process.env.PUBLIC_BASE_URL = "not-a-url";
process.env.YOUTUBE_PUBSUB_SECRET = "test-secret";

const mockPost = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("axios", () => {
  const isAxiosError = () => false;
  return { default: { post: mockPost, isAxiosError }, isAxiosError };
});

const { requestSubscription } = await import("./hub-client.js");

describe("requestSubscription with an unusable callback url", () => {
  it("returns a failure instead of rejecting", async () => {
    // new URL("./...", "not-a-url") throws TypeError(ERR_INVALID_URL) before any
    // request goes out. It still has to become a return value: an unhandled
    // rejection would take the whole process down.
    const result = await requestSubscription("UCabc");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("network");
      expect(result.message).toContain("Invalid URL");
    }
    expect(mockPost).not.toHaveBeenCalled();
  });
});
