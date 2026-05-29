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
- **File absence:** the file is **not written** when the channel has no
  non-uploaded streams in the database (the writer's query filter is
  `uploadedVideo !== true`). Readers must tolerate a 404 / missing key
  in S3 for any given channelId and treat it as "no archived content
  yet for this channel". Note: if a previously-created file exists from
  an earlier writer run, it is not automatically deleted when the channel
  later has no qualifying videos — readers should not rely on file
  absence as proof a channel has no content.
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
