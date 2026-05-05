import { raw } from "hono/html";

const LIVE_MARKER = "<!--HONEYBEE_LIVE-->";
const PAST_MARKER = "<!--HONEYBEE_PAST-->";

const INDEX_PAGE_CSS = `
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

function IndexPage() {
  return (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Chat Archives Index</title>
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css"
          rel="stylesheet"
          integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB"
          crossorigin="anonymous"
        />
        <style dangerouslySetInnerHTML={{ __html: INDEX_PAGE_CSS }} />
      </head>
      <body>
        <ul class="nav nav-tabs" role="tablist">
          <li class="nav-item" role="presentation">
            <button
              class="nav-link active"
              id="live-tab"
              data-bs-toggle="tab"
              data-bs-target="#live-tab-pane"
              type="button"
              role="tab"
              aria-controls="live-tab-pane"
              aria-selected="true"
            >
              Live / Upcoming
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button
              class="nav-link"
              id="past-tab"
              data-bs-toggle="tab"
              data-bs-target="#past-tab-pane"
              type="button"
              role="tab"
              aria-controls="past-tab-pane"
              aria-selected="false"
            >
              Past
            </button>
          </li>
        </ul>
        <div class="tab-content">
          <div
            class="tab-pane fade show active"
            id="live-tab-pane"
            role="tabpanel"
            aria-labelledby="live-tab"
            tabindex={0}
          >
            <div class="container">
              <div class="row row-cols-1 row-cols-md-4 g-4">
                {raw(LIVE_MARKER)}
              </div>
            </div>
          </div>
          <div
            class="tab-pane fade"
            id="past-tab-pane"
            role="tabpanel"
            aria-labelledby="past-tab"
            tabindex={0}
          >
            <div class="container">
              <div class="row row-cols-1 row-cols-md-4 g-4">
                {raw(PAST_MARKER)}
              </div>
            </div>
          </div>
        </div>
        <script
          src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.min.js"
          integrity="sha384-G/EV+4j2dNv+tEPo3++6LCgdCROaejBqfUeNjuKAiuXbjrxilcCdDz6ZAVfHWe1Y"
          crossorigin="anonymous"
        ></script>
      </body>
    </html>
  );
}

export async function renderIndexShell(): Promise<
  [head: string, between: string, tail: string]
> {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/await-thenable
  const full = await (<IndexPage />).toString();
  const liveIdx = full.indexOf(LIVE_MARKER);
  const pastIdx = full.indexOf(PAST_MARKER);
  if (liveIdx < 0 || pastIdx < 0 || pastIdx <= liveIdx) {
    throw new Error(
      "IndexPage shell render did not contain both markers in order"
    );
  }
  return [
    "<!DOCTYPE html>" + full.slice(0, liveIdx),
    full.slice(liveIdx + LIVE_MARKER.length, pastIdx),
    full.slice(pastIdx + PAST_MARKER.length),
  ];
}
