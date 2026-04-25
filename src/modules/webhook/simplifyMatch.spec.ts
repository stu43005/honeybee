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
