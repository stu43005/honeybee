// @ts-check
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const SERVICES = [
  "scheduler",
  "worker",
  "crawler",
  "manager",
  "webhook",
  "discord-bot",
  "metrics",
];

const SHARED_MESSAGE =
  "Use a #models / #modules / #utils alias, or promote the shared code out of src/services/.";

const crossServiceOverrides = SERVICES.map((service) => ({
  files: [`src/services/${service}/**/*.ts`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: SERVICES.filter((sibling) => sibling !== service).flatMap(
          (sibling) => [
            {
              // Direct sibling reference at any ascent depth:
              // "./webhook/x.js", "../webhook/x.js", "../../webhook/x.js".
              regex: `^\\.\\.?(\\/\\.\\.)*\\/${sibling}(\\/|$)`,
              message: `Cross-service import into "${sibling}" is forbidden. ${SHARED_MESSAGE}`,
            },
            {
              // Any relative spelling that climbs out and names the segment
              // again: "../../services/webhook/x.js".
              regex: `^\\.\\.?\\/(.*\\/)?services\\/${sibling}(\\/|$)`,
              message: `Cross-service import into "${sibling}" is forbidden. ${SHARED_MESSAGE}`,
            },
          ]
        ),
      },
    ],
  },
}));

const sharedLayerOverride = {
  files: ["src/models/**/*.ts", "src/modules/**/*.ts", "src/utils/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            // Shared code must never reach into a service. Relative-anchored so
            // an unrelated package path such as "some-pkg/services/x" is not hit.
            regex: `^\\.\\.?\\/(.*\\/)?services\\/`,
            message:
              "Shared code must not import service-private modules; that would re-expose one service's internals to every other service.",
          },
        ],
      },
    ],
  },
};

export default defineConfig(
  globalIgnores(["dist/**", "node_modules/**", "coverage/**"]),
  eslint.configs.recommended,
  tseslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Separate tsconfig that also includes spec/test files and config files
        // (main tsconfig.json excludes them from the build output).
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow underscore-prefixed unused args (conventional "intentionally unused")
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Do not flag passing async functions as callbacks (EventEmitter / setInterval / etc.).
      // Still flags real type lies like `if (asyncFn())` or assigning to a `() => void` property.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false } },
      ],
      // Type-safety cluster accepted as-is for the existing codebase.
      // Most violations live in mongoose/typegoose/axios glue code where `any`
      // is pragmatic. Tightening these requires case-by-case type design and
      // is deferred to follow-up work. New code should prefer explicit types.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },
  ...crossServiceOverrides,
  sharedLayerOverride,
  prettier
);
