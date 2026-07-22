import { describe, expect, it } from "vitest";
import {
  reasoningActiveForRuntime,
  selectAgentAdapter,
  tunnelFeaturesForRuntime,
} from "../models/runtimeProfile.js";

describe("selectAgentAdapter", () => {
  it("uses verified native tools when the loaded template and catalog agree", () => {
    expect(
      selectAgentAdapter({
        detectedTools: true,
        catalogToolLevel: "native",
        runtimeToolSupport: true,
        jsonSchema: true,
      }),
    ).toEqual({ adapter: "native_tools", tools: true });
  });

  it("adapts weaker catalog models through runtime-enforced schema actions", () => {
    expect(
      selectAgentAdapter({
        detectedTools: false,
        catalogToolLevel: "prompted",
        runtimeToolSupport: false,
        jsonSchema: true,
      }),
    ).toEqual({ adapter: "schema_actions", tools: true });
  });

  it("supports an unlisted open model when its loaded template advertises tools", () => {
    expect(
      selectAgentAdapter({
        runtimeToolSupport: true,
        jsonSchema: false,
      }),
    ).toEqual({ adapter: "native_tools", tools: true });
  });

  it("does not advertise actions when neither runtime path is verified", () => {
    expect(
      selectAgentAdapter({
        catalogToolLevel: "none",
        runtimeToolSupport: false,
        jsonSchema: false,
      }),
    ).toEqual({ adapter: "native_tools", tools: false });
  });
});

describe("tunnelFeaturesForRuntime", () => {
  it("does not claim an unavailable runtime method", () => {
    expect(
      tunnelFeaturesForRuntime({
        features: {
          tools: false,
          structuredOutput: false,
          exactInputTokens: false,
          jsonSchema: false,
          vision: false,
          audio: false,
        },
      }),
    ).toEqual(["finish_reason_v1", "model_runtime_profile_v1"]);
  });

  it("advertises every capability that the loaded runtime verified", () => {
    expect(
      tunnelFeaturesForRuntime({
        features: {
          tools: true,
          structuredOutput: true,
          exactInputTokens: true,
          jsonSchema: true,
          vision: false,
          audio: false,
        },
      }),
    ).toEqual([
      "tools",
      "finish_reason_v1",
      "input_tokens_v1",
      "json_schema_v1",
      "model_runtime_profile_v1",
    ]);
  });
});

describe("reasoningActiveForRuntime", () => {
  it("disables reasoning when the loaded context is below the catalog floor", () => {
    expect(
      reasoningActiveForRuntime({
        detectedThinking: true,
        catalogLevel: "native_toggleable",
        disabled: false,
        contextWindow: 65_536,
        minimumContextTokens: 131_072,
      }),
    ).toBe(false);
  });

  it("enables reasoning when the loaded context meets the catalog floor", () => {
    expect(
      reasoningActiveForRuntime({
        detectedThinking: true,
        catalogLevel: "native_toggleable",
        disabled: false,
        contextWindow: 131_072,
        minimumContextTokens: 131_072,
      }),
    ).toBe(true);
  });
});
