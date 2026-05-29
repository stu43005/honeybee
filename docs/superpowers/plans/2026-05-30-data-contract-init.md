# Data Contract Initialisation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap `docs/data-contract/` with `README.md` and four file-type markdown documents that document the current `chats-archive` output as the data contract between honeybee and vchat-web, and add a one-line pointer from project `CLAUDE.md` to the contract's reviewer checklist.

**Architecture:** Documentation-only. Six independent files are created or modified; no writer code changes. The four file-type documents are content-independent of each other and can be authored in parallel; `README.md` depends on the four file-type documents existing (it links to them) and must be authored last; the project `CLAUDE.md` pointer is independent.

**Tech Stack:** Markdown only. Prettier is the only formatter (auto-runs via PostToolUse hook on every Write). No tsc, no eslint, no jest involved.

**Spec compliance / Path A waiver statement (REQUIRED for the reviewer checklist):**

This plan implements §8 "Initialisation" of
[docs/superpowers/specs/2026-05-29-data-contract-design.md](../specs/2026-05-29-data-contract-design.md).
It is classified as **Path A (additive)** per §7.2. The research-subagent
report is **waived** under the §7.1 first-checklist-item exception:
_"the initial bootstrap of an existing writer's output (§8)"_. No new
field is introduced and no new data source is touched; every field, type,
and value documented in the four file-type contracts is derived from
existing writer code at:

- `src/components/chats-archive/archive-video.ts` (writes `video-meta.json`
  and `video-chats.jsonl`)
- `src/components/chats-archive/build-video-summary.ts` (produces the per-video
  summary shape embedded in `video-meta.json`, root-index, and channel-index)
- `src/components/chats-archive/gen-index-file.ts` (writes `data/index.json`)
- `src/components/chats-archive/gen-channel-index-file.ts` (writes
  `data/channels/{channelId}.json`)

The PR description for the implementing PR must reproduce this paragraph
verbatim as the waiver justification. Additionally, the §7.1 "Revision
history table has one new row added" check is satisfied for each
file-type document by adding the `r0` bootstrap row to its table.

---

## File structure

| Path                                  | Action | Owner task |
| ------------------------------------- | ------ | ---------- |
| `docs/data-contract/video-meta.md`    | Create | Task 1     |
| `docs/data-contract/video-chats.md`   | Create | Task 2     |
| `docs/data-contract/root-index.md`    | Create | Task 3     |
| `docs/data-contract/channel-index.md` | Create | Task 4     |
| `docs/data-contract/README.md`        | Create | Task 5     |
| `CLAUDE.md`                           | Modify | Task 6     |

Each file-type document follows the §5.3 template of the spec exactly:
front-matter header lines, `## Revision history` table, `## version N`
chapters with `### Base shape (rM)` / `### Cumulative JSON example` /
`### Reader guidance` subsections. Wording rules from §3.1 apply: prose
uses "version" / "revision rN"; `rN` is allowed only as a label inside
headers, the revision-history `Revision` column, and the abbreviation
"vN rM". Never as a bare noun in narrative prose.

Task 1–4 are independent and may execute in parallel under
subagent-driven-development. Task 5 (README) and Task 6 (CLAUDE.md
pointer) may execute after Tasks 1–4 are complete and committed; Task 5
is the only one with a soft content dependency (README's file-type index
table names the four file-type documents and their current versions).

---

### Task 1: `docs/data-contract/video-meta.md`

**Files:**

- Create: `docs/data-contract/video-meta.md`

**Context (derived from writer code, do not re-derive):**

`src/components/chats-archive/archive-video.ts:272-280` constructs the
meta object as:

```ts
const meta = {
  ...(await buildVideoSummary(video)), // VideoSummary fields
  archiveVersion: 2, // overrides the field from buildVideoSummary
  aggregates: {
    ...aggregates, // VideoAggregates counts
    currencyTable: currencies, // CurrencyAgg[]
    jpyTotal: jpySum, // number
  },
};
```

`buildVideoSummary` (`src/components/chats-archive/build-video-summary.ts`)
with default `includeChannel: true` returns:

```ts
{
  id: string;
  title: string;
  channel: { id: string; name: string; avatarUrl?: string };  // present
  status: string;                                              // holodex VideoStatus
  duration: number;                                            // seconds
  availableAt: string;                                         // ISO 8601, Date serialised by JSON.stringify
  archiveVersion: number;                                      // from hbStats.chatsArchiveVersion ?? 1, OVERRIDDEN in meta.json
  stats: {
    superChatTotalJpy: number;
    memberCount: number;
    giftCount: number;
  };
  scheduledStart?: string;   // ISO 8601
  actualStart?: string;      // ISO 8601
  actualEnd?: string;        // ISO 8601
  publishedAt?: string;      // ISO 8601
}
```

`VideoAggregates` and `CurrencyAgg` are declared in
`src/components/chats-archive/archive-video.ts:42-46, 302-313`:

```ts
interface CurrencyAgg {
  currency: string;
  amount: number;
  jpyAmount: number;
}

type VideoAggregates = {
  chatCount: number;
  superChatCount: number;
  superStickerCount: number;
  membershipCount: number;
  giftCount: number;
  giftPurchaseCount: number;
  totalGiftAmount: number;
  milestoneCount: number;
  pollCount: number;
  raidCount: number;
};
```

(Inside `meta.json` `aggregates` ALSO gets `currencyTable: CurrencyAgg[]`
and `jpyTotal: number` appended — see the `meta` literal above.)

- [ ] **Step 1: Write `docs/data-contract/video-meta.md`**

Use the Write tool with this exact content:

````markdown
# Video meta (`{videoId}.meta.json`)

**File path pattern:** `data/videos/{videoId}.meta.json`
**Companion file:** `data/videos/{videoId}.jsonl` — see
[video-chats.md](./video-chats.md). When a companion exists, its version
is always identical to this file's version; readers determine the version
of the file with no JSON version field by reading the companion's version
field.
**Writer:** `src/components/chats-archive/archive-video.ts`
**Version field in JSON:** `archiveVersion`
**Current writer emits:** version 2, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                                               |
| ------- | -------- | ---------- | --- | --------------------------------------------------------------------- |
| 1       | r0       | (legacy)   | —   | Pre-v2 archive output. Files may still exist on S3 from earlier runs. |
| 2       | r0       | 2026-05-30 | —   | Initial documentation of the existing v2 writer output (bootstrap).   |

## version 1 (legacy)

Files at this version may still exist on S3 for videos archived before the
v2 writer landed. Full v1 schema is not normatively documented; readers
should branch on `archiveVersion === 1` and treat all fields except `id`
and `title` as optional.

## version 2

### Base shape (r0)

