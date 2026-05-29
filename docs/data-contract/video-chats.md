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
  authorType: string;
  membership?: unknown; // present when the author has a YouTube membership
  isVerified: boolean;
  isOwner: boolean;
  isModerator: boolean;
}

interface ChatRow extends AuthorRowBase {
  type: "chat";
  message: unknown; // YouTube chat message runs (text + emoji segments)
}

interface SuperChatRow extends AuthorRowBase {
  type: "superChat";
  message: unknown;
  amount: number;
  currency: string; // ISO 4217 code
  jpyAmount: number;
  significance?: number;
  color?: number;
}

interface SuperStickerRow extends AuthorRowBase {
  type: "superSticker";
  text?: string;
  image: unknown;
  amount: number;
  currency: string;
  jpyAmount: number;
  significance?: number;
  color?: number;
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
  message: unknown;
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
  "authorType": "Verified",
  "isVerified": true,
  "isOwner": false,
  "isModerator": false,
  "message": [{ "text": "hello!" }]
}
```

```json
{
  "type": "superChat",
  "id": "SCdef456",
  "timestamp": "2026-05-29T12:07:00.000Z",
  "authorName": "Supporter",
  "authorChannelId": "UCyyyyyyyyyyyyyyyyyyyyyy",
  "authorType": "Member",
  "isVerified": false,
  "isOwner": false,
  "isModerator": false,
  "message": [{ "text": "thanks!" }],
  "amount": 1000,
  "currency": "JPY",
  "jpyAmount": 1000,
  "color": 4280391411
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
