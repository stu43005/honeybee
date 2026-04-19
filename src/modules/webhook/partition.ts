import { createHash } from "node:crypto";

/**
 * Deterministic uint32 hash of a collection name.
 * Used by assignInstance() to map collections to instances.
 * MD5 is used for distribution only, not security.
 */
export function hashCollection(collName: string): number {
  const digest = createHash("md5").update(collName).digest();
  return digest.readUInt32BE(0);
}

/**
 * Pure function: given a collection name and a list of active instance IDs,
 * deterministically returns the instance responsible for that collection.
 * Instance list is sorted internally for stability.
 */
export function assignInstance(
  collName: string,
  instanceIds: readonly string[]
): string {
  if (instanceIds.length === 0) {
    throw new Error("assignInstance: no active instances");
  }
  const sorted = [...instanceIds].sort();
  return sorted[hashCollection(collName) % sorted.length];
}
