import { describe, expect, it } from "vitest";
import { resolvePreviewOptions, buildPreviewMessages } from "../agents/preview.js";

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

describe("buildPreviewMessages (CONTRACTS §6 preview images)", () => {
  it("plain text messages stay strings (no parts, hasImages false)", () => {
    const { messages, hasImages } = buildPreviewMessages("persona", [
      { role: "user", content: "hi" },
    ]);
    expect(hasImages).toBe(false);
    expect(messages).toEqual([
      { role: "system", content: "persona" },
      { role: "user", content: "hi" },
    ]);
  });

  it("images become OpenAI content parts on that message", () => {
    const dataUrl = "data:image/jpeg;base64,AAAA";
    const { messages, hasImages } = buildPreviewMessages("p", [
      { role: "user", content: "what is this?", images: [dataUrl] },
    ]);
    expect(hasImages).toBe(true);
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    });
  });

  it("malformed image entries are dropped, not crashed on", () => {
    const { messages, hasImages } = buildPreviewMessages("p", [
      { role: "user", content: "x", images: [123, null] },
    ]);
    expect(hasImages).toBe(false);
    expect(messages[1]).toEqual({ role: "user", content: "x" });
  });
});
