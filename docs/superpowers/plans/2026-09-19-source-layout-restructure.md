# Source Layout Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `src/` so that every file's directory states whether it belongs to one service, is shared across services, or is a data contract, and make the resulting boundaries machine-enforced.

**Architecture:** Three tiers — `src/services/<service>/` for code reachable from exactly one entrypoint, `src/modules/` for code reachable from two or more, and `src/models/` + `src/constants.ts` + `src/interfaces.ts` + `src/utils/` as always-shared. Cross-tier imports are written as Node.js subpath-import aliases (`#models/...`, `#modules/...`, `#utils/...`); `src/services/` deliberately has no alias, so a cross-service import can only be spelled as a relative path, which an ESLint rule then rejects. The directories `commands/`, `components/`, `data/` and `discord/` disappear.

**Tech Stack:** TypeScript 6.0.2 (NodeNext, ESM-only), Node ≥ 24, Jest 29.7.0 + ts-jest 29.4.9 (true ESM), ESLint 9.39.4 flat config, Typegoose/Mongoose, Bee-Queue, Agenda.

---

## Deviation from the design document

The design document's step 4 reads "introduce the imports field and rewrite existing imports to aliases" as a single step. There are 281 relative import lines to convert, and the majority of them live in files that steps 5 and 6 are about to move anyway. Rewriting them twice is wasted work and doubles the review surface.

This plan therefore splits that step:

- **Task 6** introduces the `"imports"` field, the Jest mapper, and rewrites only the files that never move — `src/models/**`, `src/modules/**`, `src/utils/**`, `src/constants.ts`. That is enough to prove the alias mechanism works under tsc, ESLint, Jest and Node.
- **Tasks 8–14 and 15** rewrite each moved file's imports as part of the move that touches it.

Everything else follows the design document's ordering. No other deviation is intended; if a reviewer finds one, treat it as a plan defect.

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
grep -rn "action-counter\|ActionCounter" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .
```

Expected: exactly one line, the class declaration inside the file itself. If any other line appears, stop and report — the file is not dead and this task must not proceed.

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

Tasks 6 onward need a way to prove that compiled code still loads. Build that first, so every later task can call it.

**Files:**

- Create: `scripts/smoke-entrypoints.sh`

- [ ] **Step 1: Write the script**

Create `scripts/smoke-entrypoints.sh`:

```bash
#!/usr/bin/env bash
# Loads every compiled service entrypoint in its own Node process to prove the
# emitted code resolves and evaluates. Pass the directory layout in use:
#   ./scripts/smoke-entrypoints.sh commands   -> dist/commands/<name>.js
#   ./scripts/smoke-entrypoints.sh services   -> dist/services/<name>/index.js
set -euo pipefail

LAYOUT="${1:-services}"
SERVICES=(scheduler worker crawler manager webhook discord-bot metrics)
FAILED=0

for s in "${SERVICES[@]}"; do
  case "$LAYOUT" in
    commands) target="./dist/commands/$s.js" ;;
    services) target="./dist/services/$s/index.js" ;;
    *) echo "unknown layout: $LAYOUT" >&2; exit 64 ;;
  esac

  if [ ! -f "${target#./}" ]; then
    printf '%-14s MISSING %s\n' "$s" "$target"
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
    printf '%-14s ok\n' "$s"
  else
    printf '%-14s FAILED\n' "$s"
    FAILED=1
  fi
done

