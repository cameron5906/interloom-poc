import type { ToolDef } from "@interloom/protocol";

export interface LlamaToolDef {
  type: "function";
  function: ToolDef;
}

/**
 * Adapt wire-level JSON Schema for llama.cpp's grammar compiler.
 *
 * llama.cpp expands finite string bounds such as `maxLength: 2000` into a
 * repeated GBNF rule and can reject the whole request as too complex before
 * generation starts. The instance still validates every emitted tool call
 * against the untouched registered-tool schema, so removing this generation
 * hint does not broaden executable behavior.
 */
export function adaptToolSchemaForInference(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(adaptToolSchemaForInference);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const adapted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "maxLength") continue;
    adapted[key] = adaptToolSchemaForInference(child);
  }
  return adapted;
}

export function toLlamaTools(tools: ToolDef[]): LlamaToolDef[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      ...tool,
      parameters: adaptToolSchemaForInference(tool.parameters) as Record<string, unknown>,
    },
  }));
}
