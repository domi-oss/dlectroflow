import { describe, it, expect, afterEach } from "vitest";
import {
  encryptToken,
  decryptToken,
  encryptNullable,
  decryptNullable,
} from "./token-cipher";

const KEY = "0".repeat(64);

afterEach(() => {
  process.env.TOKEN_ENC_KEY = KEY;
});

describe("token-cipher", () => {
  it("round-trips a value", () => {
    const secret = "ya29.a0AfB_reclaim-refresh-token";
    expect(decryptToken(encryptToken(secret))).toBe(secret);
  });

  it("produces a v1 envelope that is not the plaintext", () => {
    const out = encryptToken("hello");
    expect(out.startsWith("v1:")).toBe(true);
    expect(out).not.toContain("hello");
  });

  it("uses a fresh IV each call (same input → different ciphertext)", () => {
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("rejects a tampered payload (auth-tag failure)", () => {
    const out = encryptToken("tamper-me");
    const flipped = out.slice(0, -2) + (out.endsWith("A") ? "B" : "A") + out.slice(-1);
    expect(() => decryptToken(flipped)).toThrow();
  });

  it("rejects a non-v1 / malformed envelope", () => {
    expect(() => decryptToken("plaintext-no-prefix")).toThrow();
    expect(() => decryptToken("v2:whatever")).toThrow();
  });

  it("rejects a key of the wrong length", () => {
    process.env.TOKEN_ENC_KEY = "abcd"; // 2 bytes
    expect(() => encryptToken("x")).toThrow(/32 bytes/);
  });

  it("throws when the key is missing", () => {
    delete process.env.TOKEN_ENC_KEY;
    expect(() => encryptToken("x")).toThrow(/TOKEN_ENC_KEY/);
  });

  it("nullable helpers pass null through and round-trip values", () => {
    expect(encryptNullable(null)).toBeNull();
    expect(encryptNullable(undefined)).toBeNull();
    expect(decryptNullable(null)).toBeNull();
    const enc = encryptNullable("v");
    expect(enc).not.toBeNull();
    expect(decryptNullable(enc)).toBe("v");
  });

  it("encryptNullable handles empty string (not null)", () => {
    const encrypted = encryptNullable("");
    expect(encrypted).not.toBeNull();
    expect(encrypted).toMatch(/^v1:/);
    expect(decryptNullable(encrypted)).toBe("");
  });

  it("decryptNullable throws on empty non-null string", () => {
    expect(() => decryptNullable("")).toThrow();
  });

  it("decryptToken throws on v1-prefixed but too-short payload", () => {
    expect(() => decryptToken("v1:AAAA")).toThrow(/Malformed token envelope/);
  });
});
