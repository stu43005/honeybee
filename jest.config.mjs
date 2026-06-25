/** @type {import('jest').Config} */
const config = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  // Bound parallel workers so concurrent ts-jest processes cannot exhaust
  // system memory. Combined with ts-jest `isolatedModules` (transpile-only,
  // no per-worker full type-check program), this keeps each worker lightweight.
  maxWorkers: "50%",
  testMatch: ["**/tests/**/*.ts?(x)", "**/?(*.)+(spec|test).ts?(x)"],
  testPathIgnorePatterns: ["dist", "\\.claude/worktrees/"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transformIgnorePatterns: ["/node_modules/(?!lodash-es/)"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        // Transpile-only: skip ts-jest's full type-checking program (~2GB per
        // worker). Type safety is still enforced by `npm run build` (tsc).
        // Set here (not in tsconfig) so tsc can keep inlining holodex.js's
        // ambient `const enum`s, which TS2748 forbids under isolatedModules;
        // ts-jest's transpile emits them as runtime member access, and
        // holodex.js ships real runtime enum objects, so they resolve.
        isolatedModules: true,
      },
    ],
  },
};

export default config;
