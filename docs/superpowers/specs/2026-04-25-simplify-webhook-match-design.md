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
  not change. The reconcile diff uses `lodash.isEqual`, which is
  order-insensitive on plain object keys, so non-deterministic key ordering
  in `flatObjectKey` output does not cause spurious re-opens.
- **Element types in `$in` / `$nin`.** Element comparison and union/
  intersection operations are defined for JSON scalars only (string, number,
  boolean, `null`). If any element of an `$in` / `$nin` array is a non-scalar
  (object, array, regex, etc.), the entire value is classified as `opaque`
  by the canonicalizer (see "Value canonicalization" below) and only
  participates in dedupe. This is sufficient for every shape in
  [src/data/track.ts](../../../src/data/track.ts), where `$in` / `$nin`
  payloads are channel-id strings.

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

**Note on canonicalization regime.** Rules 2 and 3 are defined in terms of
the canonical kinds produced by the "Value canonicalization" section below
(`in`, `nin`, `exists`, `opaque`). Each comparison canonicalizes its inputs
on the fly; merged values stay in canonical form throughout the fixpoint
loop. **Denormalization to surface form happens exactly once, at the end of
the loop, on the surviving branches.** This avoids surface↔canonical
round-trips on every pass.

#### Rule 2 — Single-key merge

For two branches with **identical key sets**, identify the keys whose values
differ (deep equality on canonical form). If exactly one key K differs,
attempt to merge by canonical kind of the two values on K:

