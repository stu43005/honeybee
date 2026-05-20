# MongoDB Partial Index Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three Typegoose `@index(...)` definitions whose
`partialFilterExpression` uses MongoDB-disallowed operators (causing the
indexes to silently not exist in production), and add a console warning so
future autoIndex failures surface in deploy logs.

**Architecture:** Three independent file edits under `src/`. No new modules,
no new dependencies, no runtime tests (the failures are MongoDB
server-side; verification is operator-executed against the production
replica via the deployment runbook in the design doc). After all three
edits, run typecheck and lint to confirm nothing else broke.

**Tech Stack:** TypeScript (ESM, NodeNext), `@typegoose/typegoose`,
`mongoose`. No new dependencies.

---

## File Structure

- **Modify** `src/models/Video.ts` — simplify the broken partial filter on
  the `{hbCleanedAt, actualEnd, hbEnd}` compound index.
- **Modify** `src/models/Channel.ts` — drop the broken
  `partialFilterExpression` from both 4-field compound indexes.
- **Modify** `src/modules/db.ts` — add `attachIndexWarningListeners()`
  helper and invoke it inline after each model import.

No new files. No test files (the failure surface is MongoDB server-side; the
production verification is the deployment runbook in the design doc, not
unit tests).

---

## Task 1: Simplify Video partial filter

**Files:**

- Modify: `src/models/Video.ts:91-99`

Current state of those lines (the partial filter uses `$nin` twice, which is
not in MongoDB's `partialFilterExpression` operator whitelist; the server
rejects the spec and the index is never created):

```ts
@index(
  { hbCleanedAt: 1, actualEnd: 1, hbEnd: 1 },
  {
    partialFilterExpression: {
      hbCleanedAt: null,
      hbStatus: { $nin: [HoneybeeStatus.Created] },
      status: { $nin: LiveStatus },
    },
  }
)
```

The fix keeps the index key shape but reduces the partial filter to a single
equality (`hbCleanedAt: null`), which is allowed and matches both
explicit-`null` and missing-field Video documents (the `$setOnInsert` path
at `Video.ts:373-378` creates documents without `hbCleanedAt`, so the
missing-field case must remain indexed). The query in
`src/components/cleanup.ts:61-89` already includes `hbCleanedAt: null` as a
top-level predicate, so the planner will be eligible to choose this index;
the previously-in-filter `hbStatus`/`status` constraints fall back to
FETCH-stage filtering, which is cheap because the uncleaned-Video set is
small.

- [ ] **Step 1: Read the surrounding context**

Run:

```bash
sed -n '60,105p' src/models/Video.ts
```

Expected output: lines 60-105 of `Video.ts`, including the four `@index(...)`
decorators. Confirm that lines 91-99 match the current state shown above.
If they do not, stop and re-read the design doc — the file has drifted.

- [ ] **Step 2: Edit `src/models/Video.ts:91-99`**

Replace the `@index(...)` block at lines 91-99 with:

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

Do not touch the three other `@index` decorators at lines 65-87 or the
non-partial `@index({ updatedAt: 1 })` and `@index({ channelId: 1, availableAt: -1 })`.

- [ ] **Step 3: Typecheck**

Run:

```bash
npx tsc --noEmit
```

Expected: exits 0 with no output. If errors mention `Video.ts`, re-read
the file and confirm the edit; if they mention unrelated files, the
working tree was already broken before this task.

- [ ] **Step 4: Lint the changed file**

Run:

```bash
npx eslint src/models/Video.ts
```

Expected: exits 0 with no output.

- [ ] **Step 5: Commit**

Use the `git-master` skill to create a single commit containing only
`src/models/Video.ts`. The commit message (Semantic + English, matching
recent project history) must be:

```
fix(models): simplify Video partial index filter to allowed operators
```

Do not stage other files (the working tree should be clean apart from this
edit; if there are other changes from prior tasks, this task should run
before them per the listed task order).

---

## Task 2: Drop Channel partial filter

**Files:**

- Modify: `src/models/Channel.ts:18-38`

Current state of those lines (both partial filters use `$ne` three times,
which is not in MongoDB's `partialFilterExpression` operator whitelist; the
server rejects the spec and neither index exists in production):

