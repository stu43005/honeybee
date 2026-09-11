# crawler 已消失影片的標記與批次隔離 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `crawler youtube update` 在 YouTube 查不到影片或頻道時，能把「已消失」這個事實寫進資料庫，並讓單筆失敗不再中止整批。

**Architecture:** `updateVideoFromYoutube()` 與 `updateChannelFromYoutube()` 的 `save()` 改為在 YouTube 查不到該項目時傳入 `{ validateBeforeSave: false }`，繞過 mongoose validator，讓 `status` / `deleted` / `crawledAt` 得以落盤，文件因此離開候選清單；兩個函式的逐筆迴圈各自包上 try/catch 做批次隔離；候選清單前兩條無界查詢加上排序與筆數上限。

**Tech Stack:** TypeScript (ESM, NodeNext)、Mongoose 8.2 + Typegoose、Jest 29（true-ESM，`jest.unstable_mockModule`）、googleapis、Agenda。

---

## File Structure

| 檔案                          | 責任                                             | 本計畫的變動                                                    |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| `src/modules/youtube.ts`      | YouTube Data API 抓取與 Video / Channel 文件同步 | 修改 `updateVideoFromYoutube()` 與 `updateChannelFromYoutube()` |
| `src/modules/youtube.spec.ts` | 上述模組的單元測試                               | 擴充 mock 基礎設施與 11 個案例                                  |
| `src/commands/crawler.ts`     | crawler 服務的 Agenda 任務定義                   | 修改 `JOB_YOUTUBE_UPDATE_VIDEOS` 的候選清單查詢                 |

沒有新增檔案。三個檔案的責任邊界維持原狀。

---

## Task 1: video 端跳過驗證寫入

**Files:**

- Modify: `src/modules/youtube.ts:185`
- Test: `src/modules/youtube.spec.ts`

- [ ] **Step 1: 擴充測試檔的 import 與 fake，讓 save 的 options 可被斷言**

在 `src/modules/youtube.spec.ts` 頂端的 import 區，於 `@jest/globals` 那行之後加入：

```ts
import { VideoStatus } from "holodex.js";
```

把動態 import 區（目前是 `VideoModel` 與 `updateVideoFromYoutube` 兩行）替換成：

```ts
const { default: VideoModel } = await import("../models/Video.js");
const { default: ChannelModel } = await import("../models/Channel.js");
const { updateVideoFromYoutube } = await import("./youtube.js");
```

把 `fakeVideo()` 的 `save` 改成帶參數型別，讓 `toHaveBeenCalledWith` 能比對 options：

```ts
// A minimal mutable stand-in for a Video document.
function fakeVideo(overrides: Record<string, unknown>) {
  return {
    id: "vid",
    save: jest
      .fn<(options?: { validateBeforeSave?: boolean }) => Promise<unknown>>()
      .mockResolvedValue(undefined),
    ...overrides,
  } as any;
}
```

- [ ] **Step 2: 寫失敗測試**

在檔案末端新增一個 describe 區塊：

