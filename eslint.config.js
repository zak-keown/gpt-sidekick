import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.output/**",
      "**/.wxt/**",
      "fixtures.local/**",
    ],
  },
  {
    files: ["packages/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "core", pattern: "packages/core/**" },
        { type: "adapters", pattern: "packages/adapters/**" },
        { type: "ui", pattern: "packages/ui/**" },
        { type: "apps", pattern: "apps/**" },
      ],
    },
    rules: {
      // Path-based layering: core imports nothing; adapters/ui may use core;
      // apps compose everything.
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            { from: "adapters", allow: ["core"] },
            { from: "ui", allow: ["core"] },
            { from: "apps", allow: ["core", "adapters", "ui", "apps"] },
          ],
        },
      ],
      // Workspace imports resolve by package name, which boundaries treats as
      // external — enforce the same rule at the package-name level for core.
      "boundaries/external": [
        "error",
        {
          default: "allow",
          rules: [
            {
              from: ["core"],
              disallow: ["@gpt-sidekick/*"],
              message:
                "core must stay dependency-free of adapters/ui (host-agnostic)",
            },
          ],
        },
      ],
    },
  },
);
