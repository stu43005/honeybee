import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { EventEmitter } from "node:events";
import { Types } from "mongoose";
import type { Application } from "../application.js";
import type { RedisModule } from "../redis.js";
import type { WebhookPartitionModule } from "./partition.js";
import type { WebhookQueueProducerModule } from "./queue.js";

jest.unstable_mockModule("../../models/Webhook.js", () => ({
  __esModule: true,
  default: { findEnabled: jest.fn(), watch: jest.fn() },
}));

jest.unstable_mockModule("../db.js", () => ({
  __esModule: true,
  documentLog: jest.fn(),
  getModelByCollectionName: jest.fn(),
}));

const WebhookModelMod = await import("../../models/Webhook.js");
const dbMod = await import("../db.js");
const { WebhookChangeStreamModule } = await import("./changestream.js");

const WebhookModel: any = (WebhookModelMod as any).default;
const getModelByCollectionName: jest.Mock =
  dbMod.getModelByCollectionName as any;

interface FakeStream extends EventEmitter {
  closed: boolean;
  resumeToken: any;
  close: jest.MockedFunction<() => Promise<void>>;
  removeAllListeners: jest.MockedFunction<(event?: string | symbol) => this>;
}

function makeFakeStream(): FakeStream {
  const ee = new EventEmitter() as FakeStream;
  ee.closed = false;
  ee.resumeToken = undefined;
  ee.close = jest.fn(() => {
    ee.closed = true;
    return Promise.resolve();
  });
  const original = ee.removeAllListeners.bind(ee);
  ee.removeAllListeners = jest.fn(() => original()) as any;
  return ee;
}

function makeWebhook(opts: { match?: any; followUpdate?: boolean }): any {
  return {
    _id: new Types.ObjectId(),
    colls: ["videos"],
    match: opts.match,
    followUpdate: opts.followUpdate ?? false,
    validateSync: () => undefined,
  };
}

describe("WebhookChangeStreamModule reconcile diff", () => {
  let module: any;
  let watchCalls: any[];
  let modelStub: { watch: jest.Mock };
  let metaStream: FakeStream;
  let redisStub: any;
  let partitionStub: any;
  let producerStub: any;
  let app: any;

  beforeEach(() => {
    watchCalls = [];
    modelStub = {
      watch: jest.fn((pipeline: any, _opts: any) => {
        const stream = makeFakeStream();
        watchCalls.push({ pipeline, stream });
        return stream;
      }),
    };
    getModelByCollectionName.mockReset();
    getModelByCollectionName.mockReturnValue(modelStub);

    metaStream = makeFakeStream();
    WebhookModel.watch = jest.fn(() => metaStream);
    WebhookModel.findEnabled = jest.fn();

    redisStub = {
      redis: {
        get: jest.fn(() => Promise.resolve(null)),
        set: jest.fn(() => Promise.resolve("OK")),
      },
    } as unknown as RedisModule;

    partitionStub = Object.assign(new EventEmitter(), {
      instanceId: "inst-test",
      getAssignedCollections: jest.fn((all: string[]) => all),
    }) as unknown as WebhookPartitionModule;

    producerStub = {
      scheduleAndEnqueue: jest.fn(async () => {}),
    } as unknown as WebhookQueueProducerModule;

    app = {
      get: jest.fn((name: string) => {
        if (name === "redis") return redisStub;
        if (name === "webhook-partition") return partitionStub;
        if (name === "webhook-queue-producer") return producerStub;
        return undefined;
      }),
    } as unknown as Application;

    module = new WebhookChangeStreamModule(app);
    void module.init();
  });

  afterEach(async () => {
    await module.close();
  });

  async function reconcile(webhooks: any[]): Promise<void> {
    WebhookModel.findEnabled.mockResolvedValueOnce(webhooks);
    await module.setupCollections();
  }

  it("does not re-open the change stream on a no-op reconcile", async () => {
    const wh = makeWebhook({ match: { channelId: "x" }, followUpdate: false });
    await reconcile([wh]);
    expect(watchCalls).toHaveLength(1);

    await reconcile([wh]);
    expect(watchCalls).toHaveLength(1); // unchanged
  });

  it("re-opens the change stream when raw branches differ even if simplified output is identical", async () => {
    // First reconcile: two webhooks producing two raw branches that simplify
    // to a single $in.
    const whA = makeWebhook({ match: { channelId: "x" }, followUpdate: false });
    const whB = makeWebhook({ match: { channelId: "y" }, followUpdate: false });
    await reconcile([whA, whB]);
    expect(watchCalls).toHaveLength(1);
    const firstStream = watchCalls[0].stream;

    // Second reconcile: one webhook with the union $in. Raw branches differ
    // (length 2 vs length 1) but simplified output matches.
    const whC = makeWebhook({
      match: { channelId: { $in: ["x", "y"] } },
      followUpdate: false,
    });
    await reconcile([whC]);
    expect(watchCalls).toHaveLength(2);
    expect(firstStream.close).toHaveBeenCalled();

    // Pin down the "simplified output identical" half of the contract:
    // the $match shape sent to model.watch must be deeply equal across the
    // two reconciles, even though the raw branches differ. If this fails,
    // the simplifier is producing different output for inputs that should
    // simplify to the same shape — a regression in simplifyOrBranches.
    expect(watchCalls[0].pipeline[0].$match).toEqual(
      watchCalls[1].pipeline[0].$match
    );
  });

  // Defensive coverage beyond spec item 18: this test guards the
  // `closed === false` short-circuit in setupCollections. If a future change
  // accidentally drops that check, a driver-side closure would leave the
  // module re-using a dead stream forever; this test catches that.
  it("re-opens the change stream when the previous one is already closed", async () => {
    const wh = makeWebhook({ match: { channelId: "x" }, followUpdate: false });
    await reconcile([wh]);
    expect(watchCalls).toHaveLength(1);

    // Simulate driver-side closure
    watchCalls[0].stream.closed = true;
    await reconcile([wh]);
    expect(watchCalls).toHaveLength(2);
  });
});
