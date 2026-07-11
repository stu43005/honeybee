# Daily leaderboard (`data/leaderboard/{metric}/{YYYY-MM-DD}.json`)

**File path pattern:** `data/leaderboard/{metric}/{YYYY-MM-DD}.json`, where
`{metric}` is `maxviewers` or `likes` and `{YYYY-MM-DD}` is a JST calendar
date.
**Companion file:** none.
**Writer:** `src/components/chats-archive/gen-leaderboard-file.ts`
**Version field in JSON:** none at version 1 — readers detect version
defensively as `(json.version ?? 1)`.
**Current writer emits:** version 1, revision r0

## Revision history

| Version | Revision | Date       | PR  | Summary                                        |
| ------- | -------- | ---------- | --- | ---------------------------------------------- |
| 1       | r0       | 2026-07-11 | —   | Initial daily maxViewers / likes leaderboards. |

## version 1

### Base shape (r0)

```ts
interface Leaderboard {
  date: string; // "YYYY-MM-DD" in JST — the day this file ranks
  snapshotAt: string; // ISO 8601; when this file was generated
  metric: "maxViewers" | "likes"; // which field entries are ranked by
  entries: VideoSummaryWithChannel[]; // top 50, sorted desc by `metric`
}

interface VideoSummaryWithChannel {
  id: string;
  title: string;
  channel: { id: string; name: string; avatarUrl?: string };
  status: string; // holodex VideoStatus
  duration: number; // seconds
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
  "date": "2026-07-11",
  "snapshotAt": "2026-07-11T09:00:00.000Z",
  "metric": "maxViewers",
  "entries": [
    {
      "id": "topVid001",
      "title": "Big collab stream",
      "channel": {
        "id": "UCaaaaaaaaaaaaaaaaaaaaaa",
        "name": "Channel A",
        "avatarUrl": "https://yt3.googleusercontent.com/.../a.jpg"
      },
      "status": "past",
      "duration": 7200,
      "availableAt": "2026-07-11T10:00:00.000Z",
      "archiveVersion": 2,
      "stats": {
        "superChatTotalJpy": 12345,
        "memberCount": 42,
        "giftCount": 7
      },
      "scheduledStart": "2026-07-11T10:00:00.000Z",
      "actualStart": "2026-07-11T10:01:00.000Z",
      "actualEnd": "2026-07-11T12:01:00.000Z",
      "maxViewers": 54000,
      "likes": 8900
    }
  ]
}
```

### Reader guidance

- **Version detection:** absence of a `version` key implies version 1.
- **Semantics — start-date leaderboard ranked by lifetime metric:** a
  stream is attributed to exactly one JST day (the day its `availableAt`
  falls in) and ranked by its full-lifetime `maxViewers` / `likes` value.
  The metric is **not** re-scoped to the calendar day; a stream that
  starts before JST midnight and peaks after midnight is ranked only in
  its start day's file, with its whole-lifetime metric. Do not read this
  as same-day activity.
- **File absence / empty day:** a date with no qualifying streams still
  produces a file with `entries: []`. A 404 means the file was never
  generated (e.g. a date outside the refresh window); an empty `entries`
  array means the day was computed and nobody qualified.
- **Qualification:** entries have the ranked metric `> 0` and exclude
  uploaded videos and ignored streams.
- **Always present at root:** `date`, `snapshotAt`, `metric`, `entries`.
- **Always present per entry:** `id`, `title`, `channel.id`,
  `channel.name`, `status`, `duration`, `availableAt`, `archiveVersion`,
  `stats.*`.
- **May be absent per entry:** `channel.avatarUrl`, `scheduledStart`,
  `actualStart`, `actualEnd`, `publishedAt`, `viewers`, `maxViewers`,
  `likes`, `premiere`. (The entry's ranked metric — `maxViewers` for the
  `maxviewers` file, `likes` for the `likes` file — is present and `> 0`
  for every entry, since qualification requires it.)
- **Ordering:** `entries` sorted descending by `metric`, ties broken by
  ascending `id`, truncated to the top 50.
- **Regeneration cadence:** today's and yesterday's JST files are
  refreshed every 10 minutes; older dates are not refreshed on a schedule.
- **Unknown extra fields:** ignore (forward compatibility).