```ts
interface VideoMeta {
  id: string;
  title: string;
  channel: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  status: string; // holodex VideoStatus, e.g. "new", "live", "upcoming", "past", "missing"
  duration: number; // seconds; 0 for streams that never started
  availableAt: string; // ISO 8601 timestamp
  archiveVersion: 2; // literal 2 at this version
  stats: {
    superChatTotalJpy: number;
    memberCount: number;
    giftCount: number;
  };
  scheduledStart?: string; // ISO 8601
  actualStart?: string; // ISO 8601
  actualEnd?: string; // ISO 8601
  publishedAt?: string; // ISO 8601
  aggregates: VideoAggregates;
}

interface VideoAggregates {
  chatCount: number;
  superChatCount: number;
  superStickerCount: number;
  membershipCount: number;
  giftCount: number;
  giftPurchaseCount: number;
  totalGiftAmount: number;
  milestoneCount: number;
  pollCount: number;
  raidCount: number;
  currencyTable: CurrencyAgg[];
  jpyTotal: number;
}

interface CurrencyAgg {
  currency: string; // ISO 4217 code, e.g. "USD", "JPY"
  amount: number; // sum in the original currency
  jpyAmount: number; // sum converted to JPY (may include fractional)
}
```

### Cumulative JSON example (r0)

```json
{
  "id": "abcdEFGHijk",
  "title": "Stream title",
  "channel": {
    "id": "UCxxxxxxxxxxxxxxxxxxxxxx",
    "name": "Channel name",
    "avatarUrl": "https://yt3.googleusercontent.com/.../photo.jpg"
  },
  "status": "past",
  "duration": 3600,
  "availableAt": "2026-05-29T12:00:00.000Z",
  "archiveVersion": 2,
  "stats": {
    "superChatTotalJpy": 12345,
    "memberCount": 42,
    "giftCount": 7
  },
  "scheduledStart": "2026-05-29T12:00:00.000Z",
  "actualStart": "2026-05-29T12:02:13.000Z",
  "actualEnd": "2026-05-29T13:01:55.000Z",
  "publishedAt": "2026-05-28T18:00:00.000Z",
  "aggregates": {
    "chatCount": 1500,
    "superChatCount": 30,
    "superStickerCount": 5,
    "membershipCount": 10,
    "giftCount": 7,
    "giftPurchaseCount": 2,
    "totalGiftAmount": 20,
    "milestoneCount": 3,
    "pollCount": 1,
    "raidCount": 0,
    "currencyTable": [
      { "currency": "JPY", "amount": 10000, "jpyAmount": 10000 },
      { "currency": "USD", "amount": 15, "jpyAmount": 2345 }
    ],
    "jpyTotal": 12345
  }
}
```

### Reader guidance

- **Always present in this version:** `id`, `title`, `channel.id`,
  `channel.name`, `status`, `duration`, `availableAt`, `archiveVersion`,
  `stats.superChatTotalJpy`, `stats.memberCount`, `stats.giftCount`,
  `aggregates.*` (all `*Count` fields, `currencyTable`, `jpyTotal`).
- **May be absent depending on writer state:** `channel.avatarUrl`,
  `scheduledStart`, `actualStart`, `actualEnd`, `publishedAt`.
- **Empty-stream variant:** when no chat rows were written, the writer
  still emits `meta.json` with all `aggregates` counts equal to `0`, an
  empty `currencyTable`, and `jpyTotal: 0`. The sibling `.jsonl` is
  omitted in this case.
- **Unknown extra fields:** ignore (forward compatibility).
- **Atomicity:** writer renames the `.jsonl` before the `.meta.json` so a
  reader fetching `meta.json` is guaranteed the sibling `.jsonl` is
  already in place (when a `.jsonl` exists at all).
````

- [ ] **Step 2: Verify placeholder scan (no TBD / TODO / FIXME / empty bracketed stubs)**

Run:

```bash
grep -nE "TBD|TODO|FIXME|XXX|\{[A-Z][A-Z_]+\}" docs/data-contract/video-meta.md
```

Expected: no output. (`{videoId}` in the file path pattern is the only
permitted brace expression — it's a path glob, not a fill-in stub. The
regex above matches only ALL-CAPS stubs.)

- [ ] **Step 3: Verify required section headings exist**

Run:

```bash
grep -nE "^(# Video meta|## Revision history|## version 1|## version 2|### Base shape|### Cumulative JSON example|### Reader guidance)" docs/data-contract/video-meta.md
```

Expected: 7 lines of output, one per required heading.

- [ ] **Step 4: Verify the bare-rN rule (no `r0` / `r1` / `r2` etc. used as a bare noun in narrative prose)**

The `rN` token is permitted only inside section headers, inside the
`Revision` column of the revision-history table, and inside the
abbreviation "v2 r0" form. It must not appear as a bare noun in narrative
sentences. Run:

```bash
grep -nE "\br[0-9]+\b" docs/data-contract/video-meta.md
```

Inspect each match. A match is acceptable iff it is inside one of:

- a heading line starting with `#`
- a revision-history table row (line begins with `|`)
- the `Current writer emits:` header line
- a "vN rM" abbreviation immediately preceded by `v[0-9]+ `

Reject otherwise.

- [ ] **Step 5: Commit**

```bash
git add docs/data-contract/video-meta.md
git commit -m "docs(data-contract): add video-meta.md bootstrap (v2 r0)"
```

---

### Task 2: `docs/data-contract/video-chats.md`

**Files:**

- Create: `docs/data-contract/video-chats.md`

**Context (derived from writer code):**

`src/components/chats-archive/archive-video.ts:317-420` (`buildJsonlRow`)
defines the row union. All rows have `type` and `id` (`raid` allows
`id` to be absent); "author rows" share base fields from `makeAuthorRow`
(`archive-video.ts:422-442`); per-type extras follow.

Author-base fields (chat / superChat / superSticker / membership /
membershipGift / membershipGiftPurchase / milestone). Note the Mongo
models store author content as plain strings, not as YouTube run-arrays —
the writer emits whatever is in the doc directly.

```ts
{
  type: string;
  id: string;
  timestamp: string;    // ISO 8601 (Date serialised by JSON.stringify)
  authorName?: string;
  authorPhoto?: string;
  authorChannelId: string;
  authorType: "owner" | "moderator" | "member" | "verified" | "other"; // src/interfaces.ts MessageAuthorType
  membership?: string;  // membership duration ("new" or a since-date string)
  isVerified: boolean;
  isOwner: boolean;
  isModerator: boolean;
}
```

Type-specific extras (each merged onto the author-base):

| `type`                   | Extra fields                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `chat`                   | `message: string`                                                                               |
| `superChat`              | `message: string \| null`, `amount`, `currency`, `jpyAmount`, `significance?`, `color?: string` |
| `superSticker`           | `text?`, `image: string`, `amount`, `currency`, `jpyAmount`, `significance?`, `color?: string`  |
| `membership`             | `level?`, `since?`                                                                              |
| `membershipGift`         | `senderName?`                                                                                   |
| `membershipGiftPurchase` | `amount`                                                                                        |
| `milestone`              | `message: string \| null`, `level?`, `duration?`, `since?`                                      |

