# Webhook Unique Partial Index Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `$type`-based `partialFilterExpression` to the unique compound index on `Webhook.{track, feature}` so the index builds on the production collection (where 12 legitimate `track:null, feature:null` manual webhooks currently break the build), without any data migration.

**Architecture:** A one-line decorator-options edit at `src/models/Webhook.ts:21`. Mongoose's `autoIndex` rebuilds the index on next process start; the listener from commit `ad7a4f0` surfaces any build failure as `[mongoose] autoIndex failed for webhooks:`. Verification is operator-executed against the production MongoDB replica via `db.webhooks.getIndexes()` (authoritative) plus a deploy-log scan (defense-in-depth) plus a doc-count check (data untouched).

**Tech Stack:** Typegoose decorators, mongoose `autoIndex`, MongoDB 8.0.3 `partialFilterExpression` with `$type` operator, Node 24 / ESM.

---

## File Structure

- Modify: `src/models/Webhook.ts:21` — add `partialFilterExpression` to the existing `@index({ track: 1, feature: 1 }, { unique: true })`.

No other source file changes. No new file, no test file (the spec opts out of unit tests in §5.4 — index shape is a decorator static and the build outcome lives on the live MongoDB server; the existing precedent for partial-index work is `docs/superpowers/specs/2026-05-20-mongo-partial-index-fix-design.md` §5.5).

---

## Task 1: Add partial filter to Webhook unique index

**Files:**

- Modify: `src/models/Webhook.ts:21`

- [ ] **Step 1: Read the current decorator to confirm the exact `old_string`**

Run: `sed -n '20,22p' src/models/Webhook.ts`

Expected output:

```
@index({ updatedAt: 1 })
@index({ track: 1, feature: 1 }, { unique: true })
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- see interface declaration above
```

If the line at 21 does not match `@index({ track: 1, feature: 1 }, { unique: true })` exactly, stop and surface the drift before editing.

- [ ] **Step 2: Apply the decorator edit**

Replace the existing line 21 with:

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

Rationale (do NOT include in the code or in a code comment — it is here for the implementer only): the unique constraint must continue to dedupe track-derived webhooks (where `transformTrackToWebhooks` at `src/components/track-operator.ts:89-110` always sets `track: ObjectId` and `feature: string`) while excluding the 12 production docs with `track: null, feature: null` that are legitimate manual webhooks. `$type` is on the MongoDB `partialFilterExpression` operator whitelist (equality, `$exists: true`, `$gt/$gte/$lt/$lte`, `$type`, `$and`, `$or`, `$in`); `$exists: true` would not work because explicit `null` still satisfies it.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`

Expected: exits 0, no output. The change is purely a decorator-options object literal whose values flow through Typegoose's `IndexOptions` (extends mongodb `CreateIndexesOptions` where `partialFilterExpression?: Document` accepts any object). No new identifier or import.

If type errors appear, stop and surface them.

- [ ] **Step 4: Lint**

Run: `npx eslint src/models/Webhook.ts`

Expected: exits 0, no output. No new lint surface introduced.

If lint warnings or errors appear, stop and surface them.

- [ ] **Step 5: Format the edited file**

Run: `npm run format -- src/models/Webhook.ts`

Expected: Prettier rewrites `src/models/Webhook.ts` if needed and exits 0. Running format BEFORE the commit avoids a follow-up "style" commit polluting history.

Then verify the file is now Prettier-clean:

Run: `npx prettier --check src/models/Webhook.ts`

Expected: exits 0 with output `All matched files use Prettier code style!` or equivalent.

- [ ] **Step 6: Build**

Run: `npm run build`

Expected: tsc compiles `src/` to `dist/` and `chmod +x dist/index.js` succeeds. No errors.

- [ ] **Step 7: Commit via git-master**

Invoke the `git-master` skill to create the atomic commit. The skill must be invoked with:

- Staging path (explicit, no `-A` or `.`): `src/models/Webhook.ts`
- Commit message:

  ```
  fix(models): scope Webhook unique index to (track,feature) ObjectId/string pairs

  12 legitimate manual webhooks with track:null, feature:null currently
  break the autoIndex build of track_1_feature_1. Add a partial filter
  on { track: $type objectId, feature: $type string } so the unique
  constraint only covers track-derived webhooks (transformTrack upsert
  target) and ignores manual webhooks.
  ```

Expected: one new commit on the current branch containing only `src/models/Webhook.ts`.

---

## Task 2: Whole-tree verification

**Files:** none (verification only). No commit produced.

- [ ] **Step 1: Confirm Prettier is clean across the tree**

Run: `npm run format:check`

Expected: exits 0. (Task 1 Step 5 already formatted the edited file; this is the safety-net check that nothing else drifted.)

If Prettier reports drift on files this plan did not touch, stop and surface it — do not auto-format unrelated files within this plan's scope.

- [ ] **Step 2: Lint the whole src/ tree**

Run: `npm run lint`

Expected: exits 0. Catches any cross-file lint regression introduced by the change (none expected).

- [ ] **Step 3: Run the whole Jest suite**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest`

