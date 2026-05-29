# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project

Honeybee is a distributed YouTube live chat and moderation events collector. A
scheduler polls Holodex for upcoming/live streams, queues per-video jobs, and a
worker pool collects chat events via
[@stu43005/masterchat](https://www.npmjs.com/package/@stu43005/masterchat) and
writes them to MongoDB. Side services run a Discord bot, a webhook dispatcher, a
PubSubHubbub crawler, and a Prometheus metrics endpoint.

## Commands

- `npm run build` — compile TypeScript to `dist/` (also chmod the CLI entry)
- `npm run dev` — `tsc -w` watch build
- `npm run lint` / `npm run lint:fix` — ESLint over `src/`
- `npm run format` / `npm run format:check` — Prettier
- `npm test` — Jest (requires `NODE_OPTIONS=--experimental-vm-modules`, ESM)
- Single test:
  `NODE_OPTIONS='--experimental-vm-modules' npx jest src/models/Channel.spec.ts`
  (or a `-t "<name>"` filter)
- Run a service locally after build:
  `node dist/index.js <scheduler|worker|discord-bot|webhook|crawler|manager|metrics>`
  (or `honeybee` / `hb` once installed)
- Local stack: `docker-compose up` (see `CONTRIBUTING.md`); production manifests
  in `k8s/` driven by `Makefile` (`make build`, `make deploy`, `make logs`).

Node ≥ 24 required. ESM-only project (`"type": "module"`); always import with
`.js` extensions in source even though files are `.ts` (NodeNext resolution).

## Architecture

### Entrypoint and processes

`src/index.ts` is a thin yargs dispatcher that lazy-imports one of seven
long-running commands in `src/commands/`. Each command is a separate
process/deployment in k8s:

- **scheduler** — watches the `Video` collection via change streams and enqueues
  per-video jobs onto the `honeybee` Bee-Queue when a stream becomes eligible
  (it does **not** key off `actualStart`).
- **worker** — pulls jobs from the `honeybee` Bee-Queue, instantiates a
  `Masterchat` client per video, normalizes actions into typed Mongo documents
  (Chat, SuperChat, Membership, Ban/RemoveChat, Poll, Raid, Milestone, Banner,
  ModeChange, Placeholder, Track stats, etc.), and reports `HoneybeeResult`
  back.
- **crawler** — combined ingestion service for new-video discovery: Holodex
  polling, YouTube PubSubHubbub subscriber (`youtube-notification`), and YouTube
  Data API lookups.
- **manager** — runs the bulk of the project's scheduled / periodic work via
  Agenda. It is mostly a thin scheduling shell; the actual task logic lives in
  `src/components/` (e.g. `track-operator.ts`, `video-scaler.ts`, `cleanup.ts`,
  `chats-archive/`, `webhook-prepare.ts`, `video-stats.ts`).
- **webhook** — partition-sharded service that consumes Mongo change streams and
  dispatches matching events to user-defined webhooks via the `webhook`
  Bee-Queue. The architecture (partition assignment, heartbeat, rebalance,
  dispatch pipeline) is specified in
  [docs/superpowers/specs/2026-04-15-webhook-horizontal-scaling-design.md](docs/superpowers/specs/2026-04-15-webhook-horizontal-scaling-design.md);
  read that before changing anything in this service. `src/modules/webhook/`
  contains only the supporting code for that design.
- **discord-bot** — discord.js bot.
- **metrics** — Prometheus `/metrics` HTTP endpoint via `prom-client`.

### Composition (modules vs components)

- `src/modules/` — long-lived infrastructure singletons composed via the
  `Application` container in
  [src/modules/application.ts](src/modules/application.ts). Each `Module`
  exposes `init()` / `close()`; `Application.use()` registers them and
  `SHUTDOWN_TIMEOUT` (45s, < k8s 60s grace) bounds graceful drain. Examples:
  `MongodbModule`, `QueueModule` (Bee-Queue), `AgendaModule`, `RedisModule`,
  `HttpServerModule`, `CollectionWatcher`, `RateLimiter`, `Cache`.
- `src/components/` — higher-level orchestration units that compose modules to
  perform a domain task (e.g., `chats-archive/`, `track-operator.ts`,
  `video-scaler.ts`, `webhook-prepare.ts`, `cleanup.ts`).
- `src/models/` — Typegoose schemas. Each file exports both the class and a
  default `Model`. Tests sit alongside (`*.spec.ts`).
- `src/data/` — static reference data (currency table, track config, webhook
  templates).
- `src/discord/` — discord-bot command modules.
- `src/modules/webhook/` — webhook subsystem internals (partitioning, dispatch,
  templating via `json-templates`).

### Cross-cutting

- **"Job" is overloaded — keep them straight:**
  1. **Bee-Queue jobs** ([src/modules/queue.ts](src/modules/queue.ts)) — two
     named queues: `honeybee` (scheduler → worker; jobs keyed by `videoId`, with
     `:N` suffix for replicas) and `webhook` (change-stream consumer → webhook
     dispatcher). Job payload types are `HoneybeeJob` / `WebhookJob` in
     [src/interfaces.ts](src/interfaces.ts); worker reports back via
     `HoneybeeResult` / `HoneybeeStatus` (`Created` / `Progress` / `Finished` /
     `Failed` / `Retrying` / `Stalled`).
  2. **Agenda jobs** ([src/modules/schedule.ts](src/modules/schedule.ts)) —
     cron-style periodic tasks (mainly driven by the `manager` service, with
     some scheduler-side periodics). Use Agenda when work is time-driven; use
     Bee-Queue when work is event-driven and needs durable per-item delivery to
     a worker pool.
- **Change streams**: both the scheduler (video lifecycle) and webhook service
  rely on Mongo change streams. Do not break replica-set assumptions; local dev
  requires `rs.initiate()`.
- **Configuration** is environment-variable driven; all envs are centralized in
  [src/constants.ts](src/constants.ts) (Holodex, Redis, MongoDB, archive dir,
  webhook partition tuning, etc.). Read this file before adding a new env var —
  there are non-obvious invariants documented in comments (e.g.
  `SHUTDOWN_TIMEOUT < terminationGracePeriodSeconds`, partition TTL = 3×
  heartbeat).
- **Hono JSX** is configured (`tsconfig.json` `jsxImportSource: "hono/jsx"`) and
  used by webhook templates / archive page rendering.

### Build/runtime quirks

- `tsconfig.json` excludes `**/*.spec.ts` and `tests/` from the build but Jest
  still picks them up via `ts-jest`.
- `src/utils/esm.ts` contains ESM-specific helpers (e.g. `__dirname` shims).
  Prefer importing from there over re-creating the pattern.
- `experimentalDecorators` + `emitDecoratorMetadata` are required for Typegoose
  models; do not disable.

## When adding code

- New long-running service → add a yargs subcommand in `src/index.ts` and a
  runner in `src/commands/` that builds an `Application`, `app.use(...)`s the
  modules it needs, and awaits `app.run()`/shutdown signals.
- New Mongo collection → add a Typegoose model in `src/models/`, follow the
  pattern of existing files (named export of class + default-exported
  `getModelForClass(...)`).
- New scheduled task → add it to `manager` via Agenda and put the actual
  implementation in `src/components/` rather than inline in
  `src/commands/manager.ts`.

## Project conventions

These have come up repeatedly in past spec/plan reviews. Treat them as load-bearing.

### Connections always go through a Module

Never call `createClient()` (or equivalent) at a callsite. Redis main client comes
from `RedisModule.redis`; pub/sub subscriber from `RedisModule.getSubscriber()`
(lazy, shared). Connection lifecycle is owned by `Application.use/close`; a
consumer only `unsubscribe`s its own listener and must not `disconnect()`.

### Application close order is LIFO

`Application.close()` runs registered modules in reverse `app.use()` order. When
adding a new module, place its `app.use(...)` so that:

- modules that must leave first (so peers can take over their work) are
  registered last
- downstream modules (queue consumers, change streams) are registered after
  their upstream (Redis, Mongo) so they close before the upstream they depend on

If a new module breaks either property, fix the registration order, not the
module's `close()` body.

## Spec/plan authoring rules

In addition to the global rules in `~/.claude/CLAUDE.md`, the following are
project-specific common pitfalls. Each spec/plan review subagent must check for
these before reporting OKAY.

### Document reference leaks (zero tolerance, recurring)

Code blocks (including JSDoc, inline comments, test `describe`/`it` strings, and
commit-message bodies generated by the plan) must not contain references to the
spec or plan itself. Before declaring a Task ready for review, grep the Task's
code blocks for: `§`, `\bspec\b`, `\bplan\b`, `Task \d`, `Layer \d`, `①②③`, and
the Chinese phrases 「依/根據/見/參考」+「設計/規格/計畫」. Any hit is a leak —
inline the actual technical content into the comment instead.

### Third-party package behavior must be verified, not guessed

The global rule already requires research subagents for third-party API usage.
For the four packages listed below, context7 documentation is **insufficient** —
the research subagent must read the actual source under `node_modules/` to
confirm behavior:

- `bee-queue` — lifecycle completion guarantees (`close()` does _not_ await
  `succeeded` listener async work), atomicity of state transitions,
  `queue.on(...)` event scope (local EventEmitter, not Redis pub/sub),
  `stallInterval` semantics
- `@redis/client` (node-redis v4) — `WatchError` pattern (not the ioredis
  null-check idiom), return types (`exists` returns a number, use `> 0`),
  `SET PX` vs `SET EX` units
- `mongoose` change streams — resume token handling, replica-set assumptions,
  `operationType` exact values
- `@stu43005/masterchat` — action shapes, abort semantics, error class hierarchy

### Package management in plans

Plan steps that touch `package.json` must follow these rules:

- Do **not** write `npm install <pkg>@<version>` to "ensure" a version — npm
  rewrites the existing caret/tilde range. Instead: `grep` the version in
  `node_modules/<pkg>/package.json` and only run `npm install` if missing.
- Verify whether the package is in `dependencies` vs `devDependencies` before
  any task that runtime-imports it. Runtime imports (anything reachable from
  `src/index.ts` at production runtime) must live in `dependencies`.
- ESM exports maps may block `require('<pkg>/package.json')` even from a
  Node/CommonJS verification snippet. Use `grep` on the file in `node_modules/`
  instead.

### Time-unit convention

New time-related constants are named with a `_MS` suffix and stored as
milliseconds. Pair with Redis `SET PX` (not `EX`) so callsites never need
`* 1000`. Each new constant carries a one-line comment explaining the chosen
value (why this number, what it tolerates, what it trades off).

### Avoid logic-free abstractions

When a spec or plan extracts a sub-component / helper module, it must answer
"what logic does this hold?" If the answer is "it just wraps JSX", "it just
re-exports", or "it just gives the boilerplate a name", inline it. The
brainstorming → spec review subagent must reject extractions whose body is
exclusively boilerplate.

### Test strength checklist

Every `it`/`test` produced by a plan must satisfy all three:

1. At least one structural assertion (`toEqual`, ordering check, snapshot) —
   `toHaveBeenCalled` alone is insufficient.
2. Lifecycle / timer / promise-based behavior is awaited via an explicit drain
   point (a `Set` of in-flight promises, an event awaited with `once`, etc.) —
   not via "wait for the event" without confirming the listener finished.
3. State changes in mocked dependencies (Redis, Mongo, queue) use stateful
   fakes, not bare `jest.fn()` — e.g. `DEL` followed by `EXISTS` must observably
   return 0 in the same test.

The plan-Task review subagent enforces this per `it`.

### Entry-only signals must be parameters in sub-files

`isMain(import.meta)`, `process.argv[1]` checks, and other "am I the entry
module?" detectors only return the truthful answer in the actual entry file.
Read them once at the entry, then pass the value down as an explicit parameter
(`isDirect`, `fromCli`, etc.). Sub-files importing these helpers and calling
them locally is a bug — they always see `false`.

### Type casts belong inside helpers, not at callsites

When a helper needs a loosely-typed view of its input (`unknown`,
`Record<string, unknown>`, or a per-variant downcast), do the cast once inside
the helper. Either accept the typed-union as the parameter and `switch` /
downcast per variant internally, or accept `unknown` and cast at the function
boundary. Never push `as unknown as Record<string, unknown>` (or an analogous
boundary cast) onto every callsite — callsites should pass the already-typed
value and read clean. If you find yourself writing the same cast at three or
more callsites, the helper signature is wrong; fix the helper instead of
repeating the cast.

### Field iteration over typed documents must be type-driven

When copying or iterating fields of a typed document (Mongoose / Typegoose
model, discriminated union, any object with a known shape):

- Do not cast to `Record<string, unknown>` just to enable bracket access. The
  cast disables tsc's typo detection — a wrong field name becomes a silent
  runtime no-op instead of a compile error.
- Drive the loop with an `as const` tuple of `keyof T` literals, e.g.
  `(["actualStart", "actualEnd", "duration"] as const).forEach(k => ...)`.
  Field names are then checked against the type at build time, and the same
  tuple can be shared between multiple emit / projection paths so the field
  set stays in sync.

### Reuse existing util helpers; do not re-invent

Before introducing a new local helper for any "common" operation, grep
`src/util.ts` and `src/utils/` for an existing equivalent. Match on behavior,
not on name — a helper with a different name but the same semantics still
counts as a duplicate. The spec/plan review subagent must reject any new local
helper whose behavior is already covered by an export from these files; fix
the call site to use the existing helper instead.

### Data contract checklist

When the PR diff touches `src/components/chats-archive/` or
`docs/data-contract/`, the spec / plan review subagent must additionally pass
the checklist at
[docs/data-contract/README.md](docs/data-contract/README.md) §8 before
reporting `OKAY`.
