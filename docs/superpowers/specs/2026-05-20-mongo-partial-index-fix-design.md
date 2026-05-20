# MongoDB Partial Index Fix — Design Spec

Date: 2026-05-20
Status: Draft

## 1. Problem

Three Typegoose `@index(...)` definitions use `$ne` or `$nin` inside
`partialFilterExpression`. Those operators are not in MongoDB's
`partialFilterExpression` operator whitelist (allowed: equality, `$exists: true`,
`$gt/$gte/$lt/$lte`, `$type`, `$and`, `$or`, `$in`). When mongoose's
`autoIndex` runs `Model.ensureIndexes()` on startup, the server rejects the
index spec. The exact in-process swallow pathway has not been instrumented
(the candidate mechanisms — model `'error'` event with no listener,
unhandled rejection on `Model.$init`, or autoIndex internal handling —
have not been distinguished by reproduction), but the observable production
outcome is that the failure does not surface in process logs and the code
runs as if `autoIndex` succeeded. The result: code says "the index exists",
DB says it does not. The authoritative post-condition for any partial-index
change is therefore `db.<collection>.getIndexes()`, not log inspection;
this is wired into the runbook (section 4 step 2).

Affected definitions:

| File                          | Index key                                                 | Bad operators in partial filter | Consumer                                                                          |
| ----------------------------- | --------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `src/models/Video.ts:91-99`   | `{ hbCleanedAt:1, actualEnd:1, hbEnd:1 }`                 | `$nin` × 2                      | `cleanEndedStreams` in `src/components/cleanup.ts:61-89`                          |
| `src/models/Channel.ts:18-26` | `{ organization:1, isInactive:1, hbIgnore:1, deleted:1 }` | `$ne` × 3                       | `Channel.SubscribedQuery` / `findSubscribed()` in `src/models/Channel.ts:165-188` |
| `src/models/Channel.ts:28-37` | `{ extraCrawl:1, isInactive:1, hbIgnore:1, deleted:1 }`   | `$ne` × 3                       | same as above                                                                     |

Verified absent in production DB by running `db.videos.getIndexes()` and
`db.channels.getIndexes()` on 2026-05-19. Both `channels` indexes are missing.
The `videos` partial index is also missing; production slow log shows the
`cleanEndedStreams` query falling back to `IXSCAN { status: 1 }` and taking
up to 891 ms per execution.

`db.channels.getIndexes()` additionally returned two indexes that are not
defined anywhere in `src/models/`:

```js
{ v: 2, key: { extraCrawl: 1, isInactive: 1 },
  name: "extraCrawl_1_isInactive_1", background: true }
{ v: 2, key: { organization: 1, isInactive: 1 },
  name: "organization_1_isInactive_1", background: true }
```

No `partialFilterExpression`, no `unique`, no `sparse`, no collation. These
are manually-created leftovers (likely added as an emergency workaround when
the original 4-field partial indexes failed to come up). They are narrower
than the indexes that will replace them and serve no purpose once the new
indexes exist.

## 2. Goals & non-goals

### Goals

1. Make each of the three broken `@index(...)` definitions create the intended
   index on a fresh MongoDB instance.
2. Make the production `cleanEndedStreams` query and `findSubscribed` query
   use the new indexes (verified via `explain()`).
3. Bring the production `channels` collection into agreement with `src/models/`
   by dropping the two leftover indexes.
4. Surface mongoose `autoIndex` failures as a console warning so future
   operator-whitelist regressions are noticeable in deploy logs, without
   blocking process startup.

### Non-goals

- Startup-time **hard-fail** for index sync failures. The process must keep
  running on failure; only a warning is emitted. Goal 4 covers the warning.
- Schema migration to add `default: false` for `isInactive` / `hbIgnore` /
  `extraCrawl` / `deleted` on `Channel`.
- Changes to `cleanup.ts` query logic. The simplified Video partial filter
  matches the existing query's `hbCleanedAt: null` predicate exactly; no query
  rewrite is needed.
- Audit or redesign of other models' indexes.

## 3. Design

### 3.1 Video — simplify partial filter

`src/models/Video.ts:91-99` becomes:

```ts
@index(
  { hbCleanedAt: 1, actualEnd: 1, hbEnd: 1 },
  {
    partialFilterExpression: {
      hbCleanedAt: null,
    },
  }
)
```

Key pattern unchanged. The `hbStatus !== "Created"` and
`status $nin LiveStatus` constraints are dropped from the partial filter and
left to FETCH-stage filtering. The set of "uncleaned" videos is already
small relative to the full collection (every video eventually receives
`hbCleanedAt`), so FETCH-stage filtering is cheap.

Equality to `null` is allowed in `partialFilterExpression`. Per MongoDB query
semantics (which `partialFilterExpression` reuses), `{ hbCleanedAt: null }`
matches both documents where the field is explicitly `null` and documents
where it is missing. This matters because Video documents are inserted via
two paths:

