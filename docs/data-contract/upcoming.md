# Upcoming index (`data/upcoming.json`)

**File path pattern:** `data/upcoming.json`
**Companion file:** none.
**Writer:** `src/components/chats-archive/gen-realtime-file.ts`
**Version field in JSON:** none at version 1 — readers detect version
defensively as `(json.version ?? 1)`.
**Current writer emits:** version 1, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                            |
| ------- | -------- | ---------- | --- | -------------------------------------------------- |
| 1       | r0       | 2026-07-11 | —   | Initial upcoming index (scheduled + just-started). |

## version 1

### Base shape (r0)

```ts
interface UpcomingIndex {
  snapshotAt: string; // ISO 8601
  upcoming: VideoSummaryWithChannel[]; // status "upcoming", within 48h, soonest first
  recentlyStarted: VideoSummaryWithChannel[]; // status "live", availableAt within last 10 min, newest first
}

interface VideoSummaryWithChannel {
  id: string;
  title: string;
  channel: { id: string; name: string; avatarUrl?: string };
  status: string; // holodex VideoStatus: "upcoming" in `upcoming`, "live" in `recentlyStarted`
  duration: number; // seconds; 0 for upcoming/just-started streams
  availableAt: string; // ISO 8601
  archiveVersion: number;
  stats: { superChatTotalJpy: number; memberCount: number; giftCount: number };
  scheduledStart?: string; // ISO 8601
  actualStart?: string; // ISO 8601
  actualEnd?: string; // ISO 8601
  publishedAt?: string; // ISO 8601
  viewers?: number;
  maxViewers?: number;
  likes?: number;
  premiere?: boolean;
}
```

### Cumulative JSON example (r0)

```json
{
  "snapshotAt": "2026-07-11T09:00:00.000Z",
  "upcoming": [
    {
      "id": "upcomingVid001",
      "title": "Scheduled stream",
      "channel": { "id": "UCbbbbbbbbbbbbbbbbbbbbbb", "name": "Channel B" },
      "status": "upcoming",
      "duration": 0,
      "availableAt": "2026-07-11T12:00:00.000Z",
      "archiveVersion": 1,
      "stats": { "superChatTotalJpy": 0, "memberCount": 0, "giftCount": 0 },
      "scheduledStart": "2026-07-11T12:00:00.000Z",
      "premiere": false
    }
  ],
  "recentlyStarted": [
    {
      "id": "liveVid001",
      "title": "Just went live",
      "channel": { "id": "UCaaaaaaaaaaaaaaaaaaaaaa", "name": "Channel A" },
      "status": "live",
      "duration": 0,
      "availableAt": "2026-07-11T08:59:00.000Z",
      "archiveVersion": 2,
      "stats": { "superChatTotalJpy": 0, "memberCount": 0, "giftCount": 0 },
      "scheduledStart": "2026-07-11T09:00:00.000Z",
      "actualStart": "2026-07-11T08:59:00.000Z",
      "viewers": 210
    }
  ]
}
```

### Reader guidance

- **Version detection:** absence of a `version` key implies version 1.
- **Always present at root:** `snapshotAt`, `upcoming`, `recentlyStarted`
  (either array may be empty).
- **Always present per entry:** `id`, `title`, `channel.id`, `channel.name`,
  `status`, `duration`, `availableAt`, `archiveVersion`, `stats.*`.
- **May be absent per entry:** `channel.avatarUrl`, `scheduledStart`,
  `actualStart`, `actualEnd`, `publishedAt`, `viewers`, `maxViewers`,
  `likes`, `premiere`.
- **`upcoming`:** streams with status `"upcoming"` whose `availableAt` is
  within the next 48 hours, sorted ascending by `availableAt` (soonest
  first).
- **`recentlyStarted`:** streams with status `"live"` whose `availableAt`
  is within the last 10 minutes (a grace window so a stream that just
  transitioned upcoming→live still shows here), sorted descending by
  `availableAt` (most recent first). A stream can briefly appear here and
  in `realtime.json` at the same time.
- **`snapshotAt`:** authoritative for this file only.
- **Regeneration cadence:** every minute.
- **Unknown extra fields:** ignore (forward compatibility).
