/**
 * Shared inference gate (CONTRACTS §6).
 *
 * One llama.cpp request in flight at a time, served per-lane round-robin
 * (lane = agentId or "preview") so one busy agent cannot starve the others.
 *
 * Traffic classes (CONTRACTS §5/§6):
 * - "interactive" (default): chat replies — lanes with interactive work are
 *   served (round-robin) before ANY maintenance work.
 * - "maintenance": compaction, internal processes — served only when no
 *   interactive request is waiting anywhere. Starvation of maintenance is
 *   acceptable; real work always outranks upkeep.
 *
 * A watchdog bounds each run: llama.cpp requests have no other timeout, and a
 * single hung fetch would otherwise deadlock every tunnel on the host.
 */

type Lane = string;

export type Priority = "interactive" | "maintenance";

/** Hard bound on a single inference run holding the gate. */
export const RUN_TIMEOUT_MS = 120_000;

interface QueueEntry {
  priority: Priority;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
  timeoutMs: number;
}

/** Per-lane FIFO queues, in lane-arrival rotation order. */
const laneQueues = new Map<Lane, QueueEntry[]>();
/** Round-robin cursor: index into the lane rotation of the last-served lane. */
let rrCursor = -1;
let servingLane: Lane | null = null;
let running = false;

function laneRotation(): Lane[] {
  return Array.from(laneQueues.keys());
}

function hasEntries(predicate: (e: QueueEntry) => boolean): boolean {
  for (const entries of laneQueues.values()) {
    if (entries.some(predicate)) return true;
  }
  return false;
}

/**
 * Pick the next entry round-robin across lanes. When any interactive entry is
 * queued, only lanes with interactive work are eligible and the oldest
 * interactive entry of the chosen lane is served (maintenance entries in the
 * same lane wait). Otherwise the oldest entry of the next busy lane is served.
 */
function nextEntry(): { lane: Lane; entry: QueueEntry } | undefined {
  const rotation = laneRotation();
  if (rotation.length === 0) return undefined;
  const interactiveOnly = hasEntries((e) => e.priority === "interactive");

  for (let step = 1; step <= rotation.length; step++) {
    const idx = (rrCursor + step) % rotation.length;
    const lane = rotation[idx]!;
    const entries = laneQueues.get(lane)!;
    const pos = interactiveOnly
      ? entries.findIndex((e) => e.priority === "interactive")
      : 0;
    if (pos === -1 || entries.length === 0) continue;
    const [entry] = entries.splice(pos, 1);
    if (entries.length === 0) laneQueues.delete(lane);
    // Advance the cursor relative to the NEW rotation (the lane may be gone).
    rrCursor = laneRotation().indexOf(lane);
    return { lane, entry: entry! };
  }
  return undefined;
}

/**
 * Enqueue an inference call. `run` is invoked exactly once when the entry is
 * served; the returned promise settles with it — or rejects on watchdog
 * timeout, after which the gate moves on (the orphaned run keeps running
 * against llama.cpp until it dies; the next restart clears it).
 */
export function enqueueInference(
  lane: Lane,
  run: () => Promise<void>,
  priority: Priority = "interactive",
  timeoutMs: number = RUN_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const entries = laneQueues.get(lane) ?? [];
    entries.push({ priority, run, resolve, reject, timeoutMs });
    laneQueues.set(lane, entries);
    void dispatch();
  });
}

async function dispatch(): Promise<void> {
  if (running) return;
  running = true;
  for (;;) {
    const next = nextEntry();
    if (!next) break;
    const { lane, entry } = next;
    servingLane = lane;
    try {
      await runWithTimeout(entry);
      entry.resolve();
    } catch (err) {
      entry.reject(err);
    } finally {
      servingLane = null;
    }
  }
  running = false;
}

function runWithTimeout(entry: QueueEntry): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`inference run timeout after ${entry.timeoutMs}ms`));
    }, entry.timeoutMs);
    entry
      .run()
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

/** Returns the lane currently being served (null when idle). */
export function getServingLane(): Lane | null {
  return servingLane;
}

/** Returns the number of requests waiting (not including in-flight). */
export function getQueueDepth(): number {
  let depth = 0;
  for (const entries of laneQueues.values()) depth += entries.length;
  return depth;
}

/**
 * Drain all queued entries for a lane (e.g., when a tunnel closes).
 * In-flight requests cannot be cancelled — only waiting ones are removed.
 */
export function drainLane(lane: Lane): void {
  const entries = laneQueues.get(lane);
  if (!entries) return;
  laneQueues.delete(lane);
  for (const entry of entries) {
    entry.reject(new Error("lane closed"));
  }
}

/** Test hygiene only: clear all gate state between test cases. */
export function resetGateForTests(): void {
  for (const entries of laneQueues.values()) {
    for (const entry of entries) entry.reject(new Error("gate reset"));
  }
  laneQueues.clear();
  rrCursor = -1;
  servingLane = null;
  running = false;
}
