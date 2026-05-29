# Cross-Repo Data Contract Mechanism — Design Spec

Date: 2026-05-29
Topic: Establish the maintenance mechanism for the data contract between
`honeybee` (writer) and `vchat-web` (reader) for the JSON / JSONL artifacts
that `chats-archive` writes under `CHAT_ARCHIVE_DIR/data/` and that are
synchronised to S3. The contract lives entirely inside the honeybee repo at
`docs/data-contract/` and is **documentation only** — no generated package, no
typings export, no runtime artifact.

This spec defines:

1. What the contract documents and what it does **not** document.
2. The versioning model and the cross-repo workflow for additive vs breaking
   changes.
3. The directory layout, per-file template, and the conventions for prose,
   schema language, and JSON examples used inside each contract document.
4. The reviewer checklist that every future spec / plan touching the contract
   must satisfy before it can be marked OKAY.

---

## 1. Scope

### 1.1 In scope

- Define a single source of truth for the shape of every file that
  `chats-archive` (or any future component) writes under
  `${CHAT_ARCHIVE_DIR}/data/` and that is consumed by `vchat-web` via S3.
- Cover the four file types currently produced:
  - `data/videos/{videoId}.meta.json`
  - `data/videos/{videoId}.jsonl`
  - `data/index.json` (root index produced by
    `src/components/chats-archive/gen-index-file.ts`)
  - `data/channels/{channelId}.json` (per-channel index produced by
    `src/components/chats-archive/gen-channel-index-file.ts`)
- Cover any future file type added under `${CHAT_ARCHIVE_DIR}/data/`: the
  contract must be extended with a new file-type document before such a file
  may be written.
- Define a per-file-type version scheme (`version` in prose, mapped to a
  concrete JSON field per file type) and a per-file-type `revision` counter
  for additive changes that live only inside the contract document.
- Define the cross-repo workflow: how vchat-web requests a contract change,
  how honeybee accepts it, and the ordering constraints between honeybee PR
  merges and vchat-web reader deployment so a breaking change cannot land
  files vchat-web cannot read.
- Define a reviewer checklist that any spec / plan touching the contract
  must pass before being marked OKAY by a review subagent.

### 1.2 Out of scope

- vchat-web reader code, internal data structures, deployment process. The
  contract describes only the bytes on S3; vchat-web's implementation
  strategy is owned by the vchat-web repo.
- Generated artefacts of any kind: no npm package, no TypeScript types
  export, no JSON Schema, no zod schema. The contract is markdown +
  TypeScript snippets + JSON examples, all consumed by humans, not imported
  by code. (TS interfaces inside the contract document are the canonical
  description; they are not exported or imported.)
- `vchat-web` pinning: `vchat-web` always reads the contract from honeybee
  `main`. There is no per-commit pin and no semver dependency.
- Internal data shapes inside honeybee (scheduler queue payloads, worker
  results, Mongo document shapes used by internal services, webhook event
  payloads, etc.). Those are program APIs, not external data contracts.
- Cross-repo automation: no generator, no CI validator, no auto-sync. The
  initial mechanism relies on human discipline plus the reviewer checklist.
  Automation may be added in a future spec; this one explicitly does not.
- Legacy version 1 files that may already exist on S3 from before the
  contract existed: the version-1 chapter of each file-type document is a
  short note that such files may exist; it does not attempt a full schema.

### 1.3 Why this design

- Per-file-type independent versioning matches the writer reality: each file
  type is produced by a different module on a different cadence, and they
  share no atomic write boundary except for the `(meta.json, jsonl)` pair
  that `archive-video.ts` writes together.
- Bumping the version only on breaking change keeps day-to-day evolution
  cheap and keeps additive changes from generating cross-repo coordination
  cost.
- Splitting a breaking change into a Phase 2a (contract-only) merge and a
  Phase 2b (writer-flip) merge with vchat-web reader deployment in between
  eliminates the "writer ahead of reader" hazard that would otherwise put
  unreadable files on S3.
- TypeScript interface syntax is the most compact and least ambiguous schema
  language for a contract that both writer and reader teams already use
  daily. JSON examples remain as a quick-read companion.

---

## 2. The contract surface

### 2.1 Storage and access path

`honeybee` writes files under the local directory `${CHAT_ARCHIVE_DIR}/data/`.
An external sync mechanism (out of scope for this spec) replicates the
directory to S3. `vchat-web` reads from S3.

