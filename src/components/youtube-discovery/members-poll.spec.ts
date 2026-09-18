/// <reference types="jest" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

type OembedResult = Awaited<
  ReturnType<typeof import("./oembed.js").probePlaylist>
>;
type PlaylistScanResult = Awaited<
  ReturnType<typeof import("../../modules/youtube.js").updateVideoFromPlaylist>
>;

const mockProbePlaylist =
  jest.fn<(playlistId: string) => Promise<OembedResult>>();
const mockUpdateVideoFromPlaylist =
  jest.fn<(playlistId: string) => Promise<PlaylistScanResult>>();
const mockSleep = jest.fn<(ms: number) => Promise<void>>();

jest.unstable_mockModule("./oembed.js", () => ({
  probePlaylist: mockProbePlaylist,
  probeVideo: jest.fn(),
}));
jest.unstable_mockModule("../../modules/youtube.js", () => ({
  updateVideoFromPlaylist: mockUpdateVideoFromPlaylist,
}));
jest.unstable_mockModule("node:timers/promises", () => ({
  setTimeout: mockSleep,
}));

const { default: ChannelModel } = await import("../../models/Channel.js");
const { pollMembersPlaylists } = await import("./members-poll.js");
const {
  YOUTUBE_MEMBERS_POLL_BATCH_SIZE,
  YOUTUBE_MEMBERS_PROBE_BATCH_SIZE,
  YOUTUBE_MEMBERS_PROBE_TTL_MS,
  YOUTUBE_MEMBERS_PROBE_RETRY_MS,
} = await import("../../constants.js");

type ChannelRow = {
  id: string;
  hasMembersPlaylist?: boolean;
  membersProbeNextAt?: Date;
  membersCrawledAt?: Date;
};

// A stateful channel collection: the probe phase writes into it and the same
// data drives the candidate queries, so "is this channel eligible next round"
// is observable rather than assumed.
function fakeChannels(rows: ChannelRow[], now: () => Date) {
  const store = new Map(rows.map((row) => [row.id, { ...row }]));

  jest.spyOn(ChannelModel, "findMembersProbeCandidates").mockImplementation(((
    limit: number
  ) =>
    Promise.resolve(
      [...store.values()]
        .filter(
          (row) =>
            row.membersProbeNextAt == null || row.membersProbeNextAt < now()
        )
        .sort(
          (a, b) =>
            (a.membersProbeNextAt?.getTime() ?? 0) -
            (b.membersProbeNextAt?.getTime() ?? 0)
        )
        .slice(0, limit)
        .map((row) => ({ id: row.id }))
    )) as never);

  jest.spyOn(ChannelModel, "findMembersPollCandidates").mockImplementation(((
    limit: number
  ) =>
    Promise.resolve(
      [...store.values()]
        .filter((row) => row.hasMembersPlaylist === true)
        .slice(0, limit)
        .map((row) => ({ id: row.id }))
    )) as never);

  jest.spyOn(ChannelModel, "updateOne").mockImplementation(((
    filter: { id: string },
    update: { $set: Partial<ChannelRow> }
  ) => {
    Object.assign(store.get(filter.id) ?? {}, update.$set);
    return Promise.resolve({ acknowledged: true }) as never;
  }) as never);

  return store;
}