Expected: every existing spec passes. The change does not touch any code path under test, so no behavioral change is expected. This run also covers the implicit "did the decorator edit break Typegoose model registration anywhere" question via the existing model specs.

If any spec fails, stop and investigate before proceeding.

- [ ] **Step 4: Build**

Run: `npm run build`

Expected: clean build to `dist/`. Repeats Task 1 Step 6 deliberately — this is the post-lint snapshot and is what the deploy pipeline will run.

---

## Handoff to manual operator tasks

After Tasks 1–2, the implementing subagent stops touching code.

Print this message verbatim:

> Code change merged. Task 3 is operator-executed against the production
> MongoDB replica. The implementing subagent must pause at this task and
> wait for the operator to paste back the verification output before
> declaring the plan complete.

---

## Task 3: [Manual] Deploy code and verify new partial index

**MANUAL OPERATOR ACTION — PAUSE EXECUTION HERE.**

The implementing subagent must:

1. Present the instructions below to the operator.
2. Stop and wait. Do not proceed beyond this task until the operator pastes back the actual output of the commands and the driver has confirmed the pass criteria below are met.
3. If the operator reports failure, stop the plan and surface the failure — do not attempt remediation from the subagent.

### Operator instructions

Sequence:

**(a) Pre-deploy baseline.** BEFORE redeploying any service, on the production MongoDB primary run:

```js
db.webhooks.countDocuments({ track: null, feature: null });
```

Record the returned integer as `PRE_DEPLOY_NULL_COUNT`. (At plan-finalization time this was `12`; if manual webhooks were added since, the live count takes precedence.)

**(b) Deploy.** Merge Task 1's commit and roll the seven Honeybee services that boot `MongodbModule` / `importAllModels` so that mongoose's `autoIndex` runs on startup. The full set is every command in `src/commands/`:

- `crawler`
- `discord-bot`
- `manager`
- `metrics`
- `scheduler`
- `webhook`
- `worker`

All seven attach the `autoIndex` listener from commit `ad7a4f0` for every model, so all seven are candidates to emit `[mongoose] autoIndex failed for webhooks:` on startup if the build fails.

**(c) Post-deploy verification.** On the production primary, run:

```js
db.webhooks.getIndexes();
db.webhooks.countDocuments({ track: null, feature: null });
db.webhooks.aggregate([{ $indexStats: {} }]).toArray();
```

In parallel, for each of the seven services listed above, grep its post-deploy startup logs for the substring `autoIndex failed for webhooks`.

### Pass criteria

**Criterion A — index presence and shape.** `db.webhooks.getIndexes()` output must contain an entry matching this subset:

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

Specifically the `unique`, `partialFilterExpression.track.$type`, and `partialFilterExpression.feature.$type` fields must all be present and equal to the values shown. `v` may be `2` or higher depending on server defaults. Additional fields (`background`, `ns`, `2dsphereIndexVersion`, etc.) if present are acceptable as long as none of the named fields above differ. Reject if `partialFilterExpression` is missing, any value within it differs, or the index has `hidden: true` set.

Additionally, `db.webhooks.aggregate([{ $indexStats: {} }])` must list `track_1_feature_1` — an entry in `$indexStats` is only published after the build commits, so its presence proves the build completed rather than being in-progress.

**Criterion B — data untouched.** The post-deploy `db.webhooks.countDocuments({ track: null, feature: null })` must equal `PRE_DEPLOY_NULL_COUNT` captured in step (a). Reject if the post-deploy count is lower — that would mean data was lost.

**Criterion C — no warning at startup.** No service emitted a `[mongoose] autoIndex failed for webhooks` line in its post-deploy startup logs. Reject if any of the seven services did — the index build failed for an unanticipated reason.

### Operator returns

The operator pastes:

1. The full output of `db.webhooks.getIndexes()`.
2. The pre-deploy `PRE_DEPLOY_NULL_COUNT` (from step (a)) and the post-deploy `countDocuments` result (from step (c)).
3. The result of `db.webhooks.aggregate([{ $indexStats: {} }]).toArray()` filtered/visually scanned to confirm `track_1_feature_1` is listed.
4. The grep result for `autoIndex failed for webhooks` across the post-deploy logs of all seven services (empty result is the expected pass).

The driver verifies all three pass criteria are literally satisfied before declaring the plan complete.

---

## Plan complete

When all three Task 3 criteria pass, the plan is complete. No follow-up tasks. The 2026-05-20 partial-index plan's remaining operator tasks are independent and may continue in parallel without interaction.
