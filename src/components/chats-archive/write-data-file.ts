import assert from "node:assert";
import fsp from "node:fs/promises";
import path from "node:path";
import { CHAT_ARCHIVE_DIR } from "../../constants.js";

/**
 * Resolve a path under `${CHAT_ARCHIVE_DIR}/data/…`. Asserts the archive
 * directory is configured; callers run only inside the `if (CHAT_ARCHIVE_DIR)`
 * guard, so the assertion never fires in practice.
 */
export function dataFilePath(...segments: string[]): string {
  assert(CHAT_ARCHIVE_DIR, "CHAT_ARCHIVE_DIR is not defined.");
  return path.join(CHAT_ARCHIVE_DIR, "data", ...segments);
}

/**
 * Write `data` as compact JSON (trailing newline) to `absPath` atomically:
 * create the parent directory, write a temp sibling, then rename it into place
 * so a reader never observes a partially written file.
 */
export async function writeDataFile(
  absPath: string,
  data: unknown
): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp`;
  await fsp.rm(tmp, { force: true });
  await fsp.writeFile(tmp, JSON.stringify(data) + "\n", "utf-8");
  await fsp.rename(tmp, absPath);
}