Non-author row types:

```ts
// poll (archive-video.ts:376-389)
{
  type: "poll";
  id: string;
  timestamp: string;       // ISO 8601 from d.updatedAt
  createdAt?: string;      // ISO 8601
  question?: string;
  choices: { text: string; voteRatio?: number }[];
  voteCount?: number;
}

// raid received (archive-video.ts:393-403)
{
  type: "raid";
  id?: string;
  timestamp: string;
  sourceVideoId?: string;
  sourceChannelId?: string;
  sourceName: string;
  sourcePhoto?: string;
}

// raid sent out (archive-video.ts:404-413)
{
  type: "raidOutgoing";
  id?: string;
  timestamp: string;
  originVideoId: string;
  originChannelId?: string;
  originName?: string;
  originPhoto?: string;
}
```

Note: `setIfDefine` in `src/util.ts` omits the key entirely when the value
is `undefined`. So fields marked optional above are literally absent (not
explicitly `null`) when the source value is undefined.

- [ ] **Step 1: Write `docs/data-contract/video-chats.md`**

Use the Write tool with this exact content:

````markdown
# Video chats (`{videoId}.jsonl`)

**File path pattern:** `data/videos/{videoId}.jsonl`
**Companion file:** `data/videos/{videoId}.meta.json` — see
[video-meta.md](./video-meta.md). When a companion exists, its version is
always identical to this file's version; readers determine the version of
this file (which has no JSON version field of its own) by reading the
companion's `archiveVersion` field.
**Writer:** `src/components/chats-archive/archive-video.ts`
**Version field in JSON:** none — version comes from companion file.
**Current writer emits:** version 2, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                                               |
| ------- | -------- | ---------- | --- | --------------------------------------------------------------------- |
| 1       | r0       | (legacy)   | —   | Pre-v2 jsonl output. Files may still exist on S3 from earlier runs.   |
| 2       | r0       | 2026-05-30 | —   | Initial documentation of the existing v2 jsonl row union (bootstrap). |

## version 1 (legacy)

Files at this version may still exist on S3 for videos archived before the
v2 writer landed. Their row shape predates the `milestone`, `raid`,
`raidOutgoing`, `membershipGift`, and `membershipGiftPurchase` row types
shipping in their current form. Full v1 schema is not normatively
documented; readers should detect v1 by reading the companion
`meta.json`'s `archiveVersion === 1`, and may fall back to a minimal row
shape consisting of `type`, `id`, `timestamp`, and a free-form payload.

## version 2

### Base shape (r0)

The file is JSON Lines: each line is a single `JsonlRow` JSON object,
followed by `\n`. Rows are sorted ascending by `timestamp`. The
discriminator is `type`.

```ts
type JsonlRow =
  | ChatRow
  | SuperChatRow
  | SuperStickerRow
  | MembershipRow
  | MembershipGiftRow
  | MembershipGiftPurchaseRow
  | MilestoneRow
  | PollRow
  | RaidRow
  | RaidOutgoingRow;

interface AuthorRowBase {
  id: string;
  timestamp: string; // ISO 8601
  authorName?: string;
  authorPhoto?: string;
  authorChannelId: string;
  authorType: "owner" | "moderator" | "member" | "verified" | "other";
  membership?: string; // membership duration string (`"new"` or a since-date) when the author has a YouTube membership
  isVerified: boolean;
  isOwner: boolean;
  isModerator: boolean;
}

interface ChatRow extends AuthorRowBase {
  type: "chat";
  message: string; // serialised chat text (emoji segments rendered into the string)
}

interface SuperChatRow extends AuthorRowBase {
  type: "superChat";
  message: string | null;
  amount: number;
  currency: string; // ISO 4217 code
  jpyAmount: number;
  significance?: number;
  color?: string; // SuperChat color name e.g. "blue", "lightblue", "green", "yellow", "orange", "magenta", "red"
}

interface SuperStickerRow extends AuthorRowBase {
  type: "superSticker";
  text?: string;
  image: string; // image URL
  amount: number;
  currency: string;
  jpyAmount: number;
  significance?: number;
  color?: string; // SuperSticker color name
}

interface MembershipRow extends AuthorRowBase {
  type: "membership";
  level?: string;
  since?: string;
}

interface MembershipGiftRow extends AuthorRowBase {
  type: "membershipGift";
  senderName?: string;
}

interface MembershipGiftPurchaseRow extends AuthorRowBase {
  type: "membershipGiftPurchase";
  amount: number; // number of gifts purchased in this batch
}

interface MilestoneRow extends AuthorRowBase {
  type: "milestone";
  message: string | null;
  level?: string;
  duration?: number; // months
  since?: string;
}

interface PollRow {
  type: "poll";
  id: string;
  timestamp: string; // ISO 8601 from poll.updatedAt
  createdAt?: string;
  question?: string;
  choices: { text: string; voteRatio?: number }[];
  voteCount?: number;
}

interface RaidRow {
  type: "raid";
  id?: string;
  timestamp: string;
  sourceVideoId?: string;
  sourceChannelId?: string;
  sourceName: string;
  sourcePhoto?: string;
}

interface RaidOutgoingRow {
  type: "raidOutgoing";
  id?: string;
  timestamp: string;
  originVideoId: string;
  originChannelId?: string;
  originName?: string;
  originPhoto?: string;
}
```

### Cumulative JSON example (r0)

A representative sequence of three rows (one per line in the actual file):

```json
{
  "type": "chat",
  "id": "ChatAbc123",
  "timestamp": "2026-05-29T12:05:00.000Z",
  "authorName": "Someone",
  "authorChannelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
  "authorType": "verified",
  "isVerified": true,
  "isOwner": false,
  "isModerator": false,
  "message": "hello!"
}
```

```json
{
  "type": "superChat",
  "id": "SCdef456",
  "timestamp": "2026-05-29T12:07:00.000Z",
  "authorName": "Supporter",
  "authorChannelId": "UCyyyyyyyyyyyyyyyyyyyyyy",
  "authorType": "member",
  "isVerified": false,
  "isOwner": false,
  "isModerator": false,
  "message": "thanks!",
  "amount": 1000,
  "currency": "JPY",
  "jpyAmount": 1000,
  "color": "blue"
}
```

```json
{
  "type": "raid",
  "id": "Raidghi789",
  "timestamp": "2026-05-29T12:10:00.000Z",
  "sourceVideoId": "OtherVideoId",
  "sourceChannelId": "UCzzzzzzzzzzzzzzzzzzzzzz",
  "sourceName": "Other Channel"
}
```

### Reader guidance

- **Discriminator:** read `type` first; the per-type schema applies.
- **Always present on every author row:** `type`, `id`, `timestamp`,
  `authorChannelId`, `authorType`, `isVerified`, `isOwner`, `isModerator`.
