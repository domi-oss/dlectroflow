import { describe, it, expect } from "vitest";
import { resolveBreakdownModel, breakdownParamsFor } from "./models";

describe("resolveBreakdownModel", () => {
  it("guest always gets haiku regardless of owner setting", () => {
    expect(resolveBreakdownModel({ isOwner: false, ownerSetting: "claude-opus-4-8" })).toBe("claude-haiku-4-5");
  });
  it("owner uses a valid stored setting", () => {
    expect(resolveBreakdownModel({ isOwner: true, ownerSetting: "claude-opus-4-8" })).toBe("claude-opus-4-8");
  });
  it("owner with no setting falls back to the default", () => {
    expect(resolveBreakdownModel({ isOwner: true, ownerSetting: null })).toBe("claude-sonnet-4-6");
  });
  it("owner with an off-allowlist value (e.g. fable) falls back to default", () => {
    expect(resolveBreakdownModel({ isOwner: true, ownerSetting: "claude-fable-5" })).toBe("claude-sonnet-4-6");
  });
});

describe("breakdownParamsFor", () => {
  it("haiku gets no thinking and no effort", () => {
    const p = breakdownParamsFor("claude-haiku-4-5");
    expect(p.thinking).toBeUndefined();
    expect(p.output_config).toBeUndefined();
  });
  it("sonnet/opus get adaptive thinking + low effort", () => {
    const p = breakdownParamsFor("claude-sonnet-4-6");
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "low" });
  });
});
