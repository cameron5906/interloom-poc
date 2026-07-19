import { describe, expect, it } from "vitest";
import { adaptToolSchemaForInference, toLlamaTools } from "../inference/toolSchema.js";

describe("inference tool-schema adaptation", () => {
  it("removes maxLength recursively without mutating the wire schema", () => {
    const parameters = {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
        },
        notes: {
          type: "array",
          items: {
            anyOf: [{ type: "string", maxLength: 1200 }, { type: "null" }],
          },
        },
      },
      required: ["instruction"],
      additionalProperties: false,
    };

    expect(adaptToolSchemaForInference(parameters)).toEqual({
      type: "object",
      properties: {
        instruction: {
          type: "string",
          minLength: 1,
        },
        notes: {
          type: "array",
          items: {
            anyOf: [{ type: "string" }, { type: "null" }],
          },
        },
      },
      required: ["instruction"],
      additionalProperties: false,
    });
    expect(parameters.properties.instruction.maxLength).toBe(2000);
    expect(parameters.properties.notes.items.anyOf[0]!.maxLength).toBe(1200);
  });

  it("adapts the function wrapper sent to llama.cpp and preserves other constraints", () => {
    const tools = [
      {
        name: "work.continue",
        description: "Continue delegated work.",
        parameters: {
          type: "object",
          properties: {
            instruction: {
              type: "string",
              minLength: 1,
              maxLength: 2000,
            },
            attempts: {
              type: "integer",
              minimum: 1,
              maximum: 3,
            },
          },
          required: ["instruction"],
          additionalProperties: false,
        },
      },
    ];

    expect(toLlamaTools(tools)).toEqual([
      {
        type: "function",
        function: {
          name: "work.continue",
          description: "Continue delegated work.",
          parameters: {
            type: "object",
            properties: {
              instruction: { type: "string", minLength: 1 },
              attempts: { type: "integer", minimum: 1, maximum: 3 },
            },
            required: ["instruction"],
            additionalProperties: false,
          },
        },
      },
    ]);
  });
});