- **May be absent on author rows:** `authorName`, `authorPhoto`,
  `membership`, plus the per-type optional extras shown above.
- **Always present on poll rows:** `type`, `id`, `timestamp`, `choices`.
- **Always present on raid/raidOutgoing rows:** `type`, `timestamp`, plus
  `sourceName` (raid) or `originVideoId` (raidOutgoing); `id` may be
  absent.
- **Empty file:** the `.jsonl` is **not written** when no rows are
  produced; readers must tolerate a missing `.jsonl` sibling and fall back
  to `aggregates` in `meta.json` (which will report all counts `= 0`).
- **Ordering:** rows are sorted ascending by `timestamp` (poll rows use
  `updatedAt` as their `timestamp`; readers do not need a secondary
  sort).
- **Unknown extra fields:** ignore (forward compatibility).
- **Unknown `type` values:** skip the row.
````

- [ ] **Step 2: Verify placeholder scan**

```bash
grep -nE "TBD|TODO|FIXME|XXX|\{[A-Z][A-Z_]+\}" docs/data-contract/video-chats.md
```

Expected: no output.

- [ ] **Step 3: Verify required section headings exist**

```bash
grep -nE "^(# Video chats|## Revision history|## version 1|## version 2|### Base shape|### Cumulative JSON example|### Reader guidance)" docs/data-contract/video-chats.md
```

Expected: 7 lines.

- [ ] **Step 4: Verify the bare-rN rule (see Task 1 Step 4)**

```bash
grep -nE "\br[0-9]+\b" docs/data-contract/video-chats.md
```

Inspect each match per the rule in Task 1 Step 4.

- [ ] **Step 5: Commit**

```bash
git add docs/data-contract/video-chats.md
git commit -m "docs(data-contract): add video-chats.md bootstrap (v2 r0)"
```

---

### Task 3: `docs/data-contract/root-index.md`

**Files:**

- Create: `docs/data-contract/root-index.md`

**Context (derived from writer code):**

`src/components/chats-archive/gen-index-file.ts:67-72` writes
`data/index.json` as:

```ts
{ live: liveSummaries, past: pastSummaries }
```

Each summary is the output of `buildVideoSummary(video)` called without
the `{ includeChannel: false }` option (lines 40, 60), so each entry
includes the `channel` block. The per-entry `archiveVersion` reflects
`video.hbStats.chatsArchiveVersion ?? 1` — i.e. the writer version of the
_video-meta_ file that corresponds to this entry on S3, **not** the
root-index's own version.

Root-index has no version field of its own at version 1 (its current
state); the absence of a `version` key implies version 1 per §3.3 of the
design spec. The implementation plan does **not** bump to version 2.

- [ ] **Step 1: Write `docs/data-contract/root-index.md`**

Use the Write tool with this exact content:

````markdown
# Root index (`data/index.json`)

**File path pattern:** `data/index.json`
**Companion file:** none. (When a companion exists, its version is always
identical to this file's version; readers determine the version of the
file with no JSON version field by reading the companion's version
field.)
**Writer:** `src/components/chats-archive/gen-index-file.ts`
**Version field in JSON:** none at version 1 — readers detect version
defensively as `(json.version ?? 1)`. A future bump will introduce a
`version: number` field at the root; until then the field's absence
implies version 1.
**Current writer emits:** version 1, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                                                 |
| ------- | -------- | ---------- | --- | ----------------------------------------------------------------------- |
| 1       | r0       | 2026-05-30 | —   | Initial documentation of the existing pre-versioned format (bootstrap). |

## version 1

### Base shape (r0)

```ts
interface RootIndex {
  live: VideoSummaryWithChannel[];
  past: VideoSummaryWithChannel[];
}

interface VideoSummaryWithChannel {
  id: string;
  title: string;
  channel: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  status: string; // holodex VideoStatus: "new" | "upcoming" | "live" | "past" | "missing"
  duration: number; // seconds; 0 for live/upcoming streams (true duration not yet known)
  availableAt: string; // ISO 8601
  archiveVersion: number; // archived data version for this video; 1 = legacy / not yet re-archived by the v2 writer, 2 = processed by the current archiver
  stats: {
    superChatTotalJpy: number;
    memberCount: number;
    giftCount: number;
  };
  scheduledStart?: string; // ISO 8601
  actualStart?: string; // ISO 8601
  actualEnd?: string; // ISO 8601
  publishedAt?: string; // ISO 8601
}
```

Reader version detection — treat absence of the `version` key as v1:

```ts
const version = (json.version ?? 1) as number;
```

### Cumulative JSON example (r0)

```json
{
  "live": [
    {
      "id": "liveVid001",
      "title": "Currently live stream",
      "channel": {
        "id": "UCaaaaaaaaaaaaaaaaaaaaaa",
        "name": "Channel A",
        "avatarUrl": "https://yt3.googleusercontent.com/.../a.jpg"
      },
      "status": "live",
      "duration": 0,
      "availableAt": "2026-05-30T08:00:00.000Z",
      "archiveVersion": 2,
      "stats": { "superChatTotalJpy": 0, "memberCount": 0, "giftCount": 0 },
      "scheduledStart": "2026-05-30T08:00:00.000Z",
      "actualStart": "2026-05-30T08:01:12.000Z"
    }
  ],
  "past": [
    {
      "id": "pastVid001",
      "title": "Recently ended stream",
      "channel": {
        "id": "UCbbbbbbbbbbbbbbbbbbbbbb",
        "name": "Channel B"
      },
      "status": "past",
      "duration": 7200,
      "availableAt": "2026-05-29T10:00:00.000Z",
      "archiveVersion": 2,
      "stats": { "superChatTotalJpy": 5000, "memberCount": 12, "giftCount": 1 },
      "scheduledStart": "2026-05-29T10:00:00.000Z",
      "actualStart": "2026-05-29T10:01:00.000Z",
      "actualEnd": "2026-05-29T12:01:00.000Z",
      "publishedAt": "2026-05-29T09:00:00.000Z"
    }
  ]
}
```

### Reader guidance

- **Version detection:** absence of a `version` key implies version 1.
- **Always present at root:** `live`, `past`. Either array may be empty.
- **Always present per video summary:** `id`, `title`, `channel.id`,
  `channel.name`, `status`, `duration`, `availableAt`, `archiveVersion`,
  `stats.superChatTotalJpy`, `stats.memberCount`, `stats.giftCount`.
- **May be absent per video summary:** `channel.avatarUrl`,
  `scheduledStart`, `actualStart`, `actualEnd`, `publishedAt`.
- **Embedded `archiveVersion`:** the corresponding video's archived data
  version. Values currently observed in production are `1` (legacy,
  pre-v2 archive on S3 with the old shape; will not be re-archived) and
  `2` (current v2 archive). Use this to decide which `video-meta.json`
  schema to apply when navigating to the per-video file. This is **not**
  the root-index's own version.
