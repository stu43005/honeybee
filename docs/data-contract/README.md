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

| Document                               | File path pattern                     | Current active version       |
| -------------------------------------- | ------------------------------------- | ---------------------------- |
| [video-meta.md](./video-meta.md)       | `data/videos/{videoId}.meta.json`     | 2                            |
| [video-chats.md](./video-chats.md)     | `data/videos/{videoId}.jsonl`         | 2 (shared with `video-meta`) |
| [root-index.md](./root-index.md)       | `data/index.json`                     | 1 (deprecated)               |
| [channel-index.md](./channel-index.md) | `data/channels/{channelId}.json`      | 1                            |
| [realtime.md](./realtime.md)           | `data/realtime.json`                  | 1                            |
| [upcoming.md](./upcoming.md)           | `data/upcoming.json`                  | 1                            |
| [daily-videos.md](./daily-videos.md)   | `data/daily-videos/{YYYY-MM-DD}.json` | 1                            |

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
  `Revision` column, and the abbreviation form (e.g. "v2 r1" in a section header). Never as a bare noun
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

(Phase 1 is the cross-repo triage / discussion stage and is not a
honeybee PR; it is omitted from the per-PR breakdown below.)

**Phase 2a — contract preview PR.** A honeybee PR that touches only
contract markdown: adds a brand-new version chapter to the affected
file-type document; leaves the previous version chapter unchanged.
Writer keeps emitting the previous version. After merge, the tracking
issue gets the label `data-contract:awaiting-reader` and the maintainer
posts the following comment verbatim (substituting only the bracketed
placeholders):

> Contract for `{file-type}` version {N} locked at `{sha}`. Writer is
> still emitting version {N-1}. Waiting for vchat-web reader before
> flipping writer.

**Phase 3 — vchat-web ships dual-version reader.** vchat-web implements
and deploys a reader that handles both v{N-1} and v{N}. After production
deployment, vchat-web replies on the issue:

> vchat-web reader for `{file-type}` version {N} deployed at
> `{vchat-web-prod-version}`. Ready to flip writer.

`{vchat-web-prod-version}` is the vchat-web git commit SHA (7 or 40 hex
chars) currently running in production.

**Phase 2b — writer flip PR.** A second honeybee PR that updates the
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
each `{videoId}.meta.json`.

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

- [ ] The PR updates the writer to emit the new version, and the
      `Current writer emits` header is updated to the new version with
      `revision r0`.
- [ ] For `root-index` / `channel-index`: the writer is changed to write
      the new value into the `version` field of the produced JSON.
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