- `src/models/Video.ts:454`, `:474`, `:496` — explicitly set `hbCleanedAt: null`
- `src/models/Video.ts:373-378` — `$setOnInsert` for new videos that does
  not set `hbCleanedAt` at all, so the field is missing on first insert

Both populations must be indexed. Confirm with a one-shot test in production
before relying on it:

```js
db.test_partial_null.drop();
db.test_partial_null.createIndex(
  { x: 1 },
  { partialFilterExpression: { x: null } }
);
db.test_partial_null.insertMany([{ x: null }, {}, { x: 1 }]);
db.test_partial_null.find({ x: null }).hint({ x: 1 }).explain("executionStats");
// pass criterion: totalKeysExamined == 2 (null + missing).
// If it returns 1, the partial index excludes missing-field documents and the
// $setOnInsert path at Video.ts:373-378 would be unindexed — escalate before
// deploying.
db.test_partial_null.drop();
```

Verified on production replica `honeybee-mongodb-0` (MongoDB 8.0.3) on
2026-05-20: `totalKeysExamined: 2`, `nReturned: 2`, plan was
`FETCH → IXSCAN(x_1, isPartial: true, bounds: [[null, null]])`. The partial
index captures both explicit-null and missing-field documents on this
server version.

`@typegoose/typegoose` and the mongoose `IndexOptions` type accept `null` in
`partialFilterExpression` without a cast: `IndexOptions` extends mongodb's
`CreateIndexesOptions`, where `partialFilterExpression?: Document`.
`Document` is declared in `node_modules/bson/bson.d.ts` as
`interface Document { [key: string]: any }` and re-exported by
`node_modules/mongodb/mongodb.d.ts`, so any value (including `null`) is
assignable.

### 3.2 Channel — drop partial filter

`src/models/Channel.ts:18-38` becomes:

```ts
@index({ organization: 1, isInactive: 1, hbIgnore: 1, deleted: 1 })
@index({ extraCrawl: 1, isInactive: 1, hbIgnore: 1, deleted: 1 })
```

Rationale for dropping the filter entirely instead of rewriting it:

- The semantic intent of `{ $ne: true }` is "field is missing, null, or
  false". The `partialFilterExpression` whitelist offers no operator that
  expresses this. `$exists: false` is not allowed (only `$exists: true` is).
  `$in: [null, false]` is allowed but does not express the same set —
  documents with the field set to other falsy values (e.g. `0`, `""`) would
  be excluded from the index, and any future read or write paths that begin
  using `false` vs missing inconsistently would silently drift out of the
  index.
- The `channels` collection is small (low thousands of documents). The
  storage/maintenance cost of indexing the inactive / ignored / deleted
  channels too is negligible.
- A schema migration to add `default: false` would let `: false` appear in
  the partial filter directly, but the migration risk (backfill on a live
  collection, plus updating every write site to actually set the default)
  outweighs the gain.

The `SubscribedQuery` at `src/models/Channel.ts:165-185` is unchanged. With
plain compound indexes, planner is expected to evaluate each `$or` branch
against the index whose leading field matches that branch's leading equality
predicate (`organization` for branch 1, `extraCrawl: true` for branch 2),
producing an OR_UNION plan or two index scans merged.

Known suboptimality for branch 1: when `HOLODEX_FETCH_ORG === HOLODEX_ALL_VTUBERS`
the predicate becomes `organization: { $ne: null }`. `$ne` on a leading index
key cannot produce a tight equality bound — the planner scans the range
`[MinKey, null) ∪ (null, MaxKey]` on the index and then FETCH-filters the
remaining `$ne: true` predicates. This is still much better than COLLSCAN
because the `channels` collection is small and most documents do have an
`organization`, but the verification in section 5.3 must use
`executionStats` to confirm key-examination volume is bounded, not just that
some IXSCAN appears.

### 3.3 Leftover index cleanup

After the new Channel indexes are live and verified, drop the two manually-
created 2-field indexes from production:

```js
db.channels.dropIndex("extraCrawl_1_isInactive_1");
db.channels.dropIndex("organization_1_isInactive_1");
```

These are strict prefixes of the new 4-field indexes, so any query that
previously used them can use the new index instead. They likely currently
serve the `findSubscribed` query as a fallback (see section 5.3 — the
production `explain` before this work showed those queries hitting `IXSCAN`,
not `COLLSCAN`). Dropping them only after section 4 step 3 passes ensures
continuity.

Recovery: if a later regression requires re-creating the leftover indexes,
the commands below reproduce the exact shape captured in section 1 (only
`background: true`; no other options):

