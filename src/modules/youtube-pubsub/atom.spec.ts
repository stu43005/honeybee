/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { parseNotification } from "./atom.js";

function feed(inner: string): string {
  return `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:at="http://purl.org/atompub/tombstones/1.0"
      xmlns="http://www.w3.org/2005/Atom">
  <title>YouTube video feed</title>
  ${inner}
</feed>`;
}

function videoEntry(id: string, title: string): string {
  return `<entry>
    <id>yt:video:${id}</id>
    <yt:videoId>${id}</yt:videoId>
    <yt:channelId>UCchannel</yt:channelId>
    <title>${title}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>
    <author>
      <name>A Channel</name>
      <uri>https://www.youtube.com/channel/UCchannel</uri>
    </author>
    <published>2026-09-17T01:02:03+00:00</published>
    <updated>2026-09-17T01:02:04+00:00</updated>
  </entry>`;
}

describe("parseNotification", () => {
  it("parses a single video entry into one row", () => {
    const result = parseNotification(feed(videoEntry("vid1", "First")));

    expect(result).toEqual([
      {
        type: "video",
        videoId: "vid1",
        channelId: "UCchannel",
        title: "First",
        link: "https://www.youtube.com/watch?v=vid1",
        channelName: "A Channel",
        published: new Date("2026-09-17T01:02:03+00:00"),
        updated: new Date("2026-09-17T01:02:04+00:00"),
      },
    ]);
  });

  it("parses every entry of a multi-entry feed, in document order", () => {
    const result = parseNotification(
      feed(videoEntry("vid1", "First") + videoEntry("vid2", "Second"))
    );

    expect(result).toEqual([
      {
        type: "video",
        videoId: "vid1",
        channelId: "UCchannel",
        title: "First",
        link: "https://www.youtube.com/watch?v=vid1",
        channelName: "A Channel",
        published: new Date("2026-09-17T01:02:03+00:00"),
        updated: new Date("2026-09-17T01:02:04+00:00"),
      },
      {
        type: "video",
        videoId: "vid2",
        channelId: "UCchannel",
        title: "Second",
        link: "https://www.youtube.com/watch?v=vid2",
        channelName: "A Channel",
        published: new Date("2026-09-17T01:02:03+00:00"),
        updated: new Date("2026-09-17T01:02:04+00:00"),
      },
    ]);
  });

  it("returns videos first and deletions after them", () => {
    const result = parseNotification(
      feed(
        `<at:deleted-entry ref="yt:video:gone" when="2026-09-17T01:00:00+00:00"/>` +
          videoEntry("vid1", "First")
      )
    );

    expect(result).toEqual([
      {
        type: "video",
        videoId: "vid1",
        channelId: "UCchannel",
        title: "First",
        link: "https://www.youtube.com/watch?v=vid1",
        channelName: "A Channel",
        published: new Date("2026-09-17T01:02:03+00:00"),
        updated: new Date("2026-09-17T01:02:04+00:00"),
      },
      { type: "deleted", videoId: "gone" },
    ]);
  });

  it("keeps a numeric-looking title and id as strings", () => {
    const result = parseNotification(feed(videoEntry("2026", "12345")));

    expect(result).toEqual([
      expect.objectContaining({ videoId: "2026", title: "12345" }),
    ]);
  });

  it("skips an entry missing videoId, channelId or title", () => {
    const result = parseNotification(
      feed(
        `<entry><yt:channelId>UCchannel</yt:channelId><title>No video id</title></entry>` +
          `<entry><yt:videoId>novideo</yt:videoId><title>No channel</title></entry>` +
          `<entry><yt:videoId>notitle</yt:videoId><yt:channelId>UCchannel</yt:channelId></entry>` +
          videoEntry("vid1", "First")
      )
    );

    expect(result).toEqual([
      expect.objectContaining({ type: "video", videoId: "vid1" }),
    ]);
  });

  it("returns an empty array for a feed with no entries", () => {
    expect(parseNotification(feed(""))).toEqual([]);
  });

  it("returns null when the body is not a feed", () => {
    expect(parseNotification("<html><body>hi</body></html>")).toBeNull();
    expect(parseNotification("not xml at all <<<")).toBeNull();
    expect(parseNotification("")).toBeNull();
  });

  it("returns null for malformed xml that still looks like a feed", () => {
    // Unclosed entry: without validation the parser would happily return a
    // plausible-looking result for this.
    expect(
      parseNotification(
        `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>vid1</yt:videoId>`
      )
    ).toBeNull();

    // Mismatched tags.
    expect(
      parseNotification(`<feed><entry><title>First</entry></title></feed>`)
    ).toBeNull();
  });
});