```ts
describe("updateVideoFromYoutube validateBeforeSave", () => {
  it("saves a vanished video without validation so the verdict lands", async () => {
    // A raid placeholder: written by a validator-bypassing upsert, so it can
    // never satisfy the required channelId/title and would fail every save.
    const gone = fakeVideo({
      id: "gone1",
      channelId: "",
      title: "",
      status: VideoStatus.New,
      deleted: false,
    });
    jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation((() => gone) as any);
    mockVideosList.mockResolvedValue({ data: { items: [] } });

    await updateVideoFromYoutube(["gone1"]);

    expect(gone.save).toHaveBeenCalledWith({ validateBeforeSave: false });
    // status and crawledAt are what take it out of the two unbounded
    // candidate queries.
    expect(gone.status).toBe(VideoStatus.Missing);
    expect(gone.deleted).toBe(true);
    expect(gone.crawledAt).toBeInstanceOf(Date);
  });

  it("validates the save when YouTube still returns the video", async () => {
    const found = fakeVideo({ id: "found1" });
    jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation((() => found) as any);
    mockVideosList.mockResolvedValue({
      data: { items: [foundItem("found1")] },
    });

    await updateVideoFromYoutube(["found1"]);

    expect(found.save).toHaveBeenCalledWith({ validateBeforeSave: true });
  });

  it("keeps the tombstone behavior for a fully populated video", async () => {
    const gone = fakeVideo({
      id: "gone2",
      channelId: "UCabcdefghijklmnopqrstuv",
      title: "A real title",
      deleted: false,
    });
    jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation((() => gone) as any);
    // Resolving the channel keeps the id out of the follow-up channel update,
    // so channels.list is never reached from this test.
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation((() => ({ id: "UCabcdefghijklmnopqrstuv" })) as any);
    mockVideosList.mockResolvedValue({ data: { items: [] } });

    const result = await updateVideoFromYoutube(["gone2"]);

    expect(gone.deleted).toBe(true);
    expect(gone.detectedDeletionAt).toBeInstanceOf(Date);
    expect(result).toEqual([gone]);
  });
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npm run test -- src/modules/youtube.spec.ts -t "validateBeforeSave"`

Expected: FAIL。前兩個案例的錯誤是 `toHaveBeenCalledWith` 收到 `[]`（實際呼叫沒有帶參數），第三個案例應該已經通過。

- [ ] **Step 4: 實作**

在 `src/modules/youtube.ts` 中，把 `updateVideoFromYoutube()` 迴圈結尾的 `await video.save();`（第 185 行）替換成：

```ts
// YouTube omitting the id is the one fact worth persisting here, and the
// document may lack required fields because of how it was created (an
// upsert bypasses validators). Validating would reject this write and
// leave the document in its old state, so it would be picked up again on
// every round forever.
await video.save({ validateBeforeSave: !!ytInfo });
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npm run test -- src/modules/youtube.spec.ts`

Expected: PASS，包含既有的 `detectedDeletionAt` 四個案例。

- [ ] **Step 6: 型別檢查與 lint**

Run: `npm run build && npm run lint`

Expected: 兩者皆無錯誤輸出。

- [ ] **Step 7: Commit**

```bash
git add src/modules/youtube.ts src/modules/youtube.spec.ts
git commit -m "fix(youtube): persist the missing verdict without validation"
```

---

## Task 2: video 端 per-video try/catch

**Files:**

- Modify: `src/modules/youtube.ts:54-187`
- Test: `src/modules/youtube.spec.ts`

- [ ] **Step 1: 寫失敗測試**

在 Task 1 建立的 describe 之後，新增：

```ts
describe("updateVideoFromYoutube batch isolation", () => {
  it("keeps updating the rest of the batch when one video fails to save", async () => {
    const boom = fakeVideo({ id: "boom1" });
    boom.save.mockRejectedValue(new Error("save failed"));
    const ok = fakeVideo({ id: "ok1" });
    jest
      .spyOn(VideoModel, "findByVideoId")
      .mockImplementation(((id: string) =>
        id === "boom1" ? boom : ok) as any);
    mockVideosList.mockResolvedValue({
      data: { items: [foundItem("boom1"), foundItem("ok1")] },
    });
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await updateVideoFromYoutube(["boom1", "ok1"]);

    expect(ok.save).toHaveBeenCalled();
    expect(result).toEqual([ok]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("boom1"),
      expect.any(Error)
    );
  });
});
```

- [ ] **Step 2: 強化既有的 never-seen 測試**

既有案例 `skips a never-seen id that is already gone (no phantom record)` 目前只斷言回傳空陣列，並在註解中說明「真的建立文件的話 save 會因為缺少 DB 而失敗」。加上 catch 之後這個假設不再成立——phantom save 的錯誤會被吞掉，回傳仍是空陣列。把該案例整段替換成：