```js
db.channels.createIndex(
  { extraCrawl: 1, isInactive: 1 },
  { background: true, name: "extraCrawl_1_isInactive_1" }
);
db.channels.createIndex(
  { organization: 1, isInactive: 1 },
  { background: true, name: "organization_1_isInactive_1" }
);
```

### 3.4 Surface autoIndex failures as warnings

`src/modules/db.ts` currently has no `Model.on('index', ...)` listener.
Extend `importAllModels()` so that immediately after each model module is
dynamically imported, any newly-registered `mongoose.models[*]` entries get
an `index` listener attached. Attaching inline (rather than once after the
whole loop completes) avoids a race where a model's `ensureIndexes()` could
in principle fire its `index` event before the post-loop attachment step
runs.

```ts
// In src/modules/db.ts, inside importAllModels():
for (const file of await fsp.readdir(modelsDir, { withFileTypes: true })) {
  if (
    file.isFile() &&
    file.name.endsWith(".js") &&
    !file.name.endsWith(".spec.js") &&
    !file.name.endsWith(".test.js")
  ) {
    const importPath = pathToFileURL(path.join(modelsDir, file.name)).href;
    await import(importPath);
    attachIndexWarningListeners();
  }
}
```

`attachIndexWarningListeners()` is a small helper, also in `src/modules/db.ts`:

```ts
function attachIndexWarningListeners(): void {
  for (const model of Object.values(mongoose.models)) {
    const flagged = model as unknown as { __hbIndexListenerAttached?: boolean };
    if (flagged.__hbIndexListenerAttached) continue;
    flagged.__hbIndexListenerAttached = true;
    model.on("index", (err: Error | null) => {
      if (err) {
        console.warn(
          `[mongoose] autoIndex failed for ${model.collection.name}:`,
          err.message
        );
      }
    });
  }
}
```

Behavior:

- If `Model.ensureIndexes()` succeeds, the `index` event fires with `err` of
  `null` — no log line.
- If it fails (e.g. an invalid `partialFilterExpression` operator), one
  `console.warn` line is emitted per failed model. The process continues.
- The idempotency flag (`__hbIndexListenerAttached`) is the mechanism that
  makes the per-import call cheap: each call only walks new models. It also
  prevents double-binding if `importAllModels()` is ever invoked twice.
- A single model file may register multiple models (it can import other
  files that also call `getModelForClass`), so the helper walks the full
  `mongoose.models` map rather than tracking only "the model added by this
  import".

No new dependency, no behavior change in healthy state, no `process.exit`.
The warning is best-effort observability; `db.<collection>.getIndexes()`
in section 4 step 2 remains the authoritative post-condition.

Steps must be executed in order. Step 4 must not begin until step 3 passes.

1. **Deploy code change.** Merging the model changes is enough — mongoose's
   `autoIndex` will create the new indexes on next process start. No
   migration script. Note that `src/modules/db.ts` does not register any
   `Model.on('index', ...)` listener, so a failed `createIndex` from
   `autoIndex` is swallowed (this is precisely the original bug); the
   authoritative post-condition is the `getIndexes()` check in step 2, not
   log inspection.
2. **Verify index presence.** On the production replica set:
   ```js
   db.videos.getIndexes();
   // expect: hbCleanedAt_1_actualEnd_1_hbEnd_1
   //         with partialFilterExpression: { hbCleanedAt: null }
   db.channels.getIndexes();
   // expect: organization_1_isInactive_1_hbIgnore_1_deleted_1
   //         extraCrawl_1_isInactive_1_hbIgnore_1_deleted_1
   //         (both without partialFilterExpression)
   ```
3. **Verify planner selection.** Run the explain plans in section 5.2 and
   5.3. Both must satisfy the pass criteria stated in those sections (not
   just "an IXSCAN appears" — section 5.3 in particular requires
   `executionStats` evidence that key examination is bounded).
4. **Drop leftover indexes.** Precondition: step 3's pass criteria (sections
   5.2 and 5.3) all passed and the explain output showed the new 4-field
   indexes being chosen — not the leftover 2-field indexes. If the leftover
   indexes were still chosen, stop and investigate before dropping.
   ```js
   db.channels.dropIndex("extraCrawl_1_isInactive_1");
   db.channels.dropIndex("organization_1_isInactive_1");
   ```
5. **Observe slow log.** Wait ≥ 1 hour; verify the pass criteria in
   section 5.4.

Doing the drop before the deploy would create a window where neither the old
nor new indexes exist, and `findSubscribed` (used by the discord-bot channel
search) would fall back to COLLSCAN.

## 5. Verification

### 5.1 Index presence

`db.videos.getIndexes()` and `db.channels.getIndexes()` outputs must include
the three new index names listed in section 4 step 2, with the partial filter
shown for the Video index only.

### 5.2 Explain — Video cleanup query

