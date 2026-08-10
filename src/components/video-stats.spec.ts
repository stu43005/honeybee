/// <reference types="jest" />
import { describe, expect, it, jest } from "@jest/globals";
import { MessageType, VideoStatsType } from "../interfaces.js";
import videoStats from "./video-stats.js";

// video-stats.ts only reads `app.get("agenda").agenda` and never touches
// Mongo/Redis at call time (all DB work happens inside the deferred job
// callbacks, which this test never invokes), so a plain object standing in
// for the AgendaModule is enough — no module needs mocking.
function fakeApp() {
  const define = jest.fn();
  const every = jest.fn();
  const app = {
    get: jest.fn(() => ({ agenda: { define, every } })),
  } as any;
  return { app, define, every };
}

function definedNames(define: jest.Mock): string[] {
  return define.mock.calls.map((call) => call[0] as string);
}

describe("videoStats registration", () => {
  it("registers gift message_total and purchase_amount_total jobs (define + every)", () => {
    const { app, define, every } = fakeApp();

    videoStats(app);

    const names = definedNames(define);
    const giftMessageTotal = `video stats - ${VideoStatsType.MessageTotal} - ${MessageType.Gift}`;
    const giftPurchaseAmountTotal = `video stats - ${VideoStatsType.PurchaseAmountTotal} - ${MessageType.Gift}`;

    expect(names).toEqual(
      expect.arrayContaining([giftMessageTotal, giftPurchaseAmountTotal])
    );

    const everyNames = every.mock.calls.map((call) => call[1] as string);
    expect(everyNames).toEqual(expect.arrayContaining([giftMessageTotal]));
    expect(everyNames).toEqual(
      expect.arrayContaining([giftPurchaseAmountTotal])
    );
  });

  it("does not register jpy amount or users stats jobs for gifts", () => {
    const { app, define } = fakeApp();

    videoStats(app);

    const names = definedNames(define);
    const giftJobs = names.filter((name) => name.includes(MessageType.Gift));

    const giftJpyTotal = `video stats - ${VideoStatsType.PurchaseAmountJpyTotal} - ${MessageType.Gift}`;
    const giftUsersSync = `video stats - ${VideoStatsType.UsersSync} - ${MessageType.Gift}`;
    const giftUsersTotalPrefix = `video stats - ${VideoStatsType.UsersTotal} - ${MessageType.Gift} - segment`;

    expect(giftJobs).not.toContain(giftJpyTotal);
    expect(giftJobs).not.toContain(giftUsersSync);
    expect(giftJobs.some((name) => name.startsWith(giftUsersTotalPrefix))).toBe(
      false
    );

    // Gift should register exactly message_total + purchase_amount_total,
    // nothing else — pins down the full set rather than just excluding two
    // names, so an accidental future addition also fails this test.
    expect(giftJobs.sort()).toEqual(
      [
        `video stats - ${VideoStatsType.MessageTotal} - ${MessageType.Gift}`,
        `video stats - ${VideoStatsType.PurchaseAmountTotal} - ${MessageType.Gift}`,
      ].sort()
    );
  });

  it("still registers jpy and users stats jobs for SuperChat (control case)", () => {
    const { app, define } = fakeApp();

    videoStats(app);

    const names = definedNames(define);
    const superChatJobs = names.filter((name) =>
      name.includes(MessageType.SuperChat)
    );

    const superChatJpyTotal = `video stats - ${VideoStatsType.PurchaseAmountJpyTotal} - ${MessageType.SuperChat}`;
    const superChatUsersSync = `video stats - ${VideoStatsType.UsersSync} - ${MessageType.SuperChat}`;

    expect(superChatJobs).toContain(superChatJpyTotal);
    expect(superChatJobs).toContain(superChatUsersSync);
    expect(
      superChatJobs.some((name) =>
        name.startsWith(
          `video stats - ${VideoStatsType.UsersTotal} - ${MessageType.SuperChat} - segment`
        )
      )
    ).toBe(true);
  });
});