```ts
it("skips a never-seen id that is already gone (no phantom record)", async () => {
  // findByVideoId returns null (never tracked); YouTube omits it (deleted).
  const findSpy = jest
    .spyOn(VideoModel, "findByVideoId")
    .mockImplementation((() => null) as any);
  // Spying the prototype observes a `new VideoModel(...).save()` attempt
  // directly. An empty result is not enough on its own: once per-video
  // errors are caught, a phantom save that rejects would be swallowed and
  // the result would still be empty.
  const protoSaveSpy = jest
    .spyOn(VideoModel.prototype, "save")
    .mockResolvedValue(undefined as never);
  mockVideosList.mockResolvedValue({ data: { items: [] } });

  const result = await updateVideoFromYoutube(["neverseen1"]);

  expect(protoSaveSpy).not.toHaveBeenCalled();
  expect(result).toEqual([]);
  expect(findSpy).toHaveBeenCalledWith("neverseen1");
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npm run test -- src/modules/youtube.spec.ts -t "batch isolation"`

Expected: FAIL，錯誤是未被捕捉的 `save failed`（整個 `updateVideoFromYoutube` 被拒絕）。強化後的 never-seen 案例此時仍然通過——它要防的迴歸要等 catch 加上去之後才可能發生。

- [ ] **Step 4: 實作**

把 `updateVideoFromYoutube()` 的 `for (const targetVideo of targetVideos) {` 迴圈 body 整段包進 try/catch。迴圈的開頭改成：

```ts
  for (const targetVideo of targetVideos) {
    try {
      const ytInfo = ytVideoItems.find(
        (ytVideoItem) => ytVideoItem.id === targetVideo
      );
```

body 其餘內容維持原樣（整段縮排一層），迴圈結尾改成：

```ts
      await video.save({ validateBeforeSave: !!ytInfo });
      result.push(video);
    } catch (error) {
      // One bad document must not cost the rest of the batch its update.
      console.error(
        `[updateVideoFromYoutube] failed to update ${targetVideo}:`,
        error
      );
    }
  }
```

`continue` 在 try 區塊內仍作用於外層 for，兩個既有守衛的語意不變。

- [ ] **Step 5: 跑測試確認通過**

Run: `npm run test -- src/modules/youtube.spec.ts`

Expected: PASS，全部案例。特別確認 `skips a never-seen id that is already gone (no phantom record)` 仍然通過——它現在是靠 `protoSaveSpy` 而不是靠「save 會拋錯」在防守。

- [ ] **Step 6: 型別檢查與 lint**

Run: `npm run build && npm run lint`

Expected: 兩者皆無錯誤輸出。

- [ ] **Step 7: Commit**

```bash
git add src/modules/youtube.ts src/modules/youtube.spec.ts
git commit -m "fix(youtube): isolate per-video failures from the rest of the batch"
```

---

## Task 3: channel 端跳過驗證寫入與守衛

**Files:**

- Modify: `src/modules/youtube.ts:216-250`
- Test: `src/modules/youtube.spec.ts`

- [ ] **Step 1: 擴充 mock 基礎設施**

`ChannelModel` 已在 Task 1 加入動態 import。把該區塊的最後一行改成同時取出 channel 函式：

```ts
const { updateVideoFromYoutube, updateChannelFromYoutube } =
  await import("./youtube.js");
```

把 `channels.list` 從匿名 `jest.fn()` 換成模組層級、可被測試控制的 mock。`mockVideosList` 宣告之後加一行：

```ts
const mockChannelsList = jest.fn<() => Promise<unknown>>();
```

並把 `jest.unstable_mockModule("googleapis", ...)` 的 factory 改成：

```ts
jest.unstable_mockModule("googleapis", () => ({
  google: {
    youtube: () => ({
      videos: { list: mockVideosList },
      channels: { list: mockChannelsList },
    }),
  },
}));
```

在 `afterEach` 中補上重置（`getYoutubeApi()` 會快取 client，所以這兩個 mock 物件的參照在整份測試檔中固定不變）：

