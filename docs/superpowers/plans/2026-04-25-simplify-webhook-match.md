# Simplify Webhook Match Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure simplifier for the `$or` branches assembled by `WebhookChangeStreamModule.buildMatch`, deduping identical branches and merging single-key differences via `$in` / `$nin` / complementary rules, then wire it in so simplification only runs when the unsimplified branches actually change.

**Architecture:** A new module `simplifyMatch.ts` exposes `simplifyOrBranches(branches)` — a pure fixpoint pairwise merger over flat MongoDB match objects. `WebhookChangeStreamModule` is split into a cheap `buildRawBranches(webhooks)` and a call to the simplifier guarded by a `lodash.isEqual` diff against the previous reconcile's raw branches stored in `CollectionState.rawBranches`. Tests stub `WebhookModel.findEnabled` and `getModelByCollectionName` to avoid spinning up MongoDB.

**Tech Stack:** TypeScript (ESM), lodash-es, Jest (ts-jest ESM), Mongoose ChangeStream.

---

## File Map

| Action | Path                                        | Responsibility                                                                                  |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Create | `src/modules/webhook/simplifyMatch.ts`      | Pure simplifier: canonicalization, Rule 1/2/3, fixpoint loop                                    |
| Create | `src/modules/webhook/simplifyMatch.spec.ts` | Unit tests, property test, determinism test, realistic-shape test                               |
| Modify | `src/modules/webhook/changestream.ts`       | Replace `buildMatch` with `buildRawBranches` + simplifier, update state, move log               |
| Create | `src/modules/webhook/changestream.spec.ts`  | Integration test using stubs for `WebhookModel`, model, `RedisModule`, `WebhookPartitionModule` |

---

## Task 1: Canonicalization, denormalization, and Rule 1 dedupe

**Files:**

- Create: `src/modules/webhook/simplifyMatch.ts`
- Test: `src/modules/webhook/simplifyMatch.spec.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/modules/webhook/simplifyMatch.spec.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- simplifyMatch.spec.ts`
Expected: FAIL with module-not-found / import error for `./simplifyMatch.js`.

- [ ] **Step 3: Create `simplifyMatch.ts` with the canonicalization core and Rule 1**

Create `src/modules/webhook/simplifyMatch.ts`:

```typescript
import { isEqual } from "lodash-es";

type Canon =
  | { kind: "in"; set: unknown[] }
  | { kind: "nin"; set: unknown[] }
  | { kind: "exists"; value: boolean }
  | { kind: "opaque"; value: unknown };

type Branch = Map<string, Canon>;

function isJsonScalar(v: unknown): boolean {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

function sortDedupedSet(arr: unknown[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const x of arr) {
    const key = JSON.stringify(x);
    if (!seen.has(key)) seen.set(key, x);
  }
  return Array.from(seen.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => v);
}

function canonicalize(value: unknown): Canon {
  if (isJsonScalar(value)) {
    return { kind: "in", set: [value] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "opaque", value };
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const k = keys[0];
    const v = obj[k];
    if (k === "$in" && Array.isArray(v) && v.every(isJsonScalar)) {
      return { kind: "in", set: sortDedupedSet(v) };
    }
    if (k === "$nin" && Array.isArray(v) && v.every(isJsonScalar)) {
      return { kind: "nin", set: sortDedupedSet(v) };
    }
    if (k === "$ne" && isJsonScalar(v)) {
      return { kind: "nin", set: [v] };
    }
    if (k === "$exists" && typeof v === "boolean") {
      return { kind: "exists", value: v };
    }
  }
  return { kind: "opaque", value };
}

function denormalize(c: Canon): unknown {
  if (c.kind === "in") {
    return c.set.length === 1 ? c.set[0] : { $in: c.set };
  }
  if (c.kind === "nin") {
    return c.set.length === 1 ? { $ne: c.set[0] } : { $nin: c.set };
  }
  if (c.kind === "exists") {
    return { $exists: c.value };
  }
  return c.value;
}

function setEqualSorted(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!isEqual(a[i], b[i])) return false;
  }
  return true;
}

function canonValueEqual(a: Canon, b: Canon): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "in" && b.kind === "in") return setEqualSorted(a.set, b.set);
  if (a.kind === "nin" && b.kind === "nin") return setEqualSorted(a.set, b.set);
  if (a.kind === "exists" && b.kind === "exists") return a.value === b.value;
  if (a.kind === "opaque" && b.kind === "opaque")
    return isEqual(a.value, b.value);
  return false;
}

function toBranch(obj: Record<string, unknown>): Branch {
  const m: Branch = new Map();
  for (const [k, v] of Object.entries(obj)) {
    m.set(k, canonicalize(v));
  }
  return m;
}

function fromBranch(b: Branch): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, c] of b) {
    obj[k] = denormalize(c);
  }
  return obj;
}

function branchKeysEqual(a: Branch, b: Branch): boolean {
  if (a.size !== b.size) return false;
  for (const k of a.keys()) {
    if (!b.has(k)) return false;
  }
  return true;
}

function branchEqual(a: Branch, b: Branch): boolean {
  if (!branchKeysEqual(a, b)) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb || !canonValueEqual(va, vb)) return false;
  }
  return true;
}

function tryMerge(a: Branch, b: Branch): Branch | null {
  if (branchEqual(a, b)) {
    return new Map(a);
  }
  return null;
}

export function simplifyOrBranches(
  branches: ReadonlyArray<Record<string, unknown>>
): Record<string, unknown>[] {
  const cur: Branch[] = branches.map(toBranch);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < cur.length; i++) {
      for (let j = i + 1; j < cur.length; j++) {
        const merged = tryMerge(cur[i], cur[j]);
        if (merged) {
          cur[i] = merged;
          cur.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return cur.map(fromBranch);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- simplifyMatch.spec.ts`
