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

  it("turns a gift document into a gift row", () => {
    const row = buildJsonlRow(
      doc("gifts", {
        id: "gift-1",
        timestamp: new Date("2026-08-09T00:00:05.000Z"),
        authorName: "sender",
        authorPhoto: "https://example.test/sender.jpg",
        authorChannelId: "UCsender",
        authorType: "other",
        giftName: "Heart",
        assetName: "heart",
        image:
          "https://www.gstatic.com/youtube/img/pdg/gift/assets/heart.png=w640-h640",
        amount: 10,
        currency: "JEWEL",
        // Present on the document, deliberately not carried into the row.
        message: "comboed x8 Heart for 80 Jewels",
        jewelCount: 80,
        comboCount: 8,
        hasGiftImageUrl: true,
        originVideoId: VIDEO_ID,
        originChannelId: "UCchannel",
        isVerified: false,
        isOwner: false,
        isModerator: false,
      }),
      VIDEO_ID
    );

    // toEqual rather than toMatchObject: the point is that the price-derivation
    // scaffolding and the raw wave-summary text do not leak into the archive.
    expect(row).toEqual({
      type: "gift",
      id: "gift-1",
      timestamp: new Date("2026-08-09T00:00:05.000Z"),
      authorName: "sender",
      authorPhoto: "https://example.test/sender.jpg",
      authorChannelId: "UCsender",
      authorType: "other",
      isVerified: false,
      isOwner: false,
      isModerator: false,
      giftName: "Heart",
      assetName: "heart",
      image:
        "https://www.gstatic.com/youtube/img/pdg/gift/assets/heart.png=w640-h640",
      amount: 10,
      currency: "JEWEL",
    });
  });

  it("leaves out the gift fields the document does not carry", () => {
    const row = buildJsonlRow(
      doc("gifts", {
        id: "gift-2",
        timestamp: new Date("2026-08-09T00:00:06.000Z"),
        authorType: "other",
        currency: "JEWEL",
        originVideoId: VIDEO_ID,
        originChannelId: "UCchannel",
      }),
      VIDEO_ID
    );

    // Asserting the key is absent, not that its value is undefined: only an
    // absent key is dropped by JSON.stringify, and the two are indistinguishable
    // to toEqual.
    for (const field of ["giftName", "assetName", "image", "amount"]) {
      expect(row).not.toHaveProperty(field);
    }
    expect(row).toHaveProperty("currency", "JEWEL");
  });

  it("fills the author fields a gift document never carries", () => {
    const row = buildJsonlRow(
      doc("gifts", {
        id: "gift-3",
        timestamp: new Date("2026-08-09T00:00:07.000Z"),
        authorType: "other",
        currency: "JEWEL",
        originVideoId: VIDEO_ID,
        originChannelId: "UCchannel",
      }),
      VIDEO_ID
    );

    // A gift action carries no badge information and only the ticker (>= 100
    // Jewels) carries a channel id, so these four arrive undefined — and
    // JSON.stringify drops undefined-valued keys, which would produce a row
    // missing fields every author row is supposed to have.
    expect(row).toEqual(
      expect.objectContaining({
        authorChannelId: "",
        authorType: "other",
        isVerified: false,
        isOwner: false,
        isModerator: false,
      })
    );
  });
});
