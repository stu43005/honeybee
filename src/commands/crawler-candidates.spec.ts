/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { VideoStatus } from "holodex.js";

process.env.GOOGLE_API_KEY = "test-key";

const { default: VideoModel } = await import("../models/Video.js");
const { collectVideoUpdateCandidates } = await import("./crawler.js");

function idList(ids: string[]) {
  return ids.map((id) => ({ id }));
}

// Each query in the list is stubbed independently so the assembled result can
// be attributed to the right one.
function stubQueries(options: {
  newVideos?: string[];
  uncrawled?: string[];
  recheck?: string[];
  live?: string[];
}) {
  jest.spyOn(VideoModel, "find").mockImplementation(((filter: {
    status?: unknown;
    crawledAt?: unknown;
    deleted?: unknown;
  }) => {
    let rows: { id: string }[] = [];
    if (filter.status === VideoStatus.New) {
      rows = idList(options.newVideos ?? []);
    } else if (filter.crawledAt === null) {
      rows = idList(options.uncrawled ?? []);
    } else if (filter.status === VideoStatus.Missing) {
      rows = idList(options.recheck ?? []);
    }
    const chain = {
      sort: () => chain,
      limit: (n: number) => ({
        select: () => Promise.resolve(rows.slice(0, n)),
        // findMissingRecheckCandidates returns the query itself, so the caller
        // adds .select() after .limit().
      }),
      select: () => Promise.resolve(rows),
    };
    return chain;
  }) as never);

  const liveChain = {
    and: () => ({ select: () => Promise.resolve([]) }),
    sort: () => ({
      limit: (n: number) => ({
        select: () => Promise.resolve(idList(options.live ?? []).slice(0, n)),
      }),
    }),
  };
  jest.spyOn(VideoModel, "findLiveVideos").mockReturnValue(liveChain as never);
  jest.spyOn(VideoModel, "findRecentlyEndedVideos").mockReturnValue({
    sort: () => ({ limit: () => ({ select: () => Promise.resolve([]) }) }),
  } as never);
}

describe("collectVideoUpdateCandidates", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("includes heuristically-Missing videos without routing them through New", async () => {
    stubQueries({ recheck: ["miss1", "miss2"] });

    const ids = await collectVideoUpdateCandidates();

    // They arrive as candidates directly. Nothing had to flip their status to
    // New first, which is what would otherwise bounce them New -> Missing on
    // every rotation.
    expect(ids).toEqual(["miss1", "miss2"]);
  });

  it("keeps the re-check ids even when live videos could fill the whole slice", async () => {
    stubQueries({
      recheck: ["miss1", "miss2"],
      live: Array.from({ length: 200 }, (_, i) => `live${i}`),
    });

    const ids = await collectVideoUpdateCandidates();

    // The cap is 100 and the live query alone could supply more than that, so
    // this only holds because the re-check query is ordered ahead of it.
    expect(ids).toHaveLength(100);
    expect(ids.slice(0, 2)).toEqual(["miss1", "miss2"]);
  });

  it("still lets the live query fill the rest of the slice", async () => {
    stubQueries({
      recheck: ["miss1"],
      live: Array.from({ length: 200 }, (_, i) => `live${i}`),
    });

    const ids = await collectVideoUpdateCandidates();

    expect(ids).toHaveLength(100);
    expect(ids.filter((id) => id.startsWith("live"))).toHaveLength(99);
  });
});
