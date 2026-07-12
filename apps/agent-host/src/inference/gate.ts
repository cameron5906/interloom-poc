/**
 * Shared inference gate (CONTRACTS §6).
 *
 * One llama.cpp request in flight at a time. Queued callers are served in
 * round-robin order across registered "lanes". The preview route participates
 * as the "preview" lane. Telemetry reads serving/idle/offline status here.
 *
 * Traffic classes (CONTRACTS §5/§6):
 * - "interactive" (default): chat replies — served immediately when the gate
 *   is free.
 * - "maintenance": compaction, internal processes — served ONLY when no
 *   interactive request is waiting. Starvation of maintenance is acceptable;
 *   real work always outranks upkeep.
 */

type Lane = string; // agentId or "preview"

export type Priority = "interactive" | "maintenance";

interface QueueEntry {
  lane: Lane;
  priority: Priority;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** Which lane's request is currently in flight (null = idle). */
let servingLane: Lane | null = null;

/** Ordered queue of waiting entries. */
const queue: QueueEntry[] = [];

/** Whether a dispatch loop is running. */
let running = false;

/**
 * Returns the next entry to serve: the oldest interactive entry, or the
 * oldest maintenance entry if no interactive entries are queued.
 */
function nextEntry(): QueueEntry | undefined {
  const interactiveIdx = queue.findIndex((e) => e.priority === "interactive");
  if (interactiveIdx !== -1) {
    return queue.splice(interactiveIdx, 1)[0];
  }
  return queue.shift();
}

/**
 * Enqueue an inference call. The provided `run` callback is invoked exactly
 * once when this entry reaches the front of the queue. Returns a promise that
 * resolves/rejects when `run` completes.
 *
 * @param priority "interactive" (default) outranks "maintenance" — maintenance
 *   requests are held back while any interactive request is waiting.
 */
export function enqueueInference(
  lane: Lane,
  run: () => Promise<void>,
  priority: Priority = "interactive",
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    queue.push({ lane, priority, run, resolve, reject });
    void dispatch();
  });
}

async function dispatch(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const entry = nextEntry();
    if (!entry) break;
    servingLane = entry.lane;
    try {
      await entry.run();
      entry.resolve();
    } catch (err) {
      entry.reject(err);
    } finally {
      servingLane = null;
    }
  }
  running = false;
}

/** Returns the lane currently being served (null when idle). */
export function getServingLane(): Lane | null {
  return servingLane;
}

/** Returns the number of requests waiting (not including in-flight). */
export function getQueueDepth(): number {
  return queue.length;
}

/**
 * Drain all queued entries for a lane (e.g., when a tunnel closes).
 * In-flight requests cannot be cancelled — only waiting ones are removed.
 */
export function drainLane(lane: Lane): void {
  let i = queue.length - 1;
  while (i >= 0) {
    if (queue[i]?.lane === lane) {
      const [entry] = queue.splice(i, 1);
      entry?.reject(new Error("lane closed"));
    }
    i--;
  }
}
