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

function setUnion(a: unknown[], b: unknown[]): unknown[] {
  return sortDedupedSet([...a, ...b]);
}

function setIntersection(a: unknown[], b: unknown[]): unknown[] {
  const bKeys = new Set(b.map((x) => JSON.stringify(x)));
  return a.filter((x) => bKeys.has(JSON.stringify(x)));
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
