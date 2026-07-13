import { describe, it, expect } from "vitest";
import { normalizeMessages } from "../inference/normalize.js";

describe("normalizeMessages", () => {
  it("merges consecutive user turns from different speakers", () => {
    const out = normalizeMessages([
      { role: "system", content: "persona" },
      { role: "user", content: "Cameron: hi" },
      { role: "user", content: "Josh: yo" },
    ]);
    expect(out).toEqual([
      { role: "system", content: "persona" },
      { role: "user", content: "Cameron: hi\n\nJosh: yo" },
    ]);
  });

  it("keeps strict user/assistant alternation intact", () => {
    const out = normalizeMessages([
      { role: "system", content: "s" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("merges multiple system turns into one leading system message", () => {
    const out = normalizeMessages([
      { role: "system", content: "persona" },
      { role: "system", content: "summary" },
      { role: "user", content: "hi" },
    ]);
    expect(out[0]).toEqual({ role: "system", content: "persona\n\nsummary" });
    expect(out).toHaveLength(2);
  });

  it("bridges a history that starts with an assistant turn", () => {
    const out = normalizeMessages([
      { role: "system", content: "s" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "now" },
    ]);
    expect(out[1]).toEqual({ role: "user", content: "(conversation in progress)" });
    expect(out[2]).toEqual({ role: "assistant", content: "earlier reply" });
  });

  it("merges consecutive assistant turns", () => {
    const out = normalizeMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "part1" },
      { role: "assistant", content: "part2" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "part1\n\npart2" },
    ]);
  });
});

describe("content-parts passthrough (vision preview)", () => {
  it("messages with array content survive normalization with parts intact", () => {
    const parts = [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
    ];
    const out = normalizeMessages([
      { role: "system", content: "p" },
      { role: "user", content: parts },
    ]);
    expect(out).toEqual([
      { role: "system", content: "p" },
      { role: "user", content: parts },
    ]);
  });

  it("consecutive same-role turns merge parts arrays", () => {
    const out = normalizeMessages([
      { role: "user", content: "a" },
      { role: "user", content: [{ type: "text", text: "b" }] },
    ]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
  });
});

describe("tool-role passthrough (native tool calling)", () => {
  it("tool turns and assistant toolCalls pass through untouched, no merging across them", () => {
    const msgs = [
      { role: "system", content: "p" },
      { role: "user", content: "check history" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "platform.read_history", arguments: "{}" }],
      },
      { role: "tool", content: '{"messages":[]}', toolCallId: "c1" },
      { role: "user", content: "Tool results above." },
    ];
    const out = normalizeMessages(msgs);
    expect(out).toEqual(msgs);
  });

  it("plain adjacent same-role turns still merge when no tool shapes involved", () => {
    const out = normalizeMessages([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
    expect(out).toEqual([{ role: "user", content: "a\n\nb" }]);
  });
});
