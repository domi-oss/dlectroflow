// Extends `expect` with @testing-library/jest-dom matchers (toBeInTheDocument,
// toHaveAttribute, etc). Safe to load for node-environment tests too — the
// matchers only touch the DOM when actually called from a jsdom test file.
// Component tests opt into the DOM via a `// @vitest-environment jsdom`
// docblock at the top of the file; the global default stays "node".
import "@testing-library/jest-dom/vitest";

// Deterministic key so token-cipher tests have a valid TOKEN_ENC_KEY.
// (32 bytes of 0x00 as 64 hex chars.) Individual tests may override/delete it.
process.env.TOKEN_ENC_KEY ??= "0".repeat(64);