```ts
@index(
  { organization: 1, isInactive: 1, hbIgnore: 1, deleted: 1 },
  {
    partialFilterExpression: {
      isInactive: { $ne: true },
      hbIgnore: { $ne: true },
      deleted: { $ne: true },
    },
  }
)
@index(
  { extraCrawl: 1, isInactive: 1, hbIgnore: 1, deleted: 1 },
  {
    partialFilterExpression: {
      extraCrawl: true,
      isInactive: { $ne: true },
      hbIgnore: { $ne: true },
      deleted: { $ne: true },
    },
  }
)
```

The fix drops `partialFilterExpression` entirely from both indexes, making
them plain compound indexes. The `channels` collection is small enough
that indexing inactive/ignored/deleted documents costs nothing meaningful;
rewriting the partial filter would require either `$in: [null, false]`
(brittle) or a schema migration (out of scope). The `SubscribedQuery`
consumer at `src/models/Channel.ts:165-185` is unchanged.

- [ ] **Step 1: Read the surrounding context**

Run:

```bash
sed -n '15,42p' src/models/Channel.ts
```

Expected output: lines 15-42. Confirm:

- Block 1 opens with `@index(` on line 18 and closes with `)` on line 27.
- Block 2 opens with `@index(` on line 28 and closes with `)` on line 38.
- Line 39 is `@index({ updatedAt: 1 })` — out of edit scope.

If the closing `)` of block 2 is not on line 38, the file has drifted and
the line range in the next step is wrong; stop and re-derive the range
before editing.

- [ ] **Step 2: Edit `src/models/Channel.ts:18-38`**

Replace the two `@index(...)` decorator blocks at lines 18-38 with these
two single-line decorators (keep the trailing `@index({ updatedAt: 1 })` at
line 39 untouched):

```ts
@index({ organization: 1, isInactive: 1, hbIgnore: 1, deleted: 1 })
@index({ extraCrawl: 1, isInactive: 1, hbIgnore: 1, deleted: 1 })
```

- [ ] **Step 3: Typecheck**

Run:

```bash
npx tsc --noEmit
```

Expected: exits 0 with no output.

- [ ] **Step 4: Lint the changed file**

Run:

```bash
npx eslint src/models/Channel.ts
```

Expected: exits 0 with no output.

- [ ] **Step 5: Commit**

Use the `git-master` skill to create a single commit containing only
`src/models/Channel.ts`. Commit message:

```
fix(models): drop Channel partial index filter to allowed operators
```

---

## Task 3: Add autoIndex warning listener

**Files:**

- Modify: `src/modules/db.ts:69-82` (the `importAllModels` function)

The current `importAllModels()` dynamically imports every `.js` file under
`src/models/` so Typegoose registers each model. Nothing currently
subscribes to mongoose's `Model.on('index', err)` event, so an `autoIndex`
failure (e.g. an invalid `partialFilterExpression`) is swallowed and the
process keeps running. The fix adds a small helper that walks
`mongoose.models` and attaches a one-time warning listener to each model,
and calls the helper inline after each `await import(...)` so the listener
is in place before mongoose's async `ensureIndexes()` could possibly fire.

- [ ] **Step 1: Read the current `importAllModels`**

Run:

```bash
sed -n '1,12p' src/modules/db.ts && echo '---' && sed -n '69,95p' src/modules/db.ts
```

Expected output:

- Lines 1-12: imports including
  `import { mongoose, type ReturnModelType } from "@typegoose/typegoose";`
- Lines 69-82: the `importAllModels` function with a `for (const file of ...)`
  loop containing `await import(importPath);`.

Confirm `mongoose` is already in scope at the top of the file. If not,
stop and re-check — the helper depends on it.

- [ ] **Step 2: Edit `src/modules/db.ts` — replace `importAllModels` and add the helper**

Locate `importAllModels` (currently at lines 69-82) and replace it with the
two functions below. Insert `attachIndexWarningListeners` immediately above
`importAllModels`:

```ts
function attachIndexWarningListeners(): void {
  for (const model of Object.values(mongoose.models)) {
    const flagged = model as unknown as {
      __hbIndexListenerAttached?: boolean;
    };
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

export async function importAllModels(): Promise<void> {
  const modelsDir = path.join(__dirname(import.meta), "../models");
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
}
```

Do not touch `MongodbModule`, `documentLog`, `changeStreamCloseSignal`,
`getModelByCollectionName`, or the exports.

