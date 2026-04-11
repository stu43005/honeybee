// @ts-check
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist/**", "node_modules/**", "coverage/**"]),
  eslint.configs.recommended,
  tseslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", "jest.config.mjs"],
        },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- import.meta.dirname is string at runtime; JS config typing is loose
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
    },
  },
  prettier
);
