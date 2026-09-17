/// <reference types="jest" />
import { describe, expect, it, jest } from "@jest/globals";

// Neither variable is set, so the module must stay inert.
delete process.env.PUBLIC_BASE_URL;
delete process.env.YOUTUBE_PUBSUB_SECRET;

const mockRenewPubsubSubscriptions = jest.fn<() => Promise<void>>();

jest.unstable_mockModule("./renewal.js", () => ({
  renewPubsubSubscriptions: mockRenewPubsubSubscriptions,
}));

const { YoutubePubsubModule } = await import("./youtube-pubsub.js");

describe("YoutubePubsubModule without a public url or secret", () => {
  it("registers no route and schedules no job", async () => {
    const registered: unknown[] = [];
    const defined: string[] = [];
    const agenda = {
      define: jest.fn((name: string) => {
        defined.push(name);
      }),
      every: jest.fn(() => Promise.resolve({})),
    };
    const app = {
      get: jest.fn(() => ({ name: "agenda", agenda })),
      http: {
        server: {
          register: jest.fn((plugin: unknown) => {
            registered.push(plugin);
            return Promise.resolve();
          }),
        },
        addNoLogRoute: jest.fn(),
      },
    };

    const module = new YoutubePubsubModule(app as never);
    await module.init();

    // A callback URL cannot be built and a delivery cannot be verified without
    // those two values, so doing nothing is the only safe behaviour.
    expect(registered).toEqual([]);
    expect(defined).toEqual([]);
    expect(app.http.addNoLogRoute).not.toHaveBeenCalled();
    expect(agenda.every).not.toHaveBeenCalled();
  });
});