```js
db.videos
  .find({
    hbCleanedAt: null,
    hbStatus: { $ne: "Created" },
    status: { $nin: ["upcoming", "live"] },
    $or: [
      { actualEnd: { $lt: ISODate("2026-05-20T00:00:00Z") } },
      { hbEnd: { $lt: ISODate("2026-05-20T00:00:00Z") } },
      {
        actualEnd: { $exists: false },
        hbEnd: { $exists: false },
        updatedAt: { $lt: ISODate("2026-05-20T00:00:00Z") },
      },
    ],
  })
  .explain("queryPlanner");
```

Pass criteria: `winningPlan` reaches `hbCleanedAt_1_actualEnd_1_hbEnd_1` via
IXSCAN (directly or under an OR stage). Fail if `status_1` is the chosen index.

### 5.3 Explain — Channel SubscribedQuery

```js
const Q = {
  $or: [
    {
      organization: { $ne: null },
      isInactive: { $ne: true },
      hbIgnore: { $ne: true },
      deleted: { $ne: true },
    },
    {
      extraCrawl: true,
      isInactive: { $ne: true },
      hbIgnore: { $ne: true },
      deleted: { $ne: true },
    },
  ],
};
db.channels.find(Q).explain("executionStats");
```

Before running explain, record the current collection size:

```js
const N = db.channels.countDocuments();
```

Pass criteria (all must hold):

- `winningPlan` matches one of these acceptable shapes (`FETCH` wrappers
  optional at each level):
  - `SUBPLAN → OR → [ IXSCAN(branch-1-index), IXSCAN(branch-2-index) ]`
  - `OR → [ IXSCAN(branch-1-index), IXSCAN(branch-2-index) ]`

  where branch-1-index is
  `organization_1_isInactive_1_hbIgnore_1_deleted_1` and branch-2-index is
  `extraCrawl_1_isInactive_1_hbIgnore_1_deleted_1`. Reject if any IXSCAN
  names the leftover 2-field index (`extraCrawl_1_isInactive_1`,
  `organization_1_isInactive_1`) or `_id_`, or if any `COLLSCAN` appears
  anywhere in `winningPlan`.

- `executionStats.totalKeysExamined ≤ 2 * N`. The `2×` allowance is for
  branch 1 when `HOLODEX_FETCH_ORG === HOLODEX_ALL_VTUBERS`: the predicate
  `organization: {$ne: null}` scans `[MinKey, null) ∪ (null, MaxKey]`, which
  in the worst case is the full key range across both indexes' OR_UNION.
- `executionStats.totalDocsExamined ≤ executionStats.totalKeysExamined`.
  Equality is expected (filter covered by index); a higher docs count means
  the planner is doing extra FETCHes beyond the index, which indicates the
  filter isn't being applied during the IXSCAN.

Wall-clock bounds are intentionally omitted — `executionTimeMillis` on a
shared production replica is dominated by cache state and contention, not
by the index design. The two structural bounds above are load-independent.

### 5.4 Slow log observation

After ≥ 1 hour of production traffic post-deploy:

- The `cleanEndedStreams` query no longer appears in mongodb slow log, or its
  `durationMillis` is below 100 ms (down from up to 891 ms).
- No new `find honeybee.channels` entries appear in slow log.

### 5.5 No unit tests

Two reasons:

- The thing that broke (a silent server-side rejection of
  `partialFilterExpression` operators) is already covered by the deploy-time
  `getIndexes()` check in section 5.1 — running it in a test against
  `mongodb-memory-server` would only re-prove the operator-whitelist fact,
  not the design.
- Planner selection (sections 5.2 / 5.3) is a function of collection size,
  cardinality, and index statistics. A test fixture cannot reproduce
  production data distribution faithfully enough for the pass criteria to
  be meaningful, and a passing in-test `explain` would not justify
  skipping the production `explain` anyway.

## 6. Risk assessment

- **Risk: planner picks unexpected plan after index changes.** Mitigated by
  step 3 of the runbook (explain before dropping leftover indexes). While
  steps 1–3 are in progress, the leftover 2-field indexes still cover the
  lookup as a fallback. After step 4 the leftover indexes are gone; if a
  later distribution change causes a regression, recover with the
  `createIndex` commands listed in section 3.3.
- **Risk: silent autoIndex failure recurs in the future.** Mitigated by
  Goal 4 (section 3.4): the `console.warn` line appears in deploy logs on
  failure. The warning is best-effort and not blocking — operators must
  still run the `getIndexes()` check (section 4 step 2) after any
  partial-index change to confirm. The warning is a backstop for accidents,
  not a substitute for verification.
- **Risk: dropping leftover indexes is destructive.** Recovered by re-creating
  them with the commands listed in section 3.3; no data loss. The new
  4-field indexes are strict supersets of the leftover 2-field ones.