```ts
afterEach(() => {
  jest.restoreAllMocks();
  mockVideosList.mockReset();
  mockChannelsList.mockReset();
});
```

在 `foundItem()` 之後新增 channel 用的兩個輔助函式：

```ts
// A minimal mutable stand-in for a Channel document.
function fakeChannel(overrides: Record<string, unknown>) {
  return {
    id: "chan",
    save: jest
      .fn<(options?: { validateBeforeSave?: boolean }) => Promise<unknown>>()
      .mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function foundChannelItem(id: string) {
  return {
    id,
    snippet: { title: "A channel" },
    statistics: {},
    brandingSettings: {},
  };
}
```

- [ ] **Step 2: 寫失敗測試**

在檔案末端新增：

```ts
describe("updateChannelFromYoutube validateBeforeSave", () => {
  it("saves a vanished channel without validation so the verdict lands", async () => {
    const gone = fakeChannel({ id: "UCgone" });
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation((() => gone) as any);
    mockChannelsList.mockResolvedValue({ data: { items: [] } });

    await updateChannelFromYoutube(["UCgone"]);

    expect(gone.save).toHaveBeenCalledWith({ validateBeforeSave: false });
    expect(gone.deleted).toBe(true);
    expect(gone.crawledAt).toBeInstanceOf(Date);
  });

  it("validates the save when YouTube still returns the channel", async () => {
    const found = fakeChannel({ id: "UCfound" });
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation((() => found) as any);
    mockChannelsList.mockResolvedValue({
      data: { items: [foundChannelItem("UCfound")] },
    });

    await updateChannelFromYoutube(["UCfound"]);

    expect(found.save).toHaveBeenCalledWith({ validateBeforeSave: true });
    expect(found.name).toBe("A channel");
  });

  it("marks every channel when the whole batch is missing", async () => {
    const a = fakeChannel({ id: "UCa" });
    const b = fakeChannel({ id: "UCb" });
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation(((id: string) => (id === "UCa" ? a : b)) as any);
    mockChannelsList.mockResolvedValue({ data: { items: [] } });

    const result = await updateChannelFromYoutube(["UCa", "UCb"]);

    expect(a.deleted).toBe(true);
    expect(b.deleted).toBe(true);
    expect(result).toEqual([a, b]);
  });

  it("skips a never-seen channel that is already gone", async () => {
    // findByChannelId returns null (never tracked); YouTube omits it.
    const findSpy = jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation((() => null) as any);
    // Spying the prototype observes a `new ChannelModel(...).save()` attempt
    // directly. An empty result is not enough on its own: once per-channel
    // errors are caught, a phantom save that rejects would be swallowed and
    // the result would still be empty.
    const protoSaveSpy = jest
      .spyOn(ChannelModel.prototype, "save")
      .mockResolvedValue(undefined as never);
    mockChannelsList.mockResolvedValue({ data: { items: [] } });

    const result = await updateChannelFromYoutube(["UCneverseen"]);

    expect(protoSaveSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
    expect(findSpy).toHaveBeenCalledWith("UCneverseen");
  });
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npm run test -- src/modules/youtube.spec.ts -t "updateChannelFromYoutube validateBeforeSave"`

Expected: 四個案例全部 FAIL，各自的原因不同——確認錯誤訊息與下列相符，不相符代表是環境或設定問題而非預期的紅燈：

1. `saves a vanished channel without validation…`：回應沒有 items，`if (!ytChannelItems?.length) return [];` 提前 return，`save` 完全沒被呼叫 → `toHaveBeenCalledWith` 收到 0 次呼叫。
2. `validates the save when YouTube still returns the channel`：回應有 items，不會提前 return，實際會走到 `save()`，但目前呼叫時沒有帶任何參數 → `toHaveBeenCalledWith({ validateBeforeSave: true })` 收到 `[]`。
3. `marks every channel when the whole batch is missing`：同第 1 點，提前 return 讓 `a.deleted` / `b.deleted` 維持 undefined。
4. `skips a never-seen channel that is already gone`：提前 return 發生在迴圈之前，`findByChannelId` 根本沒被呼叫 → `expect(findSpy).toHaveBeenCalledWith("UCneverseen")` 失敗。（`protoSaveSpy` 的斷言此時會通過，但要等實作完成後它才真正具有防護意義。）

