/**
 * Tests for the backstop `<think>` stripper (CONTRACTS §6.1).
 */

import { describe, it, expect } from "vitest";
import { ThinkStripper, stripThinkTags } from "../inference/thinkStripper.js";

function runStream(chunks: string[]): string {
  const s = new ThinkStripper();
  let out = "";
  for (const c of chunks) out += s.push(c);
  out += s.flush();
  return out;
}

describe("ThinkStripper", () => {
  it("zero-copy passthrough: no tags at all — output equals input, chunk by chunk", () => {
    const s = new ThinkStripper();
    expect(s.push("Hello, ")).toBe("Hello, ");
    expect(s.push("world! No tags here.")).toBe("world! No tags here.");
    expect(s.flush()).toBe("");
  });

  it("strips a tag entirely mid-content", () => {
    const out = runStream(["Hello <think>reasoning</think> World"]);
    expect(out).toBe("Hello World");
  });

  it("strips <thinking> variant case-insensitively", () => {
    const out = runStream(["Answer: <THINKING>secret plan</THINKING>done"]);
    expect(out).toBe("Answer: done");
  });

  it("handles a tag split across chunk boundaries (open tag split)", () => {
    const out = runStream(["hello <thi", "nk>secret</think> world"]);
    expect(out).toBe("hello world");
  });

  it("handles a close tag split across chunk boundaries", () => {
    const out = runStream(["<think>secret</thi", "nk> after"]);
    expect(out).toBe("after");
  });

  it("handles the open-angle-bracket split as a single character chunk", () => {
    const out = runStream(["before <", "think>x</think> after"]);
    expect(out).toBe("before after");
  });

  it("unclosed tag at end of stream discards everything from the open tag onward", () => {
    const out = runStream(["Hello <think>reasoning that never closes"]);
    expect(out).toBe("Hello ");
  });

  it("unclosed tag with nothing before it yields empty output", () => {
    const out = runStream(["<think>only reasoning, no close"]);
    expect(out).toBe("");
  });

  it("empty result when the whole message is a think block", () => {
    const out = runStream(["<think>only reasoning</think>"]);
    expect(out).toBe("");
  });

  it("handles multiple think blocks in one message", () => {
    const out = runStream(["A<think>one</think>B<think>two</think>C"]);
    expect(out).toBe("ABC");
  });

  it("plain text containing an unrelated '<' character is preserved (not mistaken for a tag)", () => {
    const out = runStream(["5 < 10 and 10 < 20"]);
    expect(out).toBe("5 < 10 and 10 < 20");
  });

  it("plain text with '<' near a chunk boundary is preserved across pushes", () => {
    const out = runStream(["value is 5 <", " 10, all good"]);
    expect(out).toBe("value is 5 < 10, all good");
  });

  it("stripThinkTags (complete-path helper) strips and trims in one call", () => {
    expect(stripThinkTags("<think>reasoning</think>  \n\nThe answer is 42.")).toBe("The answer is 42.");
  });

  it("stripThinkTags returns empty string for a think-only response", () => {
    expect(stripThinkTags("<think>nothing but reasoning</think>")).toBe("");
  });

  it("stripThinkTags is a passthrough (trimmed) when there are no tags", () => {
    expect(stripThinkTags("  plain answer, no tags  ")).toBe("plain answer, no tags");
  });
});
