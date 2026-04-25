import { describe, expect, it } from "@jest/globals";
import { isMatching } from "../matching.js";
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

describe("simplifyOrBranches — Rule 3 (complementary)", () => {
  it("drops the key when $in and $nin have equal sets", () => {
    const out = simplifyOrBranches([
      { a: { $in: ["x", "y"] }, b: 1 },
      { a: { $nin: ["x", "y"] }, b: 1 },
    ]);
    expect(out).toEqual([{ b: 1 }]);
  });

  it("drops the key when scalar matches $ne of the same value", () => {
    const out = simplifyOrBranches([
      { a: "x", b: 1 },
      { a: { $ne: "x" }, b: 1 },
    ]);
    expect(out).toEqual([{ b: 1 }]);
  });

  it("drops the key when boolean true matches $ne true", () => {
    const out = simplifyOrBranches([
      { a: true, b: 1 },
      { a: { $ne: true }, b: 1 },
    ]);
    expect(out).toEqual([{ b: 1 }]);
  });

  it("drops the key when $exists true matches $exists false", () => {
    const out = simplifyOrBranches([
      { a: { $exists: true }, b: 1 },
      { a: { $exists: false }, b: 1 },
    ]);
    expect(out).toEqual([{ b: 1 }]);
  });

  it("does not drop the key when $in and $nin sets differ", () => {
    const out = simplifyOrBranches([
      { a: { $in: ["x"] }, b: 1 },
      { a: { $nin: ["y"] }, b: 1 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("converges further after complementary drop reduces key set", () => {
    // After Rule 3 drops 'a', the merged branch becomes { b: 1 }, which then
    // dedupes against the third branch.
    const out = simplifyOrBranches([
      { a: { $in: ["x"] }, b: 1 },
      { a: { $nin: ["x"] }, b: 1 },
      { b: 1 },
    ]);
    expect(out).toEqual([{ b: 1 }]);
  });

  it("collapses to a single empty branch when $exists pair covers all values", () => {
    const out = simplifyOrBranches([
      { a: { $exists: true } },
      { a: { $exists: false } },
    ]);
    expect(out).toEqual([{}]);
  });
});

describe("simplifyOrBranches — equivalence preservation (property)", () => {
  // 30-doc corpus covering booleans, strings, numbers, missing fields.
  const corpus: Record<string, unknown>[] = [
    {},
    { a: "x" },
    { a: "y" },
    { a: "z" },
    { b: 1 },
    { b: 2 },
    { b: 3 },
    { a: "x", b: 1 },
    { a: "y", b: 2 },
    { a: "z", b: 3 },
    { a: "x", b: 2 },
    { c: true },
    { c: false },
    { a: "x", c: true },
    { a: "y", c: false },
    { d: null },
    { e: 5 },
    { e: 10 },
    { e: 15 },
    { a: "x", b: 1, c: true },
    { a: "y", b: 2, c: false },
    { f: "extra" },
    { a: "x", f: "extra" },
    { a: "x", b: 1, e: 5 },
    { a: "y", b: 2, e: 10 },
    { b: 1, c: true },
    { b: 2, c: false },
    { a: "z", c: true, e: 5 },
    { a: "x", b: null },
    { a: null, b: 1 },
  ];

  function disjunctionMatches(
    branches: Record<string, unknown>[],
    doc: Record<string, unknown>
  ): boolean {
    return branches.some((branch) => isMatching(doc, branch));
  }

  const fixtures: Record<string, unknown>[][] = [
    // Rule 1
    [
      { a: "x", b: 1 },
      { a: "x", b: 1 },
    ],
    // Rule 2 union
    [
      { a: "x", b: 1 },
      { a: "y", b: 1 },
      { a: "z", b: 1 },
    ],
    // Rule 2 nin intersection
    [
      { a: { $nin: ["x", "y"] }, b: 1 },
      { a: { $nin: ["y", "z"] }, b: 1 },
    ],
    // Rule 3 complementary in/nin
    [
      { a: { $in: ["x", "y"] }, b: 1 },
      { a: { $nin: ["x", "y"] }, b: 1 },
    ],
    // Rule 3 complementary scalar/$ne
    [
      { a: "x", b: 1 },
      { a: { $ne: "x" }, b: 1 },
    ],
    // Rule 3 complementary exists
    [
      { a: { $exists: true }, b: 1 },
      { a: { $exists: false }, b: 1 },
    ],
    // No-op: branches with different key sets
    [
      { a: "x", b: 1 },
      { a: "y", c: 2 },
    ],
    // No-op: branches differing in two keys
    [
      { a: "x", b: 1 },
      { a: "y", b: 2 },
    ],
    // Mixed: convergence via Rule 3 then Rule 1
    [{ a: { $in: ["x"] }, b: 1 }, { a: { $nin: ["x"] }, b: 1 }, { b: 1 }],
  ];

  it.each(fixtures)(
    "simplification preserves match set for fixture %#",
    (...fixture) => {
      const branches = fixture;
      const simplified = simplifyOrBranches(branches);
      for (const doc of corpus) {
        expect(disjunctionMatches(simplified, doc)).toBe(
          disjunctionMatches(branches, doc)
        );
      }
    }
  );
});

describe("simplifyOrBranches — determinism", () => {
  it("returns the same output for the same input regardless of branch order", () => {
    const a = simplifyOrBranches([
      { a: "x", b: 1 },
      { a: "y", b: 1 },
      { a: "z", b: 1 },
    ]);
    const b = simplifyOrBranches([
      { a: "z", b: 1 },
      { a: "y", b: 1 },
      { a: "x", b: 1 },
    ]);
    expect(a).toEqual(b);
  });

  it("returns deterministic $in element order regardless of input order", () => {
    const a = simplifyOrBranches([{ a: "b" }, { a: "a" }, { a: "c" }]);
    const b = simplifyOrBranches([{ a: "c" }, { a: "a" }, { a: "b" }]);
    expect(a).toEqual(b);
  });
});

describe("simplifyOrBranches — realistic shape (track.ts streams feature)", () => {
  it("collapses three streams-feature webhook branches with different channelIds into a single $in branch", () => {
    // Shape mirrors what buildRawBranches produces for the streams feature
    // when followUpdate=true (operationType becomes {$in:["insert","update"]})
    // and match has channelId and status.
    const op = { $in: ["insert", "update"] };
    const branches = [
      {
        operationType: op,
        "fullDocument.channelId": "UCa",
        "fullDocument.status": { $in: ["live", "past", "missing"] },
        "fullDocument.uploadedVideo": { $ne: true },
      },
      {
        operationType: op,
        "fullDocument.channelId": "UCb",
        "fullDocument.status": { $in: ["live", "past", "missing"] },
        "fullDocument.uploadedVideo": { $ne: true },
      },
      {
        operationType: op,
        "fullDocument.channelId": "UCc",
        "fullDocument.status": { $in: ["live", "past", "missing"] },
        "fullDocument.uploadedVideo": { $ne: true },
      },
    ];
    const out = simplifyOrBranches(branches);
    expect(out).toEqual([
      {
        operationType: op,
        "fullDocument.channelId": { $in: ["UCa", "UCb", "UCc"] },
        "fullDocument.status": { $in: ["live", "missing", "past"] },
        "fullDocument.uploadedVideo": { $ne: true },
      },
    ]);
  });
});
