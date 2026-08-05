import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "@/lib/source-text";
import { LlmProvider } from "@/lib/constants";
import { detectForeignProviderKey } from "./key-shape";

/**
 * #177 step 1 — the shape check that stops a member pasting one provider's key
 * into an instance configured for another.
 *
 * Every spec below is really about one property, and it is an ASYMMETRIC one:
 * the check answers "does this unmistakably belong to somebody ELSE", never
 * "does this conform to the configured provider's format". The false-reject
 * block is therefore the load-bearing part of this file — see the comment above
 * it before tightening anything here.
 */

const ANTHROPIC = LlmProvider.Anthropic;
const COMPATIBLE = LlmProvider.OpenAICompatible;

describe("detectForeignProviderKey — known-foreign is rejected", () => {
  // Both directions of the pair the app actually supports. The anthropic side
  // is the case that happened in production on 2026-08-05: a key that saved,
  // decrypted and was then refused by Anthropic with `401 invalid x-api-key`,
  // with nothing on screen to say so.
  //
  // FIXTURES CARRY THE PREFIX AND NOTHING ELSE THAT IS REALISTIC. The module
  // only ever looks at the prefix, so the body is padding — and padding it to a
  // credible length makes it a credible credential. The first version of the
  // Google row was `AIza` + 35 characters, which is EXACTLY the GCP API key
  // format, and secret detection reported it CRITICAL on this file. Keep new
  // rows too short or too obviously fake to match a scanner's regex.
  it.each([
    ["OpenAI project key", "sk-proj-not-a-real-key", "OpenAI"],
    ["OpenAI service-account key", "sk-svcacct-not-a-real-key", "OpenAI"],
    ["OpenAI admin key", "sk-admin-not-a-real-key", "OpenAI"],
    ["OpenRouter key", "sk-or-v1-not-a-real-key", "OpenRouter"],
    ["Google AI key", "AIza-not-a-real-key", "Google AI"],
    ["Groq key", "gsk_not-a-real-key", "Groq"],
    ["xAI key", "xai-not-a-real-key", "xAI"],
    ["Hugging Face token", "hf_not-a-real-key", "Hugging Face"],
  ])("rejects a %s on an anthropic instance", (_label, key, looksLike) => {
    expect(detectForeignProviderKey(key, ANTHROPIC)).toEqual({
      looksLike,
      expectedProvider: "Anthropic",
      expectedPrefix: "sk-ant-",
    });
  });

  it("rejects an Anthropic key on an openai-compatible instance", () => {
    // The ONLY assertion that is safe in this direction — see the false-reject
    // block for why every other prefix has to be accepted here.
    expect(detectForeignProviderKey("sk-ant-api03-AAAA", COMPATIBLE)).toEqual({
      looksLike: "Anthropic",
      expectedProvider: "OpenAI-compatible",
      // No fixed prefix exists to name: the endpoint is whatever the owner
      // configured, and its tokens are arbitrary strings. The panel branches on
      // this null rather than printing a prefix that would be a guess.
      expectedPrefix: null,
    });
  });

  it("still detects a foreign shape around pasted whitespace", () => {
    // `saveOwnLlmKey` trims before it calls this, but a check that a leading
    // space defeats is a check that depends on call order to be correct.
    expect(
      detectForeignProviderKey("  sk-proj-AAAAAAAAAAAA\n", ANTHROPIC),
    ).toMatchObject({ looksLike: "OpenAI" });
  });

  it("never returns any part of the key it was given", () => {
    // The rejection message is built from this return value and rendered in the
    // account panel, so anything derived from the key itself would put a secret
    // on screen (and in an RSC payload) that `account.ts` is deliberately built
    // to keep server-side.
    const secret = "sk-proj-THIS-IS-THE-SECRET-9f2c";
    const match = detectForeignProviderKey(secret, ANTHROPIC);
    expect(JSON.stringify(match)).not.toContain("THIS-IS-THE-SECRET");
    expect(JSON.stringify(match)).not.toContain("9f2c");
  });
});

describe("detectForeignProviderKey — the native shape is accepted", () => {
  it("accepts an Anthropic key on an anthropic instance", () => {
    expect(detectForeignProviderKey("sk-ant-api03-AAAA", ANTHROPIC)).toBeNull();
  });

  it("accepts an OpenAI key on an openai-compatible instance", () => {
    // OpenAI itself is the reference openai-compatible endpoint, so its keys
    // are native here, not foreign.
    expect(detectForeignProviderKey("sk-proj-AAAAAAAA", COMPATIBLE)).toBeNull();
  });
});

