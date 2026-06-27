/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { getChannelIdFilter } from "./track.js";

describe("getChannelIdFilter", () => {
  it("returns null for empty list", () => {
    expect(getChannelIdFilter([])).toBeNull();
  });
  it("returns the single id directly", () => {
    expect(getChannelIdFilter(["UCa"])).toBe("UCa");
  });
  it("returns $ne for a single id reversed", () => {
    expect(getChannelIdFilter(["UCa"], true)).toEqual({ $ne: "UCa" });
  });
  it("returns $in for multiple ids", () => {
    expect(getChannelIdFilter(["UCa", "UCb"])).toEqual({ $in: ["UCa", "UCb"] });
  });
  it("returns $nin for multiple ids reversed", () => {
    expect(getChannelIdFilter(["UCa", "UCb"], true)).toEqual({
      $nin: ["UCa", "UCb"],
    });
  });
});