- **Ordering:** `live` is sorted ascending by `availableAt`; `past` is
  sorted descending by `availableAt`.
- **Regeneration cadence:** root-index is regenerated on a schedule by
  `manager`. During a deployment window readers may observe at most two
  versions (the previous and the current). Older versions are not
  guaranteed to be present.
- **Unknown extra fields:** ignore (forward compatibility).
````

- [ ] **Step 2: Verify placeholder scan**

```bash
grep -nE "TBD|TODO|FIXME|XXX|\{[A-Z][A-Z_]+\}" docs/data-contract/root-index.md
```

Expected: no output.

- [ ] **Step 3: Verify required section headings exist**

```bash
grep -nE "^(# Root index|## Revision history|## version 1|### Base shape|### Cumulative JSON example|### Reader guidance)" docs/data-contract/root-index.md
```

Expected: 6 lines.

- [ ] **Step 4: Verify the bare-rN rule (see Task 1 Step 4)**

```bash
grep -nE "\br[0-9]+\b" docs/data-contract/root-index.md
```

Inspect per Task 1 Step 4.

- [ ] **Step 5: Commit**

```bash
git add docs/data-contract/root-index.md
git commit -m "docs(data-contract): add root-index.md bootstrap (v1 r0)"
```

---

### Task 4: `docs/data-contract/channel-index.md`

**Files:**

- Create: `docs/data-contract/channel-index.md`

**Context (derived from writer code):**

`src/components/chats-archive/gen-channel-index-file.ts:48-67` writes
`data/channels/{channelId}.json` only when at least one video exists for
the channel. The shape is:

```ts
{ id, name, avatarUrl?, videos: VideoSummary[] }
```

Each `videos[]` entry is `buildVideoSummary(video, { includeChannel: false })`
— so the entry has **no** `channel` block. The file is **not written** at
all when the channel has zero matching videos (see line 48-51: returns
early).

Like root-index, channel-index has no version field at version 1.

- [ ] **Step 1: Write `docs/data-contract/channel-index.md`**

Use the Write tool with this exact content:

````markdown
# Channel index (`data/channels/{channelId}.json`)

**File path pattern:** `data/channels/{channelId}.json`
**Companion file:** none. (When a companion exists, its version is always
identical to this file's version; readers determine the version of the
file with no JSON version field by reading the companion's version
field.)
**Writer:** `src/components/chats-archive/gen-channel-index-file.ts`
**Version field in JSON:** none at version 1 — readers detect version
defensively as `(json.version ?? 1)`. A future bump will introduce a
`version: number` field at the root; until then the field's absence
implies version 1.
**Current writer emits:** version 1, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                                                 |
| ------- | -------- | ---------- | --- | ----------------------------------------------------------------------- |
| 1       | r0       | 2026-05-30 | —   | Initial documentation of the existing pre-versioned format (bootstrap). |

## version 1

### Base shape (r0)

```ts
interface ChannelIndex {
  id: string;
  name: string;
  avatarUrl?: string;
  videos: VideoSummaryNoChannel[];
}

interface VideoSummaryNoChannel {
  id: string;
  title: string;
  status: string; // holodex VideoStatus: "new" | "upcoming" | "live" | "past" | "missing"
  duration: number; // seconds; 0 for live/upcoming streams (true duration not yet known)
  availableAt: string; // ISO 8601
  archiveVersion: number; // archived data version for this video; 1 = legacy / not yet re-archived by the v2 writer, 2 = processed by the current archiver
  stats: {
    superChatTotalJpy: number;
    memberCount: number;
    giftCount: number;
  };
  scheduledStart?: string;
  actualStart?: string;
  actualEnd?: string;
  publishedAt?: string;
}
```

Reader version detection — treat absence of the `version` key as v1:

```ts
const version = (json.version ?? 1) as number;
```

### Cumulative JSON example (r0)

```json
{
  "id": "UCaaaaaaaaaaaaaaaaaaaaaa",
  "name": "Channel A",
  "avatarUrl": "https://yt3.googleusercontent.com/.../a.jpg",
  "videos": [
    {
      "id": "vidA001",
      "title": "Most recent stream",
      "status": "past",
      "duration": 7200,
      "availableAt": "2026-05-30T08:00:00.000Z",
      "archiveVersion": 2,
      "stats": { "superChatTotalJpy": 5000, "memberCount": 12, "giftCount": 1 },
      "scheduledStart": "2026-05-30T08:00:00.000Z",
      "actualStart": "2026-05-30T08:01:00.000Z",
      "actualEnd": "2026-05-30T10:01:00.000Z",
      "publishedAt": "2026-05-30T07:00:00.000Z"
    }
  ]
}
```

### Reader guidance

- **Version detection:** absence of a `version` key implies version 1.
- **File absence:** the file is **not written** when the channel has
  zero videos in the last 100 (post-archive). Readers must tolerate a
  404 / missing key in S3 for any given channelId and treat it as "no
  archived content yet for this channel".
- **Always present at root:** `id`, `name`, `videos` (non-empty when the
  file exists).
- **May be absent at root:** `avatarUrl`.
- **Always present per video summary:** `id`, `title`, `status`,
  `duration`, `availableAt`, `archiveVersion`, `stats.*`.
- **May be absent per video summary:** `scheduledStart`, `actualStart`,
  `actualEnd`, `publishedAt`. The entry has **no** `channel` field — to
  identify the channel, use the root `id` / `name` of the index file.
- **Embedded `archiveVersion`:** the corresponding video's archived data
  version. Values currently observed in production are `1` (legacy,
  pre-v2 archive on S3 with the old shape; will not be re-archived) and
  `2` (current v2 archive). Use this to decide which `video-meta.json`
  schema to apply when navigating to the per-video file. This is **not**
  the channel-index's own version.
- **Ordering:** `videos` is sorted descending by `availableAt` (newest
  first), truncated to the most recent 100.
- **Regeneration cadence:** rewritten whenever the root-index regen
  encounters a video for this channel. Same two-version coexistence
  window as root-index applies.
- **Unknown extra fields:** ignore (forward compatibility).
````

- [ ] **Step 2: Verify placeholder scan**

```bash
grep -nE "TBD|TODO|FIXME|XXX|\{[A-Z][A-Z_]+\}" docs/data-contract/channel-index.md
```

Expected: no output. (`{channelId}` in the file path pattern is permitted
because the regex excludes lowercase-starting braced names.)

- [ ] **Step 3: Verify required section headings exist**

```bash
grep -nE "^(# Channel index|## Revision history|## version 1|### Base shape|### Cumulative JSON example|### Reader guidance)" docs/data-contract/channel-index.md
```

Expected: 6 lines.

- [ ] **Step 4: Verify the bare-rN rule (see Task 1 Step 4)**

```bash
grep -nE "\br[0-9]+\b" docs/data-contract/channel-index.md
```

