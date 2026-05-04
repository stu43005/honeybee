# Chats Archive — TSX Refactor Design

**Date**: 2026-05-04
**Target file**: `src/components/chats-archive.ts` (current ~927 lines)
**Goal**: Replace string-template HTML generation with `hono/jsx` TSX components, while preserving the row-by-row streaming behavior of static HTML file output.

---

## 1. Background

`src/components/chats-archive.ts` is an Agenda job that generates static HTML archives of YouTube live chat data:

- Per-video archive page (`archiveVideo`) — large pages with potentially tens of thousands of chat rows, written to `${CHAT_ARCHIVE_DIR}/${channelId}/${date}_${videoId}.html`.
- Top-level index page (`genIndexFile`) — live + past video cards.
- Per-channel index page (`genChannelIndexFile`) — recent videos for one channel.

Current implementation builds HTML with template strings written directly to a `fs.createWriteStream` (`ws.write(...)`). Per-video rows are streamed as they are read from a merged Mongo cursor (`multiCursorOrderedPeek`). The job calls `await job?.touch()` once per row to maintain Agenda's lock; Agenda internally throttles the persisted touch to once per half-timeout, so per-row cost is negligible.

User-supplied content (`video.title`, `chat.authorName`, `milestone.message`, etc.) is currently **not HTML-escaped** when interpolated into template strings, which is a latent XSS risk. `chat.message` has been confirmed by the user to be plain text (not HTML-rich), so auto-escaping is a clean improvement with no rendering regression.

## 2. Goals

1. Replace template-string HTML in `chats-archive.ts` with `hono/jsx` TSX components.
2. Preserve row-by-row streaming for the per-video archive page.
3. Preserve `await job?.touch()` keepalive inside the row loop.
4. Split the file by responsibility: control layer (`.ts`, no JSX) vs. presentation layer (`.tsx`).
5. Auto-escape user-supplied content via hono/jsx default escaping.
6. Keep the dev runner (`isMain(import.meta)` block) functional for manual verification.
7. Output must be DOM-equivalent to the existing implementation: same tag/attribute/class set such that the existing toggle JavaScript continues to work without modification.

## 3. Non-Goals

- Byte-for-byte identical HTML output. Whitespace, attribute order, and self-closing-tag form are allowed to differ as `hono/jsx` decides.
- Component-level unit tests. Verification is by manual visual diff against pre-refactor output (see §10).
- Restructuring the Agenda job schedule, the cursor-merge algorithm, or the file-naming/path scheme.
- Migrating other files in the codebase to JSX. Only this single feature is converted.
- Introducing the full Hono framework. Only the `hono/jsx` and `hono/html` submodules are used; no router, server, or middleware is imported.

## 4. JSX Runtime Choice

**`hono/jsx`** (Hono v4.12.16, latest stable as of 2026-05-04).

- Renders JSX directly to HTML strings via `element.toString()`.
- Supports async function components; `.toString()` returns `Promise<string>` whenever any async child is present, and `string` otherwise. Rendering code uses `await element.toString()` uniformly to be safe in both cases.
- Auto-escapes string children and attribute values by default.
- For raw HTML injection: `raw()` from `hono/html` (also re-exported from `hono/jsx`).
- For `<style>` and `<script>` body content: hono/jsx escapes these by default; raw insertion uses `dangerouslySetInnerHTML={{ __html: cssOrJsString }}`.
- `Fragment` is exported from `hono/jsx`; shorthand `<>...</>` is supported via `react-jsx` transform.

### tsconfig.json changes

Add to `compilerOptions`:

```jsonc
{
  "jsx": "react-jsx",
  "jsxImportSource": "hono/jsx",
}
```

`jsxImportSource` is global. The project currently has zero `.tsx` files and no other JSX runtime, so this option does not collide with existing code. Future introduction of a second JSX runtime would require per-file `/** @jsxImportSource ... */` pragmas or `tsconfig` project references; out of scope for this refactor.

### package.json changes

Add to `dependencies`:

```
"hono": "^4.12.16"
```

Only `hono/jsx` and `hono/html` submodules are imported.

## 5. File Layout

```
src/components/
├── chats-archive.ts                       # control layer (no JSX, .ts)
└── chats-archive/
    └── templates/
        ├── format.tsx                     # formatCurrency, FormattedTimestamp, getTimestamp, getVideoPath
        ├── VideoArchive.tsx               # per-video page shell + 9 ChatRow variants
        ├── IndexPage.tsx                  # top-level index shell
        ├── ChannelIndexPage.tsx           # per-channel index shell
        └── VideoCard.tsx                  # shared video card (used by IndexPage and ChannelIndexPage)
```

