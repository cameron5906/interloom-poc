import { describe, expect, it } from "vitest";
import { resolvePreviewOptions } from "../agents/preview.js";

const agent = {
  persona: "You are the stored persona.",
  params: { temperature: 0.7, contextLength: 4096 },
};

describe("resolvePreviewOptions", () => {
  it("uses personaOverride when present", () => {
    const { persona } = resolvePreviewOptions({ personaOverride: "Draft persona." }, agent);
    expect(persona).toBe("Draft persona.");
  });

  it("trims the override before use", () => {
    const { persona } = resolvePreviewOptions({ personaOverride: "  Draft.  " }, agent);
    expect(persona).toBe("Draft.");
  });

  it("falls back to the stored persona when the override is absent", () => {
    const { persona } = resolvePreviewOptions({ messages: [] }, agent);
    expect(persona).toBe(agent.persona);
  });

  it("falls back to the stored persona when the override is blank", () => {
    expect(resolvePreviewOptions({ personaOverride: "" }, agent).persona).toBe(agent.persona);
    expect(resolvePreviewOptions({ personaOverride: "   \n" }, agent).persona).toBe(agent.persona);
  });

  it("ignores a non-string override instead of throwing", () => {
    expect(resolvePreviewOptions({ personaOverride: 42 }, agent).persona).toBe(agent.persona);
    expect(resolvePreviewOptions({ personaOverride: { nested: true } }, agent).persona).toBe(
      agent.persona,
    );
  });

  it("uses the request temperature when it is a finite number", () => {
    expect(resolvePreviewOptions({ temperature: 1.2 }, agent).temperature).toBe(1.2);
    expect(resolvePreviewOptions({ temperature: 0 }, agent).temperature).toBe(0);
  });

  it("falls back to the stored temperature when absent or malformed", () => {
    expect(resolvePreviewOptions({}, agent).temperature).toBe(0.7);
    expect(resolvePreviewOptions({ temperature: "hot" }, agent).temperature).toBe(0.7);
    expect(resolvePreviewOptions({ temperature: Number.NaN }, agent).temperature).toBe(0.7);
    expect(resolvePreviewOptions({ temperature: Number.POSITIVE_INFINITY }, agent).temperature).toBe(
      0.7,
    );
  });
});
