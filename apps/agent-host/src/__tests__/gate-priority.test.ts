/**
 * Tests for inference gate priority (CONTRACTS §5/§6).
 *
 * Maintenance lanes are served ONLY when no interactive request is queued.
 * Starvation of maintenance by interactive work is acceptable and expected.
 */

import { describe, it, expect } from "vitest";
import { enqueueInference, getQueueDepth } from "../inference/gate.js";

describe("inference gate — priority classes", () => {
  it("maintenance waits for all interactive requests to complete first", async () => {
    const order: string[] = [];

    // Hold the gate open with an interactive blocker
    let unblockInteractive!: () => void;
    const interactiveBlocked = new Promise<void>((r) => { unblockInteractive = r; });

    const blocker = enqueueInference("agent-1", async () => {
      order.push("interactive-1-start");
      await interactiveBlocked;
      order.push("interactive-1-end");
    }, "interactive");

    // Give the gate loop a tick to start the blocker
    await new Promise<void>((r) => setTimeout(r, 5));

    // Queue a maintenance job while interactive is running
    const maintenance = enqueueInference("agent-1", async () => {
      order.push("maintenance");
    }, "maintenance");

    // Queue a second interactive job AFTER the maintenance job
    const interactive2 = enqueueInference("agent-2", async () => {
      order.push("interactive-2");
    }, "interactive");

    // Unblock the first interactive job
    unblockInteractive();

    await Promise.all([blocker, interactive2, maintenance]);

    // interactive-2 must complete before maintenance
    const maintIdx = order.indexOf("maintenance");
    const i2Idx = order.indexOf("interactive-2");
    expect(maintIdx).toBeGreaterThan(i2Idx);
    expect(order[0]).toBe("interactive-1-start");
    expect(order[order.length - 1]).toBe("maintenance");
  });

  it("maintenance runs immediately when no interactive request is queued", async () => {
    const order: string[] = [];

    // No interactive jobs queued — maintenance should run right away
    await enqueueInference("agent-1", async () => {
      order.push("maintenance-only");
    }, "maintenance");

    expect(order).toEqual(["maintenance-only"]);
  });

  it("multiple maintenance jobs are served in FIFO order among themselves", async () => {
    const order: string[] = [];

    // Hold gate with an interactive blocker
    let unblock!: () => void;
    const held = new Promise<void>((r) => { unblock = r; });

    const blocker = enqueueInference("blocker", async () => {
      await held;
    }, "interactive");

    await new Promise<void>((r) => setTimeout(r, 5));

    // Queue two maintenance jobs
    const m1 = enqueueInference("maint-1", async () => { order.push("m1"); }, "maintenance");
    const m2 = enqueueInference("maint-2", async () => { order.push("m2"); }, "maintenance");

    unblock();
    await Promise.all([blocker, m1, m2]);

    // Both maintenance jobs should complete, in arrival order
    expect(order).toEqual(["m1", "m2"]);
  });

  it("maintenance does not block an arriving interactive request", async () => {
    const order: string[] = [];

    // Hold gate with a maintenance blocker
    let unblockMaint!: () => void;
    const maintHeld = new Promise<void>((r) => { unblockMaint = r; });

    // First, let maintenance be the in-flight job (no interactive waiting)
    const maintInFlight = enqueueInference("maint", async () => {
      order.push("maint-start");
      await maintHeld;
      order.push("maint-end");
    }, "maintenance");

    await new Promise<void>((r) => setTimeout(r, 5));

    // Now queue a second maintenance and an interactive — interactive should go first
    const maint2 = enqueueInference("maint-2", async () => { order.push("maint-2"); }, "maintenance");
    const interactive = enqueueInference("agent-x", async () => { order.push("interactive"); }, "interactive");

    unblockMaint();
    await Promise.all([maintInFlight, maint2, interactive]);

    // interactive must come before maint-2
    expect(order.indexOf("interactive")).toBeLessThan(order.indexOf("maint-2"));
  });

  it("default priority is interactive", async () => {
    const order: string[] = [];

    let unblock!: () => void;
    const held = new Promise<void>((r) => { unblock = r; });

    const blocker = enqueueInference("blocker", async () => {
      await held;
    }); // no priority arg → default "interactive"

    await new Promise<void>((r) => setTimeout(r, 5));

    const maint = enqueueInference("maint", async () => { order.push("maint"); }, "maintenance");
    // queue another default-priority job — should jump ahead of maint
    const defaultPrio = enqueueInference("default", async () => { order.push("default"); });

    unblock();
    await Promise.all([blocker, maint, defaultPrio]);

    expect(order.indexOf("default")).toBeLessThan(order.indexOf("maint"));
  });

  it("getQueueDepth counts all waiting entries regardless of priority", async () => {
    let unblock!: () => void;
    const held = new Promise<void>((r) => { unblock = r; });

    const blocker = enqueueInference("blocker", async () => {
      enqueueInference("i1", async () => {}, "interactive");
      enqueueInference("m1", async () => {}, "maintenance");
      // Depth should be 2 while blocker still holds gate
      expect(getQueueDepth()).toBe(2);
      await held;
    }, "interactive");

    await new Promise<void>((r) => setTimeout(r, 5));
    unblock();
    await blocker;
  });
});