| Kind on K (branch A)                               | Kind on K (branch B)       | Merge result on K                                                                                                        |
| -------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `in: A`                                            | `in: B`                    | `in: A ∪ B`                                                                                                              |
| `nin: A`                                           | `nin: B`                   | `nin: A ∩ B` (if A ∩ B is empty, **drop K from the merged branch entirely**, reducing the branch's key set — see note 8) |
| `in: X`                                            | `nin: X` (X equal as sets) | drop K — handled by Rule 3                                                                                               |
| `exists: true`                                     | `exists: false`            | drop K — handled by Rule 3                                                                                               |
| `in` ↔ `nin` (sets unequal)                        | —                          | skip                                                                                                                     |
| `opaque` ↔ anything other than deep-equal `opaque` | —                          | skip                                                                                                                     |
| Any other combination                              | —                          | skip                                                                                                                     |

The merged branch is identical to the input branches except on K, where it
holds the merged value (or has K removed for the empty-intersection case).

Justification: for the union case,
`(R ∧ K=v1) ∨ (R ∧ K=v2) ≡ R ∧ (K=v1 ∨ K=v2) ≡ R ∧ K∈{v1,v2}` where R is the
shared remainder. For the `$nin` intersection,
`K ∉ A ∨ K ∉ B ≡ K ∉ (A ∩ B)`. When `A ∩ B = ∅`, `K ∉ ∅` is true for every
document (whether K exists or not), so the K constraint is identically true
and dropping it preserves equivalence.

**Reduced-key-set branches re-enter the loop.** After a `nin ∩ nin = ∅` drop
or a Rule 3 drop, the merged branch has fewer keys than either input. On the
next fixpoint pass it is compared against all surviving branches under the
"identical key sets" gate, and may now merge with a branch that previously
had its key set. This is how the chats/chatsOtherChannels pair, after Rule 3
drops `originChannelId`, becomes mergeable with neighbouring branches that
share the reduced shape.

#### Rule 3 — Complementary merge

For two branches with identical key sets where exactly one key K differs and
the two canonical values on K are **logical complements**, drop K from the
merged branch (which is otherwise identical to either input).

Canonical complementary pairs (all surface-form examples reduce to these
after canonicalization):

| Canonical A    | Canonical B (complement)        |
| -------------- | ------------------------------- |
| `in: X`        | `nin: X` (X deep-equal as sets) |
| `exists: true` | `exists: false`                 |

Surface-form examples that canonicalize into the `in` ↔ `nin` row:

- scalar `x` ↔ `{$ne: x}` → `in: [x]` ↔ `nin: [x]`
- `true` ↔ `{$ne: true}` → `in: [true]` ↔ `nin: [true]`
- `false` ↔ `{$ne: false}` → `in: [false]` ↔ `nin: [false]`
- `{$in: X}` ↔ `{$nin: X}` directly

Justification: `(R ∧ P) ∨ (R ∧ ¬P) ≡ R` where P is any predicate on a single
field K, regardless of whether the document has K defined.

This rule covers the `chats` / `chatsOtherChannels` case in track.ts: with the
same `trackChannels`, the two webhooks differ only in `originChannelId` being
`{$in: trackChannels}` vs `{$nin: trackChannels}`. After the merge, the
combined branch drops `originChannelId` entirely.

#### Fixpoint loop

```text
repeat:
  changed = false
  for each pair (i, j) with i < j in the current branches array, in
      ascending (i, j) order:
    if branches[i] and branches[j] can merge under Rule 1, 2, or 3:
      replace branches[i] with the merged branch
      remove branches[j]
      changed = true
      break out of the inner loops and start the next iteration
  if not changed: stop
```

The pair iteration order is fixed (ascending `i`, then ascending `j`) so the
output is deterministic regardless of which mergeable pairs exist in the
input. Different iteration orders may produce different intermediate states
but the final fixpoint shape is the same up to canonicalization, because the
merge rules form a confluent rewriting system on canonical kinds. The fixed
order pins down the exact intermediate sequence and therefore the exact
output.

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

Set elements are restricted to JSON scalars (string, number, boolean,
`null`). If an `$in` / `$nin` array contains any non-scalar element (object,
array, regex, date, `ObjectId`, etc.), the entire value canonicalizes as
`opaque` rather than `in` / `nin`. This bounds the equality / set-union /
set-intersection logic to comparisons over scalars, where deep equality is
unambiguous and matches MongoDB's BSON value equality for the types in use
in [src/data/track.ts](../../../src/data/track.ts).

Sets are stored internally as deduped arrays sorted by JSON-stringify
ascending. Set equality is "same length and pairwise deep-equal after sort";
set union dedupes by the same comparator; set intersection keeps elements
present in both.

After the fixpoint loop terminates, surviving canonical values are
denormalized back to surface form once: `in: [x]` → `x`, `nin: [x]` →
`{$ne: x}`, `in: [...]` (length ≥ 2) → `{$in: [...]}`, `nin: [...]` (length
≥ 2) → `{$nin: [...]}`, `exists: v` → `{$exists: v}`, `opaque: v` → `v`
(unchanged).

`opaque` values participate only in Rule 1 dedupe (when the underlying
surface values are deep-equal). They never participate in Rule 2 or Rule 3
because the simplifier has no semantic information about them.

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
  if (simplified.length === 0) {
    throw new Error(
      `simplifyOrBranches reduced ${rawBranches.length} branch(es) to 0 for "${coll}"`
    );
  }
  const match = simplified.length === 1 ? simplified[0] : { $or: simplified };
  if (existing) await this.closeCollection(coll);
  await this.openCollection(coll, webhooks, rawBranches, match);
  documentLog(
    coll,
    `start listening (branches: ${rawBranches.length} → ${simplified.length})`
  );
}
```

`openCollection`'s signature changes from `(coll, webhooks, match)` to
`(coll, webhooks, rawBranches, match)`. It stores `rawBranches` in
`CollectionState` for future diffs and passes `match` straight to
`model.watch([{ $match: match }], …)`.

The previous "start listening" log line that lived **inside** `openCollection`
moves out to `setupCollections` (shown above) so it can reference both
`rawBranches.length` and `simplified.length`. The single log line replaces
the previous `match length: ${match.$or.length}` log.

`buildMatch` is removed; its callers all go through `buildRawBranches` +
`simplifyOrBranches`.

### Defensive cases

- **Empty `simplified`.** Cannot happen for a non-empty input under the rules
  above (every merge keeps at least one branch). If `rawBranches` is empty,
  the collection should not have been added to `assigned` in the first place.
  The guard in `setupCollections` (shown above) throws if
  `simplified.length === 0` for a non-empty input — this catches bugs in the
  simplifier rather than silently opening a stream with an empty match (which
  would forward every event).
- **`simplified.length === 1`.** Emit the single branch directly with no
  `$or` wrapper. This is a small but real saving, since the change-stream
  pipeline is sent on every event evaluation.

## Test plan

Tests live in `src/modules/webhook/simplifyMatch.spec.ts` (matching the
`.spec.ts` naming convention used by the neighbouring `claim.spec.ts`,
`partition.spec.ts`, and `queue.spec.ts`) and run under the existing Jest
setup.

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

18. New file `src/modules/webhook/changestream.spec.ts`. The project does
    **not** depend on `mongodb-memory-server`, so this test does not spin up
    a real MongoDB. Instead it stubs the two MongoDB seams used by the
    module:
    - `WebhookModel.findEnabled` — replaced with a Jest mock that returns a
      handcrafted webhook list.
    - The model returned from `getModelByCollectionName` — replaced with a
      stub that exposes a `.watch(pipeline, options)` method returning a
      fake `ChangeStream` (an `EventEmitter` plus `closed: false`,
      `close()`, `removeAllListeners()`, `resumeToken: undefined`). Each
      `.watch` call records its `pipeline` argument so the test can assert
      the `$match` shape.

    The test also stubs `RedisModule` (resume-token get/set become no-ops)
    and `WebhookPartitionModule` (`getAssignedCollections` returns its input
    set, `instanceId` returns a constant). With these stubs the test
    constructs a `WebhookChangeStreamModule`, calls `init()`, and then
    drives the private `setupCollections` path by emitting `rebalance` on
    the partition stub (or by calling `setupCollections` via a small
    `(module as any)` cast — pick whichever the surrounding file already
    uses for `partition.spec.ts`).

    The assertions are:
    1. After the first reconcile with a given webhook set, exactly one
       `.watch` call was recorded for the relevant collection.
    2. After a second reconcile with the **same** webhook set, the recorded
       `.watch` call count is unchanged (no re-open).
    3. After a third reconcile with a webhook set whose `rawBranches` differ
       but whose **simplified output is identical** to the previous reconcile,
       the recorded `.watch` call count still increments and the previous
       fake ChangeStream's `close()` was invoked. This pins down the contract
       that the reconcile diff is on raw branches, not on the simplified
       output.

       A fixture that exhibits this exact "raw differ, simplified identical"
       shape: configure two webhooks whose raw branches are
       `[{ "fullDocument.channelId": "x" }, { "fullDocument.channelId": "y" }]`
       (two scalar branches), and on the next reconcile replace them with a
       single webhook whose raw branch is
       `[{ "fullDocument.channelId": { $in: ["x", "y"] } }]`. Both inputs
       produce the same simplified output (a single branch with
       `$in: ["x", "y"]`), but `lodash.isEqual` over the raw branches sees
       them as different (length 2 vs length 1, and the element shapes
       differ). The test must use this or an equivalent fixture; do not use
       "added webhook whose match unions into an existing `$in`", which
       would change the simplified shape.

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
