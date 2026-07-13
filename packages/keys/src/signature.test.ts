import { describe, expect, it } from "vitest";
import { agentSignature } from "./index.js";

describe("agentSignature", () => {
  it("is deterministic for the same input", () => {
    const input = {
      persona: "a helpful assistant",
      model: { filename: "model.gguf", repoId: "org/repo", quant: "Q4_K_M" },
    };
    expect(agentSignature(input)).toBe(agentSignature(input));
    expect(agentSignature({ ...input })).toBe(agentSignature({ ...input }));
  });

  it("is invariant to model field key ordering", () => {
    const a = agentSignature({
      persona: "p",
      model: { filename: "f.gguf", repoId: "org/repo", quant: "Q4" },
    });
    const b = agentSignature({
      persona: "p",
      model: { quant: "Q4", filename: "f.gguf", repoId: "org/repo" },
    });
    expect(a).toBe(b);
  });

  it("treats an absent model the same as an explicit null model", () => {
    const withoutModel = agentSignature({ persona: "p" });
    const withNullModel = agentSignature({ persona: "p", model: null });
    expect(withoutModel).toBe(withNullModel);
  });

  it("treats absent optional model fields the same as explicit null", () => {
    const withoutFields = agentSignature({
      persona: "p",
      model: { filename: "f.gguf" },
    });
    const withNullFields = agentSignature({
      persona: "p",
      model: { filename: "f.gguf", repoId: null, quant: null },
    });
    expect(withoutFields).toBe(withNullFields);
  });

  it("changes when persona changes", () => {
    const a = agentSignature({ persona: "p1" });
    const b = agentSignature({ persona: "p2" });
    expect(a).not.toBe(b);
  });

  it("changes when model.filename changes", () => {
    const base = { persona: "p", model: { filename: "a.gguf" } };
    const changed = { persona: "p", model: { filename: "b.gguf" } };
    expect(agentSignature(base)).not.toBe(agentSignature(changed));
  });

  it("changes when model.repoId changes", () => {
    const base = { persona: "p", model: { filename: "a.gguf", repoId: "org/one" } };
    const changed = { persona: "p", model: { filename: "a.gguf", repoId: "org/two" } };
    expect(agentSignature(base)).not.toBe(agentSignature(changed));
  });

  it("changes when model.quant changes", () => {
    const base = { persona: "p", model: { filename: "a.gguf", quant: "Q4" } };
    const changed = { persona: "p", model: { filename: "a.gguf", quant: "Q8" } };
    expect(agentSignature(base)).not.toBe(agentSignature(changed));
  });

  it("changes when going from no model to a model", () => {
    const a = agentSignature({ persona: "p" });
    const b = agentSignature({ persona: "p", model: { filename: "a.gguf" } });
    expect(a).not.toBe(b);
  });

  it("ignores fields other than persona and the three model identity fields", () => {
    interface WithExtras {
      persona: string;
      model?: { filename: string; repoId?: string | null; quant?: string | null } | null;
      name?: string;
      avatar?: unknown;
      title?: string;
      params?: unknown;
    }
    const base: WithExtras = {
      persona: "p",
      model: { filename: "a.gguf", repoId: "org/one", quant: "Q4" },
    };
    const withExtras: WithExtras = {
      ...base,
      name: "Different Name",
      avatar: { emoji: "🤖", bg: "blue" },
      title: "The Helper",
      params: { temperature: 0.9 },
    };
    expect(agentSignature(base)).toBe(agentSignature(withExtras));
  });
});