Inspect per Task 1 Step 4.

- [ ] **Step 5: Commit**

```bash
git add docs/data-contract/channel-index.md
git commit -m "docs(data-contract): add channel-index.md bootstrap (v1 r0)"
```

---

### Task 5: `docs/data-contract/README.md`

**Files:**

- Create: `docs/data-contract/README.md`

**Dependency note:** This task must run after Tasks 1–4 are committed
because the file-type index table names the four documents and their
current versions. The reviewer-checklist body in this README is the
verbatim copy of §7 of the design spec, with cross-references expanded
inline per §5.2 item 8 of the design spec (replace `(§8)`, `§5.4`, and
`§4.4` references with their inlined content).

- [ ] **Step 1: Write `docs/data-contract/README.md`**

Use the Write tool with this exact content:

```markdown
# Honeybee data contract

## 1. Overview

This directory is the single source of truth for the shape of files that
`chats-archive` writes under `${CHAT_ARCHIVE_DIR}/data/` and that are
synchronised to S3 for consumption by `vchat-web`. The contract is
documentation only: there is no generated package, no published
typings, and no runtime artifact. Each file-type document describes one
output file's path pattern, the writer that produces it, the JSON shape
(as TypeScript interfaces), a cumulative JSON example, and a reader
guidance section. This README is a reader-facing index plus the reviewer
checklist; it stands alone and does not require the reader to consult any
other document.

## 2. File type index

| Document                               | File path pattern                 | Current active version       |
| -------------------------------------- | --------------------------------- | ---------------------------- |
| [video-meta.md](./video-meta.md)       | `data/videos/{videoId}.meta.json` | 2                            |
| [video-chats.md](./video-chats.md)     | `data/videos/{videoId}.jsonl`     | 2 (shared with `video-meta`) |
| [root-index.md](./root-index.md)       | `data/index.json`                 | 1                            |
| [channel-index.md](./channel-index.md) | `data/channels/{channelId}.json`  | 1                            |

## 3. Versioning policy summary

- Every file type has its **own** `version` sequence. Bumping
  `video-meta`'s version does not affect `root-index` or any other file
  type.
- `version` bumps only on a **breaking** change (see §4).
- **Additive** changes (new optional field, etc.) add a new **revision**
  inside the current version's chapter, labelled `r0`, `r1`, `r2`, … in
  section headers. The revision counter lives only in the contract
  markdown. It is **not** written into the JSON file.
- Old files at older versions are never retroactively rewritten. For
  `video-meta` / `video-chats`, multiple versions coexist on S3 forever.
  For `root-index` / `channel-index` (regenerated on a schedule), at most
  two versions coexist during a deployment window.
- Prose vocabulary: **"version"** and **"revision"**. The `rN` token
  appears only as a label inside section headers, the revision-history
  `Revision` column, and the abbreviation "vN rM". Never as a bare noun
  in narrative prose.

## 4. Breaking change checklist

Any one of the following requires a `version` bump on the affected file
type:

- Renaming an existing field (at any nesting level).
- Removing an existing field, or making a previously-required field
  optional in a way that changes the data the reader sees.
- Changing the TypeScript type of a field.
- Changing the semantic meaning of an existing field (e.g. `duration`
  from seconds to milliseconds, sort order changed, enum value renamed).
- Changing the encoding of a field (e.g. ISO 8601 → epoch millis).
- Removing a file type from the contract.
- For `root-index` / `channel-index` once they reach version 2 or
  higher: any change to the meaning of the `version` field is breaking
  (inert while still at the implicit version 1).

Additive (no version bump; add a new revision to the current version
chapter):

- New optional fields only (TypeScript `?:`).
- All previously-described fields keep their name, type, semantic
  meaning, encoding, units, and ordering.
- A new file type added under `${CHAT_ARCHIVE_DIR}/data/` is additive at
  the directory level (new file-type document starting at version 1; no
  existing file type's version bumps).

## 5. Workflow summary

There are two paths:

**Path A — additive (single PR).** vchat-web's request (or honeybee's
own additive idea) is implemented in one honeybee PR that adds the
writer change and the matching contract markdown revision. vchat-web
needs no immediate action; the new optional fields show up the next time
vchat-web brainstorms a UI that wants them.

**Path B — breaking (two PRs).** Used whenever a change matches the
Breaking change checklist above.

1. **Phase 2a — contract preview PR.** A honeybee PR that touches only
   contract markdown: adds a brand-new version chapter to the affected
   file-type document; leaves the previous version chapter unchanged.
   Writer keeps emitting the previous version. After merge, the tracking
   issue gets the label `data-contract:awaiting-reader` and the
   maintainer posts the following comment verbatim (substituting only
   the bracketed placeholders):

   > Contract for `{file-type}` version {N} locked at `{sha}`. Writer is
   > still emitting version {N-1}. Waiting for vchat-web reader before
   > flipping writer.

2. **Phase 3 — vchat-web ships dual-version reader.** vchat-web
   implements and deploys a reader that handles both v{N-1} and v{N}.
   After production deployment, vchat-web replies on the issue:

   > vchat-web reader for `{file-type}` version {N} deployed at
   > `{vchat-web-prod-version}`. Ready to flip writer.

   `{vchat-web-prod-version}` is the vchat-web git commit SHA (7 or 40
   hex chars) currently running in production.

3. **Phase 2b — writer flip PR.** A second honeybee PR that updates the
   writer to emit v{N} (and, for `video-meta`, also bumps the value
   written to `Video.hbStats.chatsArchiveVersion`). Phase 2b may not
   open until the Phase 3 deployment comment is posted. After merge,
   the issue label moves from `data-contract:awaiting-reader` to
   `data-contract:done` and the issue is closed.

## 6. Issue and label conventions

- GitHub issue title prefix: `[data-contract]`
- Labels:
  - `data-contract:awaiting-reader` — added after Phase 2a merges; signals
    that vchat-web reader work is the blocker for Phase 2b.
  - `data-contract:done` — added (replacing `awaiting-reader`) after
    Phase 2b merges; issue is closed.

## 7. Internal tracking note

`Video.hbStats.chatsArchiveVersion` is an internal honeybee MongoDB field
on the `Video` collection. It records which version of the `video-meta` /
`video-chats` pair was last produced for that video, and is used by
honeybee itself to (a) decide whether to re-archive and (b) populate the
informational `archiveVersion` field embedded in `root-index` /
`channel-index` per-video summaries. This field is **not** part of the
vchat-web contract — vchat-web does not read MongoDB. The per-file
authoritative version on S3 is whatever `archiveVersion` reads inside
each `meta.json`.

## 8. Reviewer checklist

Every spec / plan that proposes a contract change must be passed by a
review subagent that runs through every applicable item below. The
subagent reports `OKAY` only when every applicable item passes; otherwise
it lists the failures.

### 8.1 Common checks (apply to every contract change)

- [ ] Research subagent report is present in the honeybee PR confirming
      the data is obtainable from YouTube / Holodex / Masterchat. The
      report may be waived only when the PR introduces **no new field
      that requires a data source** — i.e. the change is one of: a field
      removal, a pure rename of an existing field with no change to the
      value's source or semantic, a pure documentation correction of an
      existing field, or the **initial bootstrap of an existing writer's
      output** (the one-time bootstrap; this clause is inert after that
      bootstrap is complete). The waiver must be stated explicitly in the PR
      description with one sentence naming which of these categories
      applies; the reviewer rejects implicit waivers.
- [ ] The file-type document being changed corresponds to the file path
      the spec is actually touching.
- [ ] No frozen version chapter is modified except by a pure
      typo / formatting fix or by adding a sentence beginning with
      `Clarification:` that satisfies the frozen-chapter rule (no field
      name, type, optionality, enum value, unit, encoding, or ordering
      altered). A version chapter becomes frozen once the writer has
      started emitting that version OR any file at that version has been
      produced on S3.
- [ ] The revision history table has one new row added; `Version`,
      `Revision`, `Date`, and `PR` columns all have concrete values
      (no `TBD`, no empty cells).
- [ ] The cumulative JSON example at the end of the affected version
      chapter has been regenerated to reflect every revision up to and
      including the new one.
- [ ] The `Current writer emits` header at the top of the file-type
      document is updated to the values that will be true after this PR
      merges.
- [ ] Writer source code matches the contract's TypeScript interface
      (field names, optional `?:` markers, types, enum values). No
      drift.
- [ ] No writer source file, JSDoc, inline comment, or commit message
      body in honeybee references the contract documents — either by
      literal string or by paraphrase. Reject on any of: the literal
      strings `docs/data-contract`, `data-contract`, `contract md`,
      `contract document`, `contract spec`; or any phrase whose intent is
      to direct the reader to the markdown contract (examples: "see the
      contract", "per the contract spec", "as documented in docs/",
      "refer to the data-contract folder"). Writer source code must
      describe the field shape inline (TypeScript types, runtime checks,
      brief JSDoc on the value's meaning) without pointing at external
      markdown.
- [ ] If the TypeScript interface and the JSON example disagree, the TS
      interface is the canonical form and the JSON example is fixed.

### 8.2 Path A checks (additive, single PR)

- [ ] Every new field is marked optional in the TypeScript interface
      (`?:`).
- [ ] No rename, type change, semantic change, encoding change, or unit
      change is present anywhere in the diff. If any such change is
      present, the change is misclassified and must move to Path B.
- [ ] The `Reader guidance` section of the affected version chapter has
      been updated: each new field is listed under "May be absent
      depending on revision" with the annotation `since rN`.
- [ ] The spec / plan does not contain any reference to "Phase 2a",
      "Phase 2b", `data-contract:awaiting-reader`, or any other Path B
      vocabulary.

### 8.3 Path B checks (breaking, two PRs)

For the Phase 2a PR:

- [ ] The PR diff touches only contract markdown. No file under `src/`
      is modified.
- [ ] A new version chapter is created. The previous version chapter is
      unchanged.
- [ ] The `Current writer emits` header still reads the previous
      version (it will change in Phase 2b).
- [ ] The spec mandates that after merge, the
      `data-contract:awaiting-reader` label is added to the tracking
      issue and the maintainer posts the following locking comment
      verbatim (substituting only the bracketed placeholders):

      > Contract for `{file-type}` version {N} locked at `{sha}`. Writer
      > is still emitting version {N-1}. Waiting for vchat-web reader
      > before flipping writer.

For the Phase 2b PR:

- [ ] The spec states that Phase 2b may not open until the issue has a
      vchat-web "reader deployed" comment of the following form:

      > vchat-web reader for `{file-type}` version {N} deployed at
      > `{vchat-web-prod-version}`. Ready to flip writer.

- [ ] The PR (a) updates the writer to emit the new version, (b) updates
      the `Current writer emits` header to the new version with `revision