Expected: All 8 tests in the Rule 1 describe block pass.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: No errors.

Run: `npx eslint src/modules/webhook/simplifyMatch.ts src/modules/webhook/simplifyMatch.spec.ts`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/webhook/simplifyMatch.ts src/modules/webhook/simplifyMatch.spec.ts
git commit -m "feat(webhook): add simplifyOrBranches with canonicalization and dedupe"
```

---

## Task 2: Rule 2 (single-key `$in` / `$nin` merge)

**Files:**

- Modify: `src/modules/webhook/simplifyMatch.ts`
- Test: `src/modules/webhook/simplifyMatch.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/webhook/simplifyMatch.spec.ts`, after the closing `});` of the Rule 1 describe block:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- simplifyMatch.spec.ts`
Expected: 12 tests in the Rule 2 describe block fail (the rest still pass).

- [ ] **Step 3: Add set helpers and Rule 2 to `tryMerge`**

In `src/modules/webhook/simplifyMatch.ts`, add two helpers above `canonValueEqual`:

```typescript
function setUnion(a: unknown[], b: unknown[]): unknown[] {
  return sortDedupedSet([...a, ...b]);
}

function setIntersection(a: unknown[], b: unknown[]): unknown[] {
  const bKeys = new Set(b.map((x) => JSON.stringify(x)));
  return a.filter((x) => bKeys.has(JSON.stringify(x)));
}
```

Then replace the existing `tryMerge` function with:

```typescript
function tryMerge(a: Branch, b: Branch): Branch | null {
  if (branchEqual(a, b)) {
    return new Map(a);
  }
  if (!branchKeysEqual(a, b)) return null;

  const diffKeys: string[] = [];
  for (const [k, va] of a) {
    const vb = b.get(k)!;
    if (!canonValueEqual(va, vb)) diffKeys.push(k);
  }
  if (diffKeys.length !== 1) return null;

  const k = diffKeys[0];
  const va = a.get(k)!;
  const vb = b.get(k)!;

  if (va.kind === "in" && vb.kind === "in") {
    const merged = new Map(a);
    merged.set(k, { kind: "in", set: setUnion(va.set, vb.set) });
    return merged;
  }

  if (va.kind === "nin" && vb.kind === "nin") {
    const inter = setIntersection(va.set, vb.set);
    const merged = new Map(a);
    if (inter.length === 0) {
      merged.delete(k);
    } else {
      merged.set(k, { kind: "nin", set: sortDedupedSet(inter) });
    }
    return merged;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- simplifyMatch.spec.ts`
Expected: All Rule 1 + Rule 2 tests pass.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: No errors.

