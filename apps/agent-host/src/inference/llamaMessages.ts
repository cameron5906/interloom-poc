import type { InferenceMessage } from "./normalize.js";

export interface LlamaToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlamaMessage {
  role: string;
  content: InferenceMessage["content"];
  tool_calls?: LlamaToolCall[];
  tool_call_id?: string;
}

interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Translate normalized instance-wire messages into llama-server's OpenAI chat
 * shape (`/v1/chat/completions --jinja`). The instance emits assistant turns
 * with flat camelCase `toolCalls: [{id, name, arguments}]` and tool results as
 * `{role:"tool", content, toolCallId}`; llama-server expects assistant
 * `tool_calls: [{id, type:"function", function:{name, arguments}}]` and tool
 * results with `tool_call_id`. Plain turns pass through unchanged.
 */
export function toLlamaMessages(messages: InferenceMessage[]): LlamaMessage[] {
  return messages.map((m) => {
    const out: LlamaMessage = { role: m.role, content: m.content };
    if (m.toolCalls) {
      out.tool_calls = (m.toolCalls as NormalizedToolCall[]).map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    if (m.toolCallId !== undefined) {
      out.tool_call_id = m.toolCallId;
    }
    return out;
  });
}
