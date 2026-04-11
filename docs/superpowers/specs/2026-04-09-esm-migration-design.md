# ESM Migration Design Spec

## Overview

Major refactoring of the honeybee project to modernize the codebase:

- Convert from CommonJS to ESM
- Support TypeScript 6 + Node.js 24 LTS
- Add ESLint (linter) + Prettier (formatter)
- Configure Jest for ESM
- Switch package manager from yarn classic to npm
- Change TypeScript output directory from `lib/` to `dist/`
- Remove `kafka-connect/` and `scripts/` directories
- Implement lazy-loading for CLI commands
- Dynamic model loading for ESM compatibility

## Approach

**ts2esm auto-conversion + manual follow-up (Approach A)**

Use `ts2esm` to automatically add `.js` extensions to all import/export paths, then manually handle configuration, `__dirname` replacement, lazy-loading, and cleanup. This is the most pragmatic approach for a private application with no external consumers.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Typegoose decorators | Keep `experimentalDecorators` + `emitDecoratorMetadata` | Typegoose does not support TC39 decorators yet |
| Test strategy | Configure Jest + ESM infrastructure only | Only 1 existing test; new tests deferred to later |
| Node.js version | `>=24` only | Clean break, no legacy compat needed |
| `__dirname` replacement | Utility module with `import.meta.url` + `fileURLToPath` | Reusable pattern across codebase |
| kafka-connect / scripts removal | Full cleanup including CI, Docker, Makefile | No orphaned references |

---

## Section 1: Project Base Configuration

### package.json

- Add `"type": "module"`
- `"main"`: `lib/index.js` -> `dist/index.js`
- `"bin"`: both `honeybee` and `hb` point to `dist/index.js`
- `"engines"`: `{ "node": ">=24" }`
- Remove `yarn.lock`, generate `package-lock.json` via `npm install`
- Update `build` script for `dist/` output

### tsconfig.json

- `"module"`: `"commonjs"` -> `"NodeNext"`
- `"moduleResolution"`: `"node"` -> `"NodeNext"`
- `"target"`: `"es2021"` -> `"es2024"`
- `"outDir"`: `"./lib"` -> `"./dist"`
- Keep `"experimentalDecorators": true` + `"emitDecoratorMetadata": true` (Typegoose)
- `"exclude"`: `"lib"` -> `"dist"`

### .gitignore

- `lib/` -> `dist/`
- Ensure `node_modules/` is listed

### Dockerfile

- Base image: Node 20 -> Node 24
- All `lib/` paths -> `dist/`
- `yarn` commands -> `npm ci` / `npm run build`

### CI / GitHub Workflows

- `docker.yml`: remove kafka-connect build job
- All `yarn` commands -> `npm`

---

## Section 2: ESM Migration Core

### ts2esm Auto-Conversion

- Run `npx ts2esm tsconfig.json` to add `.js` extensions to all import/export paths
- Handles directory imports -> `./dir/index.js`
- Adds `with { type: 'json' }` for JSON imports if any

### `__dirname` / `__filename` Replacement

Create `src/utils/esm.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { argv } from 'node:process';
import { createRequire } from 'node:module';

export const __filename = (meta: ImportMeta): string => fileURLToPath(meta.url);

export const __dirname = (meta: ImportMeta): string => dirname(__filename(meta));

export const isMain = (meta: ImportMeta): boolean => {
  if (!meta || !argv[1]) return false;
  const require = createRequire(meta.url);
  const scriptPath = require.resolve(argv[1]);
  const modulePath = __filename(meta);
  return scriptPath === modulePath;
};
```

Replace all `__dirname` / `__filename` usage:
```ts
import { __dirname } from '../utils/esm.js';
const dir = __dirname(import.meta);
```

Replace `require.main === module` pattern (used in `src/components/chats-archive.ts`):
```ts
import { isMain } from '../utils/esm.js';
if (isMain(import.meta)) {
  // direct execution logic
}
```

### importAllModels Dynamic Loading

`src/modules/db.ts` — change `require()` to `import()`:

```ts
export async function importAllModels(): Promise<void> {
  const modelsDir = path.join(__dirname(import.meta), '..', 'models');
  for (const file of await fsp.readdir(modelsDir, { withFileTypes: true })) {
    if (
      file.isFile() &&
      !file.name.endsWith('.d.ts') &&
      !file.name.endsWith('.spec.js') &&
      !file.name.endsWith('.spec.ts') &&
      !file.name.endsWith('.test.js') &&
      !file.name.endsWith('.test.ts')
    ) {
      await import(path.join(modelsDir, file.name));
    }
  }
}
```

