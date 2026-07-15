import { describe, expect, it } from "vitest";
import { orderWork } from "../src/queue/strategy.js";

describe("orderWork (pinned-interfaces §C — v1 FCFS by enqueuedAt)", () => {
  it("sorts ascending by enqueuedAt", () => {
    const items = [
      { workId: "c", enqueuedAt: "2026-01-01T00:00:03.000Z" },
      { workId: "a", enqueuedAt: "2026-01-01T00:00:01.000Z" },
      { workId: "b", enqueuedAt: "2026-01-01T00:00:02.000Z" },
    ];
    expect(orderWork(items).map((i) => i.workId)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const items = [
      { workId: "b", enqueuedAt: "2026-01-01T00:00:02.000Z" },
      { workId: "a", enqueuedAt: "2026-01-01T00:00:01.000Z" },
    ];
    const original = [...items];
    orderWork(items);
    expect(items).toEqual(original);
  });

  it("is stable for equal timestamps", () => {
    const items = [
      { workId: "first", enqueuedAt: "2026-01-01T00:00:00.000Z" },
      { workId: "second", enqueuedAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(orderWork(items).map((i) => i.workId)).toEqual(["first", "second"]);
  });

  it("merges items across placements purely by enqueuedAt, ignoring arrival order", () => {
    const placementA = [{ workId: "a-2", enqueuedAt: "2026-01-01T00:00:05.000Z" }];
    const placementB = [{ workId: "b-1", enqueuedAt: "2026-01-01T00:00:01.000Z" }];
    const merged = orderWork([...placementA, ...placementB]);
    expect(merged.map((i) => i.workId)).toEqual(["b-1", "a-2"]);
  });
});
