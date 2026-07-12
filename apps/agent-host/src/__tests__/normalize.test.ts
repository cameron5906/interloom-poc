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