Approximate sizes:

| File                             | Approx. lines |
| -------------------------------- | ------------- |
| `chats-archive.ts`               | ~250          |
| `templates/format.tsx`           | ~60           |
| `templates/VideoArchive.tsx`     | ~280          |
| `templates/IndexPage.tsx`        | ~80           |
| `templates/ChannelIndexPage.tsx` | ~60           |
| `templates/VideoCard.tsx`        | ~70           |

### Control vs. presentation boundary

- **Control layer (`chats-archive.ts`)** owns: Agenda registration; DB cursor open/iterate (`VideoModel`, `VideoStatsModel`, `ChatModel`, `SuperChatModel`, `SuperStickerModel`, `MembershipModel`, `MembershipGiftModel`, `MembershipGiftPurchaseModel`, `MilestoneModel`, `PollModel`, `RaidModel`, `ChannelModel`); `multiCursorOrderedPeek`; `recalcVideoHbStats` invocation; file IO (`createWriteStream`, `mkdir`, `rename`, `unlink`); `archiveVideo` / `genIndexFile` / `genChannelIndexFile` / `archiveAllChats` orchestration; the `isMain(import.meta)` dev runner.
- **Presentation layer (`templates/*.tsx`)** owns: HTML structure, CSS strings, toggle script string, JSX components. Components accept **plain props** only — never raw mongoose documents traversed for fields the component does not name. (Where it is more ergonomic to pass a `DocumentType<Video>` because the component reads many of its fields, that is allowed; the rule is no DB calls, no mongoose-specific operations like `.populate()` or `.find()`, no IO.)

## 6. Streaming Hot-Path Mechanism

JSX trees must be balanced — splitting an HTML page into "open shell" and "close shell" via two separate JSX components is not expressible. To stream rows between two halves of a JSX-authored page, this design uses the **placeholder + split** pattern:

1. The full page is authored as one JSX component (e.g., `<VideoArchivePage>`).
2. At the position where rows belong, a sentinel HTML comment is emitted via `raw(ROWS_MARKER)`.
3. After `.toString()`, the resulting string is split on the marker into `[head, tail]`.
4. The control layer writes `head`, streams each row's rendered string, then writes `tail`.

Sentinel: `<!--HONEYBEE_ROWS-->`. HTML-comment form ensures `raw()` preserves it verbatim and the marker cannot collide with normal escaped output.

`<!DOCTYPE html>` cannot be represented inside a JSX tree (true for hono/jsx and React alike). The shell render helper prepends `"<!DOCTYPE html>"` to the head string explicitly.

### Per-video archive (`archiveVideo`)

Template exports (in `VideoArchive.tsx`):

```ts
export async function renderVideoArchiveShell(props: {
  video: DocumentType<Video>;
  currencies: { _id: string; amount: number; jpyAmount: number }[];
  jpySum: number;
}): Promise<[head: string, tail: string]>;

export async function renderChatRow(props: {
  doc: DocumentType<
    | Chat
    | SuperChat
    | SuperSticker
    | Membership
    | MembershipGift
    | MembershipGiftPurchase
    | Milestone
    | Poll
    | Raid
  >;
  no: number;
  video: DocumentType<Video>;
}): Promise<string>;
```

Control-layer flow inside `archiveVideo`:

```ts
const [head, tail] = await renderVideoArchiveShell({
  video,
  currencies,
  jpySum,
});
ws.write(head);
let no = 0;
for await (const doc of multiCursorOrderedPeek(...cursors)) {
  no++;
  ws.write(await renderChatRow({ doc, no, video }));
  await job?.touch();
}
ws.write(tail);
ws.end();
```

If `no === 0` after the loop, the existing "delete tmp file, return" branch is preserved. The tmp-file → final-file `rename` is unchanged.

### Index pages (`genIndexFile`, `genChannelIndexFile`)

Same placeholder+split pattern, with two markers for `genIndexFile` (one between live and past tabs):

```ts
// IndexPage.tsx
export async function renderIndexShell(): Promise<
  [head: string, between: string, tail: string]
>;
export async function renderVideoCard(props: VideoCardProps): Promise<string>;

// ChannelIndexPage.tsx
export async function renderChannelIndexShell(props: {
  channel: DocumentType<Channel>;
}): Promise<[head: string, tail: string]>;
```

`genIndexFile` flow:

