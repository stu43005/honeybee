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
**Current writer emits:** version 1, revision r1

## Revision history

| Version | Revision | Date       | PR  | Summary                                                                          |
| ------- | -------- | ---------- | --- | -------------------------------------------------------------------------------- |
| 1       | r0       | 2026-05-30 | —   | Initial documentation of the existing pre-versioned format (bootstrap).          |
| 1       | r1       | 2026-07-11 | —   | Add optional `viewers`, `maxViewers`, `likes`, `premiere` to each video summary. |

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
  duration: number; // seconds; 0 for new/live/upcoming streams (true duration not yet known)
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

### Additive fields (r1)

Since r1, each `VideoSummaryWithChannel` entry may also carry these
optional fields; all are absent when the underlying value was never
populated:

```ts
interface VideoSummaryWithChannel {
  viewers?: number; // live concurrent viewers; 0 after the stream finishes
  maxViewers?: number; // peak concurrent viewers; persists after finish
  likes?: number; // like count; persists after finish
  premiere?: boolean; // true for YouTube premieres
}
```

Reader version detection — treat absence of the `version` key as v1:

```ts
const version = (json.version ?? 1) as number;
```

### Cumulative JSON example (r1)

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
      "actualStart": "2026-05-30T08:01:12.000Z",
      "viewers": 1234,
      "maxViewers": 1500
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
      "publishedAt": "2026-05-29T09:00:00.000Z",
      "maxViewers": 6000,
      "likes": 900
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
  `scheduledStart`, `actualStart`, `actualEnd`, `publishedAt`; and, since
  r1, `viewers`, `maxViewers`, `likes`, `premiere`.
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
