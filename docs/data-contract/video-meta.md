# Video meta (`{videoId}.meta.json`)

**File path pattern:** `data/videos/{videoId}.meta.json`
**Companion file:** `data/videos/{videoId}.jsonl` — see
[video-chats.md](./video-chats.md). When a companion exists, its version
is always identical to this file's version; readers determine the version
of the file with no JSON version field by reading the companion's version
field.
**Writer:** `src/components/chats-archive/archive-video.ts`
**Version field in JSON:** `archiveVersion`
**Current writer emits:** version 2, revision r1

## Revision history

| Version | Revision | Date       | PR  | Summary                                                               |
| ------- | -------- | ---------- | --- | --------------------------------------------------------------------- |
| 1       | r0       | (legacy)   | —   | Pre-v2 archive output. Files may still exist on S3 from earlier runs. |
| 2       | r0       | 2026-05-30 | —   | Initial documentation of the existing v2 writer output (bootstrap).   |
| 2       | r1       | 2026-08-12 | —   | Add `aggregates.jewelGiftCount` (YouTube Gifts, bought with Jewels).  |

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
  giftCount: number; // membership gifts, not Jewels gifts
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

### Additive field (r1)

Since r1, `VideoAggregates` carries one further count. Readers written against
r0 ignore it under the existing unknown-extra-fields rule.

```ts
interface VideoAggregates {
  // ...every r0 field, unchanged
  jewelGiftCount: number; // since r1
}
```

`jewelGiftCount` is the number of `gift` rows in the companion `.jsonl` — the
YouTube Gifts bought with Jewels, distinct from the membership gifts counted by
`giftCount` / `giftPurchaseCount`. It is a count and not a Jewels total on
purpose: a gift row's `amount` is absent until the price table learns that
asset, and the archive is written once and never rewritten, so a total would
freeze whatever undercount happened to hold at archive time.

### Cumulative JSON example (r1)

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
    "jewelGiftCount": 143,
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
  `aggregates.*` (all `*Count` fields, `currencyTable`, `jpyTotal`) —
  plus `aggregates.jewelGiftCount` since r1.
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
