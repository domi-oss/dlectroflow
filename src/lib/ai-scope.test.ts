import { describe, it, expect } from "vitest";
import { isGuestWorkspace } from "./constants";

describe("isGuestWorkspace", () => {
  it("owner id is not a guest", () =>
    expect(isGuestWorkspace("owner")).toBe(false));
  it("any other id is a guest", () =>
    expect(isGuestWorkspace("abc-123")).toBe(true));
});
