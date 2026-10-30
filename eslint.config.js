import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  { ignores: ["dist/**", "coverage/**"] },
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
  { files: ["**/*.js"], extends: [ts.configs.disableTypeChecked] },
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
            "node:*",
          ],
        },
      ],
    },
  },
);
