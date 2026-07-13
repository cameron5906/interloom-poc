/**
 * Aggregates OpenAI-style streamed tool_call deltas (llama-server) into
 * complete calls for the tunnel's terminal stream result (CONTRACTS §3).
 */

export interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface Partial {
  id?: string;
  name: string;
  arguments: string;
}

export type ToolCallAccumulator = Map<number, Partial>;

export function newToolCallAccumulator(): ToolCallAccumulator {
  return new Map();
}

export function aggregateToolCallDelta(acc: ToolCallAccumulator, deltas: ToolCallDelta[]): void {
  for (const d of deltas) {
    const entry = acc.get(d.index) ?? { name: "", arguments: "" };
    if (d.id) entry.id = d.id;
    if (d.function?.name) entry.name += d.function.name;
    if (d.function?.arguments) entry.arguments += d.function.arguments;
    acc.set(d.index, entry);
  }
}

export function finishToolCalls(
  acc: ToolCallAccumulator,
): Array<{ id: string; name: string; arguments: string }> | undefined {
  if (acc.size === 0) return undefined;
  return [...acc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, p]) => ({ id: p.id ?? `call_${i}`, name: p.name, arguments: p.arguments }));
}
