import { describe, expect, it } from "@jest/globals";
import type { Application } from "../application.js";
import {
  WebhookPartitionModule,
  assignInstance,
  hashCollection,
} from "./partition.js";

describe("hashCollection", () => {
  it("returns a deterministic uint32 for a given collection name", () => {
    const h1 = hashCollection("chats");
    const h2 = hashCollection("chats");
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThanOrEqual(0xffffffff);
  });

  it("produces different hashes for different collection names", () => {
    expect(hashCollection("chats")).not.toBe(hashCollection("superchats"));
  });
});

describe("assignInstance", () => {
  it("returns the only instance when there is one", () => {
    expect(assignInstance("chats", ["inst-a"])).toBe("inst-a");
  });

  it("returns the same instance for the same collection regardless of call order", () => {
    const instances = ["inst-a", "inst-b", "inst-c"];
    const r1 = assignInstance("chats", instances);
    const r2 = assignInstance("chats", [...instances].reverse());
    expect(r1).toBe(r2);
  });

  it("distributes different collections across instances", () => {
    const instances = ["inst-a", "inst-b", "inst-c"];
    const assignments = new Set(
      ["chats", "superchats", "videos", "channels", "messages"].map((coll) =>
        assignInstance(coll, instances)
      )
    );
    // at least two distinct instances should get assignments from this sample
    expect(assignments.size).toBeGreaterThanOrEqual(2);
  });
});

describe("WebhookPartitionModule.getAssignedCollections", () => {
  // Test helper: bypass readonly/private for isolated unit testing.
  // TypeScript's readonly and private are compile-time only, so the double
  // cast works at runtime. Preferred over leaking test-only setters into
  // the production class.
  type MutablePartition = {
    instanceId: string;
    activeInstanceIds: string[];
  };

  // Stub Application — these tests never call init(), so the constructor's
  // stored `app` reference is never dereferenced.
  const stubApp = {} as Application;

  it("partitions collections evenly with no loss or duplication", () => {
    const module = new WebhookPartitionModule(stubApp);
    const mutable = module as unknown as MutablePartition;
    mutable.activeInstanceIds = ["inst-a", "inst-b", "inst-c"];

    const allColls = ["chats", "superchats", "videos", "channels", "messages"];

    // Collect each instance's assignments by temporarily rewriting instanceId.
    const allAssignments = mutable.activeInstanceIds.flatMap((id) => {
      mutable.instanceId = id;
      return module.getAssignedCollections(allColls);
    });

    // Union equals allColls (no loss) and no duplication (lengths match).
    expect(new Set(allAssignments)).toEqual(new Set(allColls));
    expect(allAssignments.length).toBe(allColls.length);
  });

  it("matches the standalone assignInstance() result for a fixed instance", () => {
    const module = new WebhookPartitionModule(stubApp);
    const mutable = module as unknown as MutablePartition;
    const instanceIds = ["inst-a", "inst-b", "inst-c"];
    mutable.activeInstanceIds = instanceIds;
    mutable.instanceId = "inst-b";

    const allColls = ["chats", "superchats", "videos", "channels", "messages"];
    const assigned = module.getAssignedCollections(allColls);
    const expected = allColls.filter(
      (coll) => assignInstance(coll, instanceIds) === "inst-b"
    );
    expect(assigned).toEqual(expected);
  });

  it("returns empty when no active instances", () => {
    const module = new WebhookPartitionModule(stubApp);
    const mutable = module as unknown as MutablePartition;
    mutable.activeInstanceIds = [];
    expect(module.getAssignedCollections(["chats"])).toEqual([]);
  });
});
