# Webhook Unique Index — Partial Filter Fix — Design Spec

Date: 2026-05-21
Status: Draft

## 1. Problem

The 2026-05-20 partial-index work added a mongoose `index` event listener
(`attachIndexWarningListeners()` in `src/modules/db.ts`, shipped in commit
`ad7a4f0`) that surfaces previously-swallowed `autoIndex` failures as
`console.warn` lines at process startup. On the 2026-05-21 production deploy the
listener emitted:

```
[mongoose] autoIndex failed for webhooks: Index build failed:
... E11000 duplicate key error
collection: honeybee.webhooks index: track_1_feature_1
dup key: { track: null, feature: null }
```

The failing definition is at `src/models/Webhook.ts:21`:

```ts
@index({ track: 1, feature: 1 }, { unique: true })
```

Production state on 2026-05-21:

- `db.webhooks.find({ track: null, feature: null }).count()` returned 12 —
  these are legitimate manually-inserted webhooks not derived from a
  `Track`. The schema permits this: `track` is declared
  `@prop({ ref: "Track" })` (optional) and `feature` is declared `@prop()`
  (optional) at `src/models/Webhook.ts:103-107`.
- Because the unique index treats all 12 docs as colliding on
  `(null, null)`, the build fails and the `track_1_feature_1` index does not
  exist on the live collection.

The problem pre-dates 2026-05-20; the new listener only made it visible. The
in-process behavior prior to `ad7a4f0` was the swallow pathway documented in
the 2026-05-20 spec §1 — the code assumed the index existed while the DB did
not have it.

The index is consumed by the upsert at `src/components/track-operator.ts:57-81`
which uses `{ track: track._id, feature: webhook.feature }` as the upsert key.
That callsite always sets both fields to concrete values (ObjectId + string)
via `transformTrackToWebhooks` at `src/components/track-operator.ts:89-110`, so
the upsert dedupe semantics only need to hold over docs where both fields are
populated.

## 2. Goals & non-goals

### Goals

1. Make `Webhook.@index({ track: 1, feature: 1 }, { unique: true, ... })` build
   successfully against the existing production collection (12 null/null
   docs in place), without any data migration.
2. Preserve the existing upsert dedupe contract used by
   `transformTrack` — at most one Webhook document per `(track, feature)`
   ObjectId/string pair.
3. Continue to permit multiple Webhook documents with `track: null` and/or
   `feature: null` (the manual-webhook use case).
4. Surface the post-deploy index state through `db.webhooks.getIndexes()`
   to confirm the build succeeded and the partial filter is recorded on
   the live index.

### Non-goals

- Schema migration to make `track` / `feature` `required: true`. The
  manual-webhook use case is intentionally supported.
- Deletion or rewrite of the 12 null/null documents. They are valid.
- Changes to `transformTrack`, `track-operator.ts`, or any other consumer.
  The upsert key remains `{ track: track._id, feature }` and is fully
  covered by the new partial index.
- Unit tests for the index. Index existence and partial-filter shape are
  not unit-testable in this codebase; the post-deploy `getIndexes()` check
  is the authoritative verification, following the 2026-05-20 spec §5.5
  precedent.
- Any change to the 2026-05-20 partial-index work on `Video` / `Channel` or
  to `attachIndexWarningListeners()`. The two efforts are independent.

## 3. Design

### 3.1 The change

`src/models/Webhook.ts:21` becomes:

```ts
@index(
  { track: 1, feature: 1 },
  {
    unique: true,
    partialFilterExpression: {
      track: { $type: "objectId" },
      feature: { $type: "string" },
    },
  }
)
```

Key pattern (`{ track: 1, feature: 1 }`) and uniqueness are unchanged. The
index name is therefore unchanged: `track_1_feature_1`.

### 3.2 Why `$type`, not `$exists: true`

The MongoDB `partialFilterExpression` operator whitelist (per the 2026-05-20
spec §1) admits: equality, `$exists: true`, `$gt/$gte/$lt/$lte`, `$type`,
`$and`, `$or`, `$in`. `$ne` and `$exists: false` are not admitted.

