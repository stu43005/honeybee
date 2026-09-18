/// <reference types="jest" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { VideoStatus } from "holodex.js";

type OembedResult = Awaited<
  ReturnType<typeof import("./oembed.js").probeVideo>
>;

const mockProbeVideo = jest.fn<(videoId: string) => Promise<OembedResult>>();
const mockSleep = jest.fn<(ms: number) => Promise<void>>();

jest.unstable_mockModule("./oembed.js", () => ({
  probeVideo: mockProbeVideo,
  probePlaylist: jest.fn(),
}));
jest.unstable_mockModule("node:timers/promises", () => ({
  setTimeout: mockSleep,
}));

const { default: VideoModel } = await import("../../models/Video.js");
const { probeMissingVideos } = await import("./existence-probe.js");
const { YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE } =
  await import("../../constants.js");

const STAMP = new Date("2026-09-01T00:00:00.000Z");
const RECENT_AVAILABLE = new Date("2026-09-17T00:00:00.000Z");
const OLD_AVAILABLE = new Date("2024-01-01T00:00:00.000Z");

type VideoDoc = Record<string, unknown> & { id: string };

// Enough of Mongo's comparison semantics for the filters this module builds.
// Keeping it this small is deliberate: it only needs to cover equality plus the
// three operators the candidate query and the guarded write actually use.
function matches(doc: VideoDoc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = doc[key];
    if (
      condition &&
      typeof condition === "object" &&
      !(condition instanceof Date)
    ) {
      const operators = condition as Record<string, unknown>;
      if ("$ne" in operators) return value !== operators.$ne;
      if ("$gte" in operators) {
        return value instanceof Date && value >= (operators.$gte as Date);
      }
      if ("$lt" in operators) {
        return value instanceof Date && value < (operators.$lt as Date);
      }
    }
    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }
    // A null condition matches a missing field too, as Mongo does.
    if (condition === null) return value === null || value === undefined;
    return value === condition;
  });
}

function applyUpdate(doc: VideoDoc, update: Record<string, unknown>): void {
  const set = update.$set as Record<string, unknown> | undefined;
  const unset = update.$unset as Record<string, unknown> | undefined;
  if (set) Object.assign(doc, set);
  if (unset) for (const key of Object.keys(unset)) delete doc[key];
}

/**
 * A stateful videos collection that honours the filters it is given. The real
 * candidate query runs against it, so the exclusion rules are exercised rather
 * than stubbed away, and `updateOne` only writes when its filter still matches
 * — which is the whole point of the guarded write.
 *
 * Reads return **detached copies**. A real query hands back a snapshot, and the
 * distinction is load-bearing here: the race tests mutate the stored document
 * while a probe is in flight, and if the candidate were the same object it
 * would change underneath the caller, so the guard would compare the new state
 * against itself and match — hiding the very bug these tests exist to catch.
 */
function fakeVideos(docs: VideoDoc[]) {
  const store = new Map(docs.map((doc) => [doc.id, { ...doc }]));

  jest.spyOn(VideoModel, "find").mockImplementation(((
    filter: Record<string, unknown>
  ) => ({
    sort: () => ({
      limit: (n: number) => ({
        select: () =>
          Promise.resolve(
            [...store.values()]
              .filter((doc) => matches(doc, filter))
              .sort(
                (a, b) =>
                  ((a.crawledAt as Date | undefined)?.getTime() ?? 0) -
                  ((b.crawledAt as Date | undefined)?.getTime() ?? 0)
              )
              .slice(0, n)
              // Detached, so a later mutation of the stored document cannot
              // reach back into the candidate the caller is holding.
              .map((doc) => ({ ...doc }))
          ),
      }),
    }),
  })) as never);

  jest.spyOn(VideoModel, "updateOne").mockImplementation(((
    filter: Record<string, unknown>,
    update: Record<string, unknown>
  ) => {
    const doc = store.get(filter.id as string);
    if (!doc || !matches(doc, filter)) {
      return Promise.resolve({ matchedCount: 0 }) as never;
    }
    applyUpdate(doc, update);
    return Promise.resolve({ matchedCount: 1 }) as never;
  }) as never);

  return store;
}