The contract describes the **bytes on S3**: file path, file format, JSON
shape, ordering / atomicity guarantees if any. It does not describe the local
filesystem path, the sync mechanism, or the S3 bucket layout (those are
deployment concerns).

### 2.2 What the contract is not

The contract is not:

- An API for `vchat-web` to call. There is no HTTP / gRPC / queue interface.
- A typings package. `vchat-web` does not `import` anything from honeybee.
- An event stream. Although honeybee emits change-stream events and webhook
  events internally, those are not part of the vchat-web contract.
- A schema for honeybee's internal Mongo collections.

### 2.3 What the contract is

Plain markdown files under `docs/data-contract/`, one per file type, each
containing a normative TypeScript interface, a cumulative JSON example, and a
revision history table. Plus a `README.md` index that lists the file types,
states the versioning policy, summarises the workflow, and hosts the reviewer
checklist.

---

## 3. Versioning model

### 3.1 Terminology

The contract documents use two terms with strict meanings:

| Term         | Bump trigger                                   | Where stored                                                                       |
| ------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| **version**  | Any breaking change (see §3.4)                 | A field inside the produced JSON (the field name differs per file type — see §3.3) |
| **revision** | Any additive change (new optional field, etc.) | Only the contract markdown; the produced JSON has no revision field                |

`version` is per-file-type. Bumping `video-meta`'s version from 2 to 3 has no
effect on the version of `root-index` or any other file type. Each file type
maintains its own monotonically increasing version sequence and its own
revision counter that resets to `r0` whenever the version bumps.

In file-type documents, the prose says "version 2", "revision r1" (matching
the identifier used in section headers and history tables), or
"version 2, revision r2" (often abbreviated "v2 r2"). The `rN` token is
permitted only as a label inside section headers, the revision-history
table's `Revision` column, and the "vN rM" abbreviation; it is not used as
a bare noun in narrative prose (write "revision r1", not just "r1"). The
names `archiveVersion` and `version` (as JSON field names) are reserved for
the JSON-on-disk and must not be used as the document's prose vocabulary.

### 3.2 Old files are never rewritten

Once `honeybee` produces a file at version N, that file remains at version N
on S3 forever. The writer never goes back and re-emits an old video to bump
its version. This applies to `(meta.json, jsonl)` pairs (per-video,
immutable) and to legacy versions of any file type that may still be live on
S3.

`root-index` and `channel-index` are regenerated on a schedule, so all files
of those types converge on the current writer version after a short window;
old versions disappear by overwrite. The reader nonetheless must tolerate
either version during a deployment window (see §3.6).

### 3.3 Version carrier per file type

| File type       | Path pattern                      | Version JSON field                                                                          | DB tracking                         |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------- |
| `video-meta`    | `data/videos/{videoId}.meta.json` | `archiveVersion: number`                                                                    | `Video.hbStats.chatsArchiveVersion` |
| `video-chats`   | `data/videos/{videoId}.jsonl`     | **None** — paired with `video-meta`; reader reads the companion `meta.json` for the version | (shares `video-meta`)               |
| `root-index`    | `data/index.json`                 | `version: number` at the root object                                                        | (none — regenerated)                |
| `channel-index` | `data/channels/{channelId}.json`  | `version: number` at the root object                                                        | (none — regenerated)                |

Notes:

- `video-meta` keeps its existing field name `archiveVersion` for backward
  compatibility with files already on disk. The contract document uses the
  prose word "version" but the JSON field stays named `archiveVersion`.
- `video-chats` has no version field of its own because `archive-video.ts`
  writes `(meta.json, jsonl)` in a single archive run; the version of the
  jsonl rows is whatever the sibling `meta.json` says. The contract document
  for `video-chats` carries a "Companion file" header line stating this
  explicitly.
- `root-index` and `channel-index` do not currently have a `version` field.
  Adding the field is itself defined as the **version 2** content for those
  two file types; the absence of the field implies version 1. Readers must
  use the defensive read
  `const version = (json.version ?? 1) as number;`.

**Embedded per-video summaries inside `root-index` and `channel-index`:**
Each entry under `index.live[]`, `index.past[]`, and `channel.videos[]` is a
video summary produced by `buildVideoSummary`
(`src/components/chats-archive/build-video-summary.ts`). That summary
already carries its own `archiveVersion` field whose value mirrors
`Video.hbStats.chatsArchiveVersion` for the corresponding video.

The contract treats the embedded summary as follows:

- The **shape** of the embedded summary object (which fields exist, their
  types, optionality, units, ordering) is part of the `root-index` and
  `channel-index` contracts respectively. Each index document fully
  describes the shape of the summaries it embeds; it does not delegate the
  shape to `video-meta`.
- The **value** of `archiveVersion` inside each embedded summary is
  informational: it tells the reader which version of the corresponding
  `video-meta` file is on S3. The value is not interpreted as a version
  marker for the embedded summary itself.
- Therefore, adding an optional field to the embedded summary is an
  **additive** change to `root-index` / `channel-index` (new revision).
  Renaming, removing, or changing the type / semantic of an existing field
  in the embedded summary is a **breaking** change to those file types
  (version bump), independent of whatever `video-meta`'s own version does.
- `video-meta` may bump (additive or breaking) without affecting
  `root-index` / `channel-index` so long as the embedded summary's shape
  stays valid; and conversely `root-index` / `channel-index` may bump
  without touching `video-meta`.

### 3.4 What counts as a breaking change

Any one of the following requires a version bump:

- Renaming an existing field (at any nesting level).
- Removing an existing field, or making a previously-required field
  optional in a way that changes the data the reader sees (this is rare —
  usually rename or remove).
- Changing the TypeScript type of a field (e.g. `number` → `string`,
  `string` → `string | null`).
- Changing the semantic meaning of an existing field while keeping its name
  and type (e.g. `duration` from seconds to milliseconds; `amount` from
  cents to whole units; sort order of an array changed; enum value
  renamed).
- Changing the encoding of a field (e.g. ISO 8601 → epoch millis on the
  same field).
- Removing a file type from the contract (the writer stops producing those
  files entirely).