- [ ] **Step 4: 實作**

把 `updateChannelFromYoutube()` 中從 `const ytChannelItems` 到迴圈結束的整段（第 228 至 247 行）替換成：

```ts
// A resolved response with no items means every requested id is gone
// (deleted / private / nonexistent) — API/quota errors throw before here — so
// fall through and let the per-channel loop mark the missing ids deleted.
const ytChannelItems = response?.data?.items ?? [];

const result: DocumentType<Channel>[] = [];
for (const targetChannel of targetChannels) {
  const ytInfo = ytChannelItems.find(
    (ytChannelItem) => ytChannelItem.id === targetChannel
  );
  const existing = await ChannelModel.findByChannelId(targetChannel);
  // A never-before-seen id that YouTube omits has no name to persist and is
  // not a channel we track — skip it instead of creating an invalid phantom
  // record that would fail validation.
  if (!ytInfo && !existing) continue;
  const channel = existing ?? new ChannelModel({ id: targetChannel });
  if (ytInfo) {
    applyYoutubeChannelInfo(channel, ytInfo);
  } else {
    channel.deleted = true;
  }
  channel.crawledAt = new Date();
  // Same reason as the video path: a channel inserted by a validator-
  // bypassing upsert can lack the required name, and validating would reject
  // this write and leave it stuck in the candidate list forever.
  await channel.save({ validateBeforeSave: !!ytInfo });
  result.push(channel);
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npm run test -- src/modules/youtube.spec.ts`

Expected: PASS，全部案例。

- [ ] **Step 6: 型別檢查與 lint**

Run: `npm run build && npm run lint`

Expected: 兩者皆無錯誤輸出。

- [ ] **Step 7: Commit**

```bash
git add src/modules/youtube.ts src/modules/youtube.spec.ts
git commit -m "fix(youtube): mark vanished channels instead of failing validation"
```

---

## Task 4: channel 端 per-channel try/catch

**Files:**

- Modify: `src/modules/youtube.ts`（`updateChannelFromYoutube()` 的迴圈）
- Test: `src/modules/youtube.spec.ts`

- [ ] **Step 1: 寫失敗測試**

在 Task 3 建立的 describe 之後新增：

```ts
describe("updateChannelFromYoutube batch isolation", () => {
  it("keeps updating the rest of the batch when one channel fails to save", async () => {
    const boom = fakeChannel({ id: "UCboom" });
    boom.save.mockRejectedValue(new Error("save failed"));
    const ok = fakeChannel({ id: "UCok" });
    jest
      .spyOn(ChannelModel, "findByChannelId")
      .mockImplementation(((id: string) =>
        id === "UCboom" ? boom : ok) as any);
    mockChannelsList.mockResolvedValue({
      data: {
        items: [foundChannelItem("UCboom"), foundChannelItem("UCok")],
      },
    });
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await updateChannelFromYoutube(["UCboom", "UCok"]);

    expect(ok.save).toHaveBeenCalled();
    expect(result).toEqual([ok]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("UCboom"),
      expect.any(Error)
    );
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -- src/modules/youtube.spec.ts -t "updateChannelFromYoutube batch isolation"`

Expected: FAIL，錯誤是未被捕捉的 `save failed`。

- [ ] **Step 3: 實作**

把 `updateChannelFromYoutube()` 的迴圈 body 包進 try/catch。迴圈開頭改成：

```ts
  for (const targetChannel of targetChannels) {
    try {
      const ytInfo = ytChannelItems.find(
        (ytChannelItem) => ytChannelItem.id === targetChannel
      );
```

