import fetch from "node-fetch";
import { HolodexLiveStreamInfo } from "../types/holodex";

export async function fetchLiveStreams(): Promise<HolodexLiveStreamInfo[]> {
  const response = (await fetch(
    "https://holodex.net/api/v2/live?org=All%20Vtubers",
    {
      method: "GET",
      headers: {
        "user-agent": "Vespa",
      },
    }
  ).then((res) => res.json())) as HolodexLiveStreamInfo[];

  return response;
}
