import type { FrontierWorkItem } from "@interloom/protocol";
import { describe, expect, it, vi } from "vitest";
import { QueueManager, type PlacementHandle } from "../src/queue/manager.js";

function fixture(workId: string, enqueuedAt: string, agentId = "agent-1"): FrontierWorkItem {
  return {
    workId,
    agentId,
    channelId: "ch-1",
    channelName: "general",
    workspaceName: "Test Workspace",
    trigger: {
      id: `msg-${workId}`,
      channelId: "ch-1",
      authorId: "user-1",
      authorName: "User",
      isAgent: false,
      text: "hello",
      mentions: [],
      createdAt: enqueuedAt,
    },
    recentMessages: [],
    members: [{ name: "User", isAgent: false }],
    persona: { name: "Testbot" },
    enqueuedAt,
  };
}

/** A `PlacementHandle` double whose `pull` is fully test-controlled. */
function fakeHandle(
  placementId: string,
  agentId: string,
  opts: { connected?: boolean; onPull?: () => Promise<FrontierWorkItem[]> } = {},
): PlacementHandle & { triggerWorkAvailable: () => void; triggerConnected: () => void; connected: boolean } {
  const workAvailableCbs: Array<() => void> = [];
  const connectedCbs: Array<() => void> = [];
  let connected = opts.connected ?? true;

  return {
    placementId,
    agentId,
    isConnected: () => connected,
    pull: opts.onPull ?? (async () => []),
    onWorkAvailable: (cb) => workAvailableCbs.push(cb),
    onConnected: (cb) => connectedCbs.push(cb),
    triggerWorkAvailable: () => workAvailableCbs.forEach((cb) => cb()),
    triggerConnected: () => connectedCbs.forEach((cb) => cb()),
    get connected() {
      return connected;
    },
    set connected(value: boolean) {
      connected = value;
    },
  };
}

describe("QueueManager (pinned-interfaces §C merged FCFS queue)", () => {
  it("merges interleaved enqueues across two placements in strict FCFS order by enqueuedAt", async () => {
    const manager = new QueueManager({ pollMs: 10_000, maxBatch: 5 });

    const handleA = fakeHandle("pl-a", "agent-1", {
      onPull: async () => [fixture("a-2", "2026-01-01T00:00:05.000Z")],
    });
    const handleB = fakeHandle("pl-b", "agent-1", {
      onPull: async () => [fixture("b-1", "2026-01-01T00:00:01.000Z"), fixture("b-3", "2026-01-01T00:00:09.000Z")],
    });

    manager.addPlacement(handleA);
    manager.addPlacement(handleB);
    // addPlacement pulls synchronously-scheduled (async) — let both resolve.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const first = await manager.next(100);
    const second = await manager.next(100);
    const third = await manager.next(100);

    expect(first?.item.workId).toBe("b-1");
    expect(second?.item.workId).toBe("a-2");
    expect(third?.item.workId).toBe("b-3");
  });

  it("long-poll resolves early on a work.available nudge instead of waiting the full timeout", async () => {
    const manager = new QueueManager({ pollMs: 10_000 });
    let hasItem = false;
    const handle = fakeHandle("pl-a", "agent-1", {
      onPull: async () => (hasItem ? [fixture("late-item", "2026-01-01T00:00:01.000Z")] : []),
    });
    manager.addPlacement(handle);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const started = Date.now();
    const pending = manager.next(5_000);

    setTimeout(() => {
      hasItem = true;
      handle.triggerWorkAvailable();
    }, 30);

    const result = await pending;
    const elapsed = Date.now() - started;

    expect(result?.item.workId).toBe("late-item");
    expect(elapsed).toBeLessThan(1_000);
  });

  it("long-poll resolves early when a new tunnel connects", async () => {
    const manager = new QueueManager({ pollMs: 10_000 });
    const handle = fakeHandle("pl-a", "agent-1", {
      connected: false,
      onPull: async () => [fixture("on-connect-item", "2026-01-01T00:00:01.000Z")],
    });
    manager.addPlacement(handle);

    const pending = manager.next(5_000);
    setTimeout(() => {
      handle.connected = true;
      handle.triggerConnected();
    }, 30);

    const result = await pending;
    expect(result?.item.workId).toBe("on-connect-item");
  });

  it("resolves null after the wait elapses with nothing queued", async () => {
    const manager = new QueueManager({ pollMs: 10_000 });
    const result = await manager.next(50);
    expect(result).toBeNull();
  });

  it("is lease-aware: an item is only ever handed out once, never re-pulled while buffered", async () => {
    const pull = vi.fn(async () => [fixture("once-only", "2026-01-01T00:00:01.000Z")]);
    const manager = new QueueManager({ pollMs: 10_000 });
    const handle = fakeHandle("pl-a", "agent-1", { onPull: pull });
    manager.addPlacement(handle);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const first = await manager.next(100);
    expect(first?.item.workId).toBe("once-only");

    // Nothing left buffered — a second next() must time out, not re-return
    // the same item or trigger another pull on its own.
    const second = await manager.next(50);
    expect(second).toBeNull();
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("depthForAgent reflects buffered-but-undelivered items", async () => {
    const manager = new QueueManager({ pollMs: 10_000 });
    const handle = fakeHandle("pl-a", "agent-1", {
      onPull: async () => [fixture("d1", "2026-01-01T00:00:01.000Z"), fixture("d2", "2026-01-01T00:00:02.000Z")],
    });
    manager.addPlacement(handle);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(manager.depthForAgent("agent-1")).toBe(2);
    await manager.next(100);
    expect(manager.depthForAgent("agent-1")).toBe(1);
  });

  it("removePlacement drops its buffered items and stops it from being polled further", async () => {
    const manager = new QueueManager({ pollMs: 10_000 });
    const handle = fakeHandle("pl-a", "agent-1", {
      onPull: async () => [fixture("gone", "2026-01-01T00:00:01.000Z")],
    });
    manager.addPlacement(handle);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.depthForAgent("agent-1")).toBe(1);

    manager.removePlacement("pl-a");
    expect(manager.depthForAgent("agent-1")).toBe(0);
    const result = await manager.next(50);
    expect(result).toBeNull();
  });

  it("stop() resolves every pending waiter with null", async () => {
    const manager = new QueueManager({ pollMs: 10_000 });
    const pending = manager.next(5_000);
    manager.stop();
    await expect(pending).resolves.toBeNull();
  });
});
