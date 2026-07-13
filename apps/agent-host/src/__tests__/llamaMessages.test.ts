import { describe, it, expect } from "vitest";
import { toLlamaMessages } from "../inference/llamaMessages.js";
import type { InferenceMessage } from "../inference/normalize.js";

describe("toLlamaMessages", () => {
  it("translates an assistant turn's toolCalls to OpenAI tool_calls", () => {
    const msgs: InferenceMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "platform.read_history", arguments: "{}" }] },
    ];
    const out = toLlamaMessages(msgs);
    expect(out).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "platform.read_history", arguments: "{}" } }],
      },
    ]);
    expect("toolCalls" in out[0]!).toBe(false);
  });

  it("translates a tool turn's toolCallId to OpenAI tool_call_id", () => {
    const out = toLlamaMessages([{ role: "tool", content: "{}", toolCallId: "c1" }]);
    expect(out).toEqual([{ role: "tool", content: "{}", tool_call_id: "c1" }]);
    expect("toolCallId" in out[0]!).toBe(false);
  });

  it("passes plain user/assistant/system turns through unchanged", () => {
    const out = toLlamaMessages([
      { role: "system", content: "persona" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(out).toEqual([
      { role: "system", content: "persona" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("translates a full round-2 sequence", () => {
    const out = toLlamaMessages([
      { role: "system", content: "p" },
      { role: "user", content: "check history" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "platform.read_history", arguments: "{}" }] },
      { role: "tool", content: '{"messages":[]}', toolCallId: "c1" },
      { role: "user", content: "Tool results above." },
    ]);
    expect(out).toEqual([
      { role: "system", content: "p" },
      { role: "user", content: "check history" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "platform.read_history", arguments: "{}" } }],
      },
      { role: "tool", content: '{"messages":[]}', tool_call_id: "c1" },
      { role: "user", content: "Tool results above." },
    ]);
  });
});