r0`, and (c) for `root-index` / `channel-index`, the writer is
      changed to write the new value into the `version` field of the
      produced JSON.
- [ ] For `video-meta`, the Phase 2b PR updates the writer's
      `archiveVersion` literal **and** the value written to
      `Video.hbStats.chatsArchiveVersion` to the new version. (The fact
      that the writer always sets `Video.hbStats.chatsArchiveVersion`
      after a successful write is standing behaviour; this check
      verifies the bumped value lands in both places in this PR.)
- [ ] The previous version chapter is unchanged. Its `Reader guidance`
      section is intact.
- [ ] The "reader deployed" comment on the tracking issue specifies a
      `{vchat-web-prod-version}` value that looks like a git commit SHA
      (hex, 7 or 40 chars) and is authored by a vchat-web maintainer.
      Verifying the SHA is reachable from vchat-web `main` is the
      vchat-web team's responsibility, not the reviewer's.

### 8.4 vchat-web draft checks (when the spec was triggered by a vchat-web request)

- [ ] The vchat-web draft at
      `docs/honeybee-requests/YYYY-MM-DD-{topic}.md` in the vchat-web
      repo is linked from the honeybee issue and the honeybee PR
      description.
- [ ] Every new field in the draft has all four columns filled: TS type,
      UX purpose, UI behaviour when absent, expected update frequency.
- [ ] The draft makes an explicit additive / breaking preference, and
      the honeybee PR's classification matches it. If the
      classifications differ, the honeybee issue contains a comment
      authored by the honeybee maintainer that (a) quotes the vchat-web
      draft's preference verbatim, (b) states the honeybee
      classification, and (c) states the technical reason by naming
      which §4 (Breaking change checklist) criterion is or is not
      triggered. The reviewer rejects vague disagreement notes that
      lack one of (a), (b), (c).

### 8.5 Anti-patterns (any match → reviewer must reject)

- The same PR adds a new version chapter to the contract and flips the
  writer to emit that version. Path B requires two PRs.
- A "new field" is added without the `?:` marker on the TypeScript
  interface and the change is classified as additive.
- An existing field's units, encoding, sort order, enum, or semantic
  meaning are changed without bumping the version.
- A prior version chapter is deleted, shortened, or its
  `Reader guidance` removed.
- For `root-index` / `channel-index`, the version was bumped in the
  contract but the writer code does not actually write the new value
  into the JSON `version` field.
- Any writer source file, JSDoc, inline comment, or commit message body
  in honeybee contains the literal strings `docs/data-contract`,
  `data-contract`, `contract md`, `contract document`, `contract spec`,
  or any paraphrase whose intent is to direct the reader to the
  markdown contract (examples: "see the contract", "per the contract
  spec", "as documented in docs/", "refer to the data-contract folder").
  Writer source must be self-explanatory inline.
- Any frozen version chapter receives a change that is not either a
  pure typo / formatting fix or a `Clarification:` sentence that
  introduces no new field name, type, optionality, enum value, unit,
  encoding, or ordering.
- A vchat-web spec / plan starts before the corresponding honeybee
  Phase 2a PR has merged (for Path B) or Phase 2 PR has merged (for
  Path A).
- A honeybee Phase 2b PR is opened without a prior "reader deployed"
  comment on the tracking issue.
- A revision history row is merged to `main` with `Date` or `PR` left
  as `TBD` or blank.

### 8.6 Reviewer operation

1. Read the spec / plan and classify it as Path A or Path B based on
   the diff intent.
2. Run §8.1 common checks.
3. Run §8.2 (Path A) or §8.3 (Path B) accordingly.
4. If the change was triggered by a vchat-web draft, also run §8.4.
5. Scan §8.5 for any anti-pattern match.
6. If any item fails, list every failure with a concrete fix
   suggestion; do not report `OKAY`. If every item passes, report
   `OKAY`.
```