```ts
const [head, between, tail] = await renderIndexShell();
ws.write(head);
for await (const video of liveVideosCursor) {
  // existing skip logic preserved
  channelIds.add(video.channelId);
  ws.write(
    await renderVideoCard({
      video,
      channel: await video.getChannel(),
      basePath: "",
      hbStats: video.hbStats,
    })
  );
  if (isMain(import.meta)) await archiveVideo(video.id);
}
ws.write(between);
for await (const video of pastVideosCursor) {
  // existing skip logic preserved
  channelIds.add(video.channelId);
  ws.write(
    await renderVideoCard({
      video,
      channel: await video.getChannel(),
      basePath: "",
      hbStats: video.hbStats,
    })
  );
  if (isMain(import.meta)) await archiveVideo(video.id);
}
ws.write(tail);
ws.end();
```

`genChannelIndexFile` follows the same pattern with one shell tuple. The `count === 0 → unlink` branch is preserved.

### Why this avoids "for await inside JSX"

Embedding the row-streaming `for await` inside an async JSX component (i.e., rendering the entire page as one async tree) was considered and rejected:

- Memory: all row JSX nodes accumulate before stringification; for high-volume streams (10⁴–10⁵ rows) the single resulting HTML string can reach tens of MB.
- `job.touch()` keepalive: must be invoked during cursor iteration; placing it inside a presentation component violates the control/presentation boundary.
- File-stream backpressure: a single trailing `ws.end(hugeString)` defeats Node stream `highWaterMark` / drain semantics.
- Component purity: components would have to import mongoose models and DB primitives.

Placeholder+split confines JSX to whole-page page-shell rendering and per-row rendering, both of which produce small bounded strings.

## 7. Component Inventory

### `templates/format.tsx`

```ts
export function formatCurrency(
  amount: number,
  currency: string,
  style?: Intl.NumberFormatOptions["style"]
): string;
export function getTimestamp(doc: DocumentType<object>): Date;
export function getTimestamp(doc: DocumentType<object> | null): Date | null;
export function getVideoPath(video: DocumentType<Video>): string;

export function FormattedTimestamp(props: {
  video: DocumentType<Video>;
  timestamp: Date;
}): JSX.Element;
```

`FormattedTimestamp` replaces the existing `formatTimestamp` helper. It returns a JSX element (not a string), so consumers drop it directly into JSX trees:

```tsx
<td>
  <FormattedTimestamp video={video} timestamp={timestamp} />
</td>
```

Internal logic (call `VideoModel.getTimeSeconds`, format `moment(timestamp).tz("Asia/Tokyo").format(...)`, wrap in `<a>` if `timeSecond` is truthy, else just `<time>`) is preserved.

`formatCurrency`, `getTimestamp`, `getVideoPath` are pure functions, unchanged in behavior.

### `templates/VideoArchive.tsx`

Public exports:

- `renderVideoArchiveShell(props)` — returns `[head, tail]` tuple.
- `renderChatRow(props)` — returns one `<tr>...</tr>` string per row.

Internal components (private to file):

