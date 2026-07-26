import { describe, it, expect } from "vitest";
import {
  buildStructuredInstruction,
  parseStructuredResult,
} from "./structured-output";

const tool = {
  name: "propose_steps",
  description: "d",
  inputSchema: {
    type: "object",
    properties: { parentEmoji: { type: "string" }, steps: { type: "array" } },
    required: ["parentEmoji", "steps"],
  },
};

describe("buildStructuredInstruction", () => {
  it("names the <result> sentinel and includes the schema", () => {
    const s = buildStructuredInstruction(tool);
    expect(s).toContain("<result>");
    expect(s).toContain("</result>");
    expect(s).toContain("propose_steps");
    expect(s).toContain('"parentEmoji"');
  });
});

describe("parseStructuredResult", () => {
  it("extracts and parses a valid <result> block matching required keys", () => {
    const text = 'Sure!\n<result>{"parentEmoji":"🗂️","steps":[]}</result>';
    expect(parseStructuredResult(text, tool)).toEqual({
      name: "propose_steps",
      input: { parentEmoji: "🗂️", steps: [] },
    });
  });
  it("returns undefined when the block is missing", () => {
    expect(parseStructuredResult("no json here", tool)).toBeUndefined();
  });
  it("returns undefined on malformed JSON", () => {
    expect(
      parseStructuredResult("<result>{not json}</result>", tool),
    ).toBeUndefined();
  });
  it("returns undefined when a required key is absent (schema mismatch)", () => {
    expect(
      parseStructuredResult('<result>{"steps":[]}</result>', tool),
    ).toBeUndefined();
  });
  it("returns undefined when the JSON value is not an object (partial/wrong type)", () => {
    expect(
      parseStructuredResult("<result>[1,2,3]</result>", tool),
    ).toBeUndefined();
    expect(
      parseStructuredResult("<result>null</result>", tool),
    ).toBeUndefined();
  });
});
