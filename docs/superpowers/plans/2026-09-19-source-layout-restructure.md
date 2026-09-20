# Source Layout Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `src/` so that every file's directory states whether it belongs to one service, is shared across services, or is a data contract, and make the resulting boundaries machine-enforced.

**Architecture:** Three tiers — `src/services/<service>/` for code reachable from exactly one entrypoint, `src/modules/` for code reachable from two or more, and `src/models/` + `src/constants.ts` + `src/interfaces.ts` + `src/utils/` as always-shared. Cross-tier imports are written as Node.js subpath-import aliases (`#models/...`, `#modules/...`, `#utils/...`); `src/services/` deliberately has no alias, so a cross-service import can only be spelled as a relative path, which an ESLint rule then rejects. The directories `commands/`, `components/`, `data/` and `discord/` disappear.

**Tech Stack:** TypeScript 6.0.2 (NodeNext, ESM-only), Node ≥ 24, Jest 29.7.0 + ts-jest 29.4.9 (true ESM), ESLint 9.39.4 flat config, Typegoose/Mongoose, Bee-Queue, Agenda.

---

## Deviation from the design document

The design document's step 4 reads "introduce the imports field and rewrite existing imports to aliases" as a single step. There are 281 relative import lines to convert, and the majority of them live in files that steps 5 and 6 are about to move anyway. Rewriting them twice is wasted work and doubles the review surface.

This plan therefore splits that step:

- **Task 6** introduces the `"imports"` field, the Jest mapper, and rewrites only the files that stay in a shared tier — `src/models/**`, `src/modules/**`, `src/utils/**`, `src/constants.ts`. That is enough to prove the alias mechanism works under tsc, ESLint, Jest and Node.
- **Tasks 7–13** rewrite each moved file's imports as part of the move that touches it.

**Second deviation: `src/data/track.ts` and `src/data/webhook.ts` move in Task 6, not in the dissolution step.**

The design document dissolves `src/data/` after the services move. Doing it in that order breaks intermediate commits. Three files that Tasks 10, 11 and 13 relocate import those two modules by relative path; once the importer moves a directory deeper, `../data/...` and `../../../data/...` resolve inside `src/services/`, where nothing exists. The alternative — writing temporary deeper paths into three files and rewriting them a task later — leaves specifiers in the tree that are wrong by construction and correct only by accident of depth.

Moving the two shared modules first removes the problem rather than working around it. `src/data/currency.ts` is unaffected: worker is its only consumer, so it travels with worker in Task 12, which is what finally removes the directory.

Everything else follows the design document's ordering. No other deviation is intended; if a reviewer finds one, treat it as a plan defect.

## Accepted limitation: import rewrites are specified as tables, not code blocks

Steps that rewrite import specifiers give an exhaustive old → new table rather than the resulting import block. This is deliberate and was decided explicitly after review raised it twice.

Every such table is generated from the files themselves, then checked against them. The alternative — transcribing each file's resulting import block by hand, including binding lists such as the worker entrypoint's eighteen model imports — is the same manual step that produced this plan's first round of defects, and it would add roughly a thousand lines that carry no information the table does not already carry. A specifier rewrite is fully described by the pair of strings and the instruction that bindings are unchanged.

Three things make the tables safe to work from:

- They are exhaustive per file, not illustrative.
- Each service task ends with a grep that must return empty, proving no cross-tier specifier was left relative.
- `npm run build` catches every wrong path in production code, and the per-service test run catches every wrong `jest.unstable_mockModule` key, which the build cannot see.

Reviewers should not re-raise this. If a table turns out to be wrong or incomplete, that is a defect in the table and must be fixed; the format itself is settled.

## Constraints that must survive every task

These were established empirically. Violating any of them produces a failure that `npm run build`, `npm run lint` and `npm test` all pass through silently.

1. **`src/models/` stays one flat directory, and `src/modules/db.ts` stays at exactly that path.** `importAllModels()` runs `fsp.readdir` on `path.join(__dirname(import.meta), "../models")` resolved against the _emitted_ `dist/` layout, with no recursion and an `isFile()` filter. A model placed in a subdirectory is skipped without an error and only fails when the webhook service dispatches an event for that collection.
2. **The runtime smoke check (Task 5) is the only thing that proves alias resolution works at runtime.** tsc uses a `dist`→`src` fallback and Jest uses its own `moduleNameMapper`; neither goes through Node's imports map.
3. **`node dist/index.js --help` proves nothing.** `src/index.ts` lazy-imports each service inside its yargs command handler, so `--help` returns before any service module loads.
4. **The boundary lint rules (Task 14) must land after all moves.** Their `files:` globs point at `src/services/<X>/**`; before those directories exist the rules match nothing, and a passing lint run is meaningless.
5. **The `models/` ↔ `modules/` import cycle is expected to remain.** Do not try to remove it. Any placement that keeps a model static calling its transform closes a loop, because the transform writes `WebhookModel` and `models/Webhook.ts` already imports `./Track.js`.

## Commit discipline

Every task ends in a commit made through the **git-master** skill, staged by explicit file path. Never `git add -A` or `git add .`. Repo convention: semantic prefix, English, lowercase subject, prose body, and the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

Do not create or use a git worktree. Work in the current working directory.

## Standard verification

Unless a task says otherwise, "run the standard checks" means all three of these must pass:

```bash
npm run build
npm run lint
npm test
```

---

## File Structure

### Files deleted outright

| Path                            | Reason                                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| `src/modules/action-counter.ts` | Dead code — zero references anywhere, superseded by `video-scaler` |

### Files that change responsibility

| Path                                          | New responsibility                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/modules/track/features.ts`               | Track feature table and its query builders (was `src/data/track.ts`)                                                     |
| `src/modules/track/transform.ts`              | Projecting a Track into Webhook rows, single and batch (was part of `src/components/track-operator.ts`)                  |
| `src/modules/youtube-dm/transform.ts`         | Projecting a YoutubeDmBinding into a Webhook row, single and batch (was part of `src/components/youtube-dm-operator.ts`) |
| `src/modules/webhook-template.ts`             | Discord webhook URL helpers and payload templates (was `src/data/webhook.ts`)                                            |
| `src/utils/common.ts`                         | General helpers (was `src/util.ts`)                                                                                      |
| `src/services/manager/track-operator.ts`      | Agenda registration only                                                                                                 |
| `src/services/manager/youtube-dm-operator.ts` | Agenda registration only                                                                                                 |

### Final tree

```text
src/
├── index.ts
├── constants.ts
├── interfaces.ts
├── utils/{common,esm}.ts
├── models/                     (unchanged, flat)
├── modules/
│   ├── application.ts  module.ts  http-server.ts
│   ├── db.ts  redis.ts  queue.ts  schedule.ts
│   ├── cache.ts  collection-watcher.ts  youtube.ts
│   ├── webhook-template.ts
│   ├── track/{features,transform}.ts
│   └── youtube-dm/transform.ts
├── services/
│   ├── metrics/index.ts
│   ├── scheduler/index.ts
│   ├── crawler/{index,holodex,atom}.ts + discovery/ + pubsub/
│   ├── discord-bot/index.ts + commands/ + oauth/
│   ├── webhook/{index,changestream,claim,partition,queue,simplify-match,matching}.ts
│   ├── worker/{index,gift,youtube-watch-gate}.ts + currency/
│   └── manager/{index,cleanup,gift-price,video-scaler,video-stats,webhook-prepare,track-operator,youtube-dm-operator}.ts + chats-archive/
└── scripts/inspect-simplified-match.ts
```

---

## Task 1: Remove the dead action counter

**Files:**

- Delete: `src/modules/action-counter.ts`

- [ ] **Step 1: Confirm nothing references it**

```bash
grep -rn "action-counter\|ActionCounter" --include='*.ts' --include='*.json' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .
```

Expected: exactly one line — `src/modules/action-counter.ts:3`, the class declaration inside the file itself. If any other line appears, stop and report: the file has a live consumer and this task must not proceed.

The search is restricted to source and config files on purpose. A repository-wide grep also matches the design and planning documents, which discuss this deletion by name, and those matches say nothing about whether code depends on it.

- [ ] **Step 2: Delete the file**

```bash
git rm src/modules/action-counter.ts
```

- [ ] **Step 3: Run the standard checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass. Nothing imported this file, so nothing should change.

- [ ] **Step 4: Commit via git-master**

Stage `src/modules/action-counter.ts` only. Suggested subject: `refactor(modules): drop the unused action counter`.

---

## Task 2: Move the track transform into its own module

The transform is called from `models/Track.ts` and so is reachable from three services; the Agenda registration is manager-only. Split them. Behavior must be identical — this is a move, not a rewrite.

**Files:**

- Create: `src/modules/track/transform.ts`
- Modify: `src/components/track-operator.ts`
- Modify: `src/models/Track.ts:11`

- [ ] **Step 1: Create the new module with the transform logic**

Create `src/modules/track/transform.ts`:

```ts
import type { DocumentType } from "@typegoose/typegoose";
import { DefaultRestOptions, Routes } from "discord.js";
import type { FlattenMaps } from "mongoose";
import { configredWebhookFields, trackFeatures } from "../../data/track.js";
import TrackModel, { type Track } from "../../models/Track.js";
import WebhookModel, { type Webhook } from "../../models/Webhook.js";

export async function transformTracks() {
  for await (const track of TrackModel.find()) {
    await transformTrack(track);
  }
  for await (const webhook of WebhookModel.aggregate([
    {
      $match: {
        track: { $ne: null },
      },
    },
    {
      $lookup: {
        from: "tracks",
        localField: "track",
        foreignField: "_id",
        as: "trackDoc",
      },
    },
    {
      $match: {
        trackDoc: { $size: 0 },
      },
    },
  ])) {
    if (!webhook.track) continue;
    const track = await TrackModel.findById(webhook.track);
    if (!track) {
      await WebhookModel.deleteOne({ _id: webhook._id });
    }
  }
}

