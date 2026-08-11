/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { buildJsonlRow, type ChatRowDoc } from "./archive-video.js";

const VIDEO_ID = "9hFxGFgx8Pc";

/**
 * A stand-in for a mongoose document. `buildJsonlRow` only reads
 * `collection.name` and plain fields, so a literal is enough — and keeping the
 * cast in here means no test body has to repeat it.
 */
function doc(
  collectionName: string,
  fields: Record<string, unknown>
): ChatRowDoc {
  return {
    collection: { name: collectionName },
    ...fields,
  } as unknown as ChatRowDoc;
}

describe("buildJsonlRow", () => {
  it("carries every author field of a superchat through to the row", () => {
    const row = buildJsonlRow(
      doc("superchats", {
        id: "sc-1",
        timestamp: new Date("2026-08-09T00:00:00.000Z"),
        authorName: "Supporter",
        authorPhoto: "https://example.test/photo.jpg",
        authorChannelId: "UCsender",
        authorType: "member",
        membership: "1 month",
        isVerified: false,
        isOwner: false,
        isModerator: true,
        message: "thanks!",
        amount: 1000,
        currency: "JPY",
        jpyAmount: 1000,
        significance: 2,
        color: "blue",
      }),
      VIDEO_ID
    );

    expect(row).toEqual({
      type: "superChat",
      id: "sc-1",
      timestamp: new Date("2026-08-09T00:00:00.000Z"),
      authorName: "Supporter",
      authorPhoto: "https://example.test/photo.jpg",
      authorChannelId: "UCsender",
      authorType: "member",
      membership: "1 month",
      isVerified: false,
      isOwner: false,
      isModerator: true,
      message: "thanks!",
      amount: 1000,
      currency: "JPY",
      jpyAmount: 1000,
      significance: 2,
      color: "blue",
    });
  });

  it("returns null for a collection it does not know", () => {
    expect(
      buildJsonlRow(doc("banactions", { id: "b-1" }), VIDEO_ID)
    ).toBeNull();
  });
});
