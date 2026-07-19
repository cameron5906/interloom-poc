import { signEnvelope } from "@interloom/keys";
import type { HeartbeatResponse, Placement } from "@interloom/protocol";
import { HeartbeatResponse as HeartbeatResponseSchema } from "@interloom/protocol";
import { getKeypair } from "./keys.js";
import { listAgents } from "./agents/store.js";
import { networkHeartbeat } from "./network/client.js";
import { readInstances, loadedFilenames } from "./models/loaded.js";
import type { TunnelManager } from "./tunnel/manager.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

let networkErrorLogged = false;
let currentPlacements: Placement[] = [];
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function getLastPlacements(): Placement[] {
  return currentPlacements;
}

let heartbeatRunFn: (() => Promise<void>) | null = null;

/** Trigger an immediate heartbeat cycle (e.g. after model activation). */
export function triggerHeartbeat(): void {
  if (heartbeatRunFn) {
    void heartbeatRunFn();
  }
}

export function startHeartbeatLoop(tunnelManager: TunnelManager): void {
  const run = async (): Promise<void> => {
    // Multi-instance loading (CONTRACTS §6): agents of ALL loaded models get
    // tunnels — "the active model" is now "the loaded SET".
    const loaded = loadedFilenames(readInstances());

    // Only heartbeat registered, hosted agents whose model is in the loaded
    // set. Frontier agents (CONTRACTS §14) are excluded here — the linked
    // MCP server heartbeats for them, under its own per-agent key, not the
    // host daemon. Their placements simply don't mint until the MCP first
    // connects; that's expected, not a bug.
    const agents = listAgents().filter(
      (a) =>
        a.registered && a.runtime !== "frontier" && a.model !== undefined && loaded.has(a.model.filename),
    );

    if (agents.length === 0) {
      // Still apply placements diff to close any stale tunnels
      tunnelManager.applyPlacements([], loaded);
      return;
    }

    const keypair = getKeypair();
    const allPlacements: Placement[] = [];

    for (const agent of agents) {
      const payload = {
        agentId: agent.agentId,
        status: "idle" as const,
        ts: Date.now(),
      };
      const envelope = signEnvelope(payload, keypair.privateKey, keypair.publicKey);

      try {
        const raw = await networkHeartbeat(agent.agentId, envelope);
        const parsed = HeartbeatResponseSchema.safeParse(raw);
        if (parsed.success) {
          allPlacements.push(...parsed.data.placements);
        }
        networkErrorLogged = false;
      } catch (err) {
        if (!networkErrorLogged) {
          console.warn("[heartbeat] network unreachable, retrying in 30s:", err);
          networkErrorLogged = true;
        }
      }
    }

    currentPlacements = allPlacements;
    tunnelManager.applyPlacements(allPlacements, loaded);
  };

  heartbeatRunFn = run;
  void run();
  heartbeatTimer = setInterval(() => void run(), HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeatLoop(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatRunFn = null;
}
