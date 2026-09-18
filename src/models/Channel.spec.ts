/// <reference types="jest" />
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import ChannelModel from "./Channel.js";

describe("Channel.waitForCrawl", () => {
  const tinySchedule = [1, 1, 1, 1, 1, 1] as const;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns document immediately when crawledAt is already set", async () => {
    const doc = {
      id: "UC123",
      name: "Real Name",
      crawledAt: new Date(),
    } as any;
    const spy = jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValue(doc);

    const result = await ChannelModel.waitForCrawl("UC123", {
      backoffSchedule: tinySchedule,
    });

    expect(result).toBe(doc);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("polls with backoff until crawledAt appears", async () => {
    const uncrawled = {
      id: "UC123",
      name: "Unknown channel",
      crawledAt: null,
    } as any;
    const crawled = {
      id: "UC123",
      name: "Real Name",
      crawledAt: new Date(),
    } as any;
    const spy = jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockResolvedValueOnce(uncrawled)
      .mockResolvedValueOnce(uncrawled)
      .mockResolvedValueOnce(crawled);

    const result = await ChannelModel.waitForCrawl("UC123", {
      backoffSchedule: tinySchedule,
    });

    expect(result).toBe(crawled);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("returns last snapshot with crawledAt null on timeout", async () => {
    const uncrawled = {
      id: "UC123",
      name: "Unknown channel",
      crawledAt: null,
    } as any;
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(uncrawled);

    const result = await ChannelModel.waitForCrawl("UC123", {
      timeoutMs: 20,
      backoffSchedule: tinySchedule,
    });

    expect(result).toBe(uncrawled);
    expect(result?.crawledAt).toBeNull();
  });

  it("returns null when document never exists", async () => {
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(null);

    const result = await ChannelModel.waitForCrawl("UC123", {
      timeoutMs: 20,
      backoffSchedule: tinySchedule,
    });

    expect(result).toBeNull();
  });

  it("throws on abort signal", async () => {
    const uncrawled = {
      id: "UC123",
      name: "Unknown channel",
      crawledAt: null,
    } as any;
    jest.spyOn(ChannelModel, "findByChannelId").mockResolvedValue(uncrawled);
    const controller = new AbortController();

    const promise = ChannelModel.waitForCrawl("UC123", {
      signal: controller.signal,
      backoffSchedule: [1000],
    });
    // Let the first findByChannelId resolve and the sleep begin
    await new Promise((r) => setImmediate(r));
    controller.abort();

    await expect(promise).rejects.toThrow(/abort/i);
  });
});

describe("renderBoundChannelLines", () => {
  afterEach(() => jest.restoreAllMocks());

  it("joins channel name + id in input order, falling back to Unknown channel", async () => {
    // findByChannelId returns a Mongoose query type; cast the fake impl to any
    // so per-id resolution typechecks (existing specs use mockResolvedValue for
    // the single-value case).
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation(((id: string) =>
        Promise.resolve(id === "UCa" ? { name: "Chan A" } : null)) as any);
    expect(await ChannelModel.renderBoundChannelLines(["UCa", "UCb"])).toEqual([
      "• Chan A (UCa)",
      "• Unknown channel (UCb)",
    ]);
  });

  it("returns an empty array for no channels", async () => {
    expect(await ChannelModel.renderBoundChannelLines([])).toEqual([]);
  });
});

describe("Channel.findPubsubRenewalCandidates", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // findSubscribed() returns a mongoose Query whose and/sort/limit/select all
  // return itself, so a query that records its arguments can assert the chain.
  function fakeQuery() {
    const calls: Record<string, unknown[]> = {};
    const query: Record<string, unknown> = {};
    for (const method of ["and", "sort", "limit", "select"]) {
      query[method] = jest.fn((...args: unknown[]) => {
        calls[method] = args;
        return query;
      });
    }
    return { query, calls };
  }

  it("asks for channels whose lease is near expiry and that are off cooldown", () => {
    const { query, calls } = fakeQuery();
    jest.spyOn(ChannelModel, "findSubscribed").mockReturnValue(query as never);
    const now = new Date("2026-09-17T00:00:00.000Z");

    const result = ChannelModel.findPubsubRenewalCandidates(5, now);

    expect(result).toBe(query);
    expect(calls.and).toEqual([
      [
        {
          $or: [
            { pubsubExpiresAt: null },
            { pubsubExpiresAt: { $lt: new Date("2026-09-18T00:00:00.000Z") } },
          ],
        },
        {
          $or: [
            { pubsubRequestedAt: null },
            {
              pubsubRequestedAt: {
                $lt: new Date("2026-09-16T23:45:00.000Z"),
              },
            },
          ],
        },
      ],
    ]);
    expect(calls.sort).toEqual([{ pubsubRequestedAt: 1 }]);
    expect(calls.limit).toEqual([5]);
    expect(calls.select).toEqual(["id name"]);
  });
});

describe("Channel discovery candidate queries", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Captures the arguments the static hands to find()/and()/sort()/limit()
  // without touching a database. Each method returns the same recorder so the
  // chain keeps working.
  function recordQuery() {
    const calls: { and: unknown[]; sort: unknown[]; limit: number[] } = {
      and: [],
      sort: [],
      limit: [],
    };
    const chain: Record<string, unknown> = {};
    chain.and = (clauses: unknown[]) => {
      // Spread, so the recorded value is the list of clauses rather than a
      // list of calls each holding a list — the assertions below read as the
      // filter that reaches Mongo.
      calls.and.push(...clauses);
      return chain;
    };
    chain.sort = (order: unknown) => {
      calls.sort.push(order);
      return chain;
    };
    chain.limit = (n: number) => {
      calls.limit.push(n);
      return chain;
    };
    chain.select = () => chain;
    jest.spyOn(ChannelModel, "findSubscribed").mockReturnValue(chain as never);
    return calls;
  }

  it("orders feed candidates by the oldest fetch and caps the batch", () => {
    const calls = recordQuery();

    ChannelModel.findFeedPollCandidates(7);

    expect(calls.sort).toEqual([{ feedCrawledAt: 1 }]);
    expect(calls.limit).toEqual([7]);
    // Never-fetched channels must be eligible, so the query cannot demand an
    // existing timestamp.
    expect(calls.and).toEqual([]);
  });

  it("selects members-probe candidates whose next probe time has arrived", () => {
    const now = new Date("2026-09-18T00:00:00.000Z");
    const calls = recordQuery();

    ChannelModel.findMembersProbeCandidates(3, now);

    expect(calls.and).toEqual([
      {
        $or: [
          { membersProbeNextAt: null },
          { membersProbeNextAt: { $lt: now } },
        ],
      },
    ]);
    expect(calls.sort).toEqual([{ membersProbeNextAt: 1 }]);
    expect(calls.limit).toEqual([3]);
  });

  it("scans only channels already known to have a members playlist", () => {
    const calls = recordQuery();

    ChannelModel.findMembersPollCandidates(15);

    expect(calls.and).toEqual([{ hasMembersPlaylist: true }]);
    expect(calls.sort).toEqual([{ membersCrawledAt: 1 }]);
    expect(calls.limit).toEqual([15]);
  });
});
