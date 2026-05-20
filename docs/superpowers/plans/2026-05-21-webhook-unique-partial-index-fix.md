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

Expected output (verbatim, including the leading blank line at 20 if present):

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

- [ ] **Step 5: Build**

Run: `npm run build`

Expected: tsc compiles `src/` to `dist/` and `chmod +x dist/index.js` succeeds. No errors.

- [ ] **Step 6: Run the model unit tests still pass**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/models/`

Expected: existing `Channel.spec.ts` (the only spec under `src/models/`) passes. No new tests for `Webhook` are added per the design's §5.4 opt-out — this run is a smoke check that the decorator edit did not break Typegoose model registration globally.

If any spec fails, stop and surface the failure.

- [ ] **Step 7: Commit**

Stage only `src/models/Webhook.ts` by explicit path (the project convention forbids `git add -A`):

```bash
git add src/models/Webhook.ts
git commit -m "$(cat <<'EOF'
fix(models): scope Webhook unique index to (track,feature) ObjectId/string pairs

12 legitimate manual webhooks with track:null, feature:null currently
break the autoIndex build of track_1_feature_1. Add a partial filter
on { track: $type objectId, feature: $type string } so the unique
constraint only covers track-derived webhooks (transformTrack upsert
target) and ignores manual webhooks.
EOF
)"
```

Expected: one new commit on the current branch.

---

## Task 2: Whole-tree verification

**Files:** none (verification only).

- [ ] **Step 1: Format check**

Run: `npm run format:check`

Expected: exits 0. If Prettier reports formatting drift on the edited file, run `npm run format` (re-stage if anything changed) and proceed.

- [ ] **Step 2: Lint the whole src/ tree**

Run: `npm run lint`

Expected: exits 0. Catches any cross-file lint regression introduced by the change (none expected).

- [ ] **Step 3: Run the whole Jest suite**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest`

Expected: every existing spec passes. The change does not touch any code path under test, so no behavioral change is expected.

If any spec fails, stop and investigate before proceeding.

- [ ] **Step 4: Build**

Run: `npm run build`

Expected: clean build to `dist/`. Repeats Task 1 Step 5 deliberately — this is the post-format/lint snapshot and is what the deploy pipeline will run.

- [ ] **Step 5: No commit**

This task produces no new commit. If `npm run format` rewrote a file in Step 1, that change should already have been folded into Task 1's commit by amending… but per project convention `git commit --amend` is forbidden; instead stage and commit as a follow-up:

```bash
# Only if Step 1 reformatted a file:
git add src/models/Webhook.ts
git commit -m "style: prettier autoformat after Webhook index edit"
```

Otherwise nothing to commit.

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

After Task 1's commit is merged and the Honeybee services that import the `Webhook` model (any service that boots mongoose models — at minimum the webhook service and the manager service, which run `transformTrack`) have been redeployed so that mongoose's `autoIndex` has run on startup, connect to the production MongoDB primary and run:

```js
db.webhooks.getIndexes();
db.webhooks.find({ track: null, feature: null }).count();
```

Also, in parallel, search the post-deploy logs of every restarted Honeybee service for the substring `autoIndex failed for webhooks`.

### Pass criteria

**Criterion A — index presence and shape.** `db.webhooks.getIndexes()` output must contain an entry equivalent to:

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

Specifically the `unique`, `partialFilterExpression.track.$type`, and `partialFilterExpression.feature.$type` fields must all be present and equal to the values shown. `v` may be `2` or higher depending on server defaults; `background` if present is acceptable. Reject if `partialFilterExpression` is missing or any value within it differs.

**Criterion B — data untouched.** `db.webhooks.find({ track: null, feature: null }).count()` must return the same count as immediately before the deploy. The expected value at the time this plan was written is `12`; if more manual webhooks were added between plan finalization and deploy, the new pre-deploy count takes precedence. Reject if the count decreased — that would mean data was lost.

**Criterion C — no warning at startup.** No service emitted a `[mongoose] autoIndex failed for webhooks` line in its post-deploy startup logs. Reject if any service did — the index build failed for an unanticipated reason.

### Operator returns

The operator pastes:

1. The full output of `db.webhooks.getIndexes()`.
2. The numeric result of `db.webhooks.find({ track: null, feature: null }).count()` and the immediately-pre-deploy count for comparison.
3. The grep result for `autoIndex failed for webhooks` across the post-deploy logs (empty result is the expected pass).

The driver verifies all three pass criteria are literally satisfied before declaring the plan complete.

---

## Plan complete

When all three Task 3 criteria pass, the plan is complete. No follow-up tasks. The 2026-05-20 partial-index plan's remaining operator tasks (Tasks 5–8 in that plan) are independent and may continue in parallel without interaction.
