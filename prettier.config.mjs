/**
 * Prettier configuration (issue #32 — `prettier --check` format gate).
 *
 * These values are NOT copied from Prettier's defaults blindly: each one is the
 * convention already present in the existing tree (measured across src/**), so
 * turning the gate on reformats almost nothing. Encoding them explicitly makes
 * the intent reviewable and pins the style even if Prettier's defaults ever
 * change under us.
 *
 *   semi: true            — 683 of 729 import statements already end in `;`
 *                           (the 46 that don't are three shadcn-generated files).
 *   singleQuote: false    — 688 double-quoted imports, 0 single-quoted.
 *   tabWidth: 2 / no tabs — every indented file uses 2-space indentation; none
 *                           use hard tabs.
 *   trailingComma: "all"  — multiline literals AND function params/args already
 *                           carry trailing commas throughout (278 before `)`).
 *   printWidth: 80        — the tree is written to ~80 cols; multiline objects,
 *                           JSX, and call args already wrap there.
 *
 * Prettier does not fight ESLint here: eslint-config-next (core-web-vitals +
 * typescript) carries no stylistic/formatting rules (quotes/semi/indent), so no
 * eslint-config-prettier shim is needed — verified by a clean `npm run lint`
 * after the repo-wide reformat.
 *
 * .mjs (not .json) so the reasoning above can live beside the values, matching
 * the repo's other config files (eslint.config.mjs, postcss.config.mjs).
 *
 * @type {import("prettier").Config}
 */
const config = {
  semi: true,
  singleQuote: false,
  tabWidth: 2,
  useTabs: false,
  trailingComma: "all",
  printWidth: 80,
};

export default config;