export async function transformTrack(
  track: DocumentType<Track>
): Promise<void> {
  const enabledFeatures: string[] = [];
  for (const webhook of transformTrackToWebhooks(track)) {
    enabledFeatures.push(webhook.feature!);
    await WebhookModel.updateOne(
      {
        track: track._id,
        feature: webhook.feature,
      },
      {
        $unset: {
          ...Object.fromEntries(
            configredWebhookFields
              .filter(
                (field) => !(field in webhook) || webhook[field] === undefined
              )
              .map((field) => [field, ""])
          ),
          updateUrl: "",
          insertMethod: "",
          updateMethod: "",
        },
        $set: webhook,
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );
  }
  await WebhookModel.deleteMany({
    track: track._id,
    feature: { $nin: enabledFeatures },
  });
}

function* transformTrackToWebhooks(track: DocumentType<Track>) {
  const insertUrl = new URL(
    DefaultRestOptions.api + Routes.webhook(track.clientId, track.token)
  );
  insertUrl.searchParams.set("wait", "true");
  if (track.threadId) {
    insertUrl.searchParams.set("thread_id", track.threadId);
  }

  for (const feature of track.enabledFeatures) {
    const webhook = trackFeatures[feature]?.transform?.(track) as
      | FlattenMaps<Webhook>
      | null
      | undefined;
    if (webhook) {
      webhook.track = track._id;
      webhook.feature = feature;
      webhook.insertUrl = insertUrl.toString();
      yield webhook;
    }
  }
}
```

`transformTracks` was not exported before; it is now, because the Agenda shell lives in a different file.

- [ ] **Step 2: Reduce the operator to its Agenda registration**

Replace the entire contents of `src/components/track-operator.ts` with:

```ts
import assert from "node:assert";
import type { Application } from "../modules/application.js";
import type { AgendaModule } from "../modules/schedule.js";
import { transformTracks } from "../modules/track/transform.js";

export default function trackOperator(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  agenda.define("transform tracks", transformTracks);
  void agenda.every("1 hour", "transform tracks");
}
```

- [ ] **Step 3: Point the model at the new location**

In `src/models/Track.ts`, change line 11 from:

```ts
import { transformTrack } from "../components/track-operator.js";
```

to:

```ts
import { transformTrack } from "../modules/track/transform.js";
```

Leave every `await transformTrack(track);` call site untouched.

- [ ] **Step 4: Verify no other importer was missed**

```bash
grep -rn "track-operator" --include='*.ts' src
```

Expected: only `src/commands/manager.ts` (which imports the default export) and the file itself. If `transformTrack` still appears in that grep's output outside `modules/track/`, a call site was missed.

- [ ] **Step 5: Run the standard checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass. There is no test for `transformTrack`, so this is a compile-and-regression check only.

- [ ] **Step 6: Commit via git-master**

Stage `src/modules/track/transform.ts`, `src/components/track-operator.ts`, `src/models/Track.ts`. Suggested subject: `refactor(track): separate the webhook projection from its schedule`.

---

## Task 3: Move the youtube-dm transform into its own module

Same split as Task 2, applied symmetrically. The existing test file covers only the transform functions, so it moves with them.

**Files:**

- Create: `src/modules/youtube-dm/transform.ts`
- Move: `src/components/youtube-dm-operator.spec.ts` → `src/modules/youtube-dm/transform.spec.ts`
- Modify: `src/components/youtube-dm-operator.ts`
- Modify: `src/models/YoutubeDmBinding.ts:9`

- [ ] **Step 1: Create the new module with the transform logic**

Create `src/modules/youtube-dm/transform.ts`:

```ts
import type { DocumentType } from "@typegoose/typegoose";
import { getChannelIdFilter } from "../../data/track.js";
import WebhookModel from "../../models/Webhook.js";
import YoutubeDmBindingModel, {
  type YoutubeDmBinding,
} from "../../models/YoutubeDmBinding.js";

const DM_COLLS = [
  "superchats",
  "superstickers",
  "gifts",
  "memberships",
  "milestones",
  "membershipgiftpurchases",
  "membershipgifts",
];

// Re-reads the latest binding by _id so concurrent / out-of-order bind+unbind
// transforms converge on the current channelIds instead of an older snapshot.
export async function transformYoutubeDmBinding(
  binding: Pick<DocumentType<YoutubeDmBinding>, "_id">
): Promise<void> {
  const fresh = await YoutubeDmBindingModel.findById(binding._id);
  if (!fresh || fresh.channelIds.length === 0) {
    await WebhookModel.deleteMany({ youtubeDmBinding: binding._id });
    return;
  }
  const webhook = {
    colls: DM_COLLS,
    match: { authorChannelId: getChannelIdFilter(fresh.channelIds) },
    templatePreset: "discord-embed-chats",
    insertUrl: `discord-dm://${fresh.discordUserId}`,
    youtubeDmBinding: fresh._id,
    enabled: true,
  };
  await WebhookModel.updateOne(
    { youtubeDmBinding: fresh._id },
    { $set: webhook },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

// Exported so the orphan-cleanup discriminator can be unit-tested directly.
export async function transformYoutubeDmBindings(): Promise<void> {
  for await (const binding of YoutubeDmBindingModel.find()) {
    await transformYoutubeDmBinding(binding);
  }
  // Orphan cleanup: DM webhooks whose binding doc was deleted.
  // MUST use { $type: "objectId" } (same discriminator as the partial index) —
  // { $ne: null } would also match track/generic webhooks lacking the field and
  // delete them.
  for await (const webhook of WebhookModel.aggregate([
    { $match: { youtubeDmBinding: { $type: "objectId" } } },
    {
      $lookup: {
        from: "youtubeDmBindings",
        localField: "youtubeDmBinding",
        foreignField: "_id",
        as: "bindingDoc",
      },
    },
    { $match: { bindingDoc: { $size: 0 } } },
  ])) {
    await WebhookModel.deleteOne({ _id: webhook._id });
  }
}
```

- [ ] **Step 2: Move the test alongside it**

```bash
git mv src/components/youtube-dm-operator.spec.ts src/modules/youtube-dm/transform.spec.ts
```

Then fix its three import paths. In `src/modules/youtube-dm/transform.spec.ts`, replace:

```ts
import WebhookModel from "../models/Webhook.js";
import YoutubeDmBindingModel from "../models/YoutubeDmBinding.js";
import {
  transformYoutubeDmBinding,
  transformYoutubeDmBindings,
} from "./youtube-dm-operator.js";
```

with:

```ts
import WebhookModel from "../../models/Webhook.js";
import YoutubeDmBindingModel from "../../models/YoutubeDmBinding.js";
import {
  transformYoutubeDmBinding,
  transformYoutubeDmBindings,
} from "./transform.js";
```

Leave every `describe`/`it` string and every assertion unchanged — the behavior under test has not changed.

- [ ] **Step 3: Run the moved test and watch it pass**

```bash
npm run test -- src/modules/youtube-dm/transform.spec.ts
```

Expected: PASS, same number of tests as before the move. If it fails on module resolution, the import paths in Step 2 are wrong. If it fails on an assertion, the transform body was altered — revert and copy it verbatim.

- [ ] **Step 4: Reduce the operator to its Agenda registration**

Replace the entire contents of `src/components/youtube-dm-operator.ts` with:

```ts
import assert from "node:assert";
import type { Application } from "../modules/application.js";
import type { AgendaModule } from "../modules/schedule.js";
import { transformYoutubeDmBindings } from "../modules/youtube-dm/transform.js";

export default function youtubeDmOperator(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  agenda.define("transform youtube dm bindings", transformYoutubeDmBindings);
  void agenda.every("1 hour", "transform youtube dm bindings");
}
```

- [ ] **Step 5: Point the model at the new location**

In `src/models/YoutubeDmBinding.ts`, change line 9 from:

```ts
import { transformYoutubeDmBinding } from "../components/youtube-dm-operator.js";
```

to:

```ts
import { transformYoutubeDmBinding } from "../modules/youtube-dm/transform.js";
```

- [ ] **Step 6: Run the standard checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass, including `src/models/YoutubeDmBinding.spec.ts`, which exercises the binding statics that call this transform.

- [ ] **Step 7: Commit via git-master**

Stage `src/modules/youtube-dm/transform.ts`, `src/modules/youtube-dm/transform.spec.ts`, `src/components/youtube-dm-operator.spec.ts` (the deletion), `src/components/youtube-dm-operator.ts`, `src/models/YoutubeDmBinding.ts`. Suggested subject: `refactor(youtube-dm): separate the webhook projection from its schedule`.

---

## Task 4: Merge the root util into the utils directory

`src/util.ts` and `src/utils/esm.ts` are two homes for the same kind of helper. Collapse them. The name is `common.ts`, not `index.ts`, so the alias reads `#utils/common.js` rather than `#utils/index.js` and nobody is tempted to treat it as a barrel file.

**Files:**

- Create: `src/utils/common.ts`
- Delete: `src/util.ts`
- Modify: 11 importers listed in Step 2

- [ ] **Step 1: Move the file**

```bash
git mv src/util.ts src/utils/common.ts
```

The file has no imports of its own, so its contents need no edit.

- [ ] **Step 2: Repoint every importer**

The importers and their new specifiers:

| File                                            | Old             | New                     |
| ----------------------------------------------- | --------------- | ----------------------- |
| `src/constants.ts`                              | `./util.js`     | `./utils/common.js`     |
| `src/commands/metrics.ts`                       | `../util.js`    | `../utils/common.js`    |
| `src/commands/webhook.ts`                       | `../util.js`    | `../utils/common.js`    |
| `src/commands/worker.ts`                        | `../util.js`    | `../utils/common.js`    |
| `src/components/chats-archive/archive-video.ts` | `../../util.js` | `../../utils/common.js` |
| `src/components/gift-price.ts`                  | `../util.js`    | `../utils/common.js`    |
| `src/data/webhook.ts`                           | `../util.js`    | `../utils/common.js`    |
| `src/models/Channel.ts`                         | `../util.js`    | `../utils/common.js`    |
| `src/models/Video.ts`                           | `../util.js`    | `../utils/common.js`    |
| `src/modules/webhook/changestream.ts`           | `../../util.js` | `../../utils/common.js` |
| `src/scripts/inspect-simplified-match.ts`       | `../util.js`    | `../utils/common.js`    |

- [ ] **Step 3: Verify no stale reference remains**

```bash
grep -rn --include='*.ts' 'from "\(\.\./\)*\.*/\?util\.js"' src
```

Expected: no output. A non-empty result means an importer was missed; `npm run build` would also catch it, but this grep names the file directly.

- [ ] **Step 4: Run the standard checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass.

- [ ] **Step 5: Commit via git-master**

Stage `src/utils/common.ts`, `src/util.ts` (the deletion) and the 11 modified importers, each by explicit path. Suggested subject: `refactor(utils): gather the shared helpers under one directory`.

---

## Task 5: Add the runtime smoke check script

Every task from Task 6 onward has to prove that the compiled tree still loads. Build that tool first.

The script finds each service wherever it currently lives, so it works unchanged through the intermediate states of Tasks 7-13, when some services have moved and others have not.

**Files:**

- Create: `scripts/smoke-entrypoints.sh`

- [ ] **Step 1: Write the script**

Create `scripts/smoke-entrypoints.sh`:

```bash
#!/usr/bin/env bash
# Loads every compiled service entrypoint in its own Node process to prove the
# emitted code resolves and evaluates. Each service is looked up at whichever
# location it currently occupies, so a half-migrated tree still checks all seven.
set -euo pipefail

SERVICES=(scheduler worker crawler manager webhook discord-bot metrics)
FAILED=0

for s in "${SERVICES[@]}"; do
  if [ -f "dist/services/$s/index.js" ]; then
    target="./dist/services/$s/index.js"
  elif [ -f "dist/commands/$s.js" ]; then
    target="./dist/commands/$s.js"
  else
    printf '%-14s MISSING (no compiled entrypoint)\n' "$s"
    FAILED=1
    continue
  fi

  # An explicit exit is required: some entrypoints build a cache at module
  # scope, which holds a Redis socket and an interval timer open, so the
  # process would never end on its own. The deadline turns a module that
  # genuinely wedges into a failure instead of a hang.
  if node --input-type=module -e "
      const t = setTimeout(() => {
        console.error('TIMEOUT: module did not finish loading');
        process.exit(2);
      }, 20000);
      await import('$target');
      clearTimeout(t);
      process.exit(0);
    "; then
    printf '%-14s ok   %s\n' "$s" "$target"
  else
    printf '%-14s FAILED %s\n' "$s" "$target"
    FAILED=1
  fi
done

exit "$FAILED"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/smoke-entrypoints.sh
```

- [ ] **Step 3: Prove the script can fail**

```bash
npm run clean && ./scripts/smoke-entrypoints.sh
```

Expected: seven `MISSING` lines and a non-zero exit, because `dist/` has just been deleted. Do this before the passing run: a checker that cannot fail would report success for the rest of the plan.

- [ ] **Step 4: Run it against a clean build and watch it pass**

```bash
npm run clean && npm run build && ./scripts/smoke-entrypoints.sh
```

Expected: seven lines ending `ok`, each naming a path under `dist/commands/`, exit code 0.

The `npm run clean` is not optional anywhere it appears in this plan. `npm run build` runs `tsc` and a chmod; it never deletes previous output. Without the clean, a file deleted or moved in `src/` leaves its stale `dist/` copy behind, and the smoke check happily loads the old one — which is exactly the failure this check exists to catch.

- [ ] **Step 5: Record the model-registration baseline**

```bash
ls src/models/*.ts | grep -v '\.spec\.ts' | wc -l
```

Expected: `26`. This number is the assertion used by Task 12 and by final acceptance — the count of models Mongoose registers at runtime must equal the count of non-test files in `src/models/`. Because both sides are derived, no baseline file needs to be stored, and the check stays correct if a model is legitimately added later.

- [ ] **Step 6: Commit via git-master**

Stage `scripts/smoke-entrypoints.sh`. Suggested subject: `build: add a smoke check that loads each compiled entrypoint`.

---

## Task 6: Introduce the subpath-import aliases

Add the alias namespace and convert every file that stays in a shared tier. `src/services/` gets no alias on purpose — that is what makes a cross-service import spellable only as a relative path, which Task 14 then rejects.

This task also relocates the two shared modules currently sitting in `src/data/`. They move **before** the services do, not after, because three files that Tasks 10, 11 and 13 relocate import them. Moving the consumers first would leave those imports pointing at `src/services/data/`, which does not exist, and every intermediate commit would fail to build. `src/data/currency.ts` is not part of this — worker is its only consumer, so it travels with worker in Task 12, which is what finally removes `src/data/`.

"Shared tier" here means `src/models/`, `src/utils/`, `src/constants.ts`, `src/interfaces.ts`, and those parts of `src/modules/` that remain after Tasks 9–12 lift out `holodex.ts`, `youtube-pubsub/`, `oauth/`, `webhook/`, `matching.ts`, `youtube-watch-gate.ts` and `currency-convert.ts`. Converting all of `src/modules/**` now is still correct: a file that later moves has its imports rewritten again by the task that moves it, and the tables in those tasks are written against the post-conversion state.

**Files:**

- Move: `src/data/track.ts` (+ spec) → `src/modules/track/features.ts`
- Move: `src/data/webhook.ts` (+ spec) → `src/modules/webhook-template.ts`
- Modify: `package.json`
- Modify: `jest.config.mjs`
- Modify: all of `src/models/**/*.ts`, `src/modules/**/*.ts`, `src/utils/**/*.ts`, `src/constants.ts`

- [ ] **Step 1: Relocate the two shared data modules**

```bash
git mv src/data/track.ts src/modules/track/features.ts
git mv src/data/track.spec.ts src/modules/track/features.spec.ts
git mv src/data/webhook.ts src/modules/webhook-template.ts
git mv src/data/webhook.spec.ts src/modules/webhook-template.spec.ts
```

`webhook-template` is a single file, not a directory holding one `index.ts`; a one-file directory adds nesting and no information.

`features.ts` gained a directory level, so its own imports are now stale and must be fixed in this same step — otherwise this move alone leaves a tree that does not compile:

| File                        | Old                    | New                       |
| --------------------------- | ---------------------- | ------------------------- |
| `modules/track/features.ts` | `../models/Track.js`   | `../../models/Track.js`   |
| `modules/track/features.ts` | `../models/Video.js`   | `../../models/Video.js`   |
| `modules/track/features.ts` | `../models/Webhook.js` | `../../models/Webhook.js` |

`webhook-template.ts` stays at the same depth as `data/webhook.ts` was, so its `../models/...` and `../utils/...` imports are already correct and need no change here. Step 4 converts all of these to aliases.

Then repoint the five consumers. Three already exist, two were created by Tasks 2 and 3:

| File                                  | Old                      | New                                  |
| ------------------------------------- | ------------------------ | ------------------------------------ |
| `src/modules/track/transform.ts`      | `../../data/track.js`    | `./features.js`                      |
| `src/modules/youtube-dm/transform.ts` | `../../data/track.js`    | `../track/features.js`               |
| `src/models/Track.ts`                 | `../data/track.js`       | `../modules/track/features.js`       |
| `src/discord/commands/track/track.ts` | `../../../data/track.js` | `../../../modules/track/features.js` |
| `src/commands/webhook.ts`             | `../data/webhook.js`     | `../modules/webhook-template.js`     |
| `src/components/webhook-prepare.ts`   | `../data/webhook.js`     | `../modules/webhook-template.js`     |

And inside the two moved spec files:

| File                                   | Old            | New                     |
| -------------------------------------- | -------------- | ----------------------- |
| `src/modules/track/features.spec.ts`   | `./track.js`   | `./features.js`         |
| `src/modules/webhook-template.spec.ts` | `./webhook.js` | `./webhook-template.js` |

These are written as relative paths for now; Step 3 converts the ones that cross a tier into aliases, and Tasks 10–13 convert the rest as they move those files.

- [ ] **Step 2: Add the imports field to package.json**

Insert this top-level field, alphabetically after `"description"` and before `"main"`:

```json
  "imports": {
    "#constants.js": "./dist/constants.js",
    "#interfaces.js": "./dist/interfaces.js",
    "#models/*": "./dist/models/*",
    "#modules/*": "./dist/modules/*",
    "#utils/*": "./dist/utils/*"
  },
```

The targets point at `dist/`. TypeScript follows its `rootDir`/`outDir` mapping back to `src/` for type-checking; Node uses the `dist/` path directly at runtime.

- [ ] **Step 3: Teach Jest the same namespace**

In `jest.config.mjs`, replace:

```js
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
```

with:

```js
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^#(models|modules|utils)/(.*)\\.js$": "<rootDir>/src/$1/$2",
    "^#(constants|interfaces)\\.js$": "<rootDir>/src/$1",
  },
```

The keys are listed one by one rather than as a single wildcard so that Jest and Node agree on which aliases exist. A catch-all `^#(.*)` would let a test import `#services/...`, which Node would reject at runtime.

- [ ] **Step 4: Convert imports in the shared tiers**

In `src/models/**`, `src/modules/**`, `src/utils/**` and `src/constants.ts`, rewrite cross-tier relative specifiers to aliases using this mapping:

| Target                                    | Alias            |
| ----------------------------------------- | ---------------- |
| `../constants.js`, `../../constants.js`   | `#constants.js`  |
| `../interfaces.js`, `../../interfaces.js` | `#interfaces.js` |
| `../models/X.js`, `../../models/X.js`     | `#models/X.js`   |
| `../modules/X.js`, `../../modules/X.js`   | `#modules/X.js`  |
| `../utils/X.js`, `../../utils/X.js`       | `#utils/X.js`    |

One file needs naming explicitly because the table's patterns do not describe it: `src/constants.ts` imports `./utils/common.js` after Task 4, which is a single-segment relative path rather than a `../` climb. It converts to `#utils/common.js` like the rest.

Leave these alone:

- Same-directory and subdirectory paths inside `src/modules/` (for example `./module.js`, `./partition.js`, `../db.js` from `modules/webhook/`). Within one tier, relative stays relative.
- Model-to-model paths inside `src/models/` (for example `./Channel.js`, `./Track.js`).
- `src/modules/db.ts`'s `path.join(__dirname(import.meta), "../models")` — that is a filesystem read, not an import, and no alias applies. Changing it breaks model registration silently.

- [ ] **Step 5: Update the mock specifiers in the shared tiers' tests**

`jest.unstable_mockModule` keys are literal specifier strings. Inside the converted files' tests, change:

| File                                        | Old key                   | New key              |
| ------------------------------------------- | ------------------------- | -------------------- |
| `src/modules/webhook/changestream.spec.ts`  | `../../models/Webhook.js` | `#models/Webhook.js` |
| `src/modules/youtube-pubsub/routes.spec.ts` | `../../models/Video.js`   | `#models/Video.js`   |
| `src/modules/youtube-pubsub/routes.spec.ts` | `../../models/Channel.js` | `#models/Channel.js` |
| `src/modules/youtube-pubsub/routes.spec.ts` | `../../constants.js`      | `#constants.js`      |

Leave these keys alone:

- `src/modules/webhook/changestream.spec.ts`'s `../db.js` — same tier, stays relative.
- `src/modules/youtube-pubsub/routes.spec.ts`'s `./hub-client.js` and `./renewal.js` — same directory.
- Anything under `src/components/`, `src/commands/` or `src/discord/`. Those files have not moved yet; the task that moves each one converts its keys.

Mock keys are matched as literal strings, so a key left pointing at a path that no longer resolves fails at test time rather than build time. After this step, run `npm test` before moving on — Step 5 does exactly that.

- [ ] **Step 6: Run the standard checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass. A `Cannot find module '#...'` from Jest means Step 3's mapper is wrong; the same error from tsc means Step 2's field is wrong.

- [ ] **Step 7: Prove the aliases resolve at runtime, not just in tsc and Jest**

```bash
npm run clean && npm run build && ./scripts/smoke-entrypoints.sh
```

Expected: seven `ok` lines. This is the check that matters — tsc resolved through its `dist`→`src` fallback and Jest through `moduleNameMapper`, and **neither** exercised Node's imports map. Only this step does.

- [ ] **Step 8: Confirm the production image still resolves the alias namespace**

`#` specifiers resolve against the nearest `package.json` above the importing file. In the container that is `/app/package.json`, because the Dockerfile copies `package*.json` to `/app/` and `dist` to `/app/dist`, and the entrypoint is `node dist/index.js`. Confirm that relationship is intact:

```bash
grep -n 'COPY.*package\*\.json\|COPY.*dist\|ENTRYPOINT' Dockerfile
```

Expected: `package*.json` copied to `/app/`, `dist` copied to `/app/dist`, entrypoint `node dist/index.js`. If a future change ever puts `package.json` somewhere other than the directory above `dist/`, every `#` specifier fails at container start — and nothing in `npm run build`, `npm run lint` or `npm test` would notice, because all three run from the repository root where the relationship happens to hold.

Do not change the Dockerfile in this task. This step exists to record the dependency and to catch the case where it is already broken.

- [ ] **Step 9: Commit via git-master**

Two concerns here, so ask git-master for two commits: one relocating `src/data/track.ts` and `src/data/webhook.ts` into `src/modules/` together with the six consumers repointed in Step 1, and one adding the alias namespace and converting the shared tiers. Both must build, lint and test on their own.

---

## Task 7: Move the metrics service

The first move, chosen because metrics has no private files — only the entrypoint relocates. If anything about the `services/` layout is wrong, it surfaces here with a one-file diff.

**Files:**

- Move: `src/commands/metrics.ts` → `src/services/metrics/index.ts`
- Modify: `src/index.ts:46`

- [ ] **Step 1: Move the entrypoint**

```bash
mkdir -p src/services/metrics
git mv src/commands/metrics.ts src/services/metrics/index.ts
```

- [ ] **Step 2: Convert its imports**

In `src/services/metrics/index.ts`, the file is now one level deeper, so every relative specifier is stale. Convert them to aliases:

| Old                         | New                       |
| --------------------------- | ------------------------- |
| `../constants.js`           | `#constants.js`           |
| `../interfaces.js`          | `#interfaces.js`          |
| `../models/Channel.js`      | `#models/Channel.js`      |
| `../models/Video.js`        | `#models/Video.js`        |
| `../models/VideoStats.js`   | `#models/VideoStats.js`   |
| `../modules/application.js` | `#modules/application.js` |
| `../modules/db.js`          | `#modules/db.js`          |
| `../modules/queue.js`       | `#modules/queue.js`       |
| `../utils/common.js`        | `#utils/common.js`        |

- [ ] **Step 3: Repoint the dispatcher**

In `src/index.ts`, change:

```ts
const { metrics } = await import("./commands/metrics.js");
```

to:

```ts
const { metrics } = await import("./services/metrics/index.js");
```

- [ ] **Step 4: Confirm no cross-tier reach was left relative**

```bash
grep -rn --include='*.ts' -E 'from "\.\.[^"]*/(models|modules|utils|constants|interfaces)' src/services/metrics
```

Expected: no output. Every specifier leaving the service must now be an alias. Run this same check, with the service directory substituted, at the end of Tasks 8 through 13.

- [ ] **Step 5: Run the standard checks and the smoke check**

```bash
npm run build && npm run lint && npm test
npm run clean && npm run build && ./scripts/smoke-entrypoints.sh
```

Expected: standard checks pass, then seven `ok` lines. The smoke script locates each service wherever it currently sits, so `metrics` is reported from `dist/services/metrics/index.js` and the other six from `dist/commands/`. All seven must pass — a `MISSING` line means the build did not emit that entrypoint.

- [ ] **Step 6: Commit via git-master**

Stage `src/services/metrics/index.ts`, `src/commands/metrics.ts` (the deletion), `src/index.ts`. Suggested subject: `refactor(metrics): move the service under its own directory`.

---

## Task 8: Move the scheduler service

Same shape as Task 7 — scheduler also has no private files.

**Files:**

- Move: `src/commands/scheduler.ts` → `src/services/scheduler/index.ts`
- Modify: `src/index.ts:22`

- [ ] **Step 1: Move the entrypoint**

```bash
mkdir -p src/services/scheduler
git mv src/commands/scheduler.ts src/services/scheduler/index.ts
```

- [ ] **Step 2: Convert its imports**

| Old                                | New                              |
| ---------------------------------- | -------------------------------- |
| `../constants.js`                  | `#constants.js`                  |
| `../interfaces.js`                 | `#interfaces.js`                 |
| `../models/Video.js`               | `#models/Video.js`               |
| `../modules/application.js`        | `#modules/application.js`        |
| `../modules/collection-watcher.js` | `#modules/collection-watcher.js` |
| `../modules/db.js`                 | `#modules/db.js`                 |
| `../modules/queue.js`              | `#modules/queue.js`              |
| `../modules/schedule.js`           | `#modules/schedule.js`           |

- [ ] **Step 3: Repoint the dispatcher**

In `src/index.ts`, change `"./commands/scheduler.js"` to `"./services/scheduler/index.js"`.

- [ ] **Step 4: Run the standard checks and the smoke check**

```bash
grep -rn --include='*.ts' -E 'from "\.\.[^"]*/(models|modules|utils|constants|interfaces)' src/services/scheduler
npm run build && npm run lint && npm test
npm run clean && npm run build && ./scripts/smoke-entrypoints.sh
```

Expected: the grep prints nothing, the standard checks pass, and the smoke check prints seven `ok` lines — `metrics` and `scheduler` now from `dist/services/`, the remaining five from `dist/commands/`.

- [ ] **Step 5: Commit via git-master**

Stage `src/services/scheduler/index.ts`, `src/commands/scheduler.ts` (the deletion), `src/index.ts`. Suggested subject: `refactor(scheduler): move the service under its own directory`.

---

## Task 9: Move the crawler service

Crawler owns ten private files currently split across `components/youtube-discovery/`, `modules/youtube-pubsub/` and `modules/holodex.ts`. `atom.ts` is used by both the discovery and pubsub sub-areas, so it sits at the service root rather than inside either.

**Files:**

- Move: `src/commands/crawler.ts` → `src/services/crawler/index.ts`
- Move: `src/commands/crawler-candidates.spec.ts` → `src/services/crawler/index.candidates.spec.ts`
- Move: `src/modules/holodex.ts` → `src/services/crawler/holodex.ts`
- Move: `src/modules/youtube-pubsub/atom.ts` (+ `atom.spec.ts`) → `src/services/crawler/`
- Move: `src/components/youtube-discovery/*` → `src/services/crawler/discovery/`
- Move: remaining `src/modules/youtube-pubsub/*` → `src/services/crawler/pubsub/`
- Modify: `src/index.ts:38`

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/services/crawler/discovery src/services/crawler/pubsub
git mv src/commands/crawler.ts src/services/crawler/index.ts
git mv src/commands/crawler-candidates.spec.ts src/services/crawler/index.candidates.spec.ts
git mv src/modules/holodex.ts src/services/crawler/holodex.ts
git mv src/modules/youtube-pubsub/atom.ts src/services/crawler/atom.ts
git mv src/modules/youtube-pubsub/atom.spec.ts src/services/crawler/atom.spec.ts
git mv src/components/youtube-discovery/* src/services/crawler/discovery/
git mv src/modules/youtube-pubsub/* src/services/crawler/pubsub/
rmdir src/components/youtube-discovery src/modules/youtube-pubsub
```

The `index.candidates.spec.ts` name is deliberate: the subject under test is the crawler entrypoint, and `index.spec.ts` is left free for a future primary test file.

- [ ] **Step 2: Convert imports in the service entrypoint**

In `src/services/crawler/index.ts`:

| Old                                                  | New                              |
| ---------------------------------------------------- | -------------------------------- |
| `../constants.js`                                    | `#constants.js`                  |
| `../models/Channel.js`                               | `#models/Channel.js`             |
| `../models/Video.js`                                 | `#models/Video.js`               |
| `../modules/application.js`                          | `#modules/application.js`        |
| `../modules/db.js`                                   | `#modules/db.js`                 |
| `../modules/schedule.js`                             | `#modules/schedule.js`           |
| `../modules/youtube.js`                              | `#modules/youtube.js`            |
| `../modules/holodex.js`                              | `./holodex.js`                   |
| `../components/youtube-discovery/existence-probe.js` | `./discovery/existence-probe.js` |
| `../components/youtube-discovery/feed-poll.js`       | `./discovery/feed-poll.js`       |
| `../components/youtube-discovery/members-poll.js`    | `./discovery/members-poll.js`    |
| `../modules/youtube-pubsub/youtube-pubsub.js`        | `./pubsub/youtube-pubsub.js`     |

- [ ] **Step 3: Convert imports and mock keys in the moved sub-files**

This list is exhaustive — it was generated from the files themselves, and covers ordinary imports, dynamic imports and `jest.unstable_mockModule` keys alike, because all three are matched as literal specifier strings. Replace only the specifier; the imported bindings on each line are unchanged.

| File                                | Old                                    | New                       |
| ----------------------------------- | -------------------------------------- | ------------------------- |
| `index.candidates.spec.ts`          | `../models/Video.js`                   | `#models/Video.js`        |
| `index.candidates.spec.ts`          | `./crawler.js`                         | `./index.js`              |
| `holodex.ts`                        | `../constants.js`                      | `#constants.js`           |
| `discovery/existence-probe.ts`      | `../../constants.js`                   | `#constants.js`           |
| `discovery/existence-probe.ts`      | `../../models/Video.js`                | `#models/Video.js`        |
| `discovery/existence-probe.spec.ts` | `../../constants.js`                   | `#constants.js`           |
| `discovery/existence-probe.spec.ts` | `../../models/Video.js`                | `#models/Video.js`        |
| `discovery/feed-poll.ts`            | `../../constants.js`                   | `#constants.js`           |
| `discovery/feed-poll.ts`            | `../../models/Channel.js`              | `#models/Channel.js`      |
| `discovery/feed-poll.ts`            | `../../models/Video.js`                | `#models/Video.js`        |
| `discovery/feed-poll.ts`            | `../../modules/youtube-pubsub/atom.js` | `../atom.js`              |
| `discovery/feed-poll.spec.ts`       | `../../constants.js`                   | `#constants.js`           |
| `discovery/feed-poll.spec.ts`       | `../../models/Channel.js`              | `#models/Channel.js`      |
| `discovery/feed-poll.spec.ts`       | `../../models/Video.js`                | `#models/Video.js`        |
| `discovery/members-poll.ts`         | `../../constants.js`                   | `#constants.js`           |
| `discovery/members-poll.ts`         | `../../models/Channel.js`              | `#models/Channel.js`      |
| `discovery/members-poll.ts`         | `../../modules/youtube.js`             | `#modules/youtube.js`     |
| `discovery/members-poll.spec.ts`    | `../../constants.js`                   | `#constants.js`           |
| `discovery/members-poll.spec.ts`    | `../../models/Channel.js`              | `#models/Channel.js`      |
| `discovery/members-poll.spec.ts`    | `../../modules/youtube.js`             | `#modules/youtube.js`     |
| `discovery/oembed.ts`               | `../../constants.js`                   | `#constants.js`           |
| `discovery/oembed.spec.ts`          | `../../constants.js`                   | `#constants.js`           |
| `pubsub/hub-client.ts`              | `../../constants.js`                   | `#constants.js`           |
| `pubsub/hub-client.spec.ts`         | `../../constants.js`                   | `#constants.js`           |
| `pubsub/renewal.ts`                 | `../../constants.js`                   | `#constants.js`           |
| `pubsub/renewal.ts`                 | `../../models/Channel.js`              | `#models/Channel.js`      |
| `pubsub/renewal.spec.ts`            | `../../constants.js`                   | `#constants.js`           |
| `pubsub/renewal.spec.ts`            | `../../models/Channel.js`              | `#models/Channel.js`      |
| `pubsub/renewal-timeout.spec.ts`    | `../../constants.js`                   | `#constants.js`           |
| `pubsub/renewal-timeout.spec.ts`    | `../../models/Channel.js`              | `#models/Channel.js`      |
| `pubsub/routes.ts`                  | `../../constants.js`                   | `#constants.js`           |
| `pubsub/routes.ts`                  | `../../models/Channel.js`              | `#models/Channel.js`      |
| `pubsub/routes.ts`                  | `../../models/Video.js`                | `#models/Video.js`        |
| `pubsub/routes.ts`                  | `../youtube.js`                        | `#modules/youtube.js`     |
| `pubsub/routes.ts`                  | `./atom.js`                            | `../atom.js`              |
| `pubsub/routes.spec.ts`             | `../../constants.js`                   | `#constants.js`           |
| `pubsub/routes.spec.ts`             | `../../models/Channel.js`              | `#models/Channel.js`      |
| `pubsub/routes.spec.ts`             | `../youtube.js`                        | `#modules/youtube.js`     |
| `pubsub/youtube-pubsub.ts`          | `../../constants.js`                   | `#constants.js`           |
| `pubsub/youtube-pubsub.ts`          | `../application.js`                    | `#modules/application.js` |
| `pubsub/youtube-pubsub.ts`          | `../module.js`                         | `#modules/module.js`      |
| `pubsub/youtube-pubsub.ts`          | `../schedule.js`                       | `#modules/schedule.js`    |

`pubsub/routes.spec.ts`'s `../../models/Video.js` was already converted to `#models/Video.js` by Task 6, so it does not appear here. Its `../youtube.js` does appear: Task 6 left that one relative because at the time both files were inside `src/modules/`, and it is a `jest.unstable_mockModule` key, so nothing in the build catches it — only the crawler suite does.

Everything not listed stays exactly as it is. In particular `./oembed.js`, `./hub-client.js`, `./renewal.js`, `./routes.js` and `./build-video-summary.js`-style sibling paths survive the move untouched, because the whole subtree moved together and their relationship did not change.

- [ ] **Step 4: Repoint the dispatcher**

In `src/index.ts`, change `"./commands/crawler.js"` to `"./services/crawler/index.js"`.

- [ ] **Step 5: Run the crawler tests first, then everything**

```bash
npm run test -- src/services/crawler
grep -rn --include='*.ts' -E 'from "\.\.[^"]*/(models|modules|utils|constants|interfaces)' src/services/crawler
npm run build && npm run lint && npm test
npm run clean && npm run build && ./scripts/smoke-entrypoints.sh
```

Expected: the crawler suite passes with the same test count as before the move; the grep prints nothing; the standard checks pass; the smoke check prints seven `ok` lines, with `crawler` now under `dist/services/`. Running the narrow suite first makes a mock-key mistake readable instead of buried in full-suite output.

- [ ] **Step 6: Commit via git-master**

Stage every moved and modified path explicitly. Suggested subject: `refactor(crawler): gather discovery and pubsub under the service`.

---

## Task 10: Move the discord-bot service

`modules/oauth/` moves in with the bot: it is reachable only from discord-bot. The Discord command surface stays here rather than following the track and youtube-dm verticals, because a slash command's contract is its discord.js registration and this is where anyone looks for it.

**Files:**

- Move: `src/commands/discord-bot.ts` → `src/services/discord-bot/index.ts`
- Move: `src/discord/commands/**` → `src/services/discord-bot/commands/`
- Move: `src/modules/oauth/**` → `src/services/discord-bot/oauth/`
- Modify: `src/index.ts:30`

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/services/discord-bot
git mv src/commands/discord-bot.ts src/services/discord-bot/index.ts
git mv src/discord/commands src/services/discord-bot/commands
git mv src/modules/oauth src/services/discord-bot/oauth
rmdir src/discord
```

- [ ] **Step 2: Convert imports in the service entrypoint**

In `src/services/discord-bot/index.ts`:

| Old                                            | New                                   |
| ---------------------------------------------- | ------------------------------------- |
| `../constants.js`                              | `#constants.js`                       |
| `../modules/application.js`                    | `#modules/application.js`             |
| `../modules/db.js`                             | `#modules/db.js`                      |
| `../modules/redis.js`                          | `#modules/redis.js`                   |
| `../modules/oauth/oauth.js`                    | `./oauth/oauth.js`                    |
| `../discord/commands/command.js`               | `./commands/command.js`               |
| `../discord/commands/registration.js`          | `./commands/registration.js`          |
| `../discord/commands/mod/crawl.js`             | `./commands/mod/crawl.js`             |
| `../discord/commands/mod/set-channel.js`       | `./commands/mod/set-channel.js`       |
| `../discord/commands/mod/set-video.js`         | `./commands/mod/set-video.js`         |
| `../discord/commands/track/track.js`           | `./commands/track/track.js`           |
| `../discord/commands/youtube-dm/youtube-dm.js` | `./commands/youtube-dm/youtube-dm.js` |

- [ ] **Step 3: Convert imports in the moved command files**

The subtree gained a level: `src/discord/commands/track/` sat three directories below `src/`, and `src/services/discord-bot/commands/track/` sits four. That does **not** affect sibling paths such as `../command.js` and `./fns.js` — those stay correct because the whole subtree moved together and the files' relationship to each other is unchanged. It does affect every specifier that used to climb _out_ of the subtree, and each of those becomes an alias below.

The `../../../data/track.js` that used to appear here is already gone: Task 6 relocated that module and repointed this file to `../../../modules/track/features.js`. That specifier still climbs out of the subtree, so it converts like the rest.

| File                                | Old                                     | New                           |
| ----------------------------------- | --------------------------------------- | ----------------------------- |
| `commands/mod/crawl.ts`             | `../../../models/Video.js`              | `#models/Video.js`            |
| `commands/mod/crawl.ts`             | `../../../modules/youtube.js`           | `#modules/youtube.js`         |
| `commands/mod/set-channel.ts`       | `../../../models/Channel.js`            | `#models/Channel.js`          |
| `commands/mod/set-channel.ts`       | `../../../modules/youtube.js`           | `#modules/youtube.js`         |
| `commands/mod/set-video.ts`         | `../../../models/Video.js`              | `#models/Video.js`            |
| `commands/track/fns.ts`             | `../../../models/Track.js`              | `#models/Track.js`            |
| `commands/track/track.ts`           | `../../../models/Channel.js`            | `#models/Channel.js`          |
| `commands/track/track.ts`           | `../../../models/Track.js`              | `#models/Track.js`            |
| `commands/track/track.ts`           | `../../../modules/youtube.js`           | `#modules/youtube.js`         |
| `commands/track/track.ts`           | `../../../modules/track/features.js`    | `#modules/track/features.js`  |
| `commands/youtube-dm/youtube-dm.ts` | `../../../constants.js`                 | `#constants.js`               |
| `commands/youtube-dm/youtube-dm.ts` | `../../../models/Channel.js`            | `#models/Channel.js`          |
| `commands/youtube-dm/youtube-dm.ts` | `../../../models/YoutubeDmBinding.js`   | `#models/YoutubeDmBinding.js` |
| `commands/youtube-dm/youtube-dm.ts` | `../../../modules/oauth/state-store.js` | `../../oauth/state-store.js`  |

- [ ] **Step 4: Convert imports in the moved oauth files**

`src/modules/oauth/` was two levels below `src/`; `src/services/discord-bot/oauth/` is three. Every `../../` becomes an alias and every `../` reaching into `modules/` becomes an alias:

| File                   | Old                                                                | New                           |
| ---------------------- | ------------------------------------------------------------------ | ----------------------------- |
| `oauth/discord.ts`     | `../../constants.js`                                               | `#constants.js`               |
| `oauth/google.ts`      | `../../constants.js`                                               | `#constants.js`               |
| `oauth/state-store.ts` | `../../constants.js`                                               | `#constants.js`               |
| `oauth/oauth.ts`       | `../../models/Channel.js`                                          | `#models/Channel.js`          |
| `oauth/oauth.ts`       | `../../models/YoutubeDmBinding.js`                                 | `#models/YoutubeDmBinding.js` |
| `oauth/oauth.ts`       | `../application.js`                                                | `#modules/application.js`     |
| `oauth/oauth.ts`       | `../module.js`                                                     | `#modules/module.js`          |
| `oauth/oauth.ts`       | `../redis.js`                                                      | `#modules/redis.js`           |
| `oauth/*.ts`           | `./provider.js`, `./state-store.js`, `./discord.js`, `./google.js` | unchanged                     |

- [ ] **Step 5: Update the mock and import specifiers in the moved tests**

| File                                     | Old                                   | New                           |
| ---------------------------------------- | ------------------------------------- | ----------------------------- |
| `oauth/oauth.spec.ts`                    | `../../models/Channel.js`             | `#models/Channel.js`          |
| `oauth/oauth.spec.ts`                    | `../../models/YoutubeDmBinding.js`    | `#models/YoutubeDmBinding.js` |
| `commands/youtube-dm/youtube-dm.spec.ts` | `../../../models/Channel.js`          | `#models/Channel.js`          |
| `commands/youtube-dm/youtube-dm.spec.ts` | `../../../models/YoutubeDmBinding.js` | `#models/YoutubeDmBinding.js` |

- [ ] **Step 6: Repoint the dispatcher**

In `src/index.ts`, change `"./commands/discord-bot.js"` to `"./services/discord-bot/index.js"`.

- [ ] **Step 7: Run the discord-bot tests first, then everything**

```bash
npm run test -- src/services/discord-bot
grep -rn --include='*.ts' -E 'from "\.\.[^"]*/(models|modules|utils|constants|interfaces)' src/services/discord-bot
npm run build && npm run lint && npm test
npm run clean && npm run build && ./scripts/smoke-entrypoints.sh
```

Expected: the discord-bot suite passes, the grep prints nothing, the standard checks pass, and the smoke check prints seven `ok` lines with `discord-bot` now under `dist/services/`.

`registration.spec.ts` matters most here — it imports all six command modules and asserts on their registration shape, so it is the file that catches a wrong sibling path inside the moved subtree, which the grep above cannot see.

- [ ] **Step 8: Commit via git-master**

Stage every moved and modified path explicitly. Suggested subject: `refactor(discord-bot): gather the commands and oauth under the service`.

---

## Task 11: Move the webhook service

`modules/webhook/` and `modules/matching.ts` are reachable only from this service. `simplifyMatch.ts` is renamed to `simplify-match.ts` on the way, so the whole tree is kebab-case.

**Files:**

- Move: `src/commands/webhook.ts` → `src/services/webhook/index.ts`
- Move: `src/commands/webhook-dm.spec.ts` → `src/services/webhook/index.dm.spec.ts`
- Move: `src/modules/webhook/*` → `src/services/webhook/`, renaming `simplifyMatch` → `simplify-match`
- Move: `src/modules/matching.ts` → `src/services/webhook/matching.ts`
- Modify: `src/index.ts:34`, `src/scripts/inspect-simplified-match.ts`

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/services/webhook
git mv src/commands/webhook.ts src/services/webhook/index.ts
git mv src/commands/webhook-dm.spec.ts src/services/webhook/index.dm.spec.ts
git mv src/modules/matching.ts src/services/webhook/matching.ts
git mv src/modules/webhook/changestream.ts src/services/webhook/changestream.ts
git mv src/modules/webhook/changestream.spec.ts src/services/webhook/changestream.spec.ts
git mv src/modules/webhook/claim.ts src/services/webhook/claim.ts
git mv src/modules/webhook/claim.spec.ts src/services/webhook/claim.spec.ts
git mv src/modules/webhook/partition.ts src/services/webhook/partition.ts
git mv src/modules/webhook/partition.spec.ts src/services/webhook/partition.spec.ts
git mv src/modules/webhook/queue.ts src/services/webhook/queue.ts
git mv src/modules/webhook/queue.spec.ts src/services/webhook/queue.spec.ts
git mv src/modules/webhook/simplifyMatch.ts src/services/webhook/simplify-match.ts
git mv src/modules/webhook/simplifyMatch.spec.ts src/services/webhook/simplify-match.spec.ts
rmdir src/modules/webhook
```

- [ ] **Step 2: Convert imports in the service entrypoint**

In `src/services/webhook/index.ts`:

| Old                                  | New                              |
| ------------------------------------ | -------------------------------- |
| `../constants.js`                    | `#constants.js`                  |
| `../interfaces.js`                   | `#interfaces.js`                 |
| `../models/Channel.js`               | `#models/Channel.js`             |
| `../models/Video.js`                 | `#models/Video.js`               |
| `../models/Webhook.js`               | `#models/Webhook.js`             |
| `../models/WebhookResult.js`         | `#models/WebhookResult.js`       |
| `../models/YoutubeDmBinding.js`      | `#models/YoutubeDmBinding.js`    |
| `../modules/application.js`          | `#modules/application.js`        |
| `../modules/cache.js`                | `#modules/cache.js`              |
| `../modules/collection-watcher.js`   | `#modules/collection-watcher.js` |
| `../modules/db.js`                   | `#modules/db.js`                 |
| `../utils/common.js`                 | `#utils/common.js`               |
| `../modules/redis.js`                | `#modules/redis.js`              |
| `../modules/matching.js`             | `./matching.js`                  |
| `../modules/webhook/changestream.js` | `./changestream.js`              |
| `../modules/webhook/claim.js`        | `./claim.js`                     |
| `../modules/webhook/partition.js`    | `./partition.js`                 |
| `../modules/webhook/queue.js`        | `./queue.js`                     |
| `../modules/webhook-template.js`     | `#modules/webhook-template.js`   |

- [ ] **Step 3: Convert imports in the moved sub-files**

`src/modules/webhook/` was two levels below `src/`; `src/services/webhook/` is also two, but the tier changed, so every `../` that reached a sibling module now needs an alias:

| File              | Old                             | New                        |
| ----------------- | ------------------------------- | -------------------------- |
| `changestream.ts` | `../../constants.js`            | `#constants.js`            |
| `changestream.ts` | `../../interfaces.js`           | `#interfaces.js`           |
| `changestream.ts` | `../../models/Webhook.js`       | `#models/Webhook.js`       |
| `changestream.ts` | `../../utils/common.js`         | `#utils/common.js`         |
| `changestream.ts` | `../application.js`             | `#modules/application.js`  |
| `changestream.ts` | `../db.js`                      | `#modules/db.js`           |
| `changestream.ts` | `../module.js`                  | `#modules/module.js`       |
| `changestream.ts` | `../redis.js`                   | `#modules/redis.js`        |
| `changestream.ts` | `../matching.js`                | `./matching.js`            |
| `changestream.ts` | `./partition.js`, `./queue.js`  | unchanged                  |
| `changestream.ts` | `./simplifyMatch.js`            | `./simplify-match.js`      |
| `claim.ts`        | `../../constants.js`            | `#constants.js`            |
| `claim.ts`        | `../../models/Webhook.js`       | `#models/Webhook.js`       |
| `claim.ts`        | `../../models/WebhookResult.js` | `#models/WebhookResult.js` |
| `partition.ts`    | `../../constants.js`            | `#constants.js`            |
| `partition.ts`    | `../application.js`             | `#modules/application.js`  |
| `partition.ts`    | `../module.js`                  | `#modules/module.js`       |
| `partition.ts`    | `../redis.js`                   | `#modules/redis.js`        |
| `queue.ts`        | `../../constants.js`            | `#constants.js`            |
| `queue.ts`        | `../../interfaces.js`           | `#interfaces.js`           |
| `queue.ts`        | `../application.js`             | `#modules/application.js`  |
| `queue.ts`        | `../db.js`                      | `#modules/db.js`           |
| `queue.ts`        | `../module.js`                  | `#modules/module.js`       |
| `queue.ts`        | `../redis.js`                   | `#modules/redis.js`        |

- [ ] **Step 4: Update the mock specifiers in the moved tests**

| File                     | Old key                         | New key                       |
| ------------------------ | ------------------------------- | ----------------------------- |
| `changestream.spec.ts`   | `../application.js`             | `#modules/application.js`     |
| `changestream.spec.ts`   | `../db.js`                      | `#modules/db.js`              |
| `changestream.spec.ts`   | `../redis.js`                   | `#modules/redis.js`           |
| `changestream.spec.ts`   | `../../models/Webhook.js`       | `#models/Webhook.js`          |
| `changestream.spec.ts`   | `./simplifyMatch.js`            | `./simplify-match.js`         |
| `partition.spec.ts`      | `../application.js`             | `#modules/application.js`     |
| `queue.spec.ts`          | `../application.js`             | `#modules/application.js`     |
| `queue.spec.ts`          | `../../interfaces.js`           | `#interfaces.js`              |
| `claim.spec.ts`          | `../../constants.js`            | `#constants.js`               |
| `claim.spec.ts`          | `../../models/Webhook.js`       | `#models/Webhook.js`          |
| `claim.spec.ts`          | `../../models/WebhookResult.js` | `#models/WebhookResult.js`    |
| `simplify-match.spec.ts` | `./simplifyMatch.js`            | `./simplify-match.js`         |
| `simplify-match.spec.ts` | `../matching.js`                | `./matching.js`               |
| `index.dm.spec.ts`       | `./webhook.js`                  | `./index.js`                  |
| `index.dm.spec.ts`       | `../models/WebhookResult.js`    | `#models/WebhookResult.js`    |
| `index.dm.spec.ts`       | `../models/YoutubeDmBinding.js` | `#models/YoutubeDmBinding.js` |

`index.dm.spec.ts` is the file most easily missed: it was `src/commands/webhook-dm.spec.ts`, so both its subject import and its model imports change, and none of them are mock keys.

- [ ] **Step 5: Repoint the dispatcher and the dev script**

In `src/index.ts`, change `"./commands/webhook.js"` to `"./services/webhook/index.js"`.

In `src/scripts/inspect-simplified-match.ts`:

| Old                                   | New                                     |
| ------------------------------------- | --------------------------------------- |
| `../models/Webhook.js`                | `#models/Webhook.js`                    |
| `../modules/db.js`                    | `#modules/db.js`                        |
| `../utils/common.js`                  | `#utils/common.js`                      |
| `../modules/webhook/simplifyMatch.js` | `../services/webhook/simplify-match.js` |

That last one is the one sanctioned import that reaches into a service. `scripts/` is not a service, so the boundary rule added in Task 14 does not cover it, and no alias exists for `services/`.

- [ ] **Step 6: Run the webhook tests first, then everything**

```bash
npm run test -- src/services/webhook
grep -rn --include='*.ts' -E 'from "\.\.[^"]*/(models|modules|utils|constants|interfaces)' src/services/webhook
npm run build && npm run lint && npm test
npm run clean && npm run build && ./scripts/smoke-entrypoints.sh
```

Expected: the webhook suite passes, the grep prints nothing, the standard checks pass, and the smoke check prints seven `ok` lines.

- [ ] **Step 7: Verify every model still registers**

```bash
npm run clean && npm run build
node --input-type=module -e "
  const t = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 30000);
  const { readdirSync } = await import('node:fs');
  const expected = readdirSync('src/models')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).length;
  const { importAllModels } = await import('./dist/modules/db.js');
  await importAllModels();
  const { mongoose } = await import('@typegoose/typegoose');
  const names = Object.keys(mongoose.models).sort();
  console.log(names.length + ' of ' + expected + ' registered: ' + names.join(', '));
  if (names.length !== expected) {
    console.error('model registration mismatch');
    process.exit(1);
  }
  clearTimeout(t);
  process.exit(0);
"
```

Expected: `26 of 26 registered: ...` and exit 0. Verified against the current tree.

Both numbers are computed inside the one Node process — the expected count from `src/models/`, the actual from Mongoose's registry after `importAllModels()`. Nothing is passed through the shell, which keeps the check free of the quoting and environment-passing mistakes that a two-part command invites.

Both sides are derived, so no stored baseline is needed and the check stays correct if a model is legitimately added later. An exact match is required rather than a floor: the failure this guards against is one model silently dropping out, and any floor low enough to be safe against future additions is too low to catch that.

This is the check that `npm run build`, `npm run lint` and `npm test` all pass through silently. The webhook service resolves models by collection name from a runtime string, so a model that failed to register only fails when an event for that collection arrives — in production, not in CI. The `npm run clean` matters here too: without it, a model file deleted from `src/` still has its compiled copy in `dist/`, and `readdir` finds it.

- [ ] **Step 8: Commit via git-master**

Stage every moved and modified path explicitly. Suggested subject: `refactor(webhook): gather the dispatch internals under the service`.

---

## Task 12: Move the worker service

Three files come down from `modules/` and `data/` because worker is their only consumer. If a second consumer appears later, the rule is to promote them back to `modules/` — not to import across services.

**Files:**

- Move: `src/commands/worker.ts` → `src/services/worker/index.ts`
- Move: `src/commands/worker.spec.ts` → `src/services/worker/index.spec.ts`
- Move: `src/components/gift.ts` (+ spec) → `src/services/worker/gift.ts`
- Move: `src/modules/youtube-watch-gate.ts` (+ spec) → `src/services/worker/youtube-watch-gate.ts`
- Move: `src/modules/currency-convert.ts` → `src/services/worker/currency/convert.ts`
- Move: `src/data/currency.ts` → `src/services/worker/currency/currency-map.ts`
- Modify: `src/index.ts:26`

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/services/worker/currency
git mv src/commands/worker.ts src/services/worker/index.ts
git mv src/commands/worker.spec.ts src/services/worker/index.spec.ts
git mv src/components/gift.ts src/services/worker/gift.ts
git mv src/components/gift.spec.ts src/services/worker/gift.spec.ts
git mv src/modules/youtube-watch-gate.ts src/services/worker/youtube-watch-gate.ts
git mv src/modules/youtube-watch-gate.spec.ts src/services/worker/youtube-watch-gate.spec.ts
git mv src/modules/currency-convert.ts src/services/worker/currency/convert.ts
git mv src/data/currency.ts src/services/worker/currency/currency-map.ts
rmdir src/data
```

`src/data/` is empty at this point and this removes it: Task 6 already took `track.ts` and `webhook.ts` into `src/modules/`, and `currency.ts` was its last occupant. If `rmdir` refuses because the directory is not empty, stop — a file was missed and the plan's accounting is wrong.

- [ ] **Step 2: Convert imports in the service entrypoint**

In `src/services/worker/index.ts`, all eighteen `../models/*.js` specifiers become `#models/*.js`, and:

| Old                                | New                       |
| ---------------------------------- | ------------------------- |
| `../constants.js`                  | `#constants.js`           |
| `../interfaces.js`                 | `#interfaces.js`          |
| `../utils/common.js`               | `#utils/common.js`        |
| `../modules/application.js`        | `#modules/application.js` |
| `../modules/db.js`                 | `#modules/db.js`          |
| `../modules/queue.js`              | `#modules/queue.js`       |
| `../modules/redis.js`              | `#modules/redis.js`       |
| `../modules/youtube.js`            | `#modules/youtube.js`     |
| `../components/gift.js`            | `./gift.js`               |
| `../modules/currency-convert.js`   | `./currency/convert.js`   |
| `../modules/youtube-watch-gate.js` | `./youtube-watch-gate.js` |

- [ ] **Step 3: Convert imports in the moved sub-files**

| File                    | Old                      | New                    |
| ----------------------- | ------------------------ | ---------------------- |
| `gift.ts`               | `../interfaces.js`       | `#interfaces.js`       |
| `gift.ts`               | `../models/Gift.js`      | `#models/Gift.js`      |
| `gift.ts`               | `../models/GiftPrice.js` | `#models/GiftPrice.js` |
| `gift.ts`               | `../modules/cache.js`    | `#modules/cache.js`    |
| `youtube-watch-gate.ts` | `../constants.js`        | `#constants.js`        |
| `youtube-watch-gate.ts` | `./module.js`            | `#modules/module.js`   |
| `currency/convert.ts`   | `./cache.js`             | `#modules/cache.js`    |
| `currency/convert.ts`   | `../data/currency.js`    | `./currency-map.js`    |

These two are written as they appear in the file **after Task 6**, not as they appear today. Task 6 converted this file's `../models/CurrencyExchange.js` to `#models/CurrencyExchange.js` — already correct, so it is not listed — but left `./cache.js` relative, because at that point both files were in `src/modules/`, and left `../data/currency.js` alone, because `src/data/` is not an alias tier. Moving the file is what breaks both.

`currency/currency-map.ts` has no imports.

- [ ] **Step 4: Update the specifiers in the moved tests**

| File                         | Old                                | New                       |
| ---------------------------- | ---------------------------------- | ------------------------- |
| `gift.spec.ts`               | `../interfaces.js`                 | `#interfaces.js`          |
| `gift.spec.ts`               | `../models/GiftPrice.js`           | `#models/GiftPrice.js`    |
| `youtube-watch-gate.spec.ts` | `../constants.js`                  | `#constants.js`           |
| `index.spec.ts`              | `../modules/youtube-watch-gate.js` | `./youtube-watch-gate.js` |
| `index.spec.ts`              | `./worker.js`                      | `./index.js`              |

Only `gift.spec.ts`'s `../models/GiftPrice.js` is a `jest.unstable_mockModule` key; the rest are ordinary imports. Both kinds are literal strings, so both break the same way if missed — the mock key fails at test time, the ordinary import at build time.

- [ ] **Step 5: Repoint the dispatcher**

In `src/index.ts`, change `"./commands/worker.js"` to `"./services/worker/index.js"`.

- [ ] **Step 6: Run the worker tests first, then everything**

```bash
npm run test -- src/services/worker
grep -rn --include='*.ts' -E 'from "\.\.[^"]*/(models|modules|utils|constants|interfaces)' src/services/worker
npm run build && npm run lint && npm test
npm run clean && npm run build && ./scripts/smoke-entrypoints.sh
```

Expected: the worker suite passes, the grep prints nothing, the standard checks pass, and the smoke check prints seven `ok` lines with only `manager` still under `dist/commands/`.

`gift.spec.ts` is 711 lines and mocks the gift price model — if its mock key is wrong the failures are loud and immediate.

- [ ] **Step 7: Commit via git-master**

Stage every moved and modified path explicitly. Suggested subject: `refactor(worker): gather the gift, gate and currency code under the service`.

---

## Task 13: Move the manager service

The last service, and the largest. `src/data/` is already gone by this point — Task 6 moved its two shared modules into `src/modules/`, and Task 12 took `currency.ts` into the worker — so this task finishes by emptying `src/components/` and `src/commands/`.

**Files:**

- Move: `src/commands/manager.ts` → `src/services/manager/index.ts`
- Move: `src/components/{cleanup,gift-price,video-scaler,video-stats,webhook-prepare}.ts` (+ specs) → `src/services/manager/`
- Move: `src/components/track-operator.ts` → `src/services/manager/track-operator.ts`
- Move: `src/components/youtube-dm-operator.ts` → `src/services/manager/youtube-dm-operator.ts`
- Move: `src/components/chats-archive.ts` → `src/services/manager/chats-archive/index.ts`
- Move: `src/components/chats-archive/*` → `src/services/manager/chats-archive/`
- Modify: `src/index.ts:42`

- [ ] **Step 1: Move the manager files**

```bash
mkdir -p src/services/manager/chats-archive
git mv src/commands/manager.ts src/services/manager/index.ts
git mv src/components/cleanup.ts src/services/manager/cleanup.ts
git mv src/components/gift-price.ts src/services/manager/gift-price.ts
git mv src/components/gift-price.spec.ts src/services/manager/gift-price.spec.ts
git mv src/components/video-scaler.ts src/services/manager/video-scaler.ts
git mv src/components/video-stats.ts src/services/manager/video-stats.ts
git mv src/components/video-stats.spec.ts src/services/manager/video-stats.spec.ts
git mv src/components/webhook-prepare.ts src/services/manager/webhook-prepare.ts
git mv src/components/webhook-prepare.spec.ts src/services/manager/webhook-prepare.spec.ts
git mv src/components/track-operator.ts src/services/manager/track-operator.ts
git mv src/components/youtube-dm-operator.ts src/services/manager/youtube-dm-operator.ts
git mv src/components/chats-archive.ts src/services/manager/chats-archive/index.ts
git mv src/components/chats-archive/* src/services/manager/chats-archive/
rmdir src/components/chats-archive src/components
rmdir src/commands
```

Note the ordering: `chats-archive.ts` becomes `chats-archive/index.ts` before the directory's own contents move in, so the two never collide.

- [ ] **Step 2: Convert imports in the manager entrypoint**

In `src/services/manager/index.ts`:

| Old                                    | New                        |
| -------------------------------------- | -------------------------- |
| `../modules/application.js`            | `#modules/application.js`  |
| `../modules/db.js`                     | `#modules/db.js`           |
| `../modules/schedule.js`               | `#modules/schedule.js`     |
| `../components/chats-archive.js`       | `./chats-archive/index.js` |
| `../components/cleanup.js`             | `./cleanup.js`             |
| `../components/gift-price.js`          | `./gift-price.js`          |
| `../components/track-operator.js`      | `./track-operator.js`      |
| `../components/video-scaler.js`        | `./video-scaler.js`        |
| `../components/video-stats.js`         | `./video-stats.js`         |
| `../components/webhook-prepare.js`     | `./webhook-prepare.js`     |
| `../components/youtube-dm-operator.js` | `./youtube-dm-operator.js` |

- [ ] **Step 3: Convert imports in the moved manager files**

Every `../constants.js`, `../interfaces.js`, `../models/*.js`, `../modules/*.js` and `../utils/*.js` becomes its alias. The relative edges to re-anchor:

| File                                      | Old                                                       | New                                               |
| ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `track-operator.ts`                       | `../modules/track/transform.js`                           | `#modules/track/transform.js`                     |
| `track-operator.ts`                       | `../modules/application.js`, `../modules/schedule.js`     | `#modules/application.js`, `#modules/schedule.js` |
| `youtube-dm-operator.ts`                  | `../modules/youtube-dm/transform.js`                      | `#modules/youtube-dm/transform.js`                |
| `youtube-dm-operator.ts`                  | `../modules/application.js`, `../modules/schedule.js`     | `#modules/application.js`, `#modules/schedule.js` |
| `cleanup.ts`                              | `../interfaces.js`                                        | `#interfaces.js`                                  |
| `cleanup.ts`                              | `../constants.js`                                         | `#constants.js`                                   |
| `cleanup.ts`                              | `../models/*.js` (15 of them)                             | `#models/*.js`                                    |
| `cleanup.ts`                              | `../modules/application.js`, `../modules/schedule.js`     | `#modules/application.js`, `#modules/schedule.js` |
| `cleanup.ts`                              | `./video-stats.js`                                        | unchanged                                         |
| `webhook-prepare.ts`                      | `../modules/webhook-template.js`                          | `#modules/webhook-template.js`                    |
| `chats-archive/index.ts`                  | `./chats-archive/archive-video.js` and its three siblings | `./archive-video.js` and its three siblings       |
| `chats-archive/index.ts`                  | `../utils/esm.js`                                         | `#utils/esm.js`                                   |
| `chats-archive/gen-channel-index-file.ts` | `../video-stats.js`                                       | unchanged                                         |
| `chats-archive/gen-index-file.ts`         | `../video-stats.js`                                       | unchanged                                         |
| `chats-archive/archive-video.ts`          | `../../interfaces.js`                                     | `#interfaces.js`                                  |
| `chats-archive/archive-video.ts`          | `../../utils/common.js`                                   | `#utils/common.js`                                |
| `chats-archive/*.ts`                      | `../../models/*.js`, `../../constants.js`                 | `#models/*.js`, `#constants.js`                   |

`archive-video.ts` imports the shared helper as `../../utils/common.js`, not `../../util.js` — Task 4 already renamed it. `../video-stats.js` in the two index generators stays as it is: `video-stats.ts` and the `chats-archive/` directory both moved into `src/services/manager/`, so they are still exactly one level apart.

- [ ] **Step 4: Update the specifiers in the moved tests**

| File                                          | Old                      | New                    |
| --------------------------------------------- | ------------------------ | ---------------------- |
| `chats-archive/gen-daily-videos-file.spec.ts` | `./write-data-file.js`   | unchanged              |
| `chats-archive/gen-realtime-file.spec.ts`     | `./write-data-file.js`   | unchanged              |
| `chats-archive/*.spec.ts`                     | `../../models/Video.js`  | `#models/Video.js`     |
| `gift-price.spec.ts`                          | `../models/Gift.js`      | `#models/Gift.js`      |
| `gift-price.spec.ts`                          | `../models/GiftPrice.js` | `#models/GiftPrice.js` |
| `video-stats.spec.ts`                         | `../interfaces.js`       | `#interfaces.js`       |

`webhook-prepare.spec.ts` needs no change: its only relative import is `./webhook-prepare.js`, and the subject moves with it.

The two `gift-price.spec.ts` rows are `jest.unstable_mockModule` keys and are the ones most easily missed, because that file mocks both models by literal path and nothing in the build catches a stale key.

- [ ] **Step 5: Repoint the dispatcher**

In `src/index.ts`, change `"./commands/manager.js"` to `"./services/manager/index.js"`.

- [ ] **Step 6: Confirm the old directories are gone**

```bash
ls src
```

Expected exactly: `constants.ts  index.ts  interfaces.ts  models  modules  scripts  services  types  utils`. If `commands`, `components`, `data` or `discord` still appears, a file was missed.

- [ ] **Step 7: Run the standard checks and both runtime checks**

```bash
npm run test -- src/services/manager
grep -rn --include='*.ts' -E 'from "\.\.[^"]*/(models|modules|utils|constants|interfaces)' src/services/manager
npm run build && npm run lint && npm test
npm run clean && npm run build && ./scripts/smoke-entrypoints.sh
```

Expected: the manager suite passes, the grep prints nothing, the standard checks pass, then seven `ok` lines from the smoke check — this is the first run where all seven load from `dist/services/`.

Then repeat the model-registration check from Task 11 Step 7 verbatim. Expected: `26 of 26 registered`. Anything less means a model file left `src/models/` or landed in a subdirectory, which nothing else in this plan detects.

- [ ] **Step 8: Commit via git-master**

This task touches roughly 35 files. Ask git-master to split it, but with one hard rule: **every commit must build, lint and test on its own.** That means a move and the repointing of everything that referenced the moved file belong in the same commit — splitting "move the files" from "fix the imports" produces a broken intermediate that defeats the point of committing in steps.

**Commit this task as a single commit.** A split was considered and does not work here. The obvious one — archive first, then the rest — breaks immediately: `chats-archive/gen-index-file.ts` and `gen-channel-index-file.ts` import `../video-stats.js`, and `video-stats.ts` would not have moved yet, so the first commit would not build. Reversing the order does not help either, because `manager.ts` imports every one of these files and would be pointing at `../components/` for whichever group moved first.

The dependency graph here is a star centred on the entrypoint: nothing in this group can move without the entrypoint's import list moving with it. Splitting would require writing temporary import paths into the intermediate commits, which is the same defect this rule exists to prevent, traded for a cosmetic improvement in commit granularity.

Tell git-master that this is a deliberate single commit with that justification, so it is not split to satisfy a file-count heuristic. Suggested subject: `refactor(manager): gather the scheduled jobs under the service`.

---

## Task 14: Add the boundary lint rules

This task must come after every move. The rules' `files:` globs point at `src/services/<X>/**`; run earlier they would match nothing and a passing lint would prove nothing.

**Files:**

- Modify: `eslint.config.js`

- [ ] **Step 1: Add the overrides**

In `eslint.config.js`, add these declarations above the `export default defineConfig(...)` call:

```js
const SERVICES = [
  "scheduler",
  "worker",
  "crawler",
  "manager",
  "webhook",
  "discord-bot",
  "metrics",
];

const SHARED_MESSAGE =
  "Use a #models / #modules / #utils alias, or promote the shared code out of src/services/.";

const crossServiceOverrides = SERVICES.map((service) => ({
  files: [`src/services/${service}/**/*.ts`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: SERVICES.filter((sibling) => sibling !== service).flatMap(
          (sibling) => [
            {
              // Direct sibling reference at any ascent depth:
              // "./webhook/x.js", "../webhook/x.js", "../../webhook/x.js".
              regex: `^\\.\\.?(\\/\\.\\.)*\\/${sibling}(\\/|$)`,
              message: `Cross-service import into "${sibling}" is forbidden. ${SHARED_MESSAGE}`,
            },
            {
              // Any relative spelling that climbs out and names the segment
              // again: "../../services/webhook/x.js".
              regex: `^\\.\\.?\\/(.*\\/)?services\\/${sibling}(\\/|$)`,
              message: `Cross-service import into "${sibling}" is forbidden. ${SHARED_MESSAGE}`,
            },
          ]
        ),
      },
    ],
  },
}));

const sharedLayerOverride = {
  files: ["src/models/**/*.ts", "src/modules/**/*.ts", "src/utils/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            // Shared code must never reach into a service. Relative-anchored so
            // an unrelated package path such as "some-pkg/services/x" is not hit.
            regex: `^\\.\\.?\\/(.*\\/)?services\\/`,
            message:
              "Shared code must not import service-private modules; that would re-expose one service's internals to every other service.",
          },
        ],
      },
    ],
  },
};
```

Then add both to the config array, after the existing rules block and **before** `prettier`:

```js
  ...crossServiceOverrides,
  sharedLayerOverride,
  prettier
);
```

`regex` is required here rather than a gitignore-style `group` glob: a glob such as `**/webhook/**` also matches alias specifiers like `#modules/webhook-template.js`, producing false positives. Anchoring on the leading dot is what separates a relative cross-service path from an alias.

- [ ] **Step 2: Confirm lint still passes on clean code**

```bash
npm run lint
```

Expected: pass. If it reports violations, the codebase has a real cross-service import that Tasks 7–13 left behind — fix that file, do not weaken the rule.

- [ ] **Step 3: Prove the service rule actually fires**

Add this line temporarily at the top of `src/services/worker/gift.ts`:

```ts
import "../webhook/simplify-match.js";
```

A side-effect import is used deliberately. A named import would also trip `@typescript-eslint/no-unused-vars`, and a second error on the same line makes it harder to tell whether the boundary rule fired at all.

Run:

```bash
npm run lint
```

Expected: an error on that line reading `Cross-service import into "webhook" is forbidden.` A clean pass means the `files:` glob is wrong and the rule covers nothing.

Then add a second temporary line to the same file:

```ts
import "../../services/webhook/simplify-match.js";
```

Run `npm run lint` again. Expected: errors on **both** lines. If only the first is reported, the second pattern is wrong — and that is the exact hole this pattern exists to close, since both specifiers reach the same file.

Remove both temporary lines and re-run `npm run lint`. Expected: clean.

- [ ] **Step 4: Prove the shared-layer rule actually fires**

Add this line temporarily at the top of `src/modules/cache.ts`:

```ts
import "../services/worker/gift.js";
```

Run:

```bash
npm run lint
```

Expected: an error reading `Shared code must not import service-private modules`. Remove the line and re-run. Expected: clean.

This direction matters more than it looks: without it, shared code could import one service's private module and transitively re-expose it to every other service, which is exactly the dependency inversion the whole restructure exists to prevent.

- [ ] **Step 5: Run the standard checks and the smoke check**

```bash
npm run build && npm run lint && npm test
npm run clean && npm run build && ./scripts/smoke-entrypoints.sh
```

Expected: all pass, seven `ok` lines, and no temporary import lines remaining. Confirm with `git diff --stat` that only `eslint.config.js` is modified — if `gift.ts` or `cache.ts` still appears, a negative-test line was left behind.

- [ ] **Step 6: Commit via git-master**

Stage `eslint.config.js` only. Suggested subject: `build(lint): reject imports that cross a service boundary`.

---

## Task 15: Align the remaining test filename

One test file still carries a topic name unrelated to its subject.

**Files:**

- Move: `src/modules/youtube-playlist-transport.spec.ts` → `src/modules/youtube.transport.spec.ts`

- [ ] **Step 1: Rename**

```bash
git mv src/modules/youtube-playlist-transport.spec.ts src/modules/youtube.transport.spec.ts
```

The name cannot simply be `youtube.spec.ts` — that file already exists and tests the same module. The `<subject>.<topic>.spec.ts` form names the subject first while keeping the two suites distinct, and both still match the `**/?(*.)+(spec|test).ts?(x)` pattern in `jest.config.mjs`.

- [ ] **Step 2: Confirm both suites still run**

```bash
npm run test -- src/modules/youtube
```

Expected: both `youtube.spec.ts` and `youtube.transport.spec.ts` execute, with the same total test count as before the rename.

- [ ] **Step 3: Run the standard checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass.

- [ ] **Step 4: Commit via git-master**

Stage both paths. Suggested subject: `test(youtube): name the transport suite after its subject`.

---

## Task 16: Update the project documentation

The rules only take effect if they are where people and agents read them. `AGENTS.md` currently describes the old layout in its Architecture section.

**Files:**

- Modify: `AGENTS.md`
- Modify: seven file-type documents under `docs/data-contract/` — `channel-index.md`, `daily-videos.md`, `realtime.md`, `root-index.md`, `upcoming.md`, `video-chats.md`, `video-meta.md`
- Modify: `src/constants.ts` (two comments), `src/services/webhook/claim.ts` (one comment)
- Leave alone: `docs/data-contract/README.md` — its one `src/` mention is a generic reviewer-checklist phrase, not a path

- [ ] **Step 1: Repoint every stale path in AGENTS.md**

Twelve lines name a directory this restructure removes or moves. Each needs its new location:

| Line | Current text mentions           | Replace with                                       |
| ---- | ------------------------------- | -------------------------------------------------- |
| 37   | `src/commands/`                 | `src/services/`                                    |
| 49   | `src/modules/youtube-pubsub/`   | `src/services/crawler/pubsub/`                     |
| 53   | `src/components/`               | `src/services/manager/`                            |
| 60   | `src/modules/webhook/`          | `src/services/webhook/`                            |
| 74   | `src/components/` bullet        | delete the bullet; the tier list below replaces it |
| 79   | `src/data/` bullet              | delete the bullet; the directory no longer exists  |
| 81   | `src/discord/` bullet           | `src/services/discord-bot/commands/`               |
| 82   | `src/modules/webhook/` bullet   | `src/services/webhook/`                            |
| 124  | `src/commands/`                 | `src/services/<service>/index.ts`                  |
| 130  | `src/components/`               | `src/services/manager/`                            |
| 131  | `src/commands/manager.ts`       | `src/services/manager/index.ts`                    |
| 280  | `src/util.ts` and `src/utils/`  | `src/utils/`                                       |
| 288  | `src/components/chats-archive/` | `src/services/manager/chats-archive/`              |

Line numbers are from the pre-restructure file and will drift as earlier lines change; treat them as a checklist of thirteen sites, not as offsets.

- [ ] **Step 2: Replace the composition subsection and add the placement rules**

Replace the whole "Composition (modules vs components)" subsection with this. The existing text calls `src/modules/` a home for "long-lived infrastructure singletons", which stopped being true once Tasks 2, 3 and 6 put shared domain logic there, so the description is rewritten rather than patched:

```markdown
### Composition (three tiers)

- `src/services/<service>/` — everything reachable from exactly one entrypoint.
  Each directory holds that service's runner (`index.ts`) and its private
  modules. Services never import each other; ESLint enforces it.
- `src/modules/` — everything reachable from two or more entrypoints. This is
  both infrastructure composed via the `Application` container
  ([src/modules/application.ts](src/modules/application.ts)) — `MongodbModule`,
  `QueueModule`, `AgendaModule`, `RedisModule`, `HttpServerModule`,
  `CollectionWatcher`, `Cache` — and shared domain logic that several services
  need, such as `modules/track/` and `modules/youtube-dm/`. A domain-named
  subdirectory here is grouping, not a second organising axis: what belongs in
  it is still decided by counting entrypoints.
- `src/models/`, `src/constants.ts`, `src/interfaces.ts`, `src/utils/` — shared
  unconditionally, regardless of how many services read them.

Dependencies run one way: `services/ → modules/ → models/`. The one exception
is that a few model statics call a transform in `modules/`, which leaves a
cycle between those two tiers; it predates this layout and is left alone.
```

Then add these rules under "Project conventions":

```markdown
### Where a new file goes

Count the entrypoints that can reach it. Reachable from exactly one service →
`src/services/<service>/`. Reachable from two or more → `src/modules/`. Models,
`constants.ts`, `interfaces.ts` and `utils/` are always shared regardless of
who reads them.

A file stays in its service directory until a **second** service consumes it;
only then is it promoted to `src/modules/`. Do not pre-emptively place code in
`src/modules/` on the guess that it will be shared later.

Cross-service imports are rejected by ESLint. If you find yourself wanting one,
the file you are reaching for needs promoting.

`src/models/` must stay one flat directory, and `src/modules/db.ts` must stay
at that path: model registration reads the emitted `dist/models/` with a
non-recursive `readdir`, so a model in a subdirectory is skipped silently and
only fails when the webhook service dispatches that collection.

### Cross-service verticals

Some features span several services and therefore do not live in one directory.
Where each part of the current two sits:

| Vertical     | Shared slice                            | Discord surface                             | Dispatch side               | Manager reconcile shell                   | Model                        |
| ------------ | --------------------------------------- | ------------------------------------------- | --------------------------- | ----------------------------------------- | ---------------------------- |
| `track`      | `modules/track/{features,transform}.ts` | `services/discord-bot/commands/track/`      | —                           | `services/manager/track-operator.ts`      | `models/Track.ts`            |
| `youtube-dm` | `modules/youtube-dm/transform.ts`       | `services/discord-bot/commands/youtube-dm/` | `services/webhook/index.ts` | `services/manager/youtube-dm-operator.ts` | `models/YoutubeDmBinding.ts` |

Both project onto `models/Webhook.ts`: a user configures something in Discord,
it becomes a Webhook row, the webhook service dispatches it, and manager
reconciles and removes orphans on a schedule.

Add a row whenever a new feature ends up spanning more than one service, and
update the existing rows in the same commit that moves any part of a vertical.
```

The table is written out here rather than referenced, so that someone reading `AGENTS.md` does not have to open another file to find out where a vertical lives.

- [ ] **Step 3: Repoint the stale paths in source comments**

Four comments name files or directories that this restructure moves. These are comments only — no code changes:

| File                            | Comment mentions                    | Replace with                                |
| ------------------------------- | ----------------------------------- | ------------------------------------------- |
| `src/constants.ts:100`          | `src/components/cleanup.ts`         | `src/services/manager/cleanup.ts`           |
| `src/constants.ts:104`          | `src/modules/youtube-watch-gate.ts` | `src/services/worker/youtube-watch-gate.ts` |
| `src/constants.ts:197`          | `src/components/youtube-discovery/` | `src/services/crawler/discovery/`           |
| `src/services/webhook/claim.ts` | `src/components/cleanup.ts`         | `src/services/manager/cleanup.ts`           |

`claim.ts` is listed at its post-Task-11 path; the comment travels with the file.

The `youtube-watch-gate` one is the reason Step 5's search covers more than the four removed directory names: that comment points at a path under `src/modules/` which is valid today and stale only after Task 12 moves the file, so a search for `src/components` and friends would report success while leaving it broken.

- [ ] **Step 4: Update the writer paths in the data contract documents**

Seven documents each carry one `**Writer:**` line pointing into `src/components/chats-archive/`. Rewrite the directory prefix to `src/services/manager/chats-archive/`, leaving the filename untouched:

| Document             | Writer file                 |
| -------------------- | --------------------------- |
| `channel-index.md:8` | `gen-channel-index-file.ts` |
| `daily-videos.md:5`  | `gen-daily-videos-file.ts`  |
| `realtime.md:5`      | `gen-realtime-file.ts`      |
| `root-index.md:18`   | `gen-index-file.ts`         |
| `upcoming.md:5`      | `gen-realtime-file.ts`      |
| `video-chats.md:9`   | `archive-video.ts`          |
| `video-meta.md:9`    | `archive-video.ts`          |

`README.md:213` also matches a naive `src/` grep, but its text is "No file under `src/`" — a reviewer-checklist phrase, not a path. Do not change it.

Confirm with:

```bash
grep -rn "src/components" docs/data-contract
```

Expected after editing: no output.

- [ ] **Step 5: Check for stale references across the whole repository**

```bash
grep -rn -E 'src/(components|commands|data|discord)/|src/util\.ts|src/modules/(youtube-pubsub|webhook|oauth|holodex|matching|currency-convert|youtube-watch-gate)' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
  --exclude-dir=specs --exclude-dir=plans .
```

Expected: no output. The pattern covers the four removed top-level directories, the renamed root utility, **and** the paths that moved out of `src/modules/` — those last ones are the trap, because they name a directory that still exists and so survive a search for the removed names alone.

The two excluded directories hold the design and planning documents, which describe the before state on purpose and must not be rewritten. Any hit outside them is a stale reference.

- [ ] **Step 6: Run the standard checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass. The comment edits in Step 3 touch source files, so this is not a formality.

- [ ] **Step 7: Commit via git-master**

Stage `AGENTS.md`, the seven `docs/data-contract/` files, `src/constants.ts` and `src/services/webhook/claim.ts`. Ask git-master for three commits: the placement rules and vertical table, the `AGENTS.md` path sweep, and the data-contract plus source-comment path sweep. Suggested subjects: `docs: state where a new source file belongs`, `docs: follow the services to their new paths`, and `docs(data-contract): follow the archive writer to its new path`.

---

## Final acceptance

After Task 16, all of the following must hold:

```bash
npm run clean && npm run build         # passes
npm run lint                           # passes
npm test                               # passes
./scripts/smoke-entrypoints.sh         # seven ok lines, all under dist/services/, exit 0
ls src                                 # no commands/ components/ data/ discord/
```

Plus the model-registration check from Task 11 Step 7, reporting `26 of 26 registered`.

Plus one final sweep for imports that should have become aliases:

```bash
grep -rn --include='*.ts' -E 'from "\.\.[^"]*/(models|modules|utils|constants|interfaces)' src/services
```

Expected: no output.
