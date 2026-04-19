import { describe, expect, it } from "@jest/globals";
import { assignInstance, hashCollection } from "./partition.js";

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
