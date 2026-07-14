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

  it("stamps params.contextLength = 0 (inherit loaded window) regardless of stored value", () => {
    const manifest = buildAgentManifest(base, "PUBKEY", () => undefined);
    expect(manifest.params.contextLength).toBe(0);
    expect(manifest.params.temperature).toBe(0.7);
  });
});

describe("buildAgentManifest (CONTRACTS §6/§12 profile stamping)", () => {
  it("mirrors title into capabilityBlurb when title is set", () => {
    const stored: Agent = { ...base, title: "Archivist", capabilityBlurb: "stale blurb" };
    const manifest = buildAgentManifest(stored, "PUBKEY", () => undefined, "Cameron's Host");
    expect(manifest.title).toBe("Archivist");
    expect(manifest.capabilityBlurb).toBe("Archivist");
  });

  it("leaves capabilityBlurb untouched when no title is set", () => {
    const manifest = buildAgentManifest(base, "PUBKEY", () => undefined, "Cameron's Host");
    expect(manifest.title).toBeUndefined();
    expect(manifest.capabilityBlurb).toBe("helps");
  });

  it("stamps gender and specialties when present", () => {
    const stored: Agent = {
      ...base,
      gender: "female",
      specialties: ["Code review", "Research"],
    };
    const manifest = buildAgentManifest(stored, "PUBKEY", () => undefined, "Cameron's Host");
    expect(manifest.gender).toBe("female");
    expect(manifest.specialties).toEqual(["Code review", "Research"]);
  });

  it("omits gender and specialties when absent", () => {
    const manifest = buildAgentManifest(base, "PUBKEY", () => undefined, "Cameron's Host");
    expect(manifest.gender).toBeUndefined();
    expect(manifest.specialties).toBeUndefined();
  });

  it("stamps operator with the host pubKey and display name when unbound (legacy)", () => {
    const manifest = buildAgentManifest(base, "PUBKEY", () => undefined, "Cameron's Host", null);
    expect(manifest.operator).toEqual({ pubKey: "PUBKEY", displayName: "Cameron's Host" });
  });

  it("stamps operator with the bound network identity + grant when bound", () => {
    const grant = {
      payload: {
        v: 1 as const,
        identityKey: "IDENTITY_PUBKEY",
        subjectKey: "PUBKEY",
        scope: "host-operator" as const,
        issuedAt: Date.now(),
        epoch: 0,
        nonce: "nonce-abc",
      },
      key: "IDENTITY_PUBKEY",
      sig: "sig",
    };
    const manifest = buildAgentManifest(base, "PUBKEY", () => undefined, "Cameron's Host", {
      identityKey: "IDENTITY_PUBKEY",
      displayName: "Cameron",
      grant,
      boundAt: new Date().toISOString(),
    });
    expect(manifest.operator).toEqual({
      pubKey: "IDENTITY_PUBKEY",
      displayName: "Cameron",
      grant,
    });
    // The bound operator identity legitimately differs from the signing host key.
    expect(manifest.operator?.pubKey).not.toBe(manifest.pubKey);
  });

  it("strips the DiceBear character recipe from the manifest avatar", () => {
    const stored: Agent = {
      ...base,
      avatar: {
        emoji: "🤖",
        bg: "#eee",
        imageUrl: "https://net.example/assets/av/abc.png",
        character: {
          style: "notionists",
          seed: "Bobby",
          gender: "male",
          backgroundColor: "b6e3f4",
          options: {
            brows: "variant01",
            eyes: "variant01",
            lips: "variant01",
            nose: "variant01",
            body: "variant01",
          },
        },
      },
    };
    const manifest = buildAgentManifest(stored, "PUBKEY", () => undefined, "Cameron's Host");
    expect(manifest.avatar).toEqual({
      emoji: "🤖",
      bg: "#eee",
      imageUrl: "https://net.example/assets/av/abc.png",
    });
    expect("character" in manifest.avatar).toBe(false);
  });
});
