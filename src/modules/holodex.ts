import { HolodexApiClient } from "holodex.js";
import assert from "node:assert";
import { HOLODEX_API_KEY } from "../constants";

export function getHolodex() {
  assert(HOLODEX_API_KEY, "HOLODEX_API_KEY should be defined.");

  return new HolodexApiClient({
    apiKey: HOLODEX_API_KEY,
  });
}
