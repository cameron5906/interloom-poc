import { describe, expect, it } from "vitest";
import { aggregateToolCallDelta, finishToolCalls, newToolCallAccumulator } from "../inference/toolCalls.js";

describe("streamed tool-call delta aggregation (CONTRACTS §3)", () => {
  it("assembles id/name/argument fragments by index", () => {
    const acc = newToolCallAccumulator();
    aggregateToolCallDelta(acc, [
      { index: 0, id: "c1", function: { name: "platform.read_history", arguments: "" } },
    ]);
    aggregateToolCallDelta(acc, [{ index: 0, function: { arguments: '{"before"' } }]);
    aggregateToolCallDelta(acc, [{ index: 0, function: { arguments: ':"2h"}' } }]);
    expect(finishToolCalls(acc)).toEqual([
      { id: "c1", name: "platform.read_history", arguments: '{"before":"2h"}' },
    ]);
  });

  it("handles parallel calls on distinct indexes", () => {
    const acc = newToolCallAccumulator();
    aggregateToolCallDelta(acc, [
      { index: 0, id: "a", function: { name: "x", arguments: "{}" } },
      { index: 1, id: "b", function: { name: "y", arguments: "{}" } },
    ]);
    expect(finishToolCalls(acc)!.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("missing id falls back to a generated one; empty accumulator → undefined", () => {
    const acc = newToolCallAccumulator();
    aggregateToolCallDelta(acc, [{ index: 0, function: { name: "x", arguments: "{}" } }]);
    const calls = finishToolCalls(acc)!;
    expect(calls[0]!.id).toMatch(/^call_/);
    expect(finishToolCalls(newToolCallAccumulator())).toBeUndefined();
  });
});
