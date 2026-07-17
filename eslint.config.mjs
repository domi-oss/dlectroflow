import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Background-agent git worktrees live under .claude/worktrees/ and carry
    // their own .next build output — never lint those. (`.next/**` above only
    // matches the top level, so nested build dirs need the globs too.)
    ".claude/**",
    "**/.next/**",
  ]),
  {
    // React-compiler-era advisory rules, demoted to warn so the CI lint gate
    // (#21 P3) can block on real errors today. Existing findings + restoring
    // these to error are tracked in issue #23 — don't add new ones.
    rules: {
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
]);

export default eslintConfig;
