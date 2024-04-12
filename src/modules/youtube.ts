import { google } from "googleapis";
import assert from "node:assert";
import { GOOGLE_API_KEY } from "../constants";

export function getYoutubeApi() {
  assert(GOOGLE_API_KEY, "GOOGLE_API_KEY should be defined.");

  return google.youtube({
    version: "v3",
    auth: GOOGLE_API_KEY,
  });
}
