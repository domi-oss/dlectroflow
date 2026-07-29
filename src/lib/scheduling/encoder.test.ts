import { describe, it, expect, afterEach } from "vitest";
import { pickEncoder } from "./encoder";
import { encodeReclaim } from "./encode-reclaim";
import { encodePlain } from "./encode-plain";

afterEach(() => {
  delete process.env.SCHEDULING_SYNTAX;
});

describe("pickEncoder", () => {
  it("uses the Reclaim encoder for Reclaim's own list", () => {
    expect(pickEncoder("🗓 Reclaim")).toBe(encodeReclaim);
    expect(pickEncoder("my reclaim tasks")).toBe(encodeReclaim);
  });

  it("uses the plain encoder for any other list", () => {
    expect(pickEncoder("My Tasks")).toBe(encodePlain);
    expect(pickEncoder("")).toBe(encodePlain);
  });

  it("lets SCHEDULING_SYNTAX override the detection in both directions", () => {
    process.env.SCHEDULING_SYNTAX = "plain";
    expect(pickEncoder("🗓 Reclaim")).toBe(encodePlain);
    process.env.SCHEDULING_SYNTAX = "reclaim";
    expect(pickEncoder("My Tasks")).toBe(encodeReclaim);
  });

  it("ignores an unrecognised override rather than throwing", () => {
    process.env.SCHEDULING_SYNTAX = "nonsense";
    expect(pickEncoder("🗓 Reclaim")).toBe(encodeReclaim);
  });
});
