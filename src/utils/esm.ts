import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { argv } from "node:process";
import { createRequire } from "node:module";

/**
 * ESM replacement for `__filename`.
 * Usage: `__filename(import.meta)`
 */
export const __filename = (meta: ImportMeta): string =>
  fileURLToPath(meta.url);

/**
 * ESM replacement for `__dirname`.
 * Usage: `__dirname(import.meta)`
 */
export const __dirname = (meta: ImportMeta): string =>
  dirname(__filename(meta));

/**
 * Indicates that the script was run directly.
 * ESM replacement for `require.main === module`.
 * Usage: `isMain(import.meta)`
 */
export const isMain = (meta: ImportMeta): boolean => {
  if (!meta || !argv[1]) return false;
  const require = createRequire(meta.url);
  const scriptPath = require.resolve(argv[1]);
  const modulePath = __filename(meta);
  return scriptPath === modulePath;
};
