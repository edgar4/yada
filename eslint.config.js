import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  { ignores: ["dist/**", "coverage/**", "work/**", "yada-branding/**"] },
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
    files: ["site/assets/widget-demo.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        location: "readonly",
        globalThis: "readonly",
        Response: "readonly",
        URL: "readonly",
        ReadableStream: "readonly",
        TextEncoder: "readonly",
        setTimeout: "readonly",
      },
    },
  },
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
