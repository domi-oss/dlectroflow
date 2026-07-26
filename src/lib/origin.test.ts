import { describe, it, expect, afterEach } from "vitest";
import { publicOrigin } from "./origin";

describe("publicOrigin", () => {
  const savedOrigin = process.env.PUBLIC_ORIGIN;
  const savedNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.PUBLIC_ORIGIN = savedOrigin;
    // NODE_ENV is read-only-ish under some setups; reassign defensively.
    (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
  });

  it("returns PUBLIC_ORIGIN when set", () => {
    process.env.PUBLIC_ORIGIN = "https://dlectroflow.dev";
    expect(publicOrigin()).toBe("https://dlectroflow.dev");
  });

  it("strips trailing slashes from PUBLIC_ORIGIN", () => {
    process.env.PUBLIC_ORIGIN = "https://dlectroflow.dev//";
    expect(publicOrigin()).toBe("https://dlectroflow.dev");
  });

  it("falls back to localhost in non-production when PUBLIC_ORIGIN is unset", () => {
    delete process.env.PUBLIC_ORIGIN;
    (process.env as Record<string, string | undefined>).NODE_ENV =
      "development";
    expect(publicOrigin()).toBe("http://localhost:3000");
  });

  it("refuses to guess in production when PUBLIC_ORIGIN is unset", () => {
    delete process.env.PUBLIC_ORIGIN;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(() => publicOrigin()).toThrow(/PUBLIC_ORIGIN/);
  });
});
