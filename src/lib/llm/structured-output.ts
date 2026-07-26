// Tool-less structured-output fallback. Some local/self-hosted models exposed
// through an OpenAI-compatible endpoint have no native tool-calling support
// (LLM_SUPPORTS_TOOLS=false). Instead of a `tools` param, we ask the model to
// emit its structured answer as JSON inside a `<result>...</result>` sentinel
// in plain text, then parse it back out here. Never throws — a parse failure
// just means the caller falls back to its own local/no-AI path.

import type { LLMTool, LLMToolCall } from "./types";

/** Instruction appended to the prompt when a model lacks native tools. */
export function buildStructuredInstruction(tool: LLMTool): string {
  return [
    "After your short conversational reply, output the result as a SINGLE JSON object",
    `for "${tool.name}", wrapped in <result>...</result> tags, matching this JSON Schema:`,
    JSON.stringify(tool.inputSchema),
    "Output nothing after the closing </result> tag. Do not use markdown code fences.",
  ].join("\n");
}

const RESULT_BLOCK = /<result>([\s\S]*?)<\/result>/i;

/**
 * Extract + validate the `<result>` block against the tool's required keys.
 * Returns undefined on any failure (missing block, malformed JSON, wrong
 * shape, missing required key) — this is a best-effort fallback, not a
 * validator the caller should trust to throw.
 */
export function parseStructuredResult(
  text: string,
  tool: LLMTool,
): LLMToolCall | undefined {
  const match = text.match(RESULT_BLOCK);
  if (!match) return undefined;

  let input: unknown;
  try {
    input = JSON.parse(match[1].trim());
  } catch {
    return undefined;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const required = (tool.inputSchema as { required?: unknown }).required;
  const requiredKeys = Array.isArray(required) ? (required as string[]) : [];
  for (const key of requiredKeys) {
    if (!(key in (input as Record<string, unknown>))) return undefined;
  }

  return { name: tool.name, input: input as Record<string, unknown> };
}