/**
 * THE BLOCK THAT MATTERS. #177 states the rule as "fail-open on unknown,
 * fail-closed on known-foreign", and the fail-open half is the one with teeth:
 * a conformance check ("must start `sk-ant-`") would turn a valid key in a
 * format the provider introduced after this table was written into a key that
 * CANNOT BE SAVED AT ALL. That is strictly worse than the silent 401 this issue
 * is fixing, because the user has no workaround.
 *
 * So every spec here asserts an ACCEPT, and each one would start failing the
 * moment somebody "tightened" this module into a conformance check.
 */
describe("detectForeignProviderKey — unrecognised shapes are ACCEPTED", () => {
  it.each([
    // A format Anthropic has not issued yet. This is the whole argument.
    ["a hypothetical next-generation Anthropic format", "sk-ant2-AAAAAAAA"],
    ["a format with no `sk-` prefix at all", "anthropic-v2-AAAAAAAAAAAA"],
    // A bare `sk-` is NOT unmistakable: it is the legacy OpenAI shape, but it
    // is also what a future Anthropic or self-hosted key could look like.
    // Ambiguity resolves to accept, and step 2 of #177 (the authenticated
    // probe) is what closes this gap — not a guess made here.
    ["a bare `sk-` token", `sk-${"A".repeat(48)}`],
    ["an opaque token", "9f2c4b1e8a7d3f5c9e0b2a4d6f8c1e3a"],
    ["a JWT-shaped token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.AAAA"],
  ])("accepts %s on an anthropic instance", (_label, key) => {
    expect(detectForeignProviderKey(key, ANTHROPIC)).toBeNull();
  });

  it.each([
    // Each of these is a REAL openai-compatible endpoint's token. An
    // openai-compatible instance points at whatever base URL the owner set, so
    // asserting anything beyond `sk-ant-` here rejects working configurations.
    ["an OpenRouter key", "sk-or-v1-not-a-real-key"],
    [
      "a Google AI key (Gemini's OpenAI-compatible endpoint)",
      "AIza-not-a-real-key",
    ],
    ["a Groq key", "gsk_not-a-real-key"],
    ["a Hugging Face token", "hf_not-a-real-key"],
    ["an xAI key", "xai-not-a-real-key"],
    ["a self-hosted opaque token", "local-dev-token"],
  ])("accepts %s on an openai-compatible instance", (_label, key) => {
    expect(detectForeignProviderKey(key, COMPATIBLE)).toBeNull();
  });

  it("matches prefixes case-sensitively, and accepts on a near miss", () => {
    // API keys are case-sensitive, so `SK-ANT-…` is already a broken key and
    // the provider will say so. Widening the match to catch it would only add
    // a way to reject something this module cannot actually identify.
    expect(
      detectForeignProviderKey("SK-ANT-API03-AAAA", COMPATIBLE),
    ).toBeNull();
    expect(detectForeignProviderKey("SK-PROJ-AAAAAAAA", ANTHROPIC)).toBeNull();
  });

  it("accepts an empty or whitespace-only string rather than guessing", () => {
    // `saveOwnLlmKey` rejects these earlier with `invalid_key`; this module
    // must not be the thing that turns them into a confusing "wrong provider"
    // message if that order ever changes.
    expect(detectForeignProviderKey("", ANTHROPIC)).toBeNull();
    expect(detectForeignProviderKey("   ", COMPATIBLE)).toBeNull();
  });
});

describe("detectForeignProviderKey — the module stays pure", () => {
  // #177 asks for a pure table so it is testable without a database or a
  // provider. A source scan rather than a mock, because the property is "this
  // file performs no I/O", which no amount of stubbing can demonstrate.
  // Comments are stripped first — the doc comments in that file necessarily
  // discuss keys and providers, and a scanner that reads prose as code
  // punishes the explanation (the idiom scoping.harness.test.ts uses).
  const code = stripComments(readFileSync("src/lib/llm/key-shape.ts", "utf8"));

  it.each(["process.env", "fetch(", "prisma", "readFileSync", "require("])(
    "does not reference %s",
    (forbidden) => {
      expect(code).not.toContain(forbidden);
    },
  );

  it("imports nothing but the provider-id constants", () => {
    const specifiers = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (m) => m[1],
    );
    expect(specifiers).toEqual(["@/lib/constants"]);
  });
});