- For `root-index` / `channel-index` once they reach version 2 or higher:
  any change to the meaning of the `version` field is breaking (it must
  always reflect the current document's version). Inert while these file
  types are still at the implicit version 1 with no `version` field
  written.

### 3.5 What counts as additive

A change is additive (does not bump version, only adds a new revision in the
contract document) iff:

- Only new optional fields are introduced (TypeScript `?:`).
- All previously-described fields keep their name, type, semantic meaning,
  encoding, units, and ordering.
- No file type is removed.
- New file types are additive at the directory level (writer produces a new
  file type alongside existing ones). Adding a new file type does not bump
  any existing file type's version; it adds a new file-type document under
  `docs/data-contract/` starting at version 1.

### 3.6 Concurrent versions on S3

Because writers and readers deploy independently, S3 may simultaneously
contain files at multiple versions of the same file type. The reader's
guidance is:

- For `video-meta` and `video-chats`: any version that the contract has ever
  documented (and not retracted under §4.5) may be present. The reader must
  branch on `archiveVersion` and handle every documented version.
- For `root-index` and `channel-index`: at most two versions may coexist
  during a deployment window (the previous one and the current one).
  Readers must handle the current version and the one immediately before
  it; older versions are not guaranteed to be present.

---

## 4. Cross-repo workflow

The workflow has two paths. Path A is for additive changes and is one PR
end-to-end. Path B is for breaking changes and is two PRs with vchat-web
reader deployment between them.

### 4.1 Phase 0 — vchat-web draft

When vchat-web's brainstorming surfaces a need for a new field or a new file
type, it produces a single markdown document inside the vchat-web repo at
`docs/honeybee-requests/YYYY-MM-DD-{topic}.md`. The document contains:

- A field-by-field table with columns: `field`, `proposed TS type`,
  `UX purpose`, `UI behaviour when absent`, `expected update frequency`.
- A statement about new file types if any.
- An explicit preference: "request additive" or "accept breaking" (vchat-web
  signals which path it is willing to support; honeybee may push back).

The document is not a cross-repo artefact; it is vchat-web's brainstorm
output and the basis for the honeybee issue opened in Phase 1.

### 4.2 Phase 1 — honeybee triage (parallel discussion window)

Two artefacts are opened in honeybee, in parallel:

1. A GitHub issue titled with the prefix `[data-contract]`. Its body links
   to the vchat-web draft and summarises the request. The issue is the
   discussion venue: can YouTube / Holodex / Masterchat provide the data,
   what source to use, additive or breaking.
2. A GitHub PR that implements the change. The PR description links to the
   issue. The PR must include:
   - A research subagent report confirming the data is available from
     YouTube / Holodex / Masterchat (per honeybee `CLAUDE.md` rules on
     third-party package research).
   - For additive: the writer change and the matching contract markdown
     update.
   - For breaking: only the contract markdown update (see §4.4 Phase 2a;
     writer changes belong to Phase 2b).

The issue and PR may evolve in parallel until consensus is reached. The PR
must not merge until: the issue records consensus on additive vs breaking
and on the field set; the research subagent report is in the PR; the
contract markdown is complete (no TBDs, no placeholder dates or PR numbers
in the revision history row).

### 4.3 Path A — additive (single PR)

**Phase 2 — single PR merge.** The honeybee PR contains the writer change
that adds the new optional fields and the contract markdown update that adds
a new revision row to the relevant file-type document. It merges as one PR.

**Phase 3 — vchat-web at its own pace.** vchat-web does nothing immediately.
Next time vchat-web brainstorming reaches the UI feature that needs the new
field, it sees the field already documented in the contract and uses it
directly. There is no synchronisation event.

This is safe because new fields are optional. A vchat-web reader that has
not been updated reads `undefined` for the new field and behaves exactly as
it did before the field existed. The "UI behaviour when absent" column of
the Phase 0 draft already states what that behaviour is.

### 4.4 Path B — breaking (two PRs, reader deployed in between)

A breaking change must split into two honeybee PRs with vchat-web reader
deployment in between. Merging both PRs back-to-back without waiting for
vchat-web is a violation that the reviewer checklist (§7) must catch.

**Phase 2a — "contract preview" PR.** This PR touches only the contract
markdown:

- Adds a brand-new version chapter to the affected file-type document
  (e.g. `## version 3 \n ### Base shape (r0) ...`).
- Leaves the previous version chapter unchanged.
- Does not modify any writer code. The writer continues to emit the
  previous version.

After Phase 2a merges, the maintainer adds the label
`data-contract:awaiting-reader` to the issue and posts a comment in the
following form (verbatim text, only the bracketed placeholders are
substituted at write time):

> Contract for `{file-type}` version {N} locked at `{sha}`. Writer is still
> emitting version {N-1}. Waiting for vchat-web reader before flipping
> writer.

**Phase 3 — vchat-web ships dual-version reader.** vchat-web runs its full
superpowers flow (brainstorming → spec → plan → implementation) and
delivers a reader that handles both version {N-1} and version {N} of the
affected file type. After production deployment, vchat-web replies on the
honeybee issue with a comment in the following form:

> vchat-web reader for `{file-type}` version {N} deployed at
> `{vchat-web-prod-version}`. Ready to flip writer.

`{vchat-web-prod-version}` is the vchat-web git commit SHA (full 40-char or
7-char prefix) that is currently running in production. The reviewer
checklist (§7.3) requires that this looks like a hex SHA and that the
issue comment is authored by a vchat-web maintainer; verifying the SHA is
reachable from vchat-web `main` is the vchat-web team's responsibility, not
the honeybee reviewer's.

**Phase 2b — "writer flip" PR.** The honeybee maintainer opens a second PR
that:

- Changes the writer to emit version {N}. For `video-meta`, this means
  updating the `archiveVersion` literal in `archive-video.ts` and any
  related writer code that produces the new shape. For `root-index` and
  `channel-index`, this means writing the new value into the `version`
  field of the produced JSON.
- Updates the `Current writer emits` header line in the file-type document
  to `version {N}, revision r0`.
- For `video-meta` specifically: ensures the writer also updates
  `Video.hbStats.chatsArchiveVersion` to `{N}` after a successful write
  (this is the existing tracking mechanism — the change is mechanical, the
  field already exists).

When Phase 2b merges, the label on the issue moves from
`data-contract:awaiting-reader` to `data-contract:done` and the issue is
closed.

The writer implementation code for the new version may be prepared in a
feature branch ahead of Phase 2a, but it must not land on `main` until
Phase 2b.

### 4.5 Retraction window

Between Phase 2a merge and Phase 2b merge, the new version chapter exists
in the contract but no file at that version has ever been produced on S3.
During this window the change may be retracted: a reverse PR that removes
the version chapter is acceptable, and the issue is closed without label
change.

Once Phase 2b merges (or once any file at version {N} has been produced and
synced to S3 — whichever is earlier), the version chapter is frozen and may
not be removed for any reason short of a follow-up version bump.

### 4.6 Reverse direction — honeybee initiates additive

honeybee may add a new optional field to a contract on its own initiative
(no vchat-web draft). The workflow is Path A with Phase 0 skipped: open the
issue and the single PR, supply the research report, merge. vchat-web sees
the new field whenever it next brainstorms a UI that wants it.

### 4.7 Reverse direction — honeybee initiates breaking

honeybee may initiate a breaking change (e.g. correcting a unit mistake).
The full Path B applies: Phase 1 issue and Phase 2a PR open in parallel,
research report attached, contract chapter merged, vchat-web reader
deployed, then Phase 2b. vchat-web's review may push back and the issue may
end in retraction.

---

## 5. Directory structure and document template

### 5.1 Directory layout

```text
docs/data-contract/
├── README.md
├── video-meta.md
├── video-chats.md
├── root-index.md
└── channel-index.md
```

`README.md` is the entry point. The four file-type documents each describe
exactly one file type. Future file types receive new documents alongside
these four.

### 5.2 README.md content

`README.md` contains the following sections, in order:

1. **Overview** — one paragraph describing what the contract is, who reads
   it, and a pointer to this spec.
2. **File type index** — a table listing each file-type document, the file
   path pattern it describes, and the current active `version` of that file
   type.
3. **Versioning policy summary** — short prose restatement of §3, including
   the version vs revision distinction and the per-file-type independence.
4. **Breaking change checklist** — bullet list mirroring §3.4 so authors can
   quickly self-classify.
5. **Workflow summary** — a condensed restatement of §4 with Path A and
   Path B labelled.
6. **Issue and label conventions** — `[data-contract]` prefix,
   `data-contract:awaiting-reader`, `data-contract:done`.
7. **Internal tracking note** — one paragraph stating that
   `Video.hbStats.chatsArchiveVersion` is an internal honeybee field used
   to track which version of `video-meta` was generated for each video, is
   not part of the vchat-web contract, and vchat-web does not read it.
8. **Reviewer checklist** — the full text of §7 of this spec, with no
   reductions. Cross-references to §7 are not sufficient; the README must
   stand alone. When copying §7 verbatim, every cross-reference to a
   section of this spec that does **not** have a counterpart inside README
   (notably §4.4 verbatim comment templates, §5.4 frozen-chapter rule, and
   §8 initialisation note) must be expanded inline at the reference site so
   the README reader can resolve it without leaving the README. Mechanical
   transformation: replace `(per §5.4)` with the §5.4 body inlined as a
   short footnote or parenthetical; replace `specified in §4.4` with the
   verbatim quoted comment templates; replace `(§8)` with "(the one-time
   bootstrap; this clause is inert after that bootstrap is complete)".

