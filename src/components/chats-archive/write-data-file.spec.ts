/// <reference types="jest" />
import { afterEach, describe, expect, it } from "@jest/globals";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeDataFile } from "./write-data-file.js";

describe("writeDataFile", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  });

  it("creates parent dirs and writes JSON with a trailing newline", async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-write-"));
    const target = path.join(dir, "nested", "out.json");
    await writeDataFile(target, { a: 1, b: [2, 3] });
    const text = await fsp.readFile(target, "utf-8");
    expect(text).toBe('{"a":1,"b":[2,3]}\n');
  });

  it("leaves no .tmp sibling behind after a successful write", async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-write-"));
    const target = path.join(dir, "out.json");
    await writeDataFile(target, { ok: true });
    await expect(fsp.access(`${target}.tmp`)).rejects.toThrow();
  });
});
