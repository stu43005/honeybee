# Simplify Webhook Change-Stream `$match` — Design Spec

**Date:** 2026-04-25
**Owner:** Webhook subsystem
**Status:** Draft (pending review)

## Problem

`WebhookChangeStreamModule.buildMatch` in
[src/modules/webhook/changestream.ts](../../../src/modules/webhook/changestream.ts)
assembles the change-stream `$match` filter for a collection by mapping every
enabled webhook config that targets that collection into one branch of a
top-level `$or`:

```ts
private buildMatch(webhooks: DocumentType<Webhook>[]): any {
  return {
    $or: webhooks.map((webhook) =>
      flatObjectKey({
        operationType: webhook.followUpdate
          ? { $in: ["insert", "update"] }
          : "insert",
        ...setIfDefine("fullDocument", webhook.match),
      })
    ),
  };
}
```

As the number of enabled webhooks grows, this `$or` becomes long and highly
redundant. The webhook configs come from feature transforms in
[src/data/track.ts](../../../src/data/track.ts) where dozens of tracks may
share an identical structural shape and differ only in a single field such as
`channelId`, `originChannelId`, or `authorChannelId`. The current filter pays
the cost of carrying every duplicated key on every branch — both in pipeline
size sent to MongoDB and in the work the server does to evaluate the match
against each change-stream event.

## Goal

Add a function that simplifies the array of `$or` branches so the resulting
filter matches **exactly the same set of documents** as the unsimplified one,
but with fewer / smaller branches. Wire it into the change-stream module
without making routine reconciles expensive.

Out of scope:

- Common-prefix factoring / hoisting common keys into `{$and: [..., {$or: [...]}]}`.
- Touching the `Webhook.filter` field or any post-match processing.
- Changes to webhook authoring, persistence, or the `Webhook` schema.

## Constraints

- **Equivalence preservation.** The simplified filter must match the same
  documents as the original for every possible input document. No false
  positives, no false negatives.
- **Operates on flattened branches.** `buildMatch` flattens nested objects with
  `flatObjectKey` before assembly, so the simplifier sees keys like
  `"fullDocument.channelId"`, not `"fullDocument": { "channelId": ... }`. The
  simplifier must not need to understand the `fullDocument` wrapping concern.
- **Pure, deterministic.** No I/O, no clock, no hidden state. Same input →
  same output, including stable ordering of the result.
- **Reconcile cost.** The reconcile loop in `setupCollections` runs on every
  meta-stream event and every partition rebalance. The simplification step
  must not add cost to reconciles where the underlying webhook configs did
  not change.

## Approach

Two pieces:

1. A new pure module `src/modules/webhook/simplifyMatch.ts` exporting
   `simplifyOrBranches(branches)`.
2. A revision of `WebhookChangeStreamModule` that runs the simplifier only when
   the unsimplified branches differ from the previous reconcile.

### Simplification algorithm

Input: an array of flat MongoDB match objects (each one already a `$or`
branch).
Output: an array of flat MongoDB match objects whose disjunction is logically
equivalent to the input's disjunction.

The algorithm is a **fixpoint pairwise merge** with three merge rules. Each
rule is provably equivalence-preserving:

#### Rule 1 — Dedupe

If two branches are deeply equal, drop one.
Justification: `A ∨ A ≡ A`.

#### Rule 2 — Single-key merge

For two branches with **identical key sets**, identify the keys whose values
differ (deep equality). If exactly one key differs, attempt to merge:

| Form of value on differing key K     | Form of other branch's value on K      | Merge result                                                          |
| ------------------------------------ | -------------------------------------- | --------------------------------------------------------------------- |
| Equality scalar `x`, or `{$in: [x]}` | Equality scalar `y`, or `{$in: [y]}`   | `{$in: [x, y]}` (deduped)                                             |
| Equality scalar `x`, or `{$in: [x]}` | `{$in: A}`                             | `{$in: A ∪ {x}}`                                                      |
| `{$in: A}`                           | `{$in: B}`                             | `{$in: A ∪ B}`                                                        |
| `{$nin: A}`                          | `{$nin: B}`                            | `{$nin: A ∩ B}` (drop K entirely if intersection is empty)            |
| `{$ne: x}`                           | `{$ne: y}`                             | (canonicalize to `{$nin: [x]}` / `{$nin: [y]}`, then apply $nin rule) |
| Any value `v`                        | Logical complement of `v` (see Rule 3) | apply Rule 3 instead                                                  |
| Any other shape                      | —                                      | skip (no merge for this pair)                                         |

The merged branch is identical to the input branches except on K, where it
holds the merged value. After merge, denormalize singleton `$in`/`$nin` of one
element back to the natural form (`{$in: [x]}` → `x`, `{$nin: [x]}` → `{$ne: x}`).

Justification: for the union case,
`(R ∧ K=v1) ∨ (R ∧ K=v2) ≡ R ∧ (K=v1 ∨ K=v2) ≡ R ∧ K∈{v1,v2}` where R is the
shared remainder. For the `$nin` intersection,
`K ∉ A ∨ K ∉ B ≡ K ∉ (A ∩ B)`.

#### Rule 3 — Complementary merge

For two branches with identical key sets where exactly one key K differs and
the two values are **logical complements** on K, drop the key K entirely from
the merged branch (which is otherwise identical to either input).

Recognized complementary pairs:

| Value A           | Value B (complement of A)                                                   |
| ----------------- | --------------------------------------------------------------------------- |
| Scalar `x`        | `{$ne: x}`                                                                  |
| `{$in: X}`        | `{$nin: X}` (where X compared as a set, deep-equal as a multiset of values) |
| `{$exists: true}` | `{$exists: false}`                                                          |
| `true`            | `{$ne: true}`                                                               |
| `false`           | `{$ne: false}`                                                              |

Boolean-equality cases reduce to the first row after canonicalization.

Justification: `(R ∧ P) ∨ (R ∧ ¬P) ≡ R` where P is any predicate on a single
field K, regardless of whether the document has K defined.

This rule covers the `chats` / `chatsOtherChannels` case in track.ts: with the
same `trackChannels`, the two webhooks differ only in `originChannelId` being
`{$in: trackChannels}` vs `{$nin: trackChannels}`. After the merge, the
combined branch drops `originChannelId` entirely.

#### Fixpoint loop

```
repeat:
  changed = false
  for each pair (i, j) with i < j in the current branches array:
    if branches[i] and branches[j] can merge under Rule 1, 2, or 3:
      replace branches[i] with the merged branch
      remove branches[j]
      changed = true
      break out of the inner loops and start the next iteration
  if not changed: stop
```

Bounded by `O(n²)` per pass and at most `n - 1` successful merges, giving an
upper bound of `O(n³)` for the overall loop. Webhook counts per collection
are typically small (tens to low hundreds), so this is acceptable.

### Value canonicalization

Internal helper used by Rules 2 and 3 to compare and combine values:

| Surface form                                                                      | Canonical form for comparison           |
| --------------------------------------------------------------------------------- | --------------------------------------- |
| Scalar `x` (string / number / boolean / `null`)                                   | `{__kind: "in", set: [x]}`              |
| `{$in: [...]}`                                                                    | `{__kind: "in", set: [...]}`            |
| `{$ne: x}`                                                                        | `{__kind: "nin", set: [x]}`             |
| `{$nin: [...]}`                                                                   | `{__kind: "nin", set: [...]}`           |
| `{$exists: true}`                                                                 | `{__kind: "exists", value: true}`       |
| `{$exists: false}`                                                                | `{__kind: "exists", value: false}`      |
| Anything else (e.g. `$gt`, regex, object with multiple operators, nested matches) | `{__kind: "opaque", value: <original>}` |

