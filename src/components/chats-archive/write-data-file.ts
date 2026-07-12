import assert from "node:assert";
import { randomUUID } from "node:crypto";
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
 * create the parent directory, write a per-call unique temp sibling, then
 * rename it into place so a reader never observes a partially written file.
 */
export async function writeDataFile(
  absPath: string,
  data: unknown
): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  // Per-call unique temp name: two writers racing the same output path each own
  // their own temp file, so an interleaved write can never corrupt a shared temp
  // and the atomic rename is the only contended step.
  const tmp = `${absPath}.${process.pid}.${randomUUID()}.tmp`;
  // The unique temp name means no later call cleans up after us, so on any
  // failure we must remove our own temp file or it is orphaned permanently.
  try {
    await fsp.writeFile(tmp, JSON.stringify(data) + "\n", "utf-8");
    await fsp.rename(tmp, absPath);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}
