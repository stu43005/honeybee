# Realtime index (`data/realtime.json`)

**File path pattern:** `data/realtime.json`
**Companion file:** none.
**Writer:** `src/components/chats-archive/gen-realtime-file.ts`
**Version field in JSON:** none at version 1 — readers detect version
defensively as `(json.version ?? 1)`.
**Current writer emits:** version 1, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                 |
| ------- | -------- | ---------- | --- | --------------------------------------- |
| 1       | r0       | 2026-07-11 | —   | Initial realtime index of live streams. |

## version 1

### Base shape (r0)

```ts
interface RealtimeIndex {
  snapshotAt: string; // ISO 8601; when this snapshot was generated
  live: VideoSummaryWithChannel[]; // status "live" only, sorted desc by viewers
}

interface VideoSummaryWithChannel {
  id: string;
  title: string;
  channel: { id: string; name: string; avatarUrl?: string };
  status: string; // holodex VideoStatus; always "live" in this file
  duration: number; // seconds; 0 while a stream is live
  availableAt: string; // ISO 8601
  archiveVersion: number; // 1 = legacy, 2 = current archiver
  stats: { superChatTotalJpy: number; memberCount: number; giftCount: number };
  scheduledStart?: string; // ISO 8601
  actualStart?: string; // ISO 8601
  actualEnd?: string; // ISO 8601
  publishedAt?: string; // ISO 8601
  viewers?: number; // live concurrent viewers
  maxViewers?: number; // peak concurrent viewers so far
  likes?: number; // like count so far
  premiere?: boolean; // true for YouTube premieres
}
```

### Cumulative JSON example (r0)

```json
{
  "snapshotAt": "2026-07-11T09:00:00.000Z",
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
      "availableAt": "2026-07-11T08:00:00.000Z",
      "archiveVersion": 2,
      "stats": { "superChatTotalJpy": 0, "memberCount": 0, "giftCount": 0 },
      "scheduledStart": "2026-07-11T08:00:00.000Z",
      "actualStart": "2026-07-11T08:01:12.000Z",
      "viewers": 1234,
      "maxViewers": 1500,
      "likes": 320
    }
  ]
}
```

### Reader guidance

- **Version detection:** absence of a `version` key implies version 1.
- **Always present at root:** `snapshotAt`, `live` (may be empty).
- **Always present per entry:** `id`, `title`, `channel.id`, `channel.name`,
  `status`, `duration`, `availableAt`, `archiveVersion`, `stats.*`.
- **May be absent per entry:** `channel.avatarUrl`, `scheduledStart`,
  `actualStart`, `actualEnd`, `publishedAt`, `viewers`, `maxViewers`,
  `likes`, `premiere`.
- **`status`:** always `"live"` in this file.
- **`snapshotAt`:** the instant this file was generated; authoritative for
  this file only. Do not join it with `upcoming.json` assuming a shared
  instant — the two files are published independently.
- **Ordering:** `live` is sorted descending by `viewers` (entries with no
  reported viewers sort last), ties broken by ascending `id`.
- **Regeneration cadence:** every minute.
- **Unknown extra fields:** ignore (forward compatibility).