### 5.3 Per file-type document template

Every file-type document follows this template. Headers, table column
order, and section order are fixed.

````markdown
# {File type display name} (`{file path pattern}`)

**File path pattern:** `{exact glob, e.g. data/videos/{videoId}.meta.json}`
**Companion file:** `{path or "none"}`. When a companion exists, its
version is always identical to this file's version; readers determine the
version of the file with no JSON version field by reading the companion's
version field.
**Writer:** `{relative path to writer source file}`
**Version field in JSON:** `{exact field name in the JSON, or "none — version comes from companion file"}`
**Current writer emits:** version {N}, revision r{M}

## Revision history

| Version | Revision | Date       | PR    | Summary                                     |
| ------- | -------- | ---------- | ----- | ------------------------------------------- |
| 1       | r0       | (legacy)   | —     | (one-line note; full schema not documented) |
| 2       | r0       | YYYY-MM-DD | #NNNN | initial version 2                           |
| 2       | r1       | YYYY-MM-DD | #NNNN | add field X (optional)                      |
| ...     | ...      | ...        | ...   | ...                                         |

## version 1 (legacy)

A short paragraph stating that files at this version may still exist on S3
(for `video-meta` / `video-chats`) or were the pre-versioned format (for
`root-index` / `channel-index`). Brief reader guidance: which fields are
known to have existed, or a statement that legacy files should be detected
by the absence of the version field. No full TS interface is required.

## version 2

### Base shape (r0)

```ts
interface {TypeName} {
  // ... canonical TS interface
}
```

### r1 ({YYYY-MM-DD}, PR #{NNNN})

Prose describing what was added. State which fields are new and which are
optional. State whether the field can be absent for files written by older
revisions of the same version.

### r2 ({YYYY-MM-DD}, PR #{NNNN})

Same shape as the revision r1 description above.

### Cumulative JSON example (covers r0 through r{latest})

