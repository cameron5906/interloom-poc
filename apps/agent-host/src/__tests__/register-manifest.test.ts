import { describe, expect, it } from "vitest";
import { buildAgentManifest } from "../agents/register.js";
import type { Agent } from "../agents/store.js";

const base: Agent = {
  agentId: "a-1",
  name: "Bobby",
  avatar: { emoji: "🤖", bg: "#eee" },
  persona: "helpful",
  capabilityBlurb: "helps",
  params: { temperature: 0.7, contextLength: 8192 },
  registered: true,
  model: { filename: "Qwen3-8B-Q4_K_M.gguf", displayName: "Qwen3 8B" },
};

describe("buildAgentManifest (CONTRACTS §4 capability stamping)", () => {
  it("stamps capabilities resolved by the lookup", () => {
    const manifest = buildAgentManifest(base, "PUBKEY", () => ({
      tools: true,
      vision: false,
      thinking: true,
    }));
    expect(manifest.model.capabilities).toEqual({ tools: true, vision: false, thinking: true });
    expect(manifest.pubKey).toBe("PUBKEY");
  });

  it("fresh lookup wins over stale stored capabilities", () => {
    const stored: Agent = {
      ...base,
      model: { ...base.model!, capabilities: { tools: false, vision: false, thinking: false } },
    };
    const manifest = buildAgentManifest(stored, "PUBKEY", () => ({
      tools: true,
      vision: true,
      thinking: false,
    }));
    expect(manifest.model.capabilities).toEqual({ tools: true, vision: true, thinking: false });
  });

  it("falls back to stored capabilities when the lookup is undefined", () => {
    const stored: Agent = {
      ...base,
      model: { ...base.model!, capabilities: { tools: true, vision: false, thinking: true } },
    };
    const manifest = buildAgentManifest(stored, "PUBKEY", () => undefined);
    expect(manifest.model.capabilities).toEqual({ tools: true, vision: false, thinking: true });
  });

  it("leaves capabilities absent when the model is not locally parseable", () => {
    const manifest = buildAgentManifest(base, "PUBKEY", () => undefined);
    expect(manifest.model.capabilities).toBeUndefined();
  });

  it("throws without a model (register requires one)", () => {
    expect(() => buildAgentManifest({ ...base, model: undefined }, "PUBKEY", () => undefined)).toThrow();
  });
});