Set membership uses deep equality on elements; sets are stored as deduped
arrays. After merge, results are denormalized back to surface form, with
single-element `$in`/`$nin` collapsed to scalar / `$ne`.

`opaque` values can only participate in dedupe (Rule 1) or in complementary
matches when literally one input is the other's `__kind: "opaque"` mirror —
which by definition the simplifier cannot recognize, so opaque values are
treated as merge-blocking unless deep-equal.

### Result shape

`simplifyOrBranches` returns an array. The caller decides what to wrap it in:

- If the array has length 1, the caller may emit the single branch directly
  (no `$or` wrapper).
- Otherwise, the caller wraps with `{$or: [...]}`.

The simplifier itself never emits `$or`, never emits `$and`, and never emits
nested logical operators — it only thins the existing branch list.

### Stable ordering

The output preserves the relative order of surviving branches from the input.
When a merge replaces `branches[i]` and removes `branches[j]`, the merged
branch occupies position `i`. Internal arrays inside merged values
(`$in` / `$nin` element lists) are sorted by a deterministic comparator
(JSON-stringify ascending) so that two equivalent inputs produce identical
output regardless of original branch ordering. This determinism matters for
the reconcile diff in the change-stream module.

## Integration with WebhookChangeStreamModule

The reconcile loop in `setupCollections` must avoid running the simplifier
on every reconcile. The integration splits the previous one-shot `buildMatch`
into two stages:

