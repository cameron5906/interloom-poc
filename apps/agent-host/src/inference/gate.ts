/**
 * Shared inference gate, PER LOADED INSTANCE (CONTRACTS §6 multi-instance).
 *
 * Each loaded model instance (keyed by its llama-server port) gets its own
 * gate: one request in flight at a time on that instance, served per-lane
 * round-robin (lane = agentId or "preview") so one busy agent cannot starve
 * the others ON THE SAME MODEL. Two different loaded instances serve
 * concurrently — they have no shared state.
 *
 * Traffic classes (CONTRACTS §5/§6):
 * - "interactive" (default): chat replies — lanes with interactive work are
 *   served (round-robin) before ANY maintenance work.
 * - "maintenance": compaction, internal processes — served only when no
 *   interactive request is waiting anywhere on that instance. Starvation of
 *   maintenance is acceptable; real work always outranks upkeep.
 *
 * A watchdog bounds each run: llama.cpp requests have no other timeout, and a
 * single hung fetch would otherwise deadlock every tunnel on that instance.
 * On watchdog fire the gate ABORTS the run via the `AbortSignal` passed into
 * `run()` — the engine frees up instead of leaving the gate deadlocked on an
 * orphaned request it can never observe finishing.
 */

type Lane = string;

export type Priority = "interactive" | "maintenance" | "background";

/** Hard bound on a single inference run holding the gate. */
export const RUN_TIMEOUT_MS = 120_000;

interface QueueEntry {
  priority: Priority;
  run: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
  timeoutMs: number;
}

class InstanceGate {
  private laneQueues = new Map<Lane, QueueEntry[]>();
  private rrCursor = -1;
  private servingLane: Lane | null = null;
  private running = false;
  private currentPriority: Priority | null = null;
  private currentAbort: AbortController | null = null;

  private laneRotation(): Lane[] {
    return Array.from(this.laneQueues.keys());
  }

  private hasEntries(predicate: (e: QueueEntry) => boolean): boolean {
    for (const entries of this.laneQueues.values()) {
      if (entries.some(predicate)) return true;
    }
    return false;
  }

  private nextEntry(): { lane: Lane; entry: QueueEntry } | undefined {
    const rotation = this.laneRotation();
    if (rotation.length === 0) return undefined;
    const targetPriority = this.hasEntries((e) => e.priority === "interactive")
      ? "interactive"
      : this.hasEntries((e) => e.priority === "maintenance")
        ? "maintenance"
        : "background";

    for (let step = 1; step <= rotation.length; step++) {
      const idx = (this.rrCursor + step) % rotation.length;
      const lane = rotation[idx]!;
      const entries = this.laneQueues.get(lane)!;
      const pos = entries.findIndex((e) => e.priority === targetPriority);
      if (pos === -1 || entries.length === 0) continue;
      const [entry] = entries.splice(pos, 1);
      if (entries.length === 0) this.laneQueues.delete(lane);
      // Advance the cursor relative to the NEW rotation (the lane may be gone).
      this.rrCursor = this.laneRotation().indexOf(lane);
      return { lane, entry: entry! };
    }
    return undefined;
  }

  enqueue(
    lane: Lane,
    run: (signal: AbortSignal) => Promise<void>,
    priority: Priority,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entries = this.laneQueues.get(lane) ?? [];
      entries.push({ priority, run, resolve, reject, timeoutMs });
      this.laneQueues.set(lane, entries);
      if (priority === "interactive" && this.currentPriority === "background") {
        this.currentAbort?.abort(new Error("background inference preempted by interactive work"));
      }
      void this.dispatch().catch((error) => {
        this.running = false;
        this.servingLane = null;
        for (const entries of this.laneQueues.values()) {
          for (const entry of entries) entry.reject(error);
        }
        this.laneQueues.clear();
      });
    });
  }

  private async dispatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (;;) {
      const next = this.nextEntry();
      if (!next) break;
      const { lane, entry } = next;
      this.servingLane = lane;
      try {
        await this.runWithTimeout(entry);
        entry.resolve();
      } catch (err) {
        entry.reject(err);
      } finally {
        this.servingLane = null;
      }
    }
    this.running = false;
  }

  private runWithTimeout(entry: QueueEntry): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ac = new AbortController();
      this.currentAbort = ac;
      this.currentPriority = entry.priority;
      const timer = setTimeout(() => {
        ac.abort(new Error(`inference run timeout after ${entry.timeoutMs}ms`));
        reject(new Error(`inference run timeout after ${entry.timeoutMs}ms`));
      }, entry.timeoutMs);
      entry
        .run(ac.signal)
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timer);
          if (this.currentAbort === ac) {
            this.currentAbort = null;
            this.currentPriority = null;
          }
        });
    });
  }

  getServingLane(): Lane | null {
    return this.servingLane;
  }

  getQueueDepth(): number {
    let depth = 0;
    for (const entries of this.laneQueues.values()) depth += entries.length;
    return depth;
  }

  drainLane(lane: Lane): void {
    const entries = this.laneQueues.get(lane);
    if (!entries) return;
    this.laneQueues.delete(lane);
    for (const entry of entries) {
      entry.reject(new Error("lane closed"));
    }
  }

  /** Drain every lane — used when an instance unloads. */
  drainAll(): void {
    for (const lane of this.laneRotation()) {
      this.drainLane(lane);
    }
  }
}

const gates = new Map<number, InstanceGate>();

function gateFor(port: number): InstanceGate {
  let g = gates.get(port);
  if (!g) {
    g = new InstanceGate();
    gates.set(port, g);
  }
  return g;
}

/**
 * Enqueue an inference call on the instance at `port`. `run` is invoked
 * exactly once when the entry is served, with an `AbortSignal` that fires on
 * watchdog timeout — pass it to the underlying fetch. The returned promise
 * settles with it, or rejects on watchdog timeout, after which the gate moves
 * on (the orphaned run keeps running against llama.cpp until it dies or the
 * abort takes effect).
 */
export function enqueueInference(
  port: number,
  lane: Lane,
  run: (signal: AbortSignal) => Promise<void>,
  priority: Priority = "interactive",
  timeoutMs: number = RUN_TIMEOUT_MS,
): Promise<void> {
  return gateFor(port).enqueue(lane, run, priority, timeoutMs);
}

/** Returns the lane currently being served on `port` (null when idle or no gate yet). */
export function getServingLane(port: number): Lane | null {
  return gates.get(port)?.getServingLane() ?? null;
}

/** Returns the number of requests waiting on `port` (not including the in-flight one). */
export function getQueueDepth(port: number): number {
  return gates.get(port)?.getQueueDepth() ?? 0;
}

/** Sum of queue depths across every instance — back-compat single-number telemetry field. */
export function getTotalQueueDepth(): number {
  let total = 0;
  for (const g of gates.values()) total += g.getQueueDepth();
  return total;
}

/** Every port with a live gate (has ever queued/served work) — used by telemetry. */
export function getGatePorts(): number[] {
  return Array.from(gates.keys());
}

/**
 * Drain all queued entries for a lane on `port` (e.g., when a tunnel closes).
 * In-flight requests cannot be cancelled this way — only waiting ones are removed.
 */
export function drainLane(port: number, lane: Lane): void {
  gates.get(port)?.drainLane(lane);
}

/** Drain every lane on `port` and forget the gate — used when an instance unloads. */
export function drainInstance(port: number): void {
  gates.get(port)?.drainAll();
  gates.delete(port);
}

/** Test hygiene only: clear all gate state between test cases. */
export function resetGateForTests(): void {
  for (const g of gates.values()) g.drainAll();
  gates.clear();
}
