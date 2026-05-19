# MongoDB Partial Index Fix — Design Spec

Date: 2026-05-20
Status: Draft

## 1. Problem

Three Typegoose `@index(...)` definitions use `$ne` or `$nin` inside
`partialFilterExpression`. Those operators are not in MongoDB's
`partialFilterExpression` operator whitelist (allowed: equality, `$exists: true`,
`$gt/$gte/$lt/$lte`, `$type`, `$and`, `$or`, `$in`). When mongoose's
`autoIndex` tries to create them on startup, the server rejects them; mongoose
emits the failure on the connection's `error` event and the process keeps
running. The result: code says "the index exists", DB says it does not.

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

- `extraCrawl_1_isInactive_1`
- `organization_1_isInactive_1`

These are manually-created leftovers (likely added as an emergency workaround
when the original 4-field partial indexes failed to come up). They are narrower
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

### Non-goals

- Startup-time fail-fast for index sync failures. (Considered and explicitly
  excluded by the user — current `autoIndex` log-and-continue behavior is
  retained.)
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

Equality to `null` is allowed in `partialFilterExpression`. Per MongoDB
semantics, `{ hbCleanedAt: null }` matches both documents where the field is
explicitly `null` and documents where it is missing.

### 3.2 Channel — drop partial filter

`src/models/Channel.ts:18-37` becomes:

```ts
@index({ organization: 1, isInactive: 1, hbIgnore: 1, deleted: 1 })
@index({ extraCrawl: 1, isInactive: 1, hbIgnore: 1, deleted: 1 })
```

Rationale for dropping the filter entirely instead of rewriting it:

- The semantic intent of `{ $ne: true }` is "field is missing, null, or
  false". The `partialFilterExpression` whitelist offers no operator that
  expresses this without changing semantics. (`$exists: false` is not
  allowed; `$in: [null, false]` would work but is opaque and easy to break
  when new boolean fields are added.)
- The `channels` collection is small (low thousands of documents). The
  storage/maintenance cost of indexing the inactive / ignored / deleted
  channels too is negligible.
- Keeping the partial filter would require either a brittle `$in: [null,
false]` workaround or a schema migration. Both add risk for marginal gain.

The `SubscribedQuery` at `src/models/Channel.ts:165-185` is unchanged. With
plain compound indexes, planner is expected to evaluate each `$or` branch
against the index whose leading field matches that branch's leading equality
predicate (`organization` for branch 1, `extraCrawl: true` for branch 2),
producing an OR_UNION plan or two index scans merged.

### 3.3 Leftover index cleanup

After the new Channel indexes are live and verified, drop the two manually-
created 2-field indexes from production:

```js
db.channels.dropIndex("extraCrawl_1_isInactive_1");
db.channels.dropIndex("organization_1_isInactive_1");
```

These are strict prefixes of the new 4-field indexes, so any query that
previously used them can use the new index instead.

## 4. Deployment runbook

Steps must be executed in order. Step 4 must not begin until step 3 passes.

1. **Deploy code change.** Merging the model changes is enough — mongoose's
   `autoIndex` will create the new indexes on next process start. No
   migration script.
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
3. **Verify planner selection.** Run the explain plans in section 5. Both
   must show the new indexes winning, not `status_1` or the leftover 2-field
   indexes.
4. **Drop leftover indexes.**
   ```js
   db.channels.dropIndex("extraCrawl_1_isInactive_1");
   db.channels.dropIndex("organization_1_isInactive_1");
   ```
5. **Observe slow log.** Wait ≥ 1 hour; reconfirm the pass criteria in
   section 5.3.

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
db.channels.find(Q).explain("queryPlanner");
```

Pass criteria: each `$or` branch in `winningPlan` resolves to the matching
new 4-field index — branch 1 to
`organization_1_isInactive_1_hbIgnore_1_deleted_1`, branch 2 to
`extraCrawl_1_isInactive_1_hbIgnore_1_deleted_1`. Fail if any branch falls
back to COLLSCAN or to the leftover 2-field indexes.

### 5.4 Slow log observation

After ≥ 1 hour of production traffic post-deploy:

- The `cleanEndedStreams` query no longer appears in mongodb slow log, or its
  `durationMillis` is below 100 ms (down from up to 891 ms).
- No new `find honeybee.channels` entries appear in slow log.

### 5.5 No unit tests

This change is exclusively about MongoDB server-side index acceptance and
planner selection. `mongodb-memory-server` and similar in-process MongoDB
substitutes do not guarantee identical `partialFilterExpression` validation
behavior to the production server version (8.0.x). The only meaningful
verification is the production `explain()` and slow-log observation listed
above.

## 6. Risk assessment

- **Risk: planner picks unexpected plan after index changes.** Mitigated by
  step 3 of the runbook (explain before dropping leftover indexes). If
  planner does not select the new Channel indexes, the leftover 2-field
  indexes still cover the lookup until the issue is diagnosed.
- **Risk: silent autoIndex failure recurs in the future.** Accepted. The
  user explicitly excluded a fail-fast mechanism from this scope. Future
  partial index changes must be hand-verified against the operator whitelist
  before merge.
- **Risk: dropping leftover indexes is destructive.** Recovered by re-creating
  them manually if needed; no data loss. The new 4-field indexes are strict
  supersets of the leftover 2-field ones.