Note: `importAllModels` is already `async`, so switching from `require()` to `await import()` is seamless.

### New Module: redis.ts

`src/modules/redis.ts` is a new module currently in development. It will be included in the ESM migration (import paths, module syntax).

### Other CJS -> ESM Changes

- All `require()` calls -> `import()` or static `import`
- `module.exports` -> `export` / `export default` (handled by ts2esm)

---

## Section 3: Lazy-Loading CLI Commands

### Current State

`src/index.ts` statically imports all 7 command modules at startup, loading all dependencies regardless of which subcommand runs.

### New Pattern

Use yargs builder/handler with dynamic `import()`:

```ts
#!/usr/bin/env node

import yargs from "yargs";

process.on("unhandledRejection", (err) => {
  console.log("CLI got unhandledRejection", err);
  process.exit(1);
});

process.on("uncaughtException", async (err) => {
  console.log("CLI got uncaughtException", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("Keyboard interrupt");
  process.exit(0);
});

yargs(process.argv.slice(2))
  .scriptName("honeybee")
  .command("scheduler", "start scheduler", {}, async () => {
    const { runScheduler } = await import("./commands/scheduler.js");
    await runScheduler();
  })
  .command("worker", "start worker", {}, async () => {
    const { runWorker } = await import("./commands/worker.js");
    await runWorker();
  })
  .command("discord-bot", "start discord bot", {}, async () => {
    const { runDiscordBot } = await import("./commands/discord-bot.js");
    await runDiscordBot();
  })
  .command("webhook", "start webhook service", {}, async () => {
    const { runWebhook } = await import("./commands/webhook.js");
    await runWebhook();
  })
  .command("crawler", "start crawler", {}, async () => {
    const { runCrawler } = await import("./commands/crawler.js");
    await runCrawler();
  })
  .command("manager", "start manager", {}, async () => {
    const { runManager } = await import("./commands/manager.js");
    await runManager();
  })
  .command("metrics", "Prometheus metrics endpoint", {}, async () => {
    const { metrics } = await import("./commands/metrics.js");
    await metrics();
  })
  .demandCommand(1).argv;
```

### Benefits

- Only the selected command's dependencies are loaded at runtime
- Faster startup time and lower memory usage
- No changes needed to individual command module internals

---

## Section 4: ESLint + Prettier

### ESLint

ESLint v9 flat config (`eslint.config.js`):

- `@eslint/js` for base JS rules
- `typescript-eslint` for TS parser + rules
- Enable `recommended` / `recommended-type-checked` rule sets
- `parserOptions.projectService: true` for type-aware linting
- `eslint-config-prettier` to disable format-conflicting rules

### Prettier

- Keep existing `.prettierrc` (extend as needed)
- Add `prettier` to devDependencies

### Scripts

```json
{
  "lint": "eslint src/",
  "lint:fix": "eslint src/ --fix",
  "format": "prettier --write src/",
  "format:check": "prettier --check src/"
}
```

### Principle

- ESLint: logic quality (unused vars, type safety)
- Prettier: formatting (indentation, semicolons, quotes)
- No conflicts via `eslint-config-prettier`

---

## Section 5: Jest + ESM

### Configuration

- `jest.config.js` -> `jest.config.ts` (ESM `export default`)
- Use `ts-jest` ESM preset: `ts-jest/presets/default-esm`
- `transform` with `ts-jest` + `useESM: true`
- `extensionsToTreatAsEsm: ['.ts']`

### Execution

```json
{
  "test": "NODE_OPTIONS='--experimental-vm-modules' jest"
}
```

### Existing Tests

- `Channel.spec.ts` import paths updated to use `.js` extensions (consistent with main code)

---

## Section 6: Cleanup

### Remove kafka-connect/

- Delete `kafka-connect/` directory
- Remove kafka-connect build job from `docker.yml`
- Remove kafka-connect services from `docker-compose.yml` / `docker-compose.production.yml` if present

### Remove scripts/

- Delete `scripts/` directory (`unique.js`, `kafka-consumer.js`, `agg.js`, `hg`, `changestream-consumer.js`)

### Remove Old Artifacts

- Delete `yarn.lock`
- Delete `lib/` directory if present in repo
- `.gitignore`: `lib/` -> `dist/`

### Clean Up devDependencies

- Remove `ts-node` (no longer needed; tsc compilation used)
- Evaluate if `shx` is still needed (used for `chmod +x` in build script)