exit "$FAILED"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/smoke-entrypoints.sh
```

- [ ] **Step 3: Run it against the current layout and watch it pass**

```bash
npm run build && ./scripts/smoke-entrypoints.sh commands
```

Expected: seven lines, each ending `ok`, exit code 0. This is the baseline — the layout has not changed yet, so anything other than seven passes means the script is wrong, not the code.

- [ ] **Step 4: Prove the script can fail**

```bash
./scripts/smoke-entrypoints.sh services
```

Expected: seven `MISSING` lines and a non-zero exit, because `dist/services/` does not exist yet. A script that reports success here would report success for the rest of the plan too.

- [ ] **Step 5: Commit via git-master**

Stage `scripts/smoke-entrypoints.sh`. Suggested subject: `build: add a smoke check that loads each compiled entrypoint`.

---

## Task 6: Introduce the subpath-import aliases

Add the alias namespace and convert the files that will never move. `src/services/` gets no alias on purpose — that is what makes a cross-service import spellable only as a relative path, which Task 16 then rejects.

**Files:**

- Modify: `package.json`
- Modify: `jest.config.mjs`
- Modify: all of `src/models/**/*.ts`, `src/modules/**/*.ts`, `src/utils/**/*.ts`, `src/constants.ts`

- [ ] **Step 1: Add the imports field to package.json**

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

- [ ] **Step 2: Teach Jest the same namespace**

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

- [ ] **Step 3: Convert imports in the files that never move**

In `src/models/**`, `src/modules/**`, `src/utils/**` and `src/constants.ts`, rewrite cross-tier relative specifiers to aliases using this mapping:

| Target                                    | Alias            |
| ----------------------------------------- | ---------------- |
| `../constants.js`, `../../constants.js`   | `#constants.js`  |
| `../interfaces.js`, `../../interfaces.js` | `#interfaces.js` |
| `../models/X.js`, `../../models/X.js`     | `#models/X.js`   |
| `../modules/X.js`, `../../modules/X.js`   | `#modules/X.js`  |
| `../utils/X.js`, `../../utils/X.js`       | `#utils/X.js`    |

Leave these alone:

- Same-directory and subdirectory paths inside `src/modules/` (for example `./module.js`, `./partition.js`, `../db.js` from `modules/webhook/`). Within one tier, relative stays relative.
- Model-to-model paths inside `src/models/` (for example `./Channel.js`, `./Track.js`).
- `src/modules/db.ts`'s `path.join(__dirname(import.meta), "../models")` — that is a filesystem read, not an import, and no alias applies. Changing it breaks model registration silently.

- [ ] **Step 4: Update the mock specifiers in the moved files' tests**

`jest.unstable_mockModule` keys are literal specifier strings. Inside the converted files' tests, change:

| File                                       | Old key                   | New key                                  |
| ------------------------------------------ | ------------------------- | ---------------------------------------- |
| `src/components/gift.spec.ts`              | `../models/GiftPrice.js`  | leave as-is (this file moves in Task 12) |
| `src/modules/webhook/changestream.spec.ts` | `../db.js`                | leave as-is (same tier)                  |
| `src/modules/webhook/changestream.spec.ts` | `../../models/Webhook.js` | `#models/Webhook.js`                     |

Only tests under the converted directories change in this task.

- [ ] **Step 5: Run the standard checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass. A `Cannot find module '#...'` from Jest means Step 2's mapper is wrong; the same error from tsc means Step 1's field is wrong.

- [ ] **Step 6: Prove the aliases resolve at runtime, not just in tsc and Jest**

```bash
npm run build && ./scripts/smoke-entrypoints.sh commands
```

Expected: seven `ok` lines. This is the check that matters — tsc resolved through its `dist`→`src` fallback and Jest through `moduleNameMapper`, and **neither** exercised Node's imports map. Only this step does.

- [ ] **Step 7: Commit via git-master**

Stage `package.json`, `jest.config.mjs`, and each converted source file by explicit path. Suggested subject: `refactor(imports): address the shared tiers through subpath aliases`.

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

- [ ] **Step 4: Run the standard checks and the smoke check**

```bash
npm run build && npm run lint && npm test
npm run build && ./scripts/smoke-entrypoints.sh commands
```

Expected: standard checks pass. The smoke check reports `metrics MISSING` and exits non-zero, because metrics now lives at `dist/services/metrics/index.js` while the other six are still under `dist/commands/`. That is correct for this intermediate state — confirm the other six still say `ok`, then additionally run:

```bash
node --input-type=module -e "
  const t = setTimeout(() => process.exit(2), 20000);
  await import('./dist/services/metrics/index.js');
  clearTimeout(t);
  process.exit(0);
"
```

Expected: exit 0.

- [ ] **Step 5: Commit via git-master**

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

- [ ] **Step 4: Run the standard checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass.

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

- [ ] **Step 3: Convert imports in the moved sub-files**

Apply the same rule everywhere under `src/services/crawler/`: anything reaching `constants`, `interfaces`, `models`, `modules` or `utils` becomes an alias; anything reaching another crawler file stays relative and is re-anchored to the new depth.

The relative edges that must be re-anchored:

| File                           | Old                                    | New                       |
| ------------------------------ | -------------------------------------- | ------------------------- |
| `discovery/feed-poll.ts`       | `../../modules/youtube-pubsub/atom.js` | `../atom.js`              |
| `discovery/existence-probe.ts` | `./oembed.js`                          | unchanged                 |
| `discovery/members-poll.ts`    | `./oembed.js`                          | unchanged                 |
| `pubsub/routes.ts`             | `./atom.js`                            | `../atom.js`              |
| `pubsub/routes.ts`             | `../youtube.js`                        | `#modules/youtube.js`     |
| `pubsub/renewal.ts`            | `./hub-client.js`                      | unchanged                 |
| `pubsub/youtube-pubsub.ts`     | `../application.js`                    | `#modules/application.js` |
| `pubsub/youtube-pubsub.ts`     | `../module.js`                         | `#modules/module.js`      |
| `pubsub/youtube-pubsub.ts`     | `../schedule.js`                       | `#modules/schedule.js`    |
| `pubsub/youtube-pubsub.ts`     | `./renewal.js`, `./routes.js`          | unchanged                 |

- [ ] **Step 4: Update the mock specifiers in the moved tests**

| File                                | Old key                                            | New key                                  |
| ----------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| `discovery/members-poll.spec.ts`    | `../../modules/youtube.js`                         | `#modules/youtube.js`                    |
| `discovery/members-poll.spec.ts`    | `./oembed.js`                                      | unchanged                                |
| `discovery/existence-probe.spec.ts` | `./oembed.js`                                      | unchanged                                |
| `discovery/*.spec.ts`               | `../../models/Video.js`, `../../models/Channel.js` | `#models/Video.js`, `#models/Channel.js` |
| `pubsub/routes.spec.ts`             | `./hub-client.js`, `./renewal.js`                  | unchanged                                |
| `pubsub/youtube-pubsub.spec.ts`     | `./renewal.js`                                     | unchanged                                |

- [ ] **Step 5: Repoint the dispatcher**

In `src/index.ts`, change `"./commands/crawler.js"` to `"./services/crawler/index.js"`.

- [ ] **Step 6: Run the crawler tests first, then everything**

```bash
npm run test -- src/services/crawler
npm run build && npm run lint && npm test
```

Expected: the crawler suite passes with the same test count as before the move, then all standard checks pass. Running the narrow suite first makes a mock-key mistake readable instead of buried in full-suite output.

- [ ] **Step 7: Commit via git-master**

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

Under `src/services/discord-bot/commands/`, the depth is unchanged (it was `src/discord/commands/`, now `src/services/discord-bot/commands/` — both three levels below `src/`), so sibling paths such as `../command.js` and `./fns.js` stay as they are. Only the cross-tier reaches change:

| File                                | Old                                     | New                                                                                                |
| ----------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `commands/mod/crawl.ts`             | `../../../models/Video.js`              | `#models/Video.js`                                                                                 |
| `commands/mod/crawl.ts`             | `../../../modules/youtube.js`           | `#modules/youtube.js`                                                                              |
| `commands/mod/set-channel.ts`       | `../../../models/Channel.js`            | `#models/Channel.js`                                                                               |
| `commands/mod/set-channel.ts`       | `../../../modules/youtube.js`           | `#modules/youtube.js`                                                                              |
| `commands/mod/set-video.ts`         | `../../../models/Video.js`              | `#models/Video.js`                                                                                 |
| `commands/track/fns.ts`             | `../../../models/Track.js`              | `#models/Track.js`                                                                                 |
| `commands/track/track.ts`           | `../../../models/Channel.js`            | `#models/Channel.js`                                                                               |
| `commands/track/track.ts`           | `../../../models/Track.js`              | `#models/Track.js`                                                                                 |
| `commands/track/track.ts`           | `../../../modules/youtube.js`           | `#modules/youtube.js`                                                                              |
| `commands/track/track.ts`           | `../../../data/track.js`                | `#modules/track/features.js` (Task 13 creates this path; until then keep `../../../data/track.js`) |
| `commands/youtube-dm/youtube-dm.ts` | `../../../constants.js`                 | `#constants.js`                                                                                    |
| `commands/youtube-dm/youtube-dm.ts` | `../../../models/Channel.js`            | `#models/Channel.js`                                                                               |
| `commands/youtube-dm/youtube-dm.ts` | `../../../models/YoutubeDmBinding.js`   | `#models/YoutubeDmBinding.js`                                                                      |
| `commands/youtube-dm/youtube-dm.ts` | `../../../modules/oauth/state-store.js` | `../../oauth/state-store.js`                                                                       |

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
npm run build && npm run lint && npm test
```

Expected: `registration.spec.ts` in particular must still pass — it imports all six command modules and asserts on their registration shape, so it is the file that catches a wrong relative path here.

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

| Old                                  | New                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `../constants.js`                    | `#constants.js`                                                                                  |
| `../interfaces.js`                   | `#interfaces.js`                                                                                 |
| `../models/Channel.js`               | `#models/Channel.js`                                                                             |
| `../models/Video.js`                 | `#models/Video.js`                                                                               |
| `../models/Webhook.js`               | `#models/Webhook.js`                                                                             |
| `../models/WebhookResult.js`         | `#models/WebhookResult.js`                                                                       |
| `../models/YoutubeDmBinding.js`      | `#models/YoutubeDmBinding.js`                                                                    |
| `../modules/application.js`          | `#modules/application.js`                                                                        |
| `../modules/cache.js`                | `#modules/cache.js`                                                                              |
| `../modules/collection-watcher.js`   | `#modules/collection-watcher.js`                                                                 |
| `../modules/db.js`                   | `#modules/db.js`                                                                                 |
| `../utils/common.js`                 | `#utils/common.js`                                                                               |
| `../modules/redis.js`                | `#modules/redis.js`                                                                              |
| `../modules/matching.js`             | `./matching.js`                                                                                  |
| `../modules/webhook/changestream.js` | `./changestream.js`                                                                              |
| `../modules/webhook/claim.js`        | `./claim.js`                                                                                     |
| `../modules/webhook/partition.js`    | `./partition.js`                                                                                 |
| `../modules/webhook/queue.js`        | `./queue.js`                                                                                     |
| `../data/webhook.js`                 | `#modules/webhook-template.js` (Task 13 creates this path; until then keep `../data/webhook.js`) |

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

| File                                 | Old key                         | New key                    |
| ------------------------------------ | ------------------------------- | -------------------------- |
| `changestream.spec.ts`               | `../application.js`             | `#modules/application.js`  |
| `changestream.spec.ts`               | `../db.js`                      | `#modules/db.js`           |
| `changestream.spec.ts`               | `../redis.js`                   | `#modules/redis.js`        |
| `changestream.spec.ts`               | `../../models/Webhook.js`       | `#models/Webhook.js`       |
| `changestream.spec.ts`               | `./simplifyMatch.js`            | `./simplify-match.js`      |
| `partition.spec.ts`, `queue.spec.ts` | `../application.js`             | `#modules/application.js`  |
| `claim.spec.ts`                      | `../../models/WebhookResult.js` | `#models/WebhookResult.js` |
| `simplify-match.spec.ts`             | `./simplifyMatch.js`            | `./simplify-match.js`      |

- [ ] **Step 5: Repoint the dispatcher and the dev script**

In `src/index.ts`, change `"./commands/webhook.js"` to `"./services/webhook/index.js"`.

In `src/scripts/inspect-simplified-match.ts`:

| Old                                   | New                                     |
| ------------------------------------- | --------------------------------------- |
| `../models/Webhook.js`                | `#models/Webhook.js`                    |
| `../modules/db.js`                    | `#modules/db.js`                        |
| `../utils/common.js`                  | `#utils/common.js`                      |
| `../modules/webhook/simplifyMatch.js` | `../services/webhook/simplify-match.js` |

That last one is the one sanctioned import that reaches into a service. `scripts/` is not a service, so the boundary rule added in Task 16 does not cover it, and no alias exists for `services/`.

- [ ] **Step 6: Run the webhook tests first, then everything**

```bash
npm run test -- src/services/webhook
npm run build && npm run lint && npm test
```

Expected: all pass.

- [ ] **Step 7: Verify model registration still works**

```bash
npm run build
node --input-type=module -e "
  const t = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 20000);
  const { importAllModels } = await import('./dist/modules/db.js');
  await importAllModels();
  const { mongoose } = await import('@typegoose/typegoose');
  const names = Object.keys(mongoose.models).sort();
  console.log(names.length, 'models registered');
  if (names.length < 20) { console.error('too few models:', names); process.exit(1); }
  clearTimeout(t);
  process.exit(0);
"
```

Expected: at least 20 model names printed, exit 0. This is the check that `npm run build`, `npm run lint` and `npm test` all pass through silently — the webhook service resolves models by collection name at runtime, and a model that failed to register only fails when an event for that collection arrives.

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
```

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

| File                    | Old                                | New                           |
| ----------------------- | ---------------------------------- | ----------------------------- |
| `gift.ts`               | `../interfaces.js`                 | `#interfaces.js`              |
| `gift.ts`               | `../models/Gift.js`                | `#models/Gift.js`             |
| `gift.ts`               | `../models/GiftPrice.js`           | `#models/GiftPrice.js`        |
| `gift.ts`               | `../modules/cache.js`              | `#modules/cache.js`           |
| `youtube-watch-gate.ts` | `../constants.js`                  | `#constants.js`               |
| `youtube-watch-gate.ts` | `./module.js`                      | `#modules/module.js`          |
| `currency/convert.ts`   | `../../models/CurrencyExchange.js` | `#models/CurrencyExchange.js` |
| `currency/convert.ts`   | `../cache.js`                      | `#modules/cache.js`           |
| `currency/convert.ts`   | `../../data/currency.js`           | `./currency-map.js`           |

`currency/currency-map.ts` has no imports.

- [ ] **Step 4: Update the mock specifiers in the moved tests**

| File            | Old key                            | New key                   |
| --------------- | ---------------------------------- | ------------------------- |
| `gift.spec.ts`  | `../models/GiftPrice.js`           | `#models/GiftPrice.js`    |
| `gift.spec.ts`  | `../models/Gift.js`                | `#models/Gift.js`         |
| `index.spec.ts` | `../modules/youtube-watch-gate.js` | `./youtube-watch-gate.js` |
| `index.spec.ts` | `./worker.js`                      | `./index.js`              |

- [ ] **Step 5: Repoint the dispatcher**

In `src/index.ts`, change `"./commands/worker.js"` to `"./services/worker/index.js"`.

- [ ] **Step 6: Run the worker tests first, then everything**

```bash
npm run test -- src/services/worker
npm run build && npm run lint && npm test
```

Expected: all pass. `gift.spec.ts` is 711 lines and mocks the gift price model — if its mock key is wrong the failures are loud and immediate.

- [ ] **Step 7: Commit via git-master**

Stage every moved and modified path explicitly. Suggested subject: `refactor(worker): gather the gift, gate and currency code under the service`.

---

## Task 13: Move the manager service and dissolve the data directory

The last service, and the largest. `data/track.ts` and `data/webhook.ts` are shared, so they go to `modules/` rather than into manager; that empties `src/data/` and `src/components/` completely.

**Files:**

- Move: `src/commands/manager.ts` → `src/services/manager/index.ts`
- Move: `src/components/{cleanup,gift-price,video-scaler,video-stats,webhook-prepare}.ts` (+ specs) → `src/services/manager/`
- Move: `src/components/track-operator.ts` → `src/services/manager/track-operator.ts`
- Move: `src/components/youtube-dm-operator.ts` → `src/services/manager/youtube-dm-operator.ts`
- Move: `src/components/chats-archive.ts` → `src/services/manager/chats-archive/index.ts`
- Move: `src/components/chats-archive/*` → `src/services/manager/chats-archive/`
- Move: `src/data/track.ts` (+ spec) → `src/modules/track/features.ts`
- Move: `src/data/webhook.ts` (+ spec) → `src/modules/webhook-template.ts`
- Modify: `src/index.ts:42`

- [ ] **Step 1: Move the shared data files into modules**

```bash
git mv src/data/track.ts src/modules/track/features.ts
git mv src/data/track.spec.ts src/modules/track/features.spec.ts
git mv src/data/webhook.ts src/modules/webhook-template.ts
git mv src/data/webhook.spec.ts src/modules/webhook-template.spec.ts
rmdir src/data
```

`webhook-template` is a single file, not a directory with an `index.ts` — a one-file directory adds a level of nesting and no information.

- [ ] **Step 2: Convert imports in the two relocated shared files**

| File                               | Old                    | New                     |
| ---------------------------------- | ---------------------- | ----------------------- |
| `modules/track/features.ts`        | `../models/Track.js`   | `#models/Track.js`      |
| `modules/track/features.ts`        | `../models/Video.js`   | `#models/Video.js`      |
| `modules/track/features.ts`        | `../models/Webhook.js` | `#models/Webhook.js`    |
| `modules/webhook-template.ts`      | `../models/Channel.js` | `#models/Channel.js`    |
| `modules/webhook-template.ts`      | `../models/Video.js`   | `#models/Video.js`      |
| `modules/webhook-template.ts`      | `../models/Webhook.js` | `#models/Webhook.js`    |
| `modules/webhook-template.ts`      | `../utils/common.js`   | `#utils/common.js`      |
| `modules/track/features.spec.ts`   | `./track.js`           | `./features.js`         |
| `modules/webhook-template.spec.ts` | `./webhook.js`         | `./webhook-template.js` |

- [ ] **Step 3: Repoint the three files that already referenced the data directory**

| File                                               | Old                      | New                            |
| -------------------------------------------------- | ------------------------ | ------------------------------ |
| `src/modules/track/transform.ts`                   | `../../data/track.js`    | `./features.js`                |
| `src/modules/youtube-dm/transform.ts`              | `../../data/track.js`    | `../track/features.js`         |
| `src/models/Track.ts`                              | `../data/track.js`       | `#modules/track/features.js`   |
| `src/services/discord-bot/commands/track/track.ts` | `../../../data/track.js` | `#modules/track/features.js`   |
| `src/services/webhook/index.ts`                    | `../data/webhook.js`     | `#modules/webhook-template.js` |

The last two are the deferred edits noted in Tasks 10 and 11.

- [ ] **Step 4: Move the manager files**

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

- [ ] **Step 5: Convert imports in the manager entrypoint**

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

- [ ] **Step 6: Convert imports in the moved manager files**

Every `../constants.js`, `../interfaces.js`, `../models/*.js`, `../modules/*.js` and `../utils/*.js` becomes its alias. The relative edges to re-anchor:

| File                                      | Old                                                        | New                                                  |
| ----------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| `track-operator.ts`                       | `../modules/track/transform.js`                            | `#modules/track/transform.js`                        |
| `track-operator.ts`                       | `../modules/application.js`, `../modules/schedule.js`      | `#modules/application.js`, `#modules/schedule.js`    |
| `youtube-dm-operator.ts`                  | `../modules/youtube-dm/transform.js`                       | `#modules/youtube-dm/transform.js`                   |
| `youtube-dm-operator.ts`                  | `../modules/application.js`, `../modules/schedule.js`      | `#modules/application.js`, `#modules/schedule.js`    |
| `cleanup.ts`                              | `./video-stats.js`                                         | unchanged                                            |
| `webhook-prepare.ts`                      | `../data/webhook.js`                                       | `#modules/webhook-template.js`                       |
| `chats-archive/index.ts`                  | `./chats-archive/archive-video.js` and siblings            | `./archive-video.js` and siblings                    |
| `chats-archive/index.ts`                  | `../utils/esm.js`                                          | `#utils/esm.js`                                      |
| `chats-archive/gen-channel-index-file.ts` | `../video-stats.js`                                        | `../video-stats.js` (unchanged — still one level up) |
| `chats-archive/gen-index-file.ts`         | `../video-stats.js`                                        | unchanged                                            |
| `chats-archive/*.ts`                      | `../../models/*.js`, `../../constants.js`, `../../util.js` | `#models/*.js`, `#constants.js`, `#utils/common.js`  |

- [ ] **Step 7: Update the mock specifiers in the moved tests**

| File                                          | Old key                 | New key            |
| --------------------------------------------- | ----------------------- | ------------------ |
| `chats-archive/gen-daily-videos-file.spec.ts` | `./write-data-file.js`  | unchanged          |
| `chats-archive/gen-realtime-file.spec.ts`     | `./write-data-file.js`  | unchanged          |
| `chats-archive/*.spec.ts`                     | `../../models/Video.js` | `#models/Video.js` |

- [ ] **Step 8: Repoint the dispatcher**

In `src/index.ts`, change `"./commands/manager.js"` to `"./services/manager/index.js"`.

- [ ] **Step 9: Confirm the old directories are gone**

```bash
ls src
```

Expected exactly: `constants.ts  index.ts  interfaces.ts  models  modules  scripts  services  types  utils`. If `commands`, `components`, `data` or `discord` still appears, a file was missed.

- [ ] **Step 10: Run the standard checks and both runtime checks**

```bash
npm run build && npm run lint && npm test
./scripts/smoke-entrypoints.sh services
```

Expected: standard checks pass, then seven `ok` lines from the smoke check — this is the first run where all seven live under `dist/services/`, and it is the only evidence that Node's imports map resolves the moved code.

Then repeat the model-registration check from Task 11 Step 7. Expected: the same model count as before the move. A lower count means a model file left `src/models/`.

- [ ] **Step 11: Commit via git-master**

This task touches roughly 40 files across three concerns — the shared data files, the manager service, and the dispatcher. Ask git-master to split it into at least three commits: one moving `data/` into `modules/`, one moving the manager service, one repointing the dispatcher and the deferred references from Tasks 10 and 11.

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
import { simplifyMatch } from "../webhook/simplify-match.js";
```

Run:

```bash
npm run lint
```

Expected: an error on that line reading `Cross-service import into "webhook" is forbidden.` A clean pass means the `files:` glob is wrong and the rule covers nothing.

Then add a second temporary line to the same file:

```ts
import { simplifyMatch as s2 } from "../../services/webhook/simplify-match.js";
```

Run `npm run lint` again. Expected: errors on **both** lines. If only the first is reported, the second pattern is wrong.

Remove both temporary lines and re-run `npm run lint`. Expected: clean.

- [ ] **Step 4: Prove the shared-layer rule actually fires**

Add this line temporarily at the top of `src/modules/cache.ts`:

```ts
import { computeGiftPrice } from "../services/worker/gift.js";
```

Run:

```bash
npm run lint
```

Expected: an error reading `Shared code must not import service-private modules`. Remove the line and re-run. Expected: clean.

This direction matters more than it looks: without it, shared code could import one service's private module and transitively re-expose it to every other service, which is exactly the dependency inversion the whole restructure exists to prevent.

- [ ] **Step 5: Run the standard checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass, with no temporary import lines remaining. Confirm with `git diff --stat` that only `eslint.config.js` is modified.

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
- Leave alone: `docs/data-contract/README.md` — its one `src/` mention is a generic reviewer-checklist phrase, not a path

- [ ] **Step 1: Rewrite the Architecture section of AGENTS.md**

Replace the "Composition (modules vs components)" subsection with a description of the three tiers, and add these two rules under "Project conventions":

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

### Cross-service verticals

`track` and `youtube-dm` each span three services and are therefore not in one
directory. The distribution table in
[docs/superpowers/specs/2026-09-19-source-layout-restructure-design.md](docs/superpowers/specs/2026-09-19-source-layout-restructure-design.md)
lists where each part lives; when you add or move a part of either vertical,
update that table in the same commit.
```

- [ ] **Step 2: Update the writer paths in the data contract documents**

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

- [ ] **Step 3: Check for stale references across the whole repository**

```bash
grep -rn "src/components\|src/commands\|src/data/\|src/discord" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
  --exclude-dir=specs --exclude-dir=plans .
```

Expected: no output. The two excluded directories hold the design and planning documents, which describe the before state on purpose and must not be rewritten. Any hit outside them is a stale reference.

- [ ] **Step 4: Run the standard checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass. Documentation changes cannot break these, but running them confirms the tree is still clean before the final commit.

- [ ] **Step 5: Commit via git-master**

Stage `AGENTS.md` and the `docs/data-contract/` files. Ask git-master to split the rules change and the path-reference sweep into separate commits. Suggested subjects: `docs: state where a new source file belongs` and `docs(data-contract): follow the archive writer to its new path`.

---

## Final acceptance

After Task 16, all of the following must hold:

```bash
npm run build                          # passes
npm run lint                           # passes
npm test                               # passes
./scripts/smoke-entrypoints.sh services # seven ok lines, exit 0
ls src                                 # no commands/ components/ data/ discord/
```

Plus the model-registration check from Task 11 Step 7, reporting the same model count as the pre-restructure baseline.
