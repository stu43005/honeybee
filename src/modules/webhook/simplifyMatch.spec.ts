import { describe, expect, it } from "@jest/globals";
import { simplifyOrBranches } from "./simplifyMatch.js";

describe("simplifyOrBranches — Rule 1 (dedupe)", () => {
  it("returns a single branch unchanged", () => {
    const out = simplifyOrBranches([{ a: 1, b: "x" }]);
    expect(out).toEqual([{ a: 1, b: "x" }]);
  });

  it("collapses two identical branches into one", () => {
    const out = simplifyOrBranches([
      { a: 1, b: "x" },
      { a: 1, b: "x" },
    ]);
    expect(out).toEqual([{ a: 1, b: "x" }]);
  });

  it("collapses identical branches whose values use $in", () => {
    const out = simplifyOrBranches([
      { a: { $in: ["x", "y"] } },
      { a: { $in: ["x", "y"] } },
    ]);
    expect(out).toEqual([{ a: { $in: ["x", "y"] } }]);
  });

  it("treats $in element order as set-equal during dedupe", () => {
    const out = simplifyOrBranches([
      { a: { $in: ["x", "y"] } },
      { a: { $in: ["y", "x"] } },
    ]);
    expect(out).toHaveLength(1);
    expect((out[0] as any).a.$in.sort()).toEqual(["x", "y"]);
  });

  it("dedupes opaque values that are deep-equal", () => {
    const out = simplifyOrBranches([{ a: { $gt: 5 } }, { a: { $gt: 5 } }]);
    expect(out).toEqual([{ a: { $gt: 5 } }]);
  });

  it("does not dedupe opaque values that differ", () => {
    const out = simplifyOrBranches([{ a: { $gt: 5 } }, { a: { $gt: 6 } }]);
    expect(out).toHaveLength(2);
  });

  it("preserves a single-element $in by denormalizing back to the scalar", () => {
    const out = simplifyOrBranches([{ a: { $in: ["x"] } }]);
    expect(out).toEqual([{ a: "x" }]);
  });

  it("preserves a single-element $nin by denormalizing back to $ne", () => {
    const out = simplifyOrBranches([{ a: { $nin: ["x"] } }]);
    expect(out).toEqual([{ a: { $ne: "x" } }]);
  });
});

describe("simplifyOrBranches — Rule 2 (single-key merge)", () => {
  it("merges two scalar branches differing on one key into $in", () => {
    const out = simplifyOrBranches([
      { a: "x", b: 1 },
      { a: "y", b: 1 },
    ]);
    expect(out).toEqual([{ a: { $in: ["x", "y"] }, b: 1 }]);
  });

  it("merges scalar with $in", () => {
    const out = simplifyOrBranches([
      { a: "x", b: 1 },
      { a: { $in: ["y", "z"] }, b: 1 },
    ]);
    expect(out).toEqual([{ a: { $in: ["x", "y", "z"] }, b: 1 }]);
  });

  it("merges $in with $in deduping overlap", () => {
    const out = simplifyOrBranches([
      { a: { $in: ["x", "y"] }, b: 1 },
      { a: { $in: ["y", "z"] }, b: 1 },
    ]);
    expect(out).toEqual([{ a: { $in: ["x", "y", "z"] }, b: 1 }]);
  });

  it("merges two $nin branches into $nin of intersection", () => {
    const out = simplifyOrBranches([
      { a: { $nin: ["x", "y"] }, b: 1 },
      { a: { $nin: ["y", "z"] }, b: 1 },
    ]);
    expect(out).toEqual([{ a: { $ne: "y" }, b: 1 }]);
  });

  it("drops the key when $nin intersection is empty", () => {
    const out = simplifyOrBranches([
      { a: { $nin: ["x"] }, b: 1 },
      { a: { $nin: ["y"] }, b: 1 },
    ]);
    expect(out).toEqual([{ b: 1 }]);
  });

  it("merges $ne with $ne (canonicalized to $nin)", () => {
    const out = simplifyOrBranches([
      { a: { $ne: "x" }, b: 1 },
      { a: { $ne: "y" }, b: 1 },
    ]);
    // $ne x ∨ $ne y → $nin (intersection of {x} and {y}) = $nin [] → drop key
    expect(out).toEqual([{ b: 1 }]);
  });

  it("merges $ne with $ne when both are the same value (dedupes)", () => {
    const out = simplifyOrBranches([
      { a: { $ne: "x" }, b: 1 },
      { a: { $ne: "x" }, b: 1 },
    ]);
    expect(out).toEqual([{ a: { $ne: "x" }, b: 1 }]);
  });

  it("does not merge branches with different key sets", () => {
    const out = simplifyOrBranches([
      { a: "x", b: 1 },
      { a: "y", c: 2 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("does not merge branches differing in two keys", () => {
    const out = simplifyOrBranches([
      { a: "x", b: 1 },
      { a: "y", b: 2 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("does not merge $in with $nin when sets are unequal", () => {
    const out = simplifyOrBranches([
      { a: { $in: ["x"] }, b: 1 },
      { a: { $nin: ["y"] }, b: 1 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("does not merge opaque with anything other than itself", () => {
    const out = simplifyOrBranches([
      { a: { $gt: 5 }, b: 1 },
      { a: "x", b: 1 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("collapses three scalar branches via fixpoint", () => {
    const out = simplifyOrBranches([
      { a: "x", b: 1 },
      { a: "y", b: 1 },
      { a: "z", b: 1 },
    ]);
    expect(out).toEqual([{ a: { $in: ["x", "y", "z"] }, b: 1 }]);
  });
});