- [ ] **Step 3: Typecheck**

Run:

```bash
npx tsc --noEmit
```

Expected: exits 0 with no output. If TypeScript complains about
`Model.on("index", ...)` arity or the callback signature, double-check
that the cast pattern matches the existing project style (the existing
code uses `as unknown as { ... }` patterns elsewhere — keep the cast
inside the helper, do not push it to callsites).

- [ ] **Step 4: Lint the changed file**

Run:

```bash
npx eslint src/modules/db.ts
```

Expected: exits 0 with no output.

- [ ] **Step 5: Commit**

Use the `git-master` skill to create a single commit containing only
`src/modules/db.ts`. Commit message:

```
feat(db): warn when mongoose autoIndex fails for a model
```

---

## Task 4: Whole-tree verification

No code change. Confirms the three commits from the earlier tasks compose
cleanly.

- [ ] **Step 1: Confirm working tree is clean before verifying**

Run:

```bash
git status --short
```

Expected: empty output. Any modified or untracked files at this point are
out of scope for this plan; their lint/tsc errors would spuriously fail
the next steps. If there is unrelated drift, stash it
(`git stash push -m "out-of-scope drift"`) and unstash after Task 4
completes.

- [ ] **Step 2: Full typecheck**

Run:

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Full lint**

Run:

```bash
npx eslint src/
```

Expected: exits 0.

- [ ] **Step 4: Build**

Run:

```bash
npm run build && ls -l dist/index.js
```

Expected: exits 0; the second command prints a line whose mode column
starts with `-rwxr-xr-x` (the `chmod 755` step in the build script ran
successfully). The chmod target is the load-bearing post-condition of
`npm run build`; without confirming the file exists and is executable
the build is not provably complete.

- [ ] **Step 5: Confirm all three commits are present**

Run:

```bash
git log --oneline -5
```

Expected: among the most recent commits there are exactly three whose
subjects exactly match those introduced by the earlier tasks (the Video
model partial-filter simplification, the Channel model partial-filter
drop, and the db.ts autoIndex warning helper). Commit order does not
matter — the three edits are independent, and under subagent-driven
execution they may have been authored in any order.

If any of the three is missing, the corresponding task did not produce a
commit; re-run that task before proceeding.

- [ ] **Step 6: Announce ready for production verification**

Print this message verbatim:

> Code changes merged. Tasks 5–8 are operator-executed against the
> production MongoDB replica. The implementing subagent must pause at
> each of those tasks and wait for the operator to paste back the
> verification output before continuing.

---

## Task 5: [Manual] Deploy code and verify new indexes exist

**MANUAL OPERATOR ACTION — PAUSE EXECUTION HERE.**

The implementing subagent must:

1. Present the instructions below to the operator.
2. Stop and wait. Do not proceed to any subsequent task until the
   operator pastes back the actual output of the commands and the
   driver has confirmed the pass criteria below are met.
3. If the operator reports failure, stop the whole plan and surface the
   failure — do not attempt remediation from the subagent.

### Operator instructions

After the three code commits from Tasks 1–3 are merged and the relevant
honeybee services (worker, manager, discord-bot, crawler, scheduler)
have been redeployed so that mongoose's `autoIndex` has run on
startup, connect to the production MongoDB primary and run:

```js
db.videos.getIndexes();
db.channels.getIndexes();
```

### Pass criteria

`db.videos.getIndexes()` output must contain an index named
`hbCleanedAt_1_actualEnd_1_hbEnd_1` with
`partialFilterExpression: { hbCleanedAt: null }`.

`db.channels.getIndexes()` output must contain both of these (each
without any `partialFilterExpression`):

- `organization_1_isInactive_1_hbIgnore_1_deleted_1`
- `extraCrawl_1_isInactive_1_hbIgnore_1_deleted_1`

### What to look for in the deploy logs

If a `[mongoose] autoIndex failed for <collection>: <message>` line
appears in service startup logs, the operator should report it — that
means the helper from Task 3 caught a fresh autoIndex failure, and the
new indexes were not created. Stop the plan.

### Operator returns

The operator pastes the full output of both `getIndexes()` calls and
the relevant deploy log lines. The driver verifies the pass criteria
are literally satisfied before unblocking Task 6.

