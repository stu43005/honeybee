import { describe, expect, it, jest } from "@jest/globals";
import { AxiosError } from "axios";
import { AbortError, AccessDeniedError } from "@stu43005/masterchat";
import type { YoutubeWatchGate } from "../modules/youtube-watch-gate.js";
import { is429, reportStatsUpdateError } from "./worker.js";

function make429(): AxiosError {
  return new AxiosError(
    "Request failed with status code 429",
    "ERR_BAD_REQUEST",
    undefined,
    undefined,
    { status: 429 } as never
  );
}

function makeGate(recorded: boolean) {
  const penalize = jest
    .fn<() => Promise<boolean>>()
    .mockResolvedValue(recorded);
  return { gate: { penalize } as unknown as YoutubeWatchGate, penalize };
}

describe("is429", () => {
  it("true only for an AxiosError with response.status === 429", () => {
    expect(is429(make429())).toBe(true);
  });

  it("false for masterchat AccessDeniedError (avoids cooldown poisoning)", () => {
    expect(is429(new AccessDeniedError("Rate limit exceeded: abc"))).toBe(
      false
    );
  });

  it("false for a non-429 AxiosError", () => {
    const e = new AxiosError(
      "Request failed with status code 500",
      "ERR_BAD_RESPONSE",
      undefined,
      undefined,
      { status: 500 } as never
    );
    expect(is429(e)).toBe(false);
  });

  it("false for a plain Error", () => {
    expect(is429(new Error("nope"))).toBe(false);
  });
});

describe("reportStatsUpdateError", () => {
  it("429 → calls gate.penalize(); no warning when recorded", async () => {
    const { gate, penalize } = makeGate(true);
    const log = jest.fn();
    await reportStatsUpdateError(make429(), gate, log);
    expect(penalize).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("429 → warns once when global cooldown was not recorded", async () => {
    const { gate, penalize } = makeGate(false);
    const log = jest.fn();
    await reportStatsUpdateError(make429(), gate, log);
    expect(penalize).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain(
      "global cooldown not recorded"
    );
  });

  it("AccessDeniedError → does NOT penalize; logs the general stats error", async () => {
    const { gate, penalize } = makeGate(true);
    const log = jest.fn();
    await reportStatsUpdateError(
      new AccessDeniedError("Rate limit exceeded: abc"),
      gate,
      log
    );
    expect(penalize).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("AbortError → ignored: no penalize, no log", async () => {
    const { gate, penalize } = makeGate(true);
    const log = jest.fn();
    await reportStatsUpdateError(new AbortError(), gate, log);
    expect(penalize).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("non-429 AxiosError → does NOT penalize; logs", async () => {
    const { gate, penalize } = makeGate(true);
    const log = jest.fn();
    const e = new AxiosError(
      "Request failed with status code 500",
      "ERR_BAD_RESPONSE",
      undefined,
      undefined,
      { status: 500 } as never
    );
    await reportStatsUpdateError(e, gate, log);
    expect(penalize).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
