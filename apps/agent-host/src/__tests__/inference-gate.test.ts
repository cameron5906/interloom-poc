/**
 * Tests for the shared inference gate, PER LOADED INSTANCE (CONTRACTS §6).
 *
 * Verifies:
 * - One request in flight at a time PER PORT.
 * - Round-robin order across 2 agents interleaved.
 * - Queue depth tracking (per port).
 * - drainLane removes only the right entries.
 * - Two different instances (ports) serve concurrently, independently.
 * - Watchdog abort: the AbortSignal passed to `run()` fires on timeout.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueueInference,
  getServingLane,
  getQueueDepth,
  drainLane,
  drainInstance,
  resetGateForTests,
} from "../inference/gate.js";

const PORT = 8080;
const PORT_B = 8081;

describe("inference gate", () => {
  beforeEach(() => {
    resetGateForTests();
  });

  it("runs one request at a time on a port — second starts only after first finishes", async () => {
    const order: string[] = [];
    let firstRunning = false;

    const first = enqueueInference(PORT, "lane-a", async () => {
      firstRunning = true;
      order.push("a-start");
      await new Promise<void>((r) => setTimeout(r, 20));
      order.push("a-end");
      firstRunning = false;
    });

    const second = enqueueInference(PORT, "lane-b", async () => {
      // At this point, first should already be done
      expect(firstRunning).toBe(false);
      order.push("b-start");
      order.push("b-end");
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("round-robin: 2 agents each queue 2 requests, served in arrival order (FIFO per the gate)", async () => {
    const completed: string[] = [];

    const p1 = enqueueInference(PORT, "agent-1", async () => { completed.push("a1-req1"); });
    const p2 = enqueueInference(PORT, "agent-2", async () => { completed.push("a2-req1"); });
    const p3 = enqueueInference(PORT, "agent-1", async () => { completed.push("a1-req2"); });
    const p4 = enqueueInference(PORT, "agent-2", async () => { completed.push("a2-req2"); });

    await Promise.all([p1, p2, p3, p4]);

    expect(completed).toHaveLength(4);
    expect(completed).toContain("a1-req1");
    expect(completed).toContain("a2-req1");
    expect(completed).toContain("a1-req2");
    expect(completed).toContain("a2-req2");
    expect(completed.indexOf("a1-req1")).toBeLessThan(completed.indexOf("a1-req2"));
    expect(completed.indexOf("a2-req1")).toBeLessThan(completed.indexOf("a2-req2"));
  });

  it("getQueueDepth reflects waiting entries on that port (not the in-flight one)", async () => {
    let unblockFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => { unblockFirst = r; });

    let depthWhileRunning = -1;

    const first = enqueueInference(PORT, "lane-x", async () => {
      enqueueInference(PORT, "lane-y", async () => {});
      enqueueInference(PORT, "lane-z", async () => {});
      depthWhileRunning = getQueueDepth(PORT);
      await firstBlocked;
    });

    await new Promise<void>((r) => setTimeout(r, 5));
    unblockFirst();
    await first;

    expect(depthWhileRunning).toBe(2);
  });

  it("drainLane rejects queued entries for that lane on that port without affecting others", async () => {
    let unblockFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => { unblockFirst = r; });

    const first = enqueueInference(PORT, "blocker", async () => {
      await firstBlocked;
    });

    const drainTarget = enqueueInference(PORT, "drain-me", async () => {
      throw new Error("should not run");
    });

    const survivor = enqueueInference(PORT, "keeper", async () => {});

    await new Promise<void>((r) => setTimeout(r, 5));
    drainLane(PORT, "drain-me");
    unblockFirst();

    await expect(drainTarget).rejects.toThrow("lane closed");
    await expect(first).resolves.toBeUndefined();
    await expect(survivor).resolves.toBeUndefined();
  });

  it("preview participates as its own lane", async () => {
    const completed: string[] = [];

    await enqueueInference(PORT, "agent-1", async () => { completed.push("agent"); });
    await enqueueInference(PORT, "preview", async () => { completed.push("preview"); });

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

    const blocker = enqueueInference(PORT, "blocker", async () => {
      await blockerHeld;
    });

    const a1 = enqueueInference(PORT, "A", async () => {
      await a1Gate;
      completed.push("A1");
    });
    const a2 = enqueueInference(PORT, "A", async () => {
      completed.push("A2");
    });
    const b1 = enqueueInference(PORT, "B", async () => {
      await b1Gate;
      completed.push("B1");
    });

    unblockBlocker();
    await blocker;

    releaseA1();
    await a1;

    releaseB1();
    await b1;
    await a2;

    expect(completed).toEqual(["A1", "B1", "A2"]);
  });

  it("watchdog: short timeout rejects with /timeout/, aborts the run's signal, and the gate serves the next entry", async () => {
    const completed: string[] = [];
    let signalAborted = false;

    const hung = enqueueInference(
      PORT,
      "A",
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            signalAborted = true;
            reject(new Error("aborted"));
          });
        }),
      "interactive",
      50,
    );

    const next = enqueueInference(PORT, "B", async () => {
      completed.push("B");
    });

    await expect(hung).rejects.toThrow(/timeout/);
    await next;

    expect(completed).toEqual(["B"]);
    expect(signalAborted).toBe(true);
  });

  it("watchdog abort does not affect a run finishing comfortably under its timeout", async () => {
    let aborted = false;
    await enqueueInference(
      PORT,
      "A",
      async (signal) => {
        await new Promise((r) => setTimeout(r, 5));
        aborted = signal.aborted;
      },
      "interactive",
      500,
    );
    expect(aborted).toBe(false);
  });

  it("drainLane with per-lane queues: A1+A2+B1 queued while busy; drainLane(A) rejects A1+A2; B1 still runs", async () => {
    let unblock!: () => void;
    const held = new Promise<void>((r) => { unblock = r; });

    const blocker = enqueueInference(PORT, "blocker", async () => {
      await held;
    });

    const completed: string[] = [];

    const a1 = enqueueInference(PORT, "A", async () => { completed.push("A1"); });
    const a2 = enqueueInference(PORT, "A", async () => { completed.push("A2"); });
    const b1 = enqueueInference(PORT, "B", async () => { completed.push("B1"); });

    drainLane(PORT, "A");
    unblock();

    await expect(a1).rejects.toThrow(/lane closed/);
    await expect(a2).rejects.toThrow(/lane closed/);
    await blocker;
    await b1;

    expect(completed).toEqual(["B1"]);
  });

  it("two instances (ports) serve concurrently — a slow request on one port never blocks the other", async () => {
    const order: string[] = [];
    let unblockA!: () => void;
    const aHeld = new Promise<void>((r) => { unblockA = r; });

    const slowOnA = enqueueInference(PORT, "agent-1", async () => {
      order.push("A-start");
      await aHeld;
      order.push("A-end");
    });

    // Give A a tick to start, then run something on the OTHER port — must not wait for A.
    await new Promise<void>((r) => setTimeout(r, 5));
    const fastOnB = enqueueInference(PORT_B, "agent-2", async () => {
      order.push("B-start");
      order.push("B-end");
    });

    await fastOnB;
    // B completed while A is still blocked — proves independent gates.
    expect(order).toEqual(["A-start", "B-start", "B-end"]);

    unblockA();
    await slowOnA;
    expect(order).toEqual(["A-start", "B-start", "B-end", "A-end"]);
  });

  it("getServingLane and getQueueDepth are scoped per port", async () => {
    let unblock!: () => void;
    const held = new Promise<void>((r) => { unblock = r; });

    const onA = enqueueInference(PORT, "agent-1", async () => { await held; });
    enqueueInference(PORT_B, "agent-2", async () => {});

    await new Promise<void>((r) => setTimeout(r, 5));
    expect(getServingLane(PORT)).toBe("agent-1");
    expect(getQueueDepth(PORT_B)).toBe(0);

    unblock();
    await onA;
    expect(getServingLane(PORT)).toBeNull();
  });

  it("drainInstance drains every lane on that port and forgets the gate", async () => {
    let unblock!: () => void;
    const held = new Promise<void>((r) => { unblock = r; });

    const blocker = enqueueInference(PORT, "blocker", async () => { await held; });
    const queued = enqueueInference(PORT, "agent-1", async () => {});

    await new Promise<void>((r) => setTimeout(r, 5));
    drainInstance(PORT);

    await expect(queued).rejects.toThrow(/lane closed/);
    expect(getQueueDepth(PORT)).toBe(0);

    unblock();
    await blocker;
  });
});
