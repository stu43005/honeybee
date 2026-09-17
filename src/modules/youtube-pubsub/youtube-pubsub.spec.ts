/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";

process.env.PUBLIC_BASE_URL = "https://honeybee.example.test/";
process.env.YOUTUBE_PUBSUB_SECRET = "test-secret";

const mockRenewPubsubSubscriptions = jest.fn<() => Promise<void>>();

jest.unstable_mockModule("./renewal.js", () => ({
  renewPubsubSubscriptions: mockRenewPubsubSubscriptions,
}));

const { YoutubePubsubModule } = await import("./youtube-pubsub.js");
const { pubsubRoutes } = await import("./routes.js");

type JobHandler = () => Promise<void>;

/**
 * A stand-in for the pieces of Application this module touches, recording what
 * it did so the assertions can look at structure rather than call counts.
 */
function fakeApp(options?: { withAgenda?: boolean }) {
  const registered: unknown[] = [];
  const noLogRoutes: string[] = [];
  const defined: [string, JobHandler][] = [];
  const scheduled: [string, string][] = [];

  const agenda = {
    define: jest.fn((name: string, handler: JobHandler) => {
      defined.push([name, handler]);
    }),
    every: jest.fn((interval: string, name: string) => {
      scheduled.push([interval, name]);
      return Promise.resolve({});
    }),
  };

  const app = {
    get: jest.fn((name: string) =>
      name === "agenda" && (options?.withAgenda ?? true)
        ? { name: "agenda", agenda }
        : undefined
    ),
    http: {
      server: {
        register: jest.fn((plugin: unknown) => {
          registered.push(plugin);
          return Promise.resolve();
        }),
      },
      addNoLogRoute: jest.fn((route: string) => {
        noLogRoutes.push(route);
      }),
    },
  };

  return { app, registered, noLogRoutes, defined, scheduled };
}

describe("YoutubePubsubModule", () => {
  afterEach(() => {
    mockRenewPubsubSubscriptions.mockReset();
  });

  it("registers the routes from its constructor, before init runs", () => {
    const { app, registered, noLogRoutes } = fakeApp();

    const module = new YoutubePubsubModule(app as never);

    // Registration cannot wait for init(): HttpServerModule listens first.
    expect(registered).toEqual([pubsubRoutes]);
    expect(noLogRoutes).toEqual(["/notifications/youtube"]);
    expect(module.name).toBe("youtube-pubsub");
  });

  it("defines the job and schedules it every ten minutes on init", async () => {
    const { app, defined, scheduled } = fakeApp();
    const module = new YoutubePubsubModule(app as never);

    // Nothing is scheduled until init.
    expect(defined).toEqual([]);

    await module.init();

    expect(defined.map(([name]) => name)).toEqual([
      "crawler youtube pubsub subscribe",
    ]);
    expect(scheduled).toEqual([
      ["10 minutes", "crawler youtube pubsub subscribe"],
    ]);
  });

  it("keeps the existing job name, so the stuck document is reused", async () => {
    const { app, defined, scheduled } = fakeApp();

    await new YoutubePubsubModule(app as never).init();

    // A new name would leave the old agendaJobs document locked forever with
    // nothing to clear it.
    expect(defined[0][0]).toBe("crawler youtube pubsub subscribe");
    expect(scheduled[0][1]).toBe("crawler youtube pubsub subscribe");
  });

  it("awaits the renewal round instead of firing and forgetting", async () => {
    const { app, defined } = fakeApp();
    const events: string[] = [];
    let finishRound: (() => void) | undefined;
    mockRenewPubsubSubscriptions.mockImplementation(() => {
      events.push("round started");
      return new Promise<void>((resolve) => {
        finishRound = () => {
          events.push("round finished");
          resolve();
        };
      });
    });
    await new YoutubePubsubModule(app as never).init();

    const [, handler] = defined[0];
    const running = handler();
    let handlerSettled = false;
    void running.then(() => {
      events.push("handler returned");
      handlerSettled = true;
    });

    // Explicit drain point: the handler must still be pending, because agenda
    // treats its resolution as "job complete" and would otherwise release the
    // lock while the round is still going.
    await Promise.resolve();
    expect(events).toEqual(["round started"]);
    expect(handlerSettled).toBe(false);

    finishRound?.();
    await running;

    expect(events).toEqual([
      "round started",
      "round finished",
      "handler returned",
    ]);
  });

  it("lets a failing round reject, so agenda records the failure", async () => {
    const { app, defined } = fakeApp();
    mockRenewPubsubSubscriptions.mockRejectedValue(new Error("round blew up"));
    await new YoutubePubsubModule(app as never).init();

    const [, handler] = defined[0];

    // Swallowing this would make every failed round look successful.
    await expect(handler()).rejects.toThrow("round blew up");
  });

  it("refuses to construct without the agenda module", () => {
    const { app } = fakeApp({ withAgenda: false });

    expect(() => new YoutubePubsubModule(app as never)).toThrow(
      /AgendaModule must be registered/
    );
  });
});