/** A deleted Missing video, the only kind this round is allowed to probe. */
function deletedMissing(id: string, availableAt: Date): VideoDoc {
  return {
    id,
    status: VideoStatus.Missing,
    deleted: true,
    detectedDeletionAt: STAMP,
    availableAt,
    crawledAt: STAMP,
  };
}

describe("probeMissingVideos", () => {
  beforeEach(() => {
    // The bucket split is "now minus fourteen days", so the fixtures below only
    // land in the buckets they are named for while the clock is held here.
    // Without this the suite would start failing once the real date moved past
    // RECENT_AVAILABLE's two-week window.
    jest.useFakeTimers({ doNotFake: ["performance"] });
    jest.setSystemTime(new Date("2026-09-18T00:00:00.000Z"));
    mockSleep.mockResolvedValue(undefined);
    mockProbeVideo.mockResolvedValue({ kind: "absent" });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    mockProbeVideo.mockReset();
    mockSleep.mockReset();
  });

  it("gives each bucket its own allocation", async () => {
    // Six recent and six old, against a bucket size of five: if the two
    // queries shared one allocation the older, far larger population would take
    // every slot and recent disappearances would never be probed.
    const recent = Array.from({ length: 6 }, (_, i) =>
      deletedMissing(`r${i}`, RECENT_AVAILABLE)
    );
    const old = Array.from({ length: 6 }, (_, i) =>
      deletedMissing(`o${i}`, OLD_AVAILABLE)
    );
    fakeVideos([...recent, ...old]);

    await probeMissingVideos();

    const probed = mockProbeVideo.mock.calls.map((call) => call[0]);
    expect(probed.filter((id) => id.startsWith("r"))).toHaveLength(
      YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE
    );
    expect(probed.filter((id) => id.startsWith("o"))).toHaveLength(
      YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE
    );
  });

  it.each([true, false])(
    "leaves the populated bucket its full allocation when recent=%s is empty",
    async (recentIsEmpty) => {
      // N+1 candidates in the populated bucket, so "took exactly N" is a real
      // statement about its allocation rather than about how few there were.
      const populated = Array.from(
        { length: YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE + 1 },
        (_, i) =>
          deletedMissing(
            `v${i}`,
            recentIsEmpty ? OLD_AVAILABLE : RECENT_AVAILABLE
          )
      );
      fakeVideos(populated);

      await probeMissingVideos();

      // An empty bucket must not donate its slots, and must not cost the other
      // one any either.
      expect(mockProbeVideo).toHaveBeenCalledTimes(
        YOUTUBE_EXISTENCE_PROBE_BUCKET_SIZE
      );
    }
  );

  it("never probes a video a timeout heuristic marked Missing", async () => {
    const store = fakeVideos([
      {
        id: "heuristic",
        status: VideoStatus.Missing,
        // No `deleted`: the stream is still on YouTube, so oEmbed would answer
        // 200 every time and the video would bounce New -> Missing forever.
        availableAt: RECENT_AVAILABLE,
        crawledAt: STAMP,
      },
    ]);

    await probeMissingVideos();

    expect(mockProbeVideo).not.toHaveBeenCalled();
    expect(store.get("heuristic")?.status).toBe(VideoStatus.Missing);
    expect(store.get("heuristic")?.crawledAt).toEqual(STAMP);
  });

  it("never probes a video that is already waiting for hydration", async () => {
    const store = fakeVideos([
      {
        ...deletedMissing("pending", RECENT_AVAILABLE),
        // A null crawledAt is pubsub's way of asking for a refresh. It also
        // sorts first, so without the exclusion this document would be the very
        // one the probe grabs — and a 404 would erase the request.
        crawledAt: null,
      },
    ]);

    await probeMissingVideos();

    expect(mockProbeVideo).not.toHaveBeenCalled();
    expect(store.get("pending")?.crawledAt).toBeNull();
  });

  it("restores a video that answers 200 and asks for a fresh hydration", async () => {
    const store = fakeVideos([deletedMissing("v1", RECENT_AVAILABLE)]);
    mockProbeVideo.mockResolvedValue({ kind: "present" });

    await probeMissingVideos();

    const doc = store.get("v1");
    expect(doc?.status).toBe(VideoStatus.New);
    expect(doc?.crawledAt).toBeNull();
    expect(doc).not.toHaveProperty("deleted");
    expect(doc).not.toHaveProperty("detectedDeletionAt");
  });

  it.each(["absent", "invalid", "unknown"] as const)(
    "only advances the timestamp for a %s answer",
    async (kind) => {
      const store = fakeVideos([deletedMissing("v1", RECENT_AVAILABLE)]);
      mockProbeVideo.mockResolvedValue(
        kind === "unknown" ? { kind, message: "503" } : { kind }
      );

      await probeMissingVideos();

      const doc = store.get("v1");
      expect(doc?.status).toBe(VideoStatus.Missing);
      expect(doc?.deleted).toBe(true);
      expect(doc?.crawledAt).toBeInstanceOf(Date);
      expect(doc?.crawledAt).not.toEqual(STAMP);
    }
  );

  it("drops a stale absent result rather than erasing a new refresh request", async () => {
    const store = fakeVideos([deletedMissing("v1", RECENT_AVAILABLE)]);
    // Between selection and the answer, pubsub re-announces the video and asks
    // for a refresh. The probe's own view is now out of date.
    mockProbeVideo.mockImplementation(() => {
      const doc = store.get("v1");
      if (doc) doc.crawledAt = null;
      return Promise.resolve({ kind: "absent" as const });
    });

    await probeMissingVideos();

    // The request survives; without the pinned filter the probe would have
    // written its own timestamp over it and the video would wait a whole
    // rotation — possibly weeks — to be looked at again.
    expect(store.get("v1")?.crawledAt).toBeNull();
  });

  it("drops a stale present result rather than reverting a restored video", async () => {
    const store = fakeVideos([deletedMissing("v1", RECENT_AVAILABLE)]);
    // Between selection and the answer, the video was hydrated and is now Past.
    mockProbeVideo.mockImplementation(() => {
      const doc = store.get("v1");
      if (doc) {
        doc.status = VideoStatus.Past;
        delete doc.deleted;
      }
      return Promise.resolve({ kind: "present" as const });
    });

    await probeMissingVideos();

    expect(store.get("v1")?.status).toBe(VideoStatus.Past);
  });

  it("spaces the probes and does not wait after the last one", async () => {
    fakeVideos([
      deletedMissing("v1", RECENT_AVAILABLE),
      deletedMissing("v2", OLD_AVAILABLE),
    ]);

    await probeMissingVideos();

    expect(mockSleep).toHaveBeenCalledTimes(1);
  });

  it("advances the timestamp even when the probe itself throws", async () => {
    const store = fakeVideos([
      deletedMissing("v1", RECENT_AVAILABLE),
      deletedMissing("v2", OLD_AVAILABLE),
    ]);
    mockProbeVideo
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ kind: "absent" });

    await probeMissingVideos();

    // Both were attempted, and the thrown one still moved to the back of the
    // rotation instead of reclaiming a slot every round.
    expect(mockProbeVideo).toHaveBeenCalledTimes(2);
    expect(store.get("v1")?.crawledAt).not.toEqual(STAMP);
  });

  it("keeps going when one write rejects", async () => {
    fakeVideos([
      deletedMissing("v1", RECENT_AVAILABLE),
      deletedMissing("v2", OLD_AVAILABLE),
    ]);
    const update = jest.spyOn(VideoModel, "updateOne");
    const original = update.getMockImplementation();
    update
      .mockRejectedValueOnce(new Error("write concern error") as never)
      .mockImplementation(original as never);

    await probeMissingVideos();

    // A rejected write must cost only its own candidate, not every candidate
    // behind it.
    expect(mockProbeVideo).toHaveBeenCalledTimes(2);
  });

  it("does nothing when neither bucket has a candidate", async () => {
    fakeVideos([]);

    await probeMissingVideos();

    expect(mockProbeVideo).not.toHaveBeenCalled();
    expect(mockSleep).not.toHaveBeenCalled();
  });
});