`{ track: { $exists: true } }` is insufficient because MongoDB treats a field
explicitly set to `null` as existing — the 12 production docs were inserted
with `track: null` (verified by the prod count above, which uses
`{ track: null }` and returns 12). Those docs would remain in the index and
collide.

`{ track: { $type: "objectId" } }` matches only documents whose `track` is a
BSON ObjectId, excluding both null and missing. Symmetrically
`{ feature: { $type: "string" } }` for the feature field. This matches
exactly the population that `transformTrack` produces and is the set the
unique constraint is intended to cover.

The BSON type names match the schema: `track` is declared as `Ref<Track>`
(ObjectId at the BSON layer) and `feature` is declared as `string`. The
`transform` functions in `src/data/track.ts` set `webhook.feature` to entries
from `trackFeatures`, which are JS strings.

### 3.3 Production verification of `$type` semantics

Verified on production replica `honeybee-mongodb-0` (MongoDB 8.0.3) on
2026-05-21 with the following sequence:

```js
db.test_webhook_partial.drop();
db.test_webhook_partial.createIndex(
  { track: 1, feature: 1 },
  {
    unique: true,
    partialFilterExpression: {
      track: { $type: "objectId" },
      feature: { $type: "string" },
    },
  }
);
const oid = ObjectId();
db.test_webhook_partial.insertMany([
  { track: oid, feature: "chat" },
  { track: oid, feature: "superchat" },
  { track: null, feature: null },
  { track: null, feature: null },
  {},
]);
db.test_webhook_partial
  .find({
    track: { $type: "objectId" },
    feature: { $type: "string" },
  })
  .hint({ track: 1, feature: 1 })
  .explain("executionStats");
db.test_webhook_partial.insertOne({ track: null, feature: null });
db.test_webhook_partial.drop();
```

Observed outcome:

- `executionStats`: `nReturned: 2`, `totalKeysExamined: 2`. Winning plan
  was `FETCH → IXSCAN(track_1_feature_1, isPartial: true, isUnique: true,
isSparse: false)` with bounds
  `track: [ObjectId('00...'), ObjectId('ff...')]`,
  `feature: ["", {})`.
- The third null/null insert succeeded (no E11000), confirming the unique
  constraint does not fire on documents excluded by the partial filter.
- The fact that `db.webhooks.find({ track: null, feature: null }).count()`
  returns 12 (not 0) on production after years of writes confirms the field
  storage shape matches the `null`-equality semantics the partial filter
  was chosen to ignore.

This establishes that on the production MongoDB version the partial index
covers exactly the (ObjectId, string) population and ignores both the
explicit-null and missing-field populations.

### 3.4 Why no data migration

The 12 null/null documents are valid manual webhooks and must remain. They
do not need to be indexed for any read path: no callsite filters webhooks
by `(track: null, feature: null)`. `findEnabled()` at
`src/models/Webhook.ts:111-116` and the change-stream consumer in
`src/modules/webhook/changestream.ts` iterate all enabled webhooks without
predicates over `track` or `feature`. Excluding the 12 docs from the
partial index has no functional consequence.

The schema fields stay optional. Making them `required: true` would either
reject the 12 existing docs at load time (mongoose validation fires on
`save()`, not on read, so this would only break on update) or force a
write-path migration to backfill placeholder values — both unnecessary
given the partial-index approach yields the same uniqueness guarantee over
the set we care about.

## 4. Rollout

The change is a single Typegoose `@index` decorator edit. mongoose's
`autoIndex` will run `Model.ensureIndexes()` on next process start across
every Honeybee service that imports the `Webhook` model. The first service
to come up creates the new index; subsequent services see it already
present and no-op. The `attachIndexWarningListeners()` helper from
commit `ad7a4f0` will emit a single `[mongoose] autoIndex failed for
webhooks:` warning if the build fails for any reason — this is the same
detection path that surfaced the original problem.

