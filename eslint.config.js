import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  { ignores: ["dist/**", "coverage/**", "work/**"] },
  js.configs.recommended,
  ...ts.configs.strictTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  { files: ["**/*.{js,mjs}"], extends: [ts.configs.disableTypeChecked] },
  {
    files: ["scripts/*.mjs", "deploy/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        AbortSignal: "readonly",
      },
    },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "**/providers/**",
            "**/integrations/**",
            "**/connectors/**",
            "**/storage/**",
            "node:*",
          ],
        },
      ],
    },
  },
);
