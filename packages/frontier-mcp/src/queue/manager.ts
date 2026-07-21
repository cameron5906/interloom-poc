import type { FrontierWorkItem } from "@interloom/protocol";
import { log } from "../log.js";
import { orderWork } from "./strategy.js";

/** The tunnel-shaped surface the queue manager needs from a live placement. */
export interface PlacementHandle {
  placementId: string;
  agentId: string;
  isConnected(): boolean;
  pull(max: number): Promise<FrontierWorkItem[]>;
  onWorkAvailable(cb: () => void): void;
  onConnected(cb: () => void): void;
}

interface BufferedItem {
  item: FrontierWorkItem;
  placementId: string;
  agentId: string;
}

interface Waiter {
  resolve: (result: { item: FrontierWorkItem; placementRef: string } | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface QueueManagerOptions {
  /** 20s per the task brief. */
  pollMs?: number;
  /** Small batch cap per `work.pull` call. */
  maxBatch?: number;
}

const DEFAULT_POLL_MS = 20_000;
const DEFAULT_MAX_BATCH = 5;

/**
 * Merges the FCFS-ordered work queue across every placement of every
 * linked agent (pinned-interfaces §C / CONTRACTS §14 — cross-workspace
 * ordering is owned by the MCP, no instance sees another instance's
 * queue). Items are pulled (leased 120s instance-side) once and buffered
 * here; `next()` never re-pulls an already-buffered item, so a work item
 * is drained from the instance exactly once.
 */
export class QueueManager {
  private readonly placements = new Map<string, PlacementHandle>();
  private buffer: BufferedItem[] = [];
  private waiters: Waiter[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pollMs: number;
  private readonly maxBatch: number;

  constructor(options: QueueManagerOptions = {}) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
  }

  /** Registers a placement and pulls it immediately — plus on every reconnect or `work.available` nudge thereafter. */
  addPlacement(handle: PlacementHandle): void {
    this.placements.set(handle.placementId, handle);
    handle.onWorkAvailable(() => this.startPull(handle));
    handle.onConnected(() => this.startPull(handle));
    this.startPull(handle);
  }

  removePlacement(placementId: string): void {
    this.placements.delete(placementId);
    this.buffer = this.buffer.filter((entry) => entry.placementId !== placementId);
  }

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      for (const handle of this.placements.values()) this.startPull(handle);
    }, this.pollMs);
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }

  depthForAgent(agentId: string): number {
    return this.buffer.filter((entry) => entry.agentId === agentId).length;
  }

  private startPull(handle: PlacementHandle): void {
    void this.pullFrom(handle).catch((error) => {
      log.warn("frontier queue tick failed", {
        placementId: handle.placementId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async pullFrom(handle: PlacementHandle): Promise<void> {
    if (!handle.isConnected()) return;
    let items: FrontierWorkItem[];
    try {
      items = await handle.pull(this.maxBatch);
    } catch (err) {
      log.warn("frontier queue pull failed", {
        placementId: handle.placementId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (items.length === 0) return;
    for (const item of items) {
      this.buffer.push({ item, placementId: handle.placementId, agentId: handle.agentId });
    }
    this.drainWaiters();
  }

  private drainWaiters(): void {
    while (this.waiters.length > 0 && this.buffer.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      waiter.resolve(this.takeNext());
    }
  }

  private takeNext(): { item: FrontierWorkItem; placementRef: string } | null {
    if (this.buffer.length === 0) return null;
    const ordered = orderWork(
      this.buffer.map((entry, index) => ({
        workId: entry.item.workId,
        enqueuedAt: entry.item.enqueuedAt,
        index,
      })),
    );
    const first = ordered[0];
    if (!first) return null;
    const [taken] = this.buffer.splice(first.index, 1);
    if (!taken) return null;
    return { item: taken.item, placementRef: taken.placementId };
  }

  /** Long-poll for the next item, FCFS-ordered across every registered placement; `null` on timeout. */
  async next(waitMs: number): Promise<{ item: FrontierWorkItem; placementRef: string } | null> {
    const immediate = this.takeNext();
    if (immediate) return immediate;

    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(null);
        }, waitMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }
}