Sequence:

1. Merge the model edit. No migration script.
2. Wait for at least one Honeybee service pod to roll over.
3. Run `db.webhooks.getIndexes()` on production. The expected output for
   the affected index is:

   ```js
   {
     v: 2,
     key: { track: 1, feature: 1 },
     name: "track_1_feature_1",
     unique: true,
     partialFilterExpression: {
       track: { $type: "objectId" },
       feature: { $type: "string" },
     }
   }
   ```

4. Inspect deploy logs for any `[mongoose] autoIndex failed for webhooks`
   line. None is expected.

Steps 3 and 4 are independent — step 3 is the authoritative
post-condition (consistent with 2026-05-20 spec §4 step 2). Step 4 is a
defense-in-depth check that catches the case where `getIndexes()` reports
an old cached index from a prior session.

## 5. Verification

### 5.1 Index presence (authoritative)

`db.webhooks.getIndexes()` must return an entry matching the expected
output in section 4 step 3 exactly. Pass criterion: the `unique`,
`partialFilterExpression.track.$type`, and
`partialFilterExpression.feature.$type` fields are all present and equal
to the values shown. Fail if `partialFilterExpression` is missing or any
field within it differs.

### 5.2 Manual webhook count unchanged

`db.webhooks.find({ track: null, feature: null }).count()` must still
return 12 (or whatever count is observed immediately before the deploy
when the change set is finalized). Pass criterion: the count equals the
pre-deploy count, confirming no data was deleted as a side effect.

### 5.3 No autoIndex warning at startup

Search the post-deploy logs of every Honeybee service for the substring
`autoIndex failed for webhooks`. Pass criterion: no matches. Fail if any
service emitted the warning — the index build failed for an unanticipated
reason and the live index does not exist.

### 5.4 No unit tests

Index shape is a static decorator attribute and the build outcome is a
property of the live MongoDB server, not of any code path that Jest can
exercise. The 2026-05-20 spec §5.5 established the same rationale for the
`Video` / `Channel` partial-index changes.

## 6. Risk assessment

- **Build failure on a non-prod replica with a different docs population.**
  If a staging or test environment has documents with `track` set to a
  non-ObjectId value (e.g. a string) and `feature` set to a string, those
  documents would be included in the partial index and could collide. The
  schema does not allow this via mongoose validation (`track` is a `Ref`
  enforced as ObjectId at write time), so this is only a concern for
  hand-inserted test data. Mitigation: section 5.1 (`getIndexes()`) on the
  target environment after deploy will surface the failure as a missing
  `partialFilterExpression`, and section 5.3 (log search) will surface the
  warning.
- **Future addition of a non-track-derived but
  `(track, feature)`-populated webhook.** If a code path is ever added that
  writes a Webhook with both `track` and `feature` set to non-null values
  outside of `transformTrack`, the unique constraint will fire if its key
  matches an existing track-derived entry. This is the intended behavior:
  one webhook per `(track, feature)` is the dedupe contract.
- **Concurrent build on multi-replica startup.** mongoose's `autoIndex`
  issues `createIndex` per model on each process startup. MongoDB
  serializes index builds on the same key spec across concurrent calls;
  the first wins, the rest no-op. This is the same concurrency profile as
  any other `@index` in the codebase and requires no special handling.

## 7. Independence from 2026-05-20 work

The change touches only `src/models/Webhook.ts`. It does not modify the
`Video` / `Channel` model edits, the leftover-index cleanup, or the
`attachIndexWarningListeners()` helper specified in
`docs/superpowers/specs/2026-05-20-mongo-partial-index-fix-design.md`. The
2026-05-20 work has already shipped `attachIndexWarningListeners()` in
commit `ad7a4f0`, and that helper is what surfaced the problem this spec
addresses; the two designs are causally linked through that helper but the
remaining 2026-05-20 tasks (manual operator steps) can continue in
parallel with this fix without interaction.