describe("pollMembersPlaylists", () => {
  const NOW = new Date("2026-09-18T00:00:00.000Z");
  let current = NOW;

  beforeEach(() => {
    current = NOW;
    jest.useFakeTimers({ doNotFake: ["performance"] });
    jest.setSystemTime(NOW);
    mockSleep.mockResolvedValue(undefined);
    mockUpdateVideoFromPlaylist.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    mockProbePlaylist.mockReset();
    mockUpdateVideoFromPlaylist.mockReset();
    mockSleep.mockReset();
  });

  it("derives the members playlist id from the channel id", async () => {
    fakeChannels([{ id: "UC-hM6YJuNYVAmUWxeIr9FeA" }], () => current);
    mockProbePlaylist.mockResolvedValue({ kind: "present" });

    await pollMembersPlaylists();

    expect(mockProbePlaylist.mock.calls[0]?.[0]).toBe(
      "UUMO-hM6YJuNYVAmUWxeIr9FeA"
    );
  });

  it("asks each phase for its own batch size", async () => {
    const probeSpy = jest
      .spyOn(ChannelModel, "findMembersProbeCandidates")
      .mockResolvedValue([] as never);
    const scanSpy = jest
      .spyOn(ChannelModel, "findMembersPollCandidates")
      .mockResolvedValue([] as never);

    await pollMembersPlaylists();

    expect(probeSpy.mock.calls[0]?.[0]).toBe(YOUTUBE_MEMBERS_PROBE_BATCH_SIZE);
    expect(scanSpy.mock.calls[0]?.[0]).toBe(YOUTUBE_MEMBERS_POLL_BATCH_SIZE);
  });

  it("caches a conclusive present answer for the full ttl", async () => {
    const store = fakeChannels([{ id: "UC1" }], () => current);
    mockProbePlaylist.mockResolvedValue({ kind: "present" });

    await pollMembersPlaylists();

    expect(store.get("UC1")?.hasMembersPlaylist).toBe(true);
    expect(store.get("UC1")?.membersProbeNextAt).toEqual(
      new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_TTL_MS)
    );
  });

  it("caches a conclusive absent answer and never spends quota on it", async () => {
    const store = fakeChannels([{ id: "UC1" }], () => current);
    mockProbePlaylist.mockResolvedValue({ kind: "absent" });

    await pollMembersPlaylists();

    expect(store.get("UC1")?.hasMembersPlaylist).toBe(false);
    expect(store.get("UC1")?.membersProbeNextAt).toEqual(
      new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_TTL_MS)
    );
    expect(mockUpdateVideoFromPlaylist).not.toHaveBeenCalled();
  });

  it.each(["present", "absent"] as const)(
    "does not re-probe a %s answer before the ttl expires",
    async (kind) => {
      fakeChannels([{ id: "UC1" }], () => current);
      mockProbePlaylist.mockResolvedValue({ kind });

      await pollMembersPlaylists();
      expect(mockProbePlaylist).toHaveBeenCalledTimes(1);

      // One second short of the deadline: still cached.
      current = new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_TTL_MS - 1000);
      jest.setSystemTime(current);
      mockProbePlaylist.mockClear();

      await pollMembersPlaylists();

      expect(mockProbePlaylist).not.toHaveBeenCalled();
    }
  );

  it("treats a malformed-id answer as inconclusive, not as a verdict", async () => {
    const store = fakeChannels([{ id: "UC1" }], () => current);
    // 400 says the id was rejected, which is not the same as "this channel has
    // no members playlist" — writing false here would suppress scanning for a
    // week on no evidence.
    mockProbePlaylist.mockResolvedValue({ kind: "invalid" });

    await pollMembersPlaylists();

    expect(store.get("UC1")?.hasMembersPlaylist).toBeUndefined();
    expect(store.get("UC1")?.membersProbeNextAt).toEqual(
      new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS)
    );
  });

  it("retries an inconclusive first probe in an hour, not in a week", async () => {
    const store = fakeChannels([{ id: "UC1" }], () => current);
    mockProbePlaylist.mockResolvedValue({
      kind: "unknown",
      message: "socket hang up",
    });

    await pollMembersPlaylists();

    // Still unknown, so the scan phase must keep ignoring it...
    expect(store.get("UC1")?.hasMembersPlaylist).toBeUndefined();
    // ...which is exactly why the retry may not be a week away: on first
    // rollout every channel takes this path.
    expect(store.get("UC1")?.membersProbeNextAt).toEqual(
      new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS)
    );

    current = new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS + 1);
    jest.setSystemTime(current);
    mockProbePlaylist.mockClear();

    await pollMembersPlaylists();

    expect(mockProbePlaylist).toHaveBeenCalledTimes(1);
  });

  it("does not renew a stale verdict when a re-probe fails", async () => {
    const store = fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: false,
          membersProbeNextAt: new Date(NOW.getTime() - 1),
        },
      ],
      () => current
    );
    mockProbePlaylist.mockResolvedValue({
      kind: "unknown",
      message: "503",
    });

    await pollMembersPlaylists();

    // An hour, not another week — otherwise repeated failures could keep an
    // expired "no memberships" answer alive indefinitely.
    expect(store.get("UC1")?.membersProbeNextAt).toEqual(
      new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS)
    );
    expect(store.get("UC1")?.hasMembersPlaylist).toBe(false);

    current = new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS + 1);
    jest.setSystemTime(current);
    mockProbePlaylist.mockClear();
    await pollMembersPlaylists();
    expect(mockProbePlaylist).toHaveBeenCalledTimes(1);

    current = new Date(current.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS + 1);
    jest.setSystemTime(current);
    mockProbePlaylist.mockClear();
    await pollMembersPlaylists();
    expect(mockProbePlaylist).toHaveBeenCalledTimes(1);
  });

  it("scans the playlists of channels already known to have one", async () => {
    const store = fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 60_000),
        },
      ],
      () => current
    );

    await pollMembersPlaylists();

    expect(
      mockUpdateVideoFromPlaylist.mock.calls.map((call) => call[0])
    ).toEqual(["UUMO1"]);
    expect(store.get("UC1")?.membersCrawledAt).toEqual(NOW);
  });

  it("stops the round on quota exhaustion but keeps what it already stamped", async () => {
    const store = fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
        {
          id: "UC2",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
        {
          id: "UC3",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
        {
          id: "UC4",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
      ],
      () => current
    );
    mockUpdateVideoFromPlaylist
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        kind: "quotaExceeded",
        message: "Forbidden",
      });

    await pollMembersPlaylists();

    expect(
      mockUpdateVideoFromPlaylist.mock.calls.map((call) => call[0])
    ).toEqual(["UUMO1", "UUMO2", "UUMO3"]);
    expect(store.get("UC1")?.membersCrawledAt).toEqual(NOW);
    expect(store.get("UC2")?.membersCrawledAt).toEqual(NOW);
    expect(store.get("UC3")?.membersCrawledAt).toEqual(NOW);
    expect(store.get("UC4")?.membersCrawledAt).toBeUndefined();
  });

  it("keeps going after a non-quota scan failure", async () => {
    const store = fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
        {
          id: "UC2",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
      ],
      () => current
    );
    mockUpdateVideoFromPlaylist
      .mockResolvedValueOnce({
        ok: false,
        kind: "notFound",
        message: "Not Found",
      })
      .mockResolvedValueOnce({ ok: true });

    await pollMembersPlaylists();

    expect(mockUpdateVideoFromPlaylist).toHaveBeenCalledTimes(2);
    expect(store.get("UC1")?.membersCrawledAt).toEqual(NOW);
    expect(store.get("UC2")?.membersCrawledAt).toEqual(NOW);
  });

  it("still stamps when the playlist helper throws outright", async () => {
    const store = fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
      ],
      () => current
    );
    // The helper turns API failures into results, but it can still throw before
    // reaching that point. A skipped stamp would park this channel at the head
    // of the rotation and let it reclaim a paid slot every single round.
    mockUpdateVideoFromPlaylist.mockRejectedValue(new Error("no api key"));

    await pollMembersPlaylists();

    expect(store.get("UC1")?.membersCrawledAt).toEqual(NOW);
  });

  it("still sets a probe deadline when the probe throws outright", async () => {
    const store = fakeChannels([{ id: "UC1" }], () => current);
    mockProbePlaylist.mockRejectedValue(new Error("boom"));

    await pollMembersPlaylists();

    // Treated as inconclusive: no verdict is written, and the hour-long
    // deadline is what stops it from reclaiming a probe slot next round.
    expect(store.get("UC1")?.hasMembersPlaylist).toBeUndefined();
    expect(store.get("UC1")?.membersProbeNextAt).toEqual(
      new Date(NOW.getTime() + YOUTUBE_MEMBERS_PROBE_RETRY_MS)
    );
  });

  it("keeps going when a timestamp write rejects", async () => {
    fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
        {
          id: "UC2",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
      ],
      () => current
    );
    // A database hiccup on one channel's write must not cost every channel
    // behind it its turn.
    jest
      .spyOn(ChannelModel, "updateOne")
      .mockRejectedValueOnce(new Error("write concern error") as never)
      .mockResolvedValue({ acknowledged: true } as never);

    await pollMembersPlaylists();

    expect(mockUpdateVideoFromPlaylist).toHaveBeenCalledTimes(2);
  });

  it("spaces requests across the phase boundary as well as inside a phase", async () => {
    fakeChannels(
      [
        { id: "UC1", hasMembersPlaylist: true },
        { id: "UC2", hasMembersPlaylist: true },
      ],
      () => current
    );
    mockProbePlaylist.mockResolvedValue({ kind: "present" });

    await pollMembersPlaylists();

    // Two probes and two scans: one gap inside each phase, one across the seam
    // between them. Both phases send from the same process, so the seam counts.
    expect(mockSleep).toHaveBeenCalledTimes(3);
  });

  it("does not pause on the phase boundary when nothing was probed", async () => {
    fakeChannels(
      [
        {
          id: "UC1",
          hasMembersPlaylist: true,
          membersProbeNextAt: new Date(NOW.getTime() + 1),
        },
      ],
      () => current
    );

    await pollMembersPlaylists();

    expect(mockProbePlaylist).not.toHaveBeenCalled();
    expect(mockSleep).not.toHaveBeenCalled();
  });
});
