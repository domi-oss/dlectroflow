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
      expect(resolveBreakdownModel({ tier: "guest" })).toBe("claude-haiku-4-5");
      expect(resolveBreakdownModel({ tier: "owner" })).toBe(
        "claude-sonnet-4-6",
      );
    });
    it("guest always gets haiku regardless of owner setting", () => {
      expect(
        resolveBreakdownModel({
          tier: "guest",
          ownerSetting: "claude-opus-4-8",
        }),
      ).toBe("claude-haiku-4-5");
    });
    it("owner uses a valid stored setting", () => {
      expect(
        resolveBreakdownModel({
          tier: "owner",
          ownerSetting: "claude-opus-4-8",
        }),
      ).toBe("claude-opus-4-8");
    });
    it("owner with no setting falls back to the default", () => {
      expect(resolveBreakdownModel({ tier: "owner", ownerSetting: null })).toBe(
        "claude-sonnet-4-6",
      );
    });
    it("owner with an off-allowlist value (e.g. fable) falls back to default", () => {
      expect(
        resolveBreakdownModel({
          tier: "owner",
          ownerSetting: "claude-fable-5",
        }),
      ).toBe("claude-sonnet-4-6");
    });
  });

  // ── #96 — a member is a third tier, not "not the owner" ─────────────────
  //
  // resolveBreakdownModel took { isOwner: boolean }. Before accounts that was a
  // true binary: you were the owner or you were a guest, so "not the owner"
  // meaning "cheapest tier" was correct. An invited member is a third thing and
  // landed in the guest branch, so every member got Haiku - the tier chosen as a
  // GUEST COST LEVER - including a member paying for their own API calls.
  describe("resolveBreakdownModel — tiers, not a boolean (#96)", () => {
    it("a guest still gets the cheap tier — the cost lever must survive", () => {
      expect(resolveBreakdownModel({ tier: "guest" })).toBe("claude-haiku-4-5");
    });

    it("a guest still honours GUEST_BREAKDOWN_MODEL", () => {
      process.env.GUEST_BREAKDOWN_MODEL = "claude-opus-4-8";
      expect(resolveBreakdownModel({ tier: "guest" })).toBe("claude-opus-4-8");
    });

    it("a member with their OWN key gets the owner-grade tier — they are paying", () => {
      // Handing the cheapest model to someone billed for their own usage is the
      // wrong way round, and it is the sharp end of #96.
      expect(resolveBreakdownModel({ tier: "member", hasOwnKey: true })).toBe(
        "claude-sonnet-4-6",
      );
    });

    it("a member with their own key ignores GUEST_BREAKDOWN_MODEL entirely", () => {
      process.env.GUEST_BREAKDOWN_MODEL = "claude-haiku-4-5";
      expect(
        resolveBreakdownModel({ tier: "member", hasOwnKey: true }),
      ).not.toBe("claude-haiku-4-5");
    });

    it("a member with their own key ignores the owner's configured tier too", () => {
      // It is not the owner's spend to economise on.
      expect(
        resolveBreakdownModel({
          tier: "member",
          hasOwnKey: true,
          ownerSetting: "claude-haiku-4-5",
        }),
      ).toBe("claude-sonnet-4-6");
    });

    it("a member on the instance key follows the owner's configured tier", () => {
      // A member on the instance key is the owner's cost decision, and the owner
      // already has a control for it. It is NOT the guest lever.
      expect(
        resolveBreakdownModel({
          tier: "member",
          ownerSetting: "claude-opus-4-8",
        }),
      ).toBe("claude-opus-4-8");
    });

    it("a member on the instance key with no setting gets the owner default", () => {
      expect(resolveBreakdownModel({ tier: "member" })).toBe(
        "claude-sonnet-4-6",
      );
    });

    it("ignores an un-allowlisted ownerSetting for every non-guest tier", () => {
      for (const tier of ["owner", "member"] as const) {
        expect(
          resolveBreakdownModel({ tier, ownerSetting: "gpt-cheapest" }),
        ).toBe("claude-sonnet-4-6");
      }
    });

    it("the owner is unchanged: setting, then env, then the default", () => {
      expect(
        resolveBreakdownModel({
          tier: "owner",
          ownerSetting: "claude-opus-4-8",
        }),
      ).toBe("claude-opus-4-8");
      process.env.OWNER_BREAKDOWN_MODEL = "claude-haiku-4-5";
      expect(resolveBreakdownModel({ tier: "owner" })).toBe("claude-haiku-4-5");
      delete process.env.OWNER_BREAKDOWN_MODEL;
      expect(resolveBreakdownModel({ tier: "owner" })).toBe(
        "claude-sonnet-4-6",
      );
    });

    it("an own key does not promote a GUEST — a guest has no account to hold one", () => {
      expect(resolveBreakdownModel({ tier: "guest", hasOwnKey: true })).toBe(
        "claude-haiku-4-5",
      );
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

  it("every tier resolves to LLM_MODEL when no split set", () => {
    expect(resolveBreakdownModel({ tier: "owner" })).toBe("llama3.1:8b");
    expect(resolveBreakdownModel({ tier: "member" })).toBe("llama3.1:8b");
    expect(resolveBreakdownModel({ tier: "guest" })).toBe("llama3.1:8b");
  });

  it("respects an explicit owner/guest split over LLM_MODEL", () => {
    process.env.LLM_OWNER_MODEL = "llama3.1:70b";
    process.env.LLM_GUEST_MODEL = "llama3.1:8b-instruct";
    expect(resolveBreakdownModel({ tier: "owner" })).toBe("llama3.1:70b");
    expect(resolveBreakdownModel({ tier: "guest" })).toBe(
      "llama3.1:8b-instruct",
    );
  });

  it("only a guest gets LLM_GUEST_MODEL — a member is not a guest (#96)", () => {
    process.env.LLM_OWNER_MODEL = "local-big";
    process.env.LLM_GUEST_MODEL = "local-tiny";
    expect(resolveBreakdownModel({ tier: "guest" })).toBe("local-tiny");
    expect(resolveBreakdownModel({ tier: "member" })).toBe("local-big");
    expect(resolveBreakdownModel({ tier: "owner" })).toBe("local-big");
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
    expect(() => resolveBreakdownModel({ tier: "owner" })).toThrow(
      /requires LLM_MODEL/,
    );
    expect(() => resolveUtilityModel()).toThrow(/requires LLM_MODEL/);
  });
});
