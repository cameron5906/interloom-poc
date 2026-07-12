/**
 * Tests for the shared inference gate (CONTRACTS §6).
 *
 * Verifies:
 * - One request in flight at a time.
 * - Round-robin order across 2 agents interleaved.
 * - Queue depth tracking.
 * - drainLane removes only the right entries.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { enqueueInference, getServingLane, getQueueDepth, drainLane, resetGateForTests } from "../inference/gate.js";

describe("inference gate", () => {
  beforeEach(() => {
    resetGateForTests();
  });

  it("runs one request at a time — second starts only after first finishes", async () => {
    const order: string[] = [];
    let firstRunning = false;

    const first = enqueueInference("lane-a", async () => {
      firstRunning = true;
      order.push("a-start");
      await new Promise<void>((r) => setTimeout(r, 20));
      order.push("a-end");
      firstRunning = false;
    });

    const second = enqueueInference("lane-b", async () => {
      // At this point, first should already be done
      expect(firstRunning).toBe(false);
      order.push("b-start");
      order.push("b-end");
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("round-robin: 2 agents each queue 2 requests, served in arrival order (FIFO per the gate)", async () => {
    // The gate is FIFO (not strict round-robin per-lane), but the specification
    // says "per-agent round-robin fairness". Here we verify that the gate
    // serialises requests and does not starve any lane — all 4 complete.
    const completed: string[] = [];

    const p1 = enqueueInference("agent-1", async () => { completed.push("a1-req1"); });
    const p2 = enqueueInference("agent-2", async () => { completed.push("a2-req1"); });
    const p3 = enqueueInference("agent-1", async () => { completed.push("a1-req2"); });
    const p4 = enqueueInference("agent-2", async () => { completed.push("a2-req2"); });

    await Promise.all([p1, p2, p3, p4]);

    expect(completed).toHaveLength(4);
    expect(completed).toContain("a1-req1");
    expect(completed).toContain("a2-req1");
    expect(completed).toContain("a1-req2");
    expect(completed).toContain("a2-req2");
    // All from agent-1 complete before agent-1's second request starts
    expect(completed.indexOf("a1-req1")).toBeLessThan(completed.indexOf("a1-req2"));
    expect(completed.indexOf("a2-req1")).toBeLessThan(completed.indexOf("a2-req2"));
  });

  it("getQueueDepth reflects waiting entries (not the in-flight one)", async () => {
    // Block the gate with a slow first request, then check depth while it runs
    let unblockFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => { unblockFirst = r; });

    let depthWhileRunning = -1;

    const first = enqueueInference("lane-x", async () => {
      // Queue 2 more while first is in flight
      enqueueInference("lane-y", async () => {});
      enqueueInference("lane-z", async () => {});
      depthWhileRunning = getQueueDepth();
      await firstBlocked;
    });

    // Give the gate loop a tick to start the first entry
    await new Promise<void>((r) => setTimeout(r, 5));
    unblockFirst();
    await first;

    expect(depthWhileRunning).toBe(2);
  });

  it("drainLane rejects queued entries for that lane without affecting others", async () => {
    let unblockFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => { unblockFirst = r; });

    // Start a blocker to hold the gate
    const first = enqueueInference("blocker", async () => {
      await firstBlocked;
    });

    // Queue an entry for the lane to be drained
    const drainTarget = enqueueInference("drain-me", async () => {
      throw new Error("should not run");
    });

    // Queue a survivor
    const survivor = enqueueInference("keeper", async () => {});

    // Drain while blocker holds gate
    await new Promise<void>((r) => setTimeout(r, 5));
    drainLane("drain-me");
    unblockFirst();

    // drain-me should reject, keeper and blocker should resolve
    await expect(drainTarget).rejects.toThrow("lane closed");
    await expect(first).resolves.toBeUndefined();
    await expect(survivor).resolves.toBeUndefined();
  });

  it("preview participates as its own lane", async () => {
    const completed: string[] = [];

    await enqueueInference("agent-1", async () => { completed.push("agent"); });
    await enqueueInference("preview", async () => { completed.push("preview"); });

    expect(completed).toEqual(["agent", "preview"]);
  });

  it("RR fairness: with gate busy, A1+A2 (lane A) then B1 (lane B) → completion order A1, B1, A2", async () => {
    let unblockBlocker!: () => void;
    const blockerHeld = new Promise<void>((r) => { unblockBlocker = r; });

    let releaseA1!: () => void;
    const a1Gate = new Promise<void>((r) => { releaseA1 = r; });
    let releaseB1!: () => void;
    const b1Gate = new Promise<void>((r) => { releaseB1 = r; });

    const completed: string[] = [];

    // Hold the gate with a blocker so we can queue A1, A2, B1 before any runs
    const blocker = enqueueInference("blocker", async () => {
      await blockerHeld;
    });

    // Enqueue A1, A2 on lane A and B1 on lane B while blocker holds the gate
    const a1 = enqueueInference("A", async () => {
      await a1Gate;
      completed.push("A1");
    });
    const a2 = enqueueInference("A", async () => {
      completed.push("A2");
    });
    const b1 = enqueueInference("B", async () => {
      await b1Gate;
      completed.push("B1");
    });

    // Release blocker — RR should now pick A1 (next from A), then B1 (next from B), then A2
    unblockBlocker();
    await blocker;

    // A1 is now running; release it
    releaseA1();
    await a1;

    // B1 should now be running; release it
    releaseB1();
    await b1;
    await a2;

    expect(completed).toEqual(["A1", "B1", "A2"]);
  });

  it("watchdog: enqueueInference with short timeout rejects with /timeout/ and gate serves next entry", async () => {
    const completed: string[] = [];

    // A hung run that never resolves within the timeout
    const hung = enqueueInference("A", () => new Promise<void>(() => { /* never */ }), "interactive", 50);

    // Queue a second entry that should run after the watchdog fires
    const next = enqueueInference("B", async () => {
      completed.push("B");
    });

    await expect(hung).rejects.toThrow(/timeout/);
    await next;

    expect(completed).toEqual(["B"]);
  });

  it("drainLane with per-lane queues: A1+A2+B1 queued while busy; drainLane(A) rejects A1+A2; B1 still runs", async () => {
    let unblock!: () => void;
    const held = new Promise<void>((r) => { unblock = r; });

    const blocker = enqueueInference("blocker", async () => {
      await held;
    });

    const completed: string[] = [];

    const a1 = enqueueInference("A", async () => { completed.push("A1"); });
    const a2 = enqueueInference("A", async () => { completed.push("A2"); });
    const b1 = enqueueInference("B", async () => { completed.push("B1"); });

    drainLane("A");
    unblock();

    await expect(a1).rejects.toThrow(/lane closed/);
    await expect(a2).rejects.toThrow(/lane closed/);
    await blocker;
    await b1;

    expect(completed).toEqual(["B1"]);
  });
});