1. **Cheap stage — build raw branches.** Same logic as today's `buildMatch`,
   minus the `{$or: ...}` wrapper:

   ```ts
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

2. **Expensive stage — simplify.** Only run when raw branches differ from
   what the existing change stream was opened with.

`CollectionState` is amended to store the **raw** (unsimplified) branches as
the comparison key, since that is the cheap-diff input:

```ts
interface CollectionState {
  changeStream: mongo.ChangeStream;
  tokenSaveInterval: NodeJS.Timeout;
  rawBranches: any[]; // pre-simplification, for diff
  webhooks: DocumentType<Webhook>[];
}
```

The previous `changeStreamMatch` field is removed; nothing else reads it.

`setupCollections`'s assigned-collection loop becomes:

```ts
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
  const match = simplified.length === 1 ? simplified[0] : { $or: simplified };
  if (existing) await this.closeCollection(coll);
  await this.openCollection(coll, webhooks, rawBranches, match);
}
```

`openCollection`'s signature changes: it now receives `rawBranches` (stored in
state for future diffs) and `match` (passed straight to
`model.watch([{ $match: match }], …)`). The log line that previously read
`match length: ${match.$or.length}` becomes
`branches: ${rawBranches.length} → ${simplified.length}` so the simplification
ratio is observable in production logs.

`buildMatch` is removed; its callers all go through `buildRawBranches` +
`simplifyOrBranches`.

### Defensive cases

- **Empty `simplified`.** Cannot happen for a non-empty input under the rules
  above (every merge keeps at least one branch). If `rawBranches` is empty,
  the collection should not have been added to `assigned` in the first place.
  Guard with an explicit check that throws if `simplified.length === 0` after
  a non-empty input — this catches bugs in the simplifier rather than silently
  opening a stream with an empty match (which would forward every event).
- **`simplified.length === 1`.** Emit the single branch directly with no
  `$or` wrapper. This is a small but real saving, since the change-stream
  pipeline is sent on every event evaluation.

## Test plan

Tests live in `src/modules/webhook/simplifyMatch.test.ts` and run under the
existing Jest setup.

### Rule-level unit tests

1. **Dedupe identical branches.** Two deep-equal inputs collapse to one.
2. **Scalar union merge.** `{ a: "x", b: 1 }` ∨ `{ a: "y", b: 1 }`
   → `{ a: { $in: ["x", "y"] }, b: 1 }`.
3. **Scalar + `$in` merge.** `{ a: "x", b: 1 }` ∨ `{ a: { $in: ["y", "z"] }, b: 1 }`
   → `{ a: { $in: ["x", "y", "z"] }, b: 1 }`.
4. **`$in` + `$in` merge with overlap deduped.**
5. **`$nin` + `$nin` intersection merge.**
6. **`$nin` + `$nin` empty-intersection drops the key.**
7. **`$ne` + `$ne` merge** (canonicalize, then apply `$nin` rule).
8. **Complementary `$in` vs `$nin` (same set) drops the key.** This is the
   `chats` / `chatsOtherChannels` case from track.ts.
9. **Complementary scalar `true` vs `{$ne: true}` drops the key.**
10. **Complementary `{$exists: true}` vs `{$exists: false}` drops the key.**
11. **Branches with ≥ 2 differing keys are left alone.**
12. **Branches with different key sets are left alone.**
13. **Opaque value (e.g. `{$gt: 5}`) participates in dedupe but not in union
    merges.**
14. **Iterative fixpoint.** Three branches of the form
    `{ a: "x", b: 1 }`, `{ a: "y", b: 1 }`, `{ a: "z", b: 1 }`
    collapse to a single `{ a: { $in: ["x", "y", "z"] }, b: 1 }`.

### Property test

15. Equivalence preservation — generate a small fixed corpus of synthetic
    documents (≈ 30 docs covering booleans, strings, numbers, missing fields,
    arrays) and a hand-curated set of branch arrays. For each branch array,
    assert that for every doc in the corpus, the input disjunction and the
    simplified disjunction produce the same boolean. The matcher used is the
    project's existing `isMatching` helper from
    [src/modules/matching.ts](../../../src/modules/matching.ts), which already
    backs the in-process post-filter for change events. This is the same
    semantics MongoDB applies on the server, modulo the operators the helper
    supports — which covers everything used in track.ts.

### Realistic-shape test

16. Feed the simplifier the flattened branches that
    `buildRawBranches` produces for a set of three Track configs sharing the
    same feature flags but different `trackChannels`, and assert the expected
    consolidated shape (single branch with `$in` of all channel ids).

### Determinism test

17. Feed the simplifier the same branches in two different orders; assert
    both invocations return deeply-equal output (including the order of
    elements inside merged `$in` / `$nin` arrays).

### Integration test

18. In the existing change-stream test file (or a new one alongside it),
    construct a `WebhookChangeStreamModule` instance, drive `setupCollections`
    with a webhook set, then call `setupCollections` again with the same
    webhook set, and assert the change stream was not re-opened (i.e. the
    `closed === false && isEqual(rawBranches, …)` short-circuit fires).
    Then drive `setupCollections` once more with a webhook set that has the
    same simplified shape but different raw branches (e.g. add a webhook
    whose match unions cleanly into an existing `$in`); assert the stream is
    re-opened, because the diff is on raw branches, not simplified output.

## Risks and mitigations

- **Bug in equivalence preservation.** A faulty merge rule could silently
  drop documents that the original filter would have matched, breaking
  webhook delivery. Mitigation: the property test (item 15) covers the
  combinatorial space against an independent matcher; rule-level tests
  cover each merge path; the simplifier is a pure function so failures are
  reproducible from the test fixtures alone.
- **Determinism drift across Node versions.** Object-key ordering in JSON
  stringify is well-defined for plain objects across Node 18 / 20 / 22.
  Mitigation: the comparator sorts arrays of values, not arrays of objects
  with mixed key orders; if a future change introduces nested-object values
  inside `$in`/`$nin`, the comparator must be updated to canonicalize keys
  first.
- **Larger `$in` arrays in the simplified filter.** A merged `$in` of many
  channel ids is sent in the change-stream pipeline once at open time. The
  per-event evaluation cost of `$in` against a hashed set is `O(1)` in
  practice on the server, so the larger pipeline at open is offset by the
  smaller per-event work. No mitigation needed; just noted so the size is
  not surprising.
