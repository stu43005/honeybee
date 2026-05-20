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

- Modify: `src/models/Channel.ts:18-37`

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

Expected output: lines 15-42, showing both `@index(...)` decorators in
their current broken form. Confirm they match the current state above.

- [ ] **Step 2: Edit `src/models/Channel.ts:18-37`**

Replace the two `@index(...)` decorator blocks at lines 18-37 with these
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

No code change. Confirms the three commits compose cleanly.

- [ ] **Step 1: Full typecheck**

Run:

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 2: Full lint**

Run:

```bash
npx eslint src/
```

Expected: exits 0.

- [ ] **Step 3: Build**

Run:

```bash
npm run build
```

Expected: exits 0; `dist/` is regenerated. (This is the same as `tsc`
plus the `chmod` step in `package.json`.)

- [ ] **Step 4: Confirm commit graph**

Run:

```bash
git log --oneline -5
```

Expected: the top three commits are (in this order, newest first):

```
feat(db): warn when mongoose autoIndex fails for a model
fix(models): drop Channel partial index filter to allowed operators
fix(models): simplify Video partial index filter to allowed operators
```

If the order differs, the tasks were executed out of sequence — not a
correctness issue (the three edits are independent), but the commit
ordering convention prefers leaf-model edits before the infrastructure
edit. Re-order via `git rebase -i` only if explicitly requested.

- [ ] **Step 5: Report deployment runbook**

Print the following message verbatim, so the operator knows the
implementation is complete and the next step is operator-driven:

> Implementation merged. The new indexes will be created by mongoose's
> `autoIndex` on next process start. Execute the deployment runbook in
> `docs/superpowers/specs/2026-05-20-mongo-partial-index-fix-design.md`
> sections 4 and 5 against the production replica to verify the indexes
> are created, the planner selects them, and the leftover 2-field
> Channel indexes can be safely dropped.

Do not attempt to run the runbook from this session — it requires
production replica access and operator judgement on each step's pass/fail.
