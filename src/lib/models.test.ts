import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveBreakdownModel,
  breakdownParamsFor,
  modelChoicesForProvider,
  resolveUtilityModel,
} from "./models";

beforeEach(() => {
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_OWNER_MODEL;
  delete process.env.LLM_GUEST_MODEL;
  delete process.env.OWNER_BREAKDOWN_MODEL;
  delete process.env.GUEST_BREAKDOWN_MODEL;
});

describe("anthropic provider (default)", () => {
  describe("resolveBreakdownModel", () => {
    it("guest → haiku default, owner → sonnet default", () => {
      expect(resolveBreakdownModel({ isOwner: false })).toBe(
        "claude-haiku-4-5",
      );
      expect(resolveBreakdownModel({ isOwner: true })).toBe(
        "claude-sonnet-4-6",
      );
    });
    it("guest always gets haiku regardless of owner setting", () => {
      expect(
        resolveBreakdownModel({
          isOwner: false,
          ownerSetting: "claude-opus-4-8",
        }),
      ).toBe("claude-haiku-4-5");
    });
    it("owner uses a valid stored setting", () => {
      expect(
        resolveBreakdownModel({
          isOwner: true,
          ownerSetting: "claude-opus-4-8",
        }),
      ).toBe("claude-opus-4-8");
    });
    it("owner with no setting falls back to the default", () => {
      expect(resolveBreakdownModel({ isOwner: true, ownerSetting: null })).toBe(
        "claude-sonnet-4-6",
      );
    });
    it("owner with an off-allowlist value (e.g. fable) falls back to default", () => {
      expect(
        resolveBreakdownModel({
          isOwner: true,
          ownerSetting: "claude-fable-5",
        }),
      ).toBe("claude-sonnet-4-6");
    });
  });

  it("breakdownParamsFor returns hints (thinking/effort) for sonnet/opus, bare for haiku", () => {
    expect(breakdownParamsFor("claude-haiku-4-5")).toEqual({
      model: "claude-haiku-4-5",
      hints: {},
    });
    expect(breakdownParamsFor("claude-opus-4-8")).toEqual({
      model: "claude-opus-4-8",
      hints: { thinking: true, effort: "low" },
    });
    expect(breakdownParamsFor("claude-sonnet-4-6")).toEqual({
      model: "claude-sonnet-4-6",
      hints: { thinking: true, effort: "low" },
    });
  });

  it("exposes the three-tier choice list", () => {
    expect(modelChoicesForProvider()?.map((c) => c.id)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-8",
    ]);
  });

  it("resolveUtilityModel always returns opus (BREAKDOWN_MODEL), matching pre-#59 spark/rollup/focus behavior", () => {
    expect(resolveUtilityModel()).toBe("claude-opus-4-8");
  });
});

describe("openai-compatible provider", () => {
  beforeEach(() => {
    process.env.LLM_PROVIDER = "openai-compatible";
    process.env.LLM_MODEL = "llama3.1:8b";
  });

  it("owner + guest both resolve to LLM_MODEL when no split set", () => {
    expect(resolveBreakdownModel({ isOwner: true })).toBe("llama3.1:8b");
    expect(resolveBreakdownModel({ isOwner: false })).toBe("llama3.1:8b");
  });

  it("respects an explicit owner/guest split over LLM_MODEL", () => {
    process.env.LLM_OWNER_MODEL = "llama3.1:70b";
    process.env.LLM_GUEST_MODEL = "llama3.1:8b-instruct";
    expect(resolveBreakdownModel({ isOwner: true })).toBe("llama3.1:70b");
    expect(resolveBreakdownModel({ isOwner: false })).toBe(
      "llama3.1:8b-instruct",
    );
  });

  it("breakdownParamsFor never attaches anthropic-only hints", () => {
    expect(breakdownParamsFor("llama3.1:8b")).toEqual({
      model: "llama3.1:8b",
      hints: {},
    });
  });

  it("has no user-facing choice list (single configured model)", () => {
    expect(modelChoicesForProvider()).toBeNull();
  });

  it("resolveUtilityModel resolves the configured owner model, split over LLM_MODEL", () => {
    expect(resolveUtilityModel()).toBe("llama3.1:8b");
    process.env.LLM_OWNER_MODEL = "llama3.1:70b";
    expect(resolveUtilityModel()).toBe("llama3.1:70b");
  });

  it("throws a descriptive error when no model env is configured", () => {
    delete process.env.LLM_MODEL;
    delete process.env.LLM_OWNER_MODEL;
    delete process.env.LLM_GUEST_MODEL;
    expect(() => resolveBreakdownModel({ isOwner: true })).toThrow(
      /requires LLM_MODEL/,
    );
    expect(() => resolveUtilityModel()).toThrow(/requires LLM_MODEL/);
  });
});
