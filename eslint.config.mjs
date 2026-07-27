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
    rules: {
      // React-compiler-era rules. Demoted to warn when the CI lint gate landed
      // (#21 P3) because main already had findings — 15 of them by the time #23
      // was picked up, since nothing was blocking new ones. #23 fixed 9 and
      // suppressed 6 inline with a per-site reason (5 Date.now() reads in async
      // Server Components + one deliberate poll), so they are back at ERROR and
      // now block CI. New violations are bugs, not backlog.
      "react-hooks/purity": "error",
      "react-hooks/set-state-in-effect": "error",
      "react-hooks/refs": "error",
      // #23 — a leading underscore is already this repo's marker for "declared
      // to satisfy a contract / arity, deliberately not read" (see the
      // scheduling providers' `_ctx`/`_opts`, which say so in a comment). Honour
      // it instead of leaving five permanently-warning intentional cases that
      // train people to ignore lint output. Anything unmarked still warns.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
