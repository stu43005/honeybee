import type { DocumentType } from "@typegoose/typegoose";
import { raw } from "hono/html";
import type { Channel } from "../../../models/Channel.js";

const CARDS_MARKER = "<!--HONEYBEE_CHANNEL_CARDS-->";

const CHANNEL_PAGE_CSS = `
    body {
      font-family: Arial, sans-serif;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px;
    }
    th {
      background-color: #f2f2f2;
    }
`;

function ChannelIndexPage({ channel }: { channel: DocumentType<Channel> }) {
  return (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{channel.name} - Video Archive</title>
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css"
          rel="stylesheet"
          integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB"
          crossorigin="anonymous"
        />
        <style dangerouslySetInnerHTML={{ __html: CHANNEL_PAGE_CSS }} />
      </head>
      <body>
        <div class="container">
          <div class="d-flex align-items-center my-3">
            <img
              src={channel.avatarUrl}
              alt="Channel Avatar"
              style="height: 48px; width: 48px; border-radius: 50%; margin-right: 12px;"
            />
            <h1 class="mb-0">{channel.name}</h1>
          </div>
          <hr />
          <div class="row row-cols-1 row-cols-md-4 g-4">
            {raw(CARDS_MARKER)}
          </div>
        </div>
      </body>
    </html>
  );
}

export async function renderChannelIndexShell(props: {
  channel: DocumentType<Channel>;
}): Promise<[head: string, tail: string]> {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/await-thenable
  const full = await (<ChannelIndexPage {...props} />).toString();
  const idx = full.indexOf(CARDS_MARKER);
  if (idx < 0) {
    throw new Error(
      "ChannelIndexPage shell render did not contain CARDS_MARKER"
    );
  }
  return [
    "<!DOCTYPE html>" + full.slice(0, idx),
    full.slice(idx + CARDS_MARKER.length),
  ];
}