- `<VideoArchivePage>` — full page JSX with `raw(ROWS_MARKER)` placeholder.
- `<PageHead>` — `<head>` block; CSS injected via `<style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />`.
- `<HeaderBlock>` — title/thumbnail and the currency stats table at the top.
- `<CurrencyTable>` — receives computed `currencies` and `jpySum` arrays.
- `<ToggleControls>` — the fixed checkbox UI.
- `<ChatTableHead>` — table header `<tr>` with column titles.
- `<TogglesScript>` — `<script dangerouslySetInnerHTML={{ __html: TOGGLE_SCRIPT }} />` at end of body.
- `<ChatRow>` — wraps `<tr>` with id/class, dispatches inner cells via switch on `doc.collection.name`.
- `<AuthorPhoto>` — shared element returning `<img ... />` if `src` provided, else `null`.
- 9 row-cell components, each rendering the `<td>` cells for one row variant:
  - `<OwnerOrModeratorChatCells>` — for `chats` collection (covers both owner and moderator chats; the `class="row chats owner"` vs `class="row chats moderator"` distinction is added by `<ChatRow>`'s class computation, not by the cells).
  - `<SuperChatCells>`
  - `<SuperStickerCells>`
  - `<MembershipCells>`
  - `<MembershipGiftCells>`
  - `<MembershipGiftPurchaseCells>` — wraps `amount` in `<span class="gift-count">{amount}</span>` so the toggle script's count-summing logic continues to work.
  - `<MilestoneCells>`
  - `<PollCells>` — handles the prepended `createdAt` time when present, reproduces the choices `<br/>`-joined list with optional voteRatio percentage, and the `voteCount ? \`${voteCount} votes\` : ""` prefix.
  - `<RaidCells>` — renders source author photo and the "and their viewers just joined" message.

Class computation helper:

```ts
function computeRowClasses(doc: DocumentType<...>): string[] {
  const classes = ["row", doc.collection.name];
  if ("significance" in doc && doc.significance) classes.push(`significance-${doc.significance}`);
  if ("isOwner" in doc && doc.isOwner) classes.push("owner");
  if ("isModerator" in doc && doc.isModerator) classes.push("moderator");
  return classes;
}
```

Constants: `PAGE_CSS` (the existing `<style>` block as a string), `TOGGLE_SCRIPT` (the existing toggle JavaScript as a string), `ROWS_MARKER`.

### `templates/IndexPage.tsx`

Public exports:

- `renderIndexShell()` — returns `[head, between, tail]` tuple. Two markers split out the live-tab content area and the past-tab content area.

Internal components:

- `<IndexPage>` — Bootstrap-based `<html>` shell with two tabs and `raw(LIVE_MARKER)` / `raw(PAST_MARKER)` inside the respective tab panes.

Constants: `INDEX_PAGE_CSS`, `LIVE_MARKER` (`<!--HONEYBEE_LIVE-->`), `PAST_MARKER` (`<!--HONEYBEE_PAST-->`), Bootstrap CDN URLs (preserved from current code).

### `templates/ChannelIndexPage.tsx`

Public exports:

- `renderChannelIndexShell({ channel })` — returns `[head, tail]` tuple.

Internal components:

- `<ChannelIndexPage>` — channel-specific shell with avatar/name header and `raw(CARDS_MARKER)` placeholder.

### `templates/VideoCard.tsx`

Public exports:

```ts
export interface VideoCardProps {
  video: DocumentType<Video>;
  channel: DocumentType<Channel>;
  basePath: string;
  hbStats:
    | {
        totalSuperChatAmountJpy?: number;
        totalMembers?: number;
        totalGifts?: number;
      }
    | undefined;
}
export async function renderVideoCard(props: VideoCardProps): Promise<string>;
```

Internal components: `<VideoCard>`, `<StatusText>` (status switch returns the appropriate `<time>` or `Live Now` span).

The control layer (not the component) handles `recalcVideoHbStats` invocation and re-fetching the updated video when running in `isMain` dev mode; the component receives already-finalized `hbStats`.

## 8. Behavior Differences Catalog

| Item                                                                                     | Current                                               | New                                                                                                                                                                                                                          | Notes                                                                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| User text in HTML body (titles, author names, messages, milestone messages)              | Unescaped template-string interpolation               | Auto-escaped by hono/jsx                                                                                                                                                                                                     | Closes pre-existing XSS risk. `chat.message` confirmed plain text by user, so no rendering regression. |
| `<style>` and `<script>` body content                                                    | Template string                                       | `dangerouslySetInnerHTML={{ __html: ... }}`                                                                                                                                                                                  | Hono/jsx escapes these tag bodies by default. CSS/JS strings extracted to module-level constants.      |
| `<!DOCTYPE html>`                                                                        | Embedded in template                                  | Not representable in JSX; prepended manually inside `renderVideoArchiveShell` / `renderIndexShell` / `renderChannelIndexShell`                                                                                               | Output identical.                                                                                      |
| HTML attribute `class`                                                                   | (n/a, not used inline; existing styles use selectors) | Use `class` directly in JSX (hono/jsx accepts both `class` and `className`)                                                                                                                                                  | Aligns with HTML; no React conversion overhead.                                                        |
| Image `src` URL                                                                          | Template string                                       | JSX attribute, attribute-escaped                                                                                                                                                                                             | URLs do not contain `"`; no behavioral change.                                                         |
| Conditional rendering (e.g., `superchat.message ?? '<span class="wordless">...</span>'`) | Ternary in template string                            | Ternary in JSX with element fallback                                                                                                                                                                                         | Equivalent.                                                                                            |
| `poll.choices.map(...).join("<br/>")` trailing-`<br/>` behavior                          | `Array.join` produces no trailing `<br/>`             | Implementation MUST reproduce no-trailing-`<br/>` behavior: use either `flatMap` with `[<br/>, …line]` then `.slice(1)`, or build the array, render with `.map((c, i) => <Fragment>{i > 0 && <br/>}{lineFor(c)}</Fragment>)` | Easy to get wrong.                                                                                     |
| Multi-line text within one `<td>` (e.g., currency amount lines split with `<br/>`)       | `${...}<br/>${...}` template                          | `<>{first}<br/>{second}</>`                                                                                                                                                                                                  | Equivalent.                                                                                            |
| Output whitespace / attribute ordering / self-closing form                               | Hand-controlled                                       | Hono-determined                                                                                                                                                                                                              | Acceptable — only DOM equivalence is required (see §10).                                               |

## 9. Migration / PR Structure

**Single PR.** The 6 files are tightly coupled (control-layer imports each template's public API); splitting risks intermediate states that fail to build or fail to produce HTML.

Subagent-Driven Development plan (per user-global CLAUDE.md):

- Implementer subagents (sonnet, parallel where independent):
  - **A** — `tsconfig.json` JSX option, `package.json` add `hono`, control-layer rewrite `chats-archive.ts`. May proceed in parallel with B/C/D because the templates' public API signatures are fixed by §6/§7.
  - **B** — `templates/format.tsx`, `templates/VideoCard.tsx`.
  - **C** — `templates/VideoArchive.tsx` (largest: page shell + 9 row variants).
  - **D** — `templates/IndexPage.tsx`, `templates/ChannelIndexPage.tsx`.
- Spec Reviewer (opus): verifies §6/§7/§8 are honored, public API signatures match exactly, `<!DOCTYPE>` prepending and ROWS_MARKER splitting are correctly implemented, no template imports DB models, every behavioral diff in §8 is preserved (especially the no-trailing-`<br/>` poll join). Spec Reviewer must include concrete patch suggestions, not just descriptions.
- Code Quality Reviewer (sonnet): naming, dead code, lint conformance.
- Final Code Reviewer (opus): integration audit; runs the validation checklist (§10) end-to-end.

## 10. Verification — Manual

No unit tests are added (per user request). The verification protocol is:

### Pre-refactor — capture baseline output

Before starting implementation, run the existing dev runner (`isMain(import.meta)` block) against a developer's local Mongo with representative data, and save the produced HTML files to a local non-git directory as the baseline:

- One per-video archive with high SuperChat volume.
- One per-video archive containing polls and raids.
- One per-video archive with memberships and membership gifts.
- One per-video archive whose `video.title` and chat `authorName` fields contain `&`, `<`, `>`, `"`, and emoji.
- The top-level `index.html`.
- One per-channel `index.html`.

### Post-refactor — visual diff

Open baseline and new output side-by-side in a browser. Verify:

- All three page types render without console errors.
- Toggle controls (`owner` / `moderator` / `memberships` / `milestones` / `membershipgifts` / `membershipgiftpurchases` / `superchats` / `superstickers` / `polls` / `raids`) and significance toggles 1–7 all work; the `toggle-all-significance` master toggle drives the seven children.
- Toggle `(count)` next to each label is correct.
- `membershipgiftpurchases` label shows `(count: N, total: M)` matching the sum of `<span class="gift-count">` values.
- Currency stats table at top of video page shows the same totals as baseline; JPY total row shows the sum.
- Empty SuperChat / milestone messages display the `(wordless superchat)` / `(wordless milestone)` fallback.
- Poll display shows `voteCount votes`, the question, and each choice line with optional `(NN.N%)` suffix.
- Raid row shows source author photo and the joined-the-stream message.
- `video.title` containing HTML-special characters is now visibly escaped (e.g., `<` displays as `<`, not breaking layout).

### Strict validation gate (per user-global CLAUDE.md)

After every implementer subagent completes, and again after final integration:

1. `npm run build` — `tsc` must report zero errors.
2. `npm run lint` — must pass.
3. Manual: `node dist/components/chats-archive.js` runs the dev runner and produces HTML; visual diff vs. baseline passes.

A subagent may not declare its task complete until all three pass.

## 11. Open Questions / Risks

- **`<!DOCTYPE html>` prepending**: confirmed in §6 to be appended manually outside the JSX tree. No risk.
- **`raw()` import path**: hono exports `raw` from both `hono/html` and `hono/jsx`. Implementer must pick one and use it consistently across templates. Recommendation: `hono/html` (matches hono's documented examples).
- **No-trailing-`<br/>` reproduction in poll choices**: easy to introduce a regression. Implementer must inspect baseline output for this exact case before declaring complete.
- **`isMain(import.meta)` dev runner inside a `.ts` control layer**: unaffected — the runner does not use JSX itself.
- **Future second JSX runtime**: if another file later wants Preact/React, the global `jsxImportSource` setting will conflict. Out of scope; addressed when needed via per-file pragmas or tsconfig project references.