```json
{
  // a complete example with every field of the latest revision filled in
}
```

### Reader guidance

- **Always present in this version:** `{list of fields guaranteed regardless of revision}`
- **May be absent depending on revision:** `{list, each annotated with "since r{N}"}`
- **Unknown extra fields:** ignore (forward compatibility).
- **Any version-specific quirks:** state explicitly.

## version 3 (placeholder if Phase 2a has merged but Phase 2b has not)

A version chapter with at least the Base shape, written during Phase 2a.
The `Current writer emits` header at the top of the document still points
at version 2 until Phase 2b merges.
````

Conventions:

- The TypeScript interface is the canonical description. The JSON example
  is illustrative. If the two disagree, the TS interface wins, and the spec
  / plan author must reconcile (the reviewer checklist enforces this).
- The cumulative JSON example is regenerated for every revision so it
  always reflects the latest shape of the current version.
- Each revision subsection in the version chapter remains forever; it is
  not collapsed into the base shape even after multiple revisions.
- The `Current writer emits` header is the **single source of truth** for
  what the writer is doing right now. Every PR that changes the writer's
  emitted version or revision must update this header in the same PR.
- "Companion file" appears on both `video-meta.md` and `video-chats.md`,
  pointing at each other and stating that the version is shared via the
  meta.json's `archiveVersion`.

### 5.4 Frozen old version chapters

A version chapter is frozen once any of:

- Phase 2b has merged (so writer has started emitting that version), or
- Any file at that version has been produced on S3.

Frozen chapters may receive corrections only when the diff falls into one
of two narrowly-defined categories:

1. **Typo / formatting fix.** Pure typographical, grammatical, or markdown
   formatting changes. No word that names a field, type, value, unit, or
   ordering is altered, added, or removed.
2. **Clarification sentence.** A new sentence that begins literally with
   the word `Clarification:` may be added to a Reader guidance bullet or
   to a revision subsection's prose. The clarification must not introduce
   any new field name, change an existing type or optionality marker,
   change an enum value, alter a unit or encoding, or assert a new
   ordering. The reviewer subagent confirms this by diff inspection.

Any other change to a frozen chapter is a violation. To express something
that would change the contract, create a new revision (additive change to
the current version) or a new version (breaking change). Frozen chapters
may not receive new revisions and may not be removed.

---

## 6. DB tracking

### 6.1 Why DB tracking exists

`Video.hbStats.chatsArchiveVersion` is the honeybee-internal record of which
version of `video-meta` / `video-chats` was last written for that video.
The writer (`archive-video.ts`) updates this field after a successful write.
The reader path (`buildVideoSummary` in
`src/components/chats-archive/build-video-summary.ts`) uses this field when
constructing index entries so that `root-index` and `channel-index` can
correctly tag each video with the version of its meta / jsonl pair.

### 6.2 Why it is not in the vchat-web contract

vchat-web does not read MongoDB. Its only data source is S3. The DB field
exists solely so honeybee itself can answer "what version did I last write
for video X" without re-reading the file. From vchat-web's perspective, the
version on disk in each `meta.json` is authoritative.

### 6.3 Mention in the contract

`README.md` carries a single paragraph (§5.2 item 7) acknowledging the field
exists. Individual file-type documents (`video-meta.md`,
`video-chats.md`, `root-index.md`, `channel-index.md`) do not mention it.

Workflow documents — this spec, future specs that change the contract,
and the reviewer checklist (including its verbatim copy in
`docs/data-contract/README.md`) — may reference
`Video.hbStats.chatsArchiveVersion` when describing writer obligations
during a version bump (see §4.4 Phase 2b). The boundary that excludes the
field is the four file-type markdown documents (`video-meta.md`,
`video-chats.md`, `root-index.md`, `channel-index.md`) under
`docs/data-contract/`, not `README.md` and not other documentation in the
honeybee repo.

---

## 7. Reviewer checklist

Every spec / plan that proposes a contract change must be passed by a review
subagent that runs through every applicable item below. The subagent reports
`OKAY` only when every applicable item passes; otherwise it lists the
failures.

The full checklist also lives verbatim in
`docs/data-contract/README.md` (§5.2 item 8) so reviewers do not need to
cross-reference this spec.

### 7.1 Common checks (apply to every contract change)

