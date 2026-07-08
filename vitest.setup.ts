// Extends `expect` with @testing-library/jest-dom matchers (toBeInTheDocument,
// toHaveAttribute, etc). Safe to load for node-environment tests too — the
// matchers only touch the DOM when actually called from a jsdom test file.
// Component tests opt into the DOM via a `// @vitest-environment jsdom`
// docblock at the top of the file; the global default stays "node".
import "@testing-library/jest-dom/vitest";