body 其餘內容維持原樣（整段縮排一層），迴圈結尾改成：

```ts
      await channel.save({ validateBeforeSave: !!ytInfo });
      result.push(channel);
    } catch (error) {
      // This function runs at the end of the video update, so an escaping
      // error would also drop a batch of videos that already saved fine.
      console.error(
        `[updateChannelFromYoutube] failed to update ${targetChannel}:`,
        error
      );
    }
  }
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- src/modules/youtube.spec.ts`

Expected: PASS，全部案例。

- [ ] **Step 5: 型別檢查與 lint**

Run: `npm run build && npm run lint`

Expected: 兩者皆無錯誤輸出。

- [ ] **Step 6: Commit**

```bash
git add src/modules/youtube.ts src/modules/youtube.spec.ts
git commit -m "fix(youtube): isolate per-channel failures from the rest of the batch"
```

---

## Task 5: 候選清單加界

**Files:**

- Modify: `src/commands/crawler.ts:288-291`

這個任務沒有單元測試：目標查詢寫在 Agenda 任務定義的 body 裡，沒有可獨立呼叫的匯出，為它建立測試接縫需要重構整個任務，代價與收益不成比例。改動以型別檢查與 diff 檢視驗證。

- [ ] **Step 1: 實作**

在 `src/commands/crawler.ts` 的 `JOB_YOUTUBE_UPDATE_VIDEOS` 中，把候選清單的前兩條查詢：

```ts
        ...mapToId(
          await VideoModel.find({ status: VideoStatus.New }).select("id")
        ),
        ...mapToId(await VideoModel.find({ crawledAt: null }).select("id")),
```

替換成：

```ts
        // These two sit first in the Set, so without a cap they fill the whole
        // 100-slot slice and push live videos out. Newest-first matters: _id is
        // immutable, so an ascending cap would keep re-selecting the same
        // oldest ids forever and starve newer videos behind them if those ids
        // never manage to save. Descending puts new videos first and lets
        // permanently unsavable ones fall past the cap instead of blocking
        // discovery, and it runs off the default _id index with no in-memory
        // sort stage. Documents that do save leave these queries on their own,
        // so nothing is skipped — only the order changes. The scheduled-start
        // query below stays unbounded on purpose: a stream about to go live has
        // to be fetched now, and that spike drains within a round.
        ...mapToId(
          await VideoModel.find({ status: VideoStatus.New })
            .sort({ _id: -1 })
            .limit(25)
            .select("id")
        ),
        ...mapToId(
          await VideoModel.find({ crawledAt: null })
            .sort({ _id: -1 })
            .limit(25)
            .select("id")
        ),
```

- [ ] **Step 2: 型別檢查與 lint**

Run: `npm run build && npm run lint`

Expected: 兩者皆無錯誤輸出。

- [ ] **Step 3: 檢視 diff 確認只動到那兩條查詢**

Run: `git diff src/commands/crawler.ts`

Expected: 只有前兩條查詢加上 `.sort({ _id: -1 })` 與 `.limit(25)`，以及新增的註解。第三至第五條查詢（`scheduledStart` 窗口、`findRecentlyEndedVideos`、`findLiveVideos`）完全未變。

- [ ] **Step 4: 跑完整測試套件**

Run: `npm test`

Expected: PASS，全部測試檔。

- [ ] **Step 5: Commit**

```bash
git add src/commands/crawler.ts
git commit -m "fix(crawler): bound the two unbounded video candidate queries"
```

---

## 完成後的整體驗證

- [ ] **Step 1: 完整驗證**

Run: `npm run build && npm run lint && npm test`

Expected: 三者皆通過，無錯誤輸出。

- [ ] **Step 2: 確認變更範圍**

Run: `git diff --stat cc9407cf34298a64f8252fb0c9815bb36af9450d -- src/`

Expected: 只有三個檔案被修改——`src/modules/youtube.ts`、`src/modules/youtube.spec.ts`、`src/commands/crawler.ts`。