- [ ] Research subagent report is present in the honeybee PR confirming the
      data is obtainable from YouTube / Holodex / Masterchat. The report may
      be waived only when the PR introduces **no new field that requires a
      data source** — i.e. the change is one of: a field removal, a pure
      rename of an existing field with no change to the value's source or
      semantic, a pure documentation correction of an existing field, or
      the initial bootstrap of an existing writer's output (§8). The waiver must
      be stated explicitly in the PR description with one sentence naming
      which of these categories applies; the reviewer rejects implicit
      waivers.
- [ ] The file-type document being changed corresponds to the file path the
      spec is actually touching.
- [ ] No frozen version chapter (per §5.4) is modified except by a pure
      typo / formatting fix or by adding a sentence beginning with
      `Clarification:` that satisfies §5.4 (no field name, type,
      optionality, enum value, unit, encoding, or ordering altered).
- [ ] The revision history table has one new row added; `Version`,
      `Revision`, `Date`, and `PR` columns all have concrete values (no `TBD`,
      no empty cells).
- [ ] The cumulative JSON example at the end of the affected version
      chapter has been regenerated to reflect every revision up to and
      including the new one.
- [ ] The `Current writer emits` header at the top of the file-type
      document is updated to the values that will be true after this PR
      merges.
- [ ] Writer source code matches the contract's TypeScript interface
      (field names, optional `?:` markers, types, enum values). No drift.
