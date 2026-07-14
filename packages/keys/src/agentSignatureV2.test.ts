import { describe, expect, it } from "vitest";
import { AGENT_SIGNATURE_VERSION, agentSignatureV1, agentSignatureV2 } from "./agentSignature.js";
import { canonicalJson } from "./canonicalJson.js";

describe("AGENT_SIGNATURE_VERSION", () => {
  it("is 2", () => {
    expect(AGENT_SIGNATURE_VERSION).toBe(2);
  });
});

describe("agentSignatureV2 golden vectors", () => {
  it("matches a known hash for a full manifest", () => {
    const input = {
      persona: "a helpful assistant",
      model: { filename: "model.gguf", repoId: "org/repo", quant: "Q4_K_M" },
      title: "The Helper",
      capabilityBlurb: "helps with things",
      avatarImageUrl: "https://example.com/a.png",
    };
    expect(agentSignatureV2(input)).toBe("4qsXn4LcMduXmctLgeLtl0fsaB2ykjKvoNGQdrceo-M");
  });

  it("matches a known hash for a minimal manifest (no title/blurb/avatar)", () => {
    const input = { persona: "p", model: { filename: "f.gguf" } };
    expect(agentSignatureV2(input)).toBe("HV297yeM5GyaL362saU-NLHJaTz0ol-lStPKNi8uu9s");
  });

  it("is deterministic for the same input", () => {
    const input = {
      persona: "a helpful assistant",
      model: { filename: "model.gguf", repoId: "org/repo", quant: "Q4_K_M" },
      title: "The Helper",
      capabilityBlurb: "helps with things",
      avatarImageUrl: "https://example.com/a.png",
    };
    expect(agentSignatureV2(input)).toBe(agentSignatureV2({ ...input }));
  });

  it("is invariant to model field key ordering", () => {
    const a = agentSignatureV2({
      persona: "p",
      model: { filename: "f.gguf", repoId: "org/repo", quant: "Q4" },
    });
    const b = agentSignatureV2({
      persona: "p",
      model: { quant: "Q4", filename: "f.gguf", repoId: "org/repo" },
    });
    expect(a).toBe(b);
  });

  it("changes when title changes", () => {
    const base = { persona: "p", model: { filename: "f.gguf" }, title: "A" };
    const changed = { persona: "p", model: { filename: "f.gguf" }, title: "B" };
    expect(agentSignatureV2(base)).not.toBe(agentSignatureV2(changed));
  });

  it("changes when capabilityBlurb changes", () => {
    const base = { persona: "p", model: { filename: "f.gguf" }, capabilityBlurb: "A" };
    const changed = { persona: "p", model: { filename: "f.gguf" }, capabilityBlurb: "B" };
    expect(agentSignatureV2(base)).not.toBe(agentSignatureV2(changed));
  });

  it("changes when avatarImageUrl changes", () => {
    const base = { persona: "p", model: { filename: "f.gguf" }, avatarImageUrl: "https://a" };
    const changed = { persona: "p", model: { filename: "f.gguf" }, avatarImageUrl: "https://b" };
    expect(agentSignatureV2(base)).not.toBe(agentSignatureV2(changed));
  });

  it("changes when persona or model identity changes (still covered, as in v1)", () => {
    const base = { persona: "p1", model: { filename: "a.gguf" } };
    expect(agentSignatureV2(base)).not.toBe(
      agentSignatureV2({ ...base, persona: "p2" }),
    );
    expect(agentSignatureV2(base)).not.toBe(
      agentSignatureV2({ ...base, model: { filename: "b.gguf" } }),
    );
  });

  it("ignores fields other than persona/model/title/capabilityBlurb/avatarImageUrl", () => {
    interface WithExtras {
      persona: string;
      model: { filename: string; repoId?: string | null; quant?: string | null };
      title?: string | null;
      capabilityBlurb?: string | null;
      avatarImageUrl?: string | null;
      name?: string;
      gender?: string;
      specialties?: string[];
      params?: unknown;
    }
    const base: WithExtras = {
      persona: "p",
      model: { filename: "a.gguf", repoId: "org/one", quant: "Q4" },
      title: "T",
      capabilityBlurb: "B",
      avatarImageUrl: "https://a",
    };
    const withExtras: WithExtras = {
      ...base,
      name: "Different Name",
      gender: "other",
      specialties: ["x", "y"],
      params: { temperature: 0.9 },
    };
    expect(agentSignatureV2(base)).toBe(agentSignatureV2(withExtras));
  });

  describe("absent-vs-null normalization", () => {
    it("treats absent title/capabilityBlurb/avatarImageUrl the same as explicit null", () => {
      const absent = agentSignatureV2({ persona: "p", model: { filename: "f.gguf" } });
      const explicitNull = agentSignatureV2({
        persona: "p",
        model: { filename: "f.gguf" },
        title: null,
        capabilityBlurb: null,
        avatarImageUrl: null,
      });
      expect(absent).toBe(explicitNull);
    });

    it("treats absent model.repoId/quant the same as explicit null", () => {
      const absent = agentSignatureV2({ persona: "p", model: { filename: "f.gguf" } });
      const explicitNull = agentSignatureV2({
        persona: "p",
        model: { filename: "f.gguf", repoId: null, quant: null },
      });
      expect(absent).toBe(explicitNull);
    });
  });

  it("v1 and v2 never collide for identical persona/model input", () => {
    const input = { persona: "p", model: { filename: "f.gguf", repoId: "r", quant: "Q4" } };
    expect(agentSignatureV1(input)).not.toBe(agentSignatureV2(input));
  });

  it("JSON-boundary round-trip: the preimage survives JSON.parse(JSON.stringify(...)) with identical canonicalJson output", () => {
    // Regression guard (JSON-boundary memory): canonicalJson once leaked undefined-valued
    // keys into the signing preimage. The `?? null` normalization must survive crossing
    // a real JSON boundary, not just stay correct in-memory.
    const preimage = {
      v: 2,
      persona: "p",
      title: undefined as string | null | undefined,
      capabilityBlurb: null as string | null,
      avatarImageUrl: null as string | null,
      model: { filename: "f.gguf", repoId: null as string | null, quant: null as string | null },
    };
    const normalized = {
      ...preimage,
      title: preimage.title ?? null,
    };
    const before = canonicalJson(normalized);
    const roundTripped = JSON.parse(JSON.stringify(normalized));
    const after = canonicalJson(roundTripped);
    expect(after).toBe(before);
    expect(before).not.toContain("undefined");
  });
});