- [ ] **Step 2: Verify placeholder scan**

```bash
grep -nE "TBD|TODO|FIXME|XXX|\{[A-Z][A-Z_]+\}" docs/data-contract/README.md
```

Expected: matches are only inside example comment templates (the verbatim
locking comment and reader-deployed comment quote `{file-type}`, `{N}`,
`{sha}`, `{vchat-web-prod-version}` — these are template placeholders
the reader is expected to substitute when filling out the comment, **not**
fill-in stubs in the README itself). All other matches should be zero.
Manually inspect each match to confirm it falls in one of those two
quoted templates.

- [ ] **Step 3: Verify the four file-type docs are linked and named correctly**

```bash
grep -nE "\[(video-meta|video-chats|root-index|channel-index)\.md\]" docs/data-contract/README.md
```

Expected: at least 4 lines, one link per file-type doc.

- [ ] **Step 4: Verify required top-level sections exist**

```bash
grep -nE "^## [0-9]+\." docs/data-contract/README.md
```

Expected: 8 lines (sections 1 through 8).

- [ ] **Step 5: Verify the bare-rN rule (see Task 1 Step 4)**

```bash
grep -nE "\br[0-9]+\b" docs/data-contract/README.md
```

Inspect per Task 1 Step 4. The phrases "revision rN" inside checklist
items count as a label use (the `rN` is part of the named identifier
being described), which is permitted.

- [ ] **Step 6: Commit**

```bash
git add docs/data-contract/README.md
git commit -m "docs(data-contract): add README.md with file-type index and reviewer checklist"
```

---

### Task 6: Pointer in project `CLAUDE.md`

**Files:**

- Modify: `CLAUDE.md` (project root)

**Context:** The design spec §8 step 2 mandates a one-line pointer in
project `CLAUDE.md` under the "Spec/plan authoring rules" section
directing spec / plan review subagents to consult the contract checklist
whenever the diff touches `chats-archive` or `docs/data-contract/`.

- [ ] **Step 1: Confirm CLAUDE.md ends with "Spec/plan authoring rules" and locate the last existing subsection**

Run:

```bash
grep -nE "^(## |### )" CLAUDE.md | tail -10
```

Expected: the last `## ` line is `## Spec/plan authoring rules` (no
later `## ` heading exists in the file). The very last `### ` line is
`### Reuse existing util helpers; do not re-invent`. The new
`### Data contract checklist` subsection will be appended **at end of
file**, which structurally places it inside `## Spec/plan authoring
rules` (since no later `## ` section closes it).

- [ ] **Step 2: Append the new subsection at end of file**

Use the Edit tool. `old_string` is the verbatim final sentence of the
last existing subsection (`### Reuse existing util helpers; do not
re-invent`). `new_string` is that same sentence followed by a blank line
and the new subsection.

`old_string`:

```
helper whose behavior is already covered by an export from these files; fix
the call site to use the existing helper instead.
```

`new_string`:

```
helper whose behavior is already covered by an export from these files; fix
the call site to use the existing helper instead.

### Data contract checklist

When the PR diff touches `src/components/chats-archive/` or
`docs/data-contract/`, the spec / plan review subagent must additionally pass
the checklist at
[docs/data-contract/README.md](docs/data-contract/README.md) §8 before
reporting `OKAY`.
```

The new subsection's body is one sentence per spec §8 step 2 ("one-line
pointer"); it does not duplicate any checklist content, only points at
the README.

- [ ] **Step 3: Verify the new subsection landed in the right place**

Run:

```bash
grep -nE "^## Spec/plan authoring rules$|^### Data contract checklist$|^## " CLAUDE.md
```

Expected output (three lines, in this order):

1. `<N>:## Spec/plan authoring rules`
2. `<M>:### Data contract checklist` with `M > N`
3. No additional `^## ` line appears between line `N` and line `M`
   (i.e. the new subsection sits inside "Spec/plan authoring rules", not
   after a different `## ` section). If a `^## ` line appears between
   them, the edit went in the wrong place — revert and retry.

- [ ] **Step 4: Verify the link target exists**

```bash
test -f docs/data-contract/README.md && echo OK
```

Expected: `OK`. (This task runs after Task 5, so README.md must exist.)

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): point spec/plan reviewer at docs/data-contract/README.md checklist"
```

---

## Spec coverage summary

| Spec section                                       | Implementing task                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| §8 step 1, `video-meta.md` bootstrap               | Task 1                                                                  |
| §8 step 1, `video-chats.md` bootstrap              | Task 2                                                                  |
| §8 step 1, `root-index.md` bootstrap               | Task 3                                                                  |
| §8 step 1, `channel-index.md` bootstrap            | Task 4                                                                  |
| §5.2 README.md content (items 1–8)                 | Task 5                                                                  |
| §5.2 item 8 verbatim-with-inlined-refs requirement | Task 5 (the §8 block of README inlines the §4.4 / §5.4 / §8 references) |
| §8 step 2 CLAUDE.md pointer                        | Task 6                                                                  |
| §8 step 3 "no writer code change"                  | Implicit; no task modifies `src/`.                                      |
| §7.1 research-subagent waiver justification        | Plan-level "Spec compliance" paragraph above.                           |
| §7.2 Path A classification                         | Plan-level "Spec compliance" paragraph above.                           |

## Out-of-scope reminders for the implementer

- **Do not** modify any file under `src/`. This plan is documentation
  only.
- **Do not** add `version` fields to `data/index.json` or
  `data/channels/{channelId}.json`. The implementation plan explicitly
  leaves `root-index` and `channel-index` at version 1 with no JSON
  `version` key; a future spec may bump them.
- **Do not** include any writer-source-side reference to
  `docs/data-contract` (per the anti-pattern list).
- **Do not** invoke `npm run lint`, `tsc`, or `npm test`; this plan
  touches no TypeScript source. Prettier autoformats markdown via the
  PostToolUse hook; no manual formatting step is required.