- [ ] No writer source file, JSDoc, inline comment, or commit message
      body in honeybee references the contract documents — either by
      literal string or by paraphrase. Reject on any of: the literal
      strings `docs/data-contract`, `data-contract`, `contract md`,
      `contract document`, `contract spec`; or any phrase whose intent is
      to direct the reader to the markdown contract (examples: "see the
      contract", "per the contract spec", "as documented in docs/", "refer
      to the data-contract folder"). Writer source code must describe the
      field shape inline (TypeScript types, runtime checks, brief JSDoc on
      the value's meaning) without pointing at external markdown.
- [ ] If the TypeScript interface and the JSON example disagree, the TS
      interface is the canonical form and the JSON example is fixed.

### 7.2 Path A checks (additive, single PR)

- [ ] Every new field is marked optional in the TypeScript interface
      (`?:`).
- [ ] No rename, type change, semantic change, encoding change, or unit
      change is present anywhere in the diff. If any such change is present,
      the change is misclassified and must move to Path B.
- [ ] The `Reader guidance` section of the affected version chapter has
      been updated: each new field is listed under "May be absent depending on
      revision" with the annotation `since r{N}`.
- [ ] The spec / plan does not contain any reference to "Phase 2a",
      "Phase 2b", `data-contract:awaiting-reader`, or any other Path B
      vocabulary.

### 7.3 Path B checks (breaking, two PRs)

For the Phase 2a PR:

- [ ] The PR diff touches only contract markdown. No file under `src/` is
      modified.
- [ ] A new version chapter is created. The previous version chapter is
      unchanged.
- [ ] The `Current writer emits` header still reads the previous version
      (it will change in Phase 2b).
- [ ] The spec mandates that after merge, the
      `data-contract:awaiting-reader` label is added to the tracking issue
      and the maintainer posts the locking comment specified in §4.4.

For the Phase 2b PR:

- [ ] The spec states that Phase 2b may not open until the issue has a
      vchat-web "reader deployed" comment matching the form specified in §4.4.
- [ ] The PR (a) updates the writer to emit the new version, (b) updates
      the `Current writer emits` header to the new version with `revision r0`,
      and (c) for `root-index` / `channel-index`, the writer is changed to
      write the new value into the `version` field of the produced JSON.
- [ ] For `video-meta`, the Phase 2b PR updates the writer's
      `archiveVersion` literal **and** the value written to
      `Video.hbStats.chatsArchiveVersion` to the new version. (The fact
      that the writer always sets `Video.hbStats.chatsArchiveVersion` after
      a successful write is standing behaviour; this check verifies the
      bumped value lands in both places in this PR.)
- [ ] The previous version chapter is unchanged. Its `Reader guidance`
      section is intact.
- [ ] The "reader deployed" comment on the tracking issue specifies a
      `{vchat-web-prod-version}` value that looks like a git commit SHA
      (hex, 7 or 40 chars) and is authored by a vchat-web maintainer.
      Verifying the SHA is reachable from vchat-web `main` is the
      vchat-web team's responsibility, not the reviewer's.

### 7.4 vchat-web draft checks (when the spec was triggered by Phase 0)

- [ ] The vchat-web draft at
      `docs/honeybee-requests/YYYY-MM-DD-{topic}.md` in the vchat-web repo is
      linked from the honeybee issue and the honeybee PR description.
- [ ] Every new field in the draft has all four columns filled: TS type,
      UX purpose, UI behaviour when absent, expected update frequency.
- [ ] The draft makes an explicit additive / breaking preference, and the
      honeybee PR's classification matches it. If the classifications
      differ, the honeybee issue contains a comment authored by the
      honeybee maintainer that (a) quotes the vchat-web draft's preference
      verbatim, (b) states the honeybee classification, and (c) states the
      technical reason by naming which §3.4 criterion is or is not
      triggered. The reviewer rejects vague disagreement notes that lack
      one of (a), (b), (c).

### 7.5 Anti-patterns (any match → reviewer must reject)

- The same PR adds a new version chapter to the contract and flips the
  writer to emit that version. Path B requires two PRs.
- A "new field" is added without the `?:` marker on the TypeScript
  interface and the change is classified as additive.
- An existing field's units, encoding, sort order, enum, or semantic
  meaning are changed without bumping the version.
- A prior version chapter is deleted, shortened, or its `Reader guidance`
  removed.
- For `root-index` / `channel-index`, the version was bumped in the
  contract but the writer code does not actually write the new value into
  the JSON `version` field.
- Any writer source file, JSDoc, inline comment, or commit message body
  in honeybee contains the literal strings `docs/data-contract`,
  `data-contract`, `contract md`, `contract document`, `contract spec`,
  or any paraphrase whose intent is to direct the reader to the markdown
  contract (examples: "see the contract", "per the contract spec", "as
  documented in docs/", "refer to the data-contract folder"). Writer
  source must be self-explanatory inline.
- Any frozen version chapter (per §5.4) receives a change that is not
  either a pure typo / formatting fix or a `Clarification:` sentence that
  introduces no new field name, type, optionality, enum value, unit,
  encoding, or ordering.
- A vchat-web spec / plan starts before the corresponding honeybee Phase
  2a PR has merged (for Path B) or Phase 2 PR has merged (for Path A).
- A honeybee Phase 2b PR is opened without a prior "reader deployed"
  comment on the tracking issue.
- A revision history row is merged to `main` with `Date` or `PR` left as
  `TBD` or blank.

### 7.6 Reviewer operation

1. Read the spec / plan and classify it as Path A or Path B based on the
   diff intent.
2. Run §7.1 common checks.
3. Run §7.2 (Path A) or §7.3 (Path B) accordingly.
4. If the change was triggered by a vchat-web draft, also run §7.4.
5. Scan §7.5 for any anti-pattern match.
6. If any item fails, list every failure with a concrete fix suggestion;
   do not report `OKAY`. If every item passes, report `OKAY`.

---

## 8. Initialisation

This spec is the design for the mechanism, not its initial population. A
follow-up implementation plan (produced by `superpowers:writing-plans` after
this spec is approved) will execute the initialisation:

1. Create `docs/data-contract/` with `README.md` and the four file-type
   documents bootstrapped from the **current** writer code state:
   - `video-meta.md` at `Current writer emits: version 2, revision r0`,
     with `archiveVersion: 2` baked into the TS interface and the
     cumulative JSON example derived from `archive-video.ts` and
     `buildVideoSummary`.
   - `video-chats.md` at `Current writer emits: version 2, revision r0`,
     companion of `video-meta`, with the JSONL row TS interface derived
     from `buildJsonlRow` in `archive-video.ts` and from the chat document
     types it reads.
   - `root-index.md` at `Current writer emits: version 1, revision r0`,
     describing the current pre-versioned format. The implementation plan
     will not bump `root-index` to version 2 (which would mean adding a
     `version` field); a future spec may do so when justified.
   - `channel-index.md` at `Current writer emits: version 1, revision r0`,
     same posture as `root-index`.
2. Add a one-line pointer in the project `CLAUDE.md` under "Spec/plan
   authoring rules" telling spec/plan review subagents to consult the
   checklist at `docs/data-contract/README.md` when the diff touches
   `chats-archive` or `docs/data-contract/`.
3. No writer code change is part of the initialisation. The contract
   documents what the writer already produces.

The initialisation itself goes through the Path A reviewer checklist (with
the understanding that the "Revision history table has a new row added"
check is satisfied by adding the `r0` row, and the "research subagent
report" check is waived because no new data source is involved — this must
be stated explicitly in the implementation plan's spec compliance section).
