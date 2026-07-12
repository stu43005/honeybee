# Daily videos index (`data/daily-videos/{YYYY-MM-DD}.json`)

**File path pattern:** `data/daily-videos/{YYYY-MM-DD}.json` (JST calendar date)
**Companion file:** none.
**Writer:** `src/components/chats-archive/gen-daily-videos-file.ts`
**Version field in JSON:** none at version 1 — readers detect version
defensively as `(json.version ?? 1)`.
**Current writer emits:** version 1, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                               |
| ------- | -------- | ---------- | --- | ----------------------------------------------------- |
| 1       | r0       | 2026-07-12 | —   | Initial per-JST-day list of started stream summaries. |

## version 1

### Base shape (r0)

```ts
interface DailyVideos {
  date: string; // "YYYY-MM-DD" in JST — the day this file lists
  snapshotAt: string; // ISO 8601; when this file was generated
  videos: VideoSummaryWithChannel[]; // started streams of that day, availableAt desc
}

interface VideoSummaryWithChannel {
  id: string;
  title: string;
  channel: { id: string; name: string; avatarUrl?: string };
  status: string; // "new" | "upcoming" | "live" | "past" | "missing"
  duration: number; // seconds; 0 while a stream is live
  availableAt: string; // ISO 8601
  archiveVersion: number; // 1 = legacy, 2 = current archiver
  stats: { superChatTotalJpy: number; memberCount: number; giftCount: number };
  scheduledStart?: string; // ISO 8601
  actualStart?: string; // ISO 8601
  actualEnd?: string; // ISO 8601
  publishedAt?: string; // ISO 8601
  viewers?: number; // live concurrent viewers; 0 after finish
  maxViewers?: number; // peak concurrent viewers; persists after finish
  likes?: number; // like count; persists after finish
  premiere?: boolean; // true for YouTube premieres
}
```

### Cumulative JSON example (r0)

```json
{
  "date": "2026-07-11",
  "snapshotAt": "2026-07-11T09:00:00.000Z",
  "videos": [
    {
      "id": "vid002",
      "title": "Later stream of the day",
      "channel": { "id": "UCbbbbbbbbbbbbbbbbbbbbbb", "name": "Channel B" },
      "status": "past",
      "duration": 3600,
      "availableAt": "2026-07-11T12:00:00.000Z",
      "archiveVersion": 2,
      "stats": { "superChatTotalJpy": 5000, "memberCount": 12, "giftCount": 1 },
      "actualStart": "2026-07-11T12:00:00.000Z",
      "actualEnd": "2026-07-11T13:00:00.000Z",
      "maxViewers": 6000,
      "likes": 900
    },
    {
      "id": "vid001",
      "title": "Earlier stream of the day",
      "channel": {
        "id": "UCaaaaaaaaaaaaaaaaaaaaaa",
        "name": "Channel A",
        "avatarUrl": "https://yt3.googleusercontent.com/.../a.jpg"
      },
      "status": "live",
      "duration": 0,
      "availableAt": "2026-07-11T08:00:00.000Z",
      "archiveVersion": 2,
      "stats": { "superChatTotalJpy": 0, "memberCount": 0, "giftCount": 0 },
      "actualStart": "2026-07-11T08:00:00.000Z",
      "viewers": 1234,
      "maxViewers": 1500,
      "likes": 320
    }
  ]
}
```

### Reader guidance

- **Version detection:** absence of a `version` key implies version 1.
- **Always present at root:** `date`, `snapshotAt`, `videos` (may be empty).
- **`videos: []`** means the day was computed and no stream qualified — distinct
  from a `404` (file not yet generated for that date).
- **Always present per entry:** `id`, `title`, `channel.id`, `channel.name`,
  `status`, `duration`, `availableAt`, `archiveVersion`, `stats.*`.
- **May be absent per entry:** `channel.avatarUrl`, `scheduledStart`,
  `actualStart`, `actualEnd`, `publishedAt`, `viewers`, `maxViewers`, `likes`,
  `premiere`.
- **Which streams are listed:** every stream that has actually started
  (`actualStart` set) and whose `availableAt` falls in this JST day, excluding
  streams that never started, uploaded videos, and ignored channels. A stream is
  placed in the day of its `availableAt`.
- **Ordering:** `videos` is sorted descending by `availableAt`, ties broken by
  ascending `id`. This is a stable default only; re-sort client-side as needed.
- **Metric freshness:** `viewers`/`maxViewers`/`likes` are a periodically
  refreshed snapshot, not necessarily final. A day file is refreshed every
  10 min while it is today/yesterday, then at least every 12h while it still
  contains a live stream and typically once more shortly after such a stream ends
  or is detected deleted (barring an extended finalize outage). For a currently
  live stream, `realtime.json` is authoritative for the instantaneous value.
- **Unknown extra fields:** ignore (forward compatibility).