Run: `npx eslint src/modules/webhook/simplifyMatch.ts src/modules/webhook/simplifyMatch.spec.ts`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/webhook/simplifyMatch.ts src/modules/webhook/simplifyMatch.spec.ts
git commit -m "feat(webhook): add Rule 2 single-key \$in/\$nin merge to simplifyOrBranches"
```

---

## Task 3: Rule 3 (complementary merge)

**Files:**

- Modify: `src/modules/webhook/simplifyMatch.ts`
- Test: `src/modules/webhook/simplifyMatch.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/webhook/simplifyMatch.spec.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- simplifyMatch.spec.ts`
Expected: 6 tests in the Rule 3 describe block fail (rest still pass).

- [ ] **Step 3: Add Rule 3 logic to `tryMerge`**

In `src/modules/webhook/simplifyMatch.ts`, modify `tryMerge` to insert Rule 3 checks **before** the Rule 2 `kind === "in"` block. The full updated function:

```typescript
function tryMerge(a: Branch, b: Branch): Branch | null {
  if (branchEqual(a, b)) {
    return new Map(a);
  }
  if (!branchKeysEqual(a, b)) return null;

  const diffKeys: string[] = [];
  for (const [k, va] of a) {
    const vb = b.get(k)!;
    if (!canonValueEqual(va, vb)) diffKeys.push(k);
  }
  if (diffKeys.length !== 1) return null;

  const k = diffKeys[0];
  const va = a.get(k)!;
  const vb = b.get(k)!;

  // Rule 3: complementary in/nin (equal sets) → drop K
  if (
    ((va.kind === "in" && vb.kind === "nin") ||
      (va.kind === "nin" && vb.kind === "in")) &&
    setEqualSorted(va.set, vb.set)
  ) {
    const merged = new Map(a);
    merged.delete(k);
    return merged;
  }

  // Rule 3: complementary exists → drop K
  if (va.kind === "exists" && vb.kind === "exists" && va.value !== vb.value) {
    const merged = new Map(a);
    merged.delete(k);
    return merged;
  }

  // Rule 2: in ∪ in
  if (va.kind === "in" && vb.kind === "in") {
    const merged = new Map(a);
    merged.set(k, { kind: "in", set: setUnion(va.set, vb.set) });
    return merged;
  }

  // Rule 2: nin ∩ nin
  if (va.kind === "nin" && vb.kind === "nin") {
    const inter = setIntersection(va.set, vb.set);
    const merged = new Map(a);
    if (inter.length === 0) {
      merged.delete(k);
    } else {
      merged.set(k, { kind: "nin", set: sortDedupedSet(inter) });
    }
    return merged;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- simplifyMatch.spec.ts`
Expected: All Rule 1 + Rule 2 + Rule 3 tests pass.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: No errors.

Run: `npx eslint src/modules/webhook/simplifyMatch.ts src/modules/webhook/simplifyMatch.spec.ts`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/webhook/simplifyMatch.ts src/modules/webhook/simplifyMatch.spec.ts
git commit -m "feat(webhook): add Rule 3 complementary merge to simplifyOrBranches"
```

---

## Task 4: Property test, determinism test, and realistic-shape test

**Files:**

- Test: `src/modules/webhook/simplifyMatch.spec.ts`

- [ ] **Step 1: Add `isMatching` import to the top of the test file**

In `src/modules/webhook/simplifyMatch.spec.ts`, add this import line immediately after the existing `import { simplifyOrBranches } from "./simplifyMatch.js";` line at the top of the file:

```typescript
import { isMatching } from "../matching.js";
```

ESLint's `import/first` rule requires all imports at the top of the file — appending the import alongside the new describe blocks below would violate that rule.

- [ ] **Step 2: Append the new describe blocks to the end of the test file**

Append the following to the end of `src/modules/webhook/simplifyMatch.spec.ts` (do NOT include any additional import line — the import was added in Step 1):

```typescript
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
      const branches = fixture as Record<string, unknown>[];
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
        "fullDocument.status": { $in: ["live", "past", "missing"] },
        "fullDocument.uploadedVideo": { $ne: true },
      },
    ]);
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test -- simplifyMatch.spec.ts`
Expected: All previously-passing tests still pass; new property/determinism/realistic-shape tests also pass without any production code changes (the simplifier is already complete).

If the property test fails for a fixture, the failure pinpoints which simplification rule produced an inequivalent output — fix in `simplifyMatch.ts` and re-run.

- [ ] **Step 4: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: No errors.

Run: `npx eslint src/modules/webhook/simplifyMatch.spec.ts`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhook/simplifyMatch.spec.ts
git commit -m "test(webhook): add property/determinism/realistic-shape tests for simplifyOrBranches"
```

---

## Task 5: Wire `simplifyOrBranches` into `WebhookChangeStreamModule`

**Files:**

- Modify: `src/modules/webhook/changestream.ts`

This task updates production code only. Tests for the wired flow live in Task 6.

- [ ] **Step 1: Read the current `changestream.ts` to confirm baseline**

Run: `wc -l src/modules/webhook/changestream.ts`
Expected: ~333 lines.

- [ ] **Step 2: Update imports**

In `src/modules/webhook/changestream.ts`, add to the existing import block at the top:

```typescript
import { simplifyOrBranches } from "./simplifyMatch.js";
```

Place it alphabetically near the other `./` imports (after `./partition.js`).

- [ ] **Step 3: Update the `CollectionState` interface**

Replace the existing `CollectionState` interface (around lines 22-27) with:

```typescript
interface CollectionState {
  changeStream: mongo.ChangeStream;
  tokenSaveInterval: NodeJS.Timeout;
  rawBranches: any[];
  webhooks: DocumentType<Webhook>[];
}
```

(`changeStreamMatch` is removed; `rawBranches` is the new diff key.)

- [ ] **Step 4: Replace `buildMatch` with `buildRawBranches`**

Replace the entire `buildMatch` method (around lines 191-202) with:

```typescript
  private buildRawBranches(webhooks: DocumentType<Webhook>[]): any[] {
    return webhooks.map((webhook) =>
      flatObjectKey({
        operationType: webhook.followUpdate
          ? { $in: ["insert", "update"] }
          : "insert",
        ...setIfDefine("fullDocument", webhook.match),
      })
    );
  }
```

- [ ] **Step 5: Rewrite the assigned-collection loop in `setupCollections`**

Replace the existing loop (around lines 167-184) — the block starting with `// 2) Open or reconfigure assigned collections` and ending at `await this.openCollection(coll, webhooks, match);` — with:

```typescript
// 2) Open or reconfigure assigned collections
for (const coll of assigned) {
  const webhooks = byColl[coll].map(({ webhook }) => webhook);
  const rawBranches = this.buildRawBranches(webhooks);
  const existing = this.collections.get(coll);
  if (
    existing &&
    existing.changeStream.closed === false &&
    isEqual(rawBranches, existing.rawBranches)
  ) {
    existing.webhooks = webhooks;
    continue;
  }
  const simplified = simplifyOrBranches(rawBranches);
  if (simplified.length === 0) {
    throw new Error(
      `simplifyOrBranches reduced ${rawBranches.length} branch(es) to 0 for "${coll}"`
    );
  }
  const match = simplified.length === 1 ? simplified[0] : { $or: simplified };
  if (existing) await this.closeCollection(coll);
  const opened = await this.openCollection(coll, webhooks, rawBranches, match);
  if (opened) {
    documentLog(
      coll,
      `start listening (branches: ${rawBranches.length} → ${simplified.length})`
    );
  }
}
```

The `if (opened)` guard preserves the baseline behavior where the "start listening" log was suppressed when `openCollection` early-returned due to an unknown collection. Without this guard, an unknown collection would log "[ERROR] Unable to get model" immediately followed by a misleading "start listening" message.

- [ ] **Step 6: Update `openCollection` signature and body**

Replace the existing `openCollection` method (around lines 217-256) with:

```typescript
  private async openCollection(
    coll: string,
    webhooks: DocumentType<Webhook>[],
    rawBranches: any[],
    match: any
  ): Promise<boolean> {
    const model = getModelByCollectionName(coll);
    if (!model) {
      documentLog(
        coll,
        `<!> [ERROR] Unable to get model (unknown collection "${coll}")`
      );
      return false;
    }
    const resumeAfter = await this.loadResumeToken(coll);
    const changeStream = model.watch([{ $match: match }], {
      resumeAfter: resumeAfter as any,
      fullDocument: "updateLookup",
      readPreference: "secondaryPreferred",
    });

    const tokenSaveInterval = global.setInterval(() => {
      const token = (changeStream as any).resumeToken;
      if (!token) return;
      void this.saveResumeToken(coll, token).catch((err) =>
        documentLog(coll, "<!> [WARN] resume token save failed:", err)
      );
    }, WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS);

    changeStream.on("change", (data: mongo.ChangeStreamDocument) => {
      this.handleChangeEvent(coll, data);
    });

    this.collections.set(coll, {
      changeStream,
      tokenSaveInterval,
      rawBranches,
      webhooks,
    });
    return true;
  }
```

The previous `documentLog(coll, \`start listening (match length: ${match.$or.length})\`)`line is removed from`openCollection`— the equivalent log now lives in`setupCollections`.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors. If the type checker complains about `any[]` in the new signature, that matches the file's existing convention (the surrounding code already uses `any` for match values).

- [ ] **Step 8: Lint**

Run: `npx eslint src/modules/webhook/changestream.ts`
Expected: No errors.

- [ ] **Step 9: Run full test suite to confirm nothing else broke**

Run: `npm test`
Expected: All existing tests pass. (The `simplifyMatch.spec.ts` suite from Tasks 1–4 also still passes.)

- [ ] **Step 10: Commit**

```bash
git add src/modules/webhook/changestream.ts
git commit -m "feat(webhook): wire simplifyOrBranches into changestream reconcile loop"
```

---

## Task 6: Integration test for the changestream reconcile diff

**Files:**

- Create: `src/modules/webhook/changestream.spec.ts`

This test stubs `WebhookModel.findEnabled` and `getModelByCollectionName` (both in `db.ts`), plus the `RedisModule` and `WebhookPartitionModule` dependencies, so no real MongoDB is required.

- [ ] **Step 1: Inspect existing module wiring**

Read the constructor signature and `init()` of `WebhookChangeStreamModule` in `src/modules/webhook/changestream.ts` (around lines 88-120) to confirm: it calls `app.get<RedisModule>("redis")`, `app.get<WebhookPartitionModule>("webhook-partition")`, `app.get<WebhookQueueProducerModule>("webhook-queue-producer")`, and `WebhookModel.watch(...)` for the meta-stream.

Read `src/modules/db.ts` to confirm `getModelByCollectionName` is exported.

- [ ] **Step 2: Write the failing test file**

Create `src/modules/webhook/changestream.spec.ts`:

```typescript
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
  close: jest.Mock;
  removeAllListeners: jest.Mock;
}

function makeFakeStream(): FakeStream {
  const ee = new EventEmitter() as FakeStream;
  ee.closed = false;
  ee.resumeToken = undefined;
  ee.close = jest.fn(async () => {
    ee.closed = true;
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
        get: jest.fn(async () => null),
        set: jest.fn(async () => "OK"),
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
    await (module as any).setupCollections();
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
```

- [ ] **Step 3: Run the test**

Run: `npm test -- changestream.spec.ts`
Expected: all three test cases pass on first run. Task 5's production change has already wired the simplifier and the diff, so any failure is in the stub setup (mock paths, factory shape, or fake-stream lifecycle), not in the production code.

Troubleshooting if the test fails at module-load time:

- Errors mentioning `jest.unstable_mockModule` or top-level `await` — confirm `package.json`'s test script uses `NODE_OPTIONS='--experimental-vm-modules' jest`.
- `(module as any).setupCollections is not a function` — confirm the method name in `changestream.ts` has not changed since this plan was written.
- The mocks not taking effect (real `WebhookModel` / real `getModelByCollectionName` running) — confirm both `jest.unstable_mockModule` calls use the same `.js` specifier the production code imports from (`"../../models/Webhook.js"` and `"../db.js"`), and that the `await import(...)` calls below them use the same specifiers.

If `unstable_mockModule` cannot be made to work, fall back to refactoring `WebhookChangeStreamModule` to accept its `WebhookModel` and `getModelByCollectionName` dependencies via an injected adapter (matching the existing Application DI pattern), then inject test doubles directly. That refactor is scope creep beyond this plan, so prefer fixing the mock setup first.

- [ ] **Step 4: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: No errors.

Run: `npx eslint src/modules/webhook/changestream.spec.ts`
Expected: No errors.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: All tests across the project pass.

- [ ] **Step 6: Commit**

```bash
git add src/modules/webhook/changestream.spec.ts
git commit -m "test(webhook): add changestream reconcile diff integration test"
```

---

## Done

After Task 6, the `simplifyOrBranches` function is fully implemented and tested, and the changestream module uses it without paying simplification cost on no-op reconciles. The end-state diff against `dev` adds two source files (`simplifyMatch.ts`, `changestream.spec.ts`), one test file (`simplifyMatch.spec.ts`), and one modified file (`changestream.ts`).