---

## Task 6: [Manual] Verify planner selects the new indexes

**MANUAL OPERATOR ACTION — PAUSE EXECUTION HERE.**

Precondition: Task 5 passed.

### Operator instructions

On the production primary, run the two explain commands defined in the
design doc section 5.2 (Video cleanup query) and section 5.3 (Channel
SubscribedQuery). The full command bodies are in the design doc; do
not paraphrase or modify the predicates.

### Pass criteria (Video — section 5.2)

`winningPlan` reaches `hbCleanedAt_1_actualEnd_1_hbEnd_1` via IXSCAN
(optionally wrapped in FETCH / OR stages). Reject if `status_1` is
the chosen index, or if any `COLLSCAN` appears in `winningPlan`.

### Pass criteria (Channel — section 5.3)

All of:

- `winningPlan` matches one of:
  - `SUBPLAN → OR → [ IXSCAN(branch-1-index), IXSCAN(branch-2-index) ]`
  - `OR → [ IXSCAN(branch-1-index), IXSCAN(branch-2-index) ]`

  (FETCH wrappers optional at each level.) Branch 1 index is
  `organization_1_isInactive_1_hbIgnore_1_deleted_1`, branch 2 is
  `extraCrawl_1_isInactive_1_hbIgnore_1_deleted_1`. Reject if any
  IXSCAN names `extraCrawl_1_isInactive_1`, `organization_1_isInactive_1`,
  or `_id_`, or if `COLLSCAN` appears anywhere.

- The collection size captured beforehand as
  `N = db.channels.countDocuments()`, and
  `executionStats.totalKeysExamined ≤ 2 * N`.

- `executionStats.totalDocsExamined ≤ executionStats.totalKeysExamined`.

### Operator returns

The operator pastes both explain outputs. The driver verifies every
criterion literally before unblocking Task 7.

If either pass criterion fails, the plan stops. Do **not** proceed to
Task 7 (drop) — without confirmed planner selection of the new indexes,
dropping the leftover 2-field indexes would degrade `findSubscribed`
to COLLSCAN.

---

## Task 7: [Manual] Drop the two leftover Channel indexes

**MANUAL OPERATOR ACTION — PAUSE EXECUTION HERE.**

**DESTRUCTIVE** — drops indexes from the production `channels`
collection. Precondition: Tasks 5 and 6 both passed.

### Operator instructions

On the production primary, run:

```js
db.channels.dropIndex("extraCrawl_1_isInactive_1");
db.channels.dropIndex("organization_1_isInactive_1");
```

### Pass criteria

Both commands return `{ "nIndexesWas": <prev-count>, "ok": 1 }`. Re-run
`db.channels.getIndexes()` and confirm neither index name appears
anymore.

### Recovery if regression appears later

If a planner regression appears days later that requires bringing the
leftover indexes back, the exact `createIndex` commands to reproduce
them are listed in the design doc section 3.3 ("Recovery"). They are
plain 2-field indexes with only `background: true` set.

### Operator returns

The operator pastes both `dropIndex` results and the post-drop
`getIndexes()` output. The driver confirms both leftover index names
are gone before unblocking Task 8.

---

## Task 8: [Manual] Observe slow log for at least 1 hour

**MANUAL OPERATOR ACTION — PAUSE EXECUTION HERE.**

Precondition: Task 7 passed.

### Operator instructions

Wait at least 1 hour of normal production traffic (so that the
5-minute `cleanEndedStreams` Agenda job and the discord-bot's
`findSubscribed` calls have run multiple times against the new
indexes). Then pull recent MongoDB slow log entries — for example, by
re-running the same Grafana / Loki query that originally surfaced this
bug (or by hand: tail mongod log filtered on
`"msg":"Slow query"`).

### Pass criteria

- Entries with `ns: "honeybee.videos"` and a `cleanEndedStreams`-shaped
  filter (the `hbCleanedAt: null` query) either no longer appear, or
  have `durationMillis < 100` (down from the pre-fix maximum of
  891 ms).
- No new slow-log entries appear with `ns: "honeybee.channels"` for
  `findSubscribed`-shaped queries.

### Operator returns

A short summary noting either "no matching slow entries" or the new
`durationMillis` range for the `cleanEndedStreams` query. Once the
operator confirms pass, the plan is complete.
