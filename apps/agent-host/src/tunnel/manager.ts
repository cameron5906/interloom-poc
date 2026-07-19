import type { Placement } from "@interloom/protocol";
import { getKeypair } from "../keys.js";
import { getAgent } from "../agents/store.js";
import { TunnelClient, type TunnelInfo } from "./client.js";

export interface PlacementsDiff {
  toOpen: Placement[];
  toClose: string[];
}

export interface LiveTunnel {
  voucherSig: string;
  authFailed: boolean;
}

/**
 * Pure function: compute which placements to open/close.
 *
 * `loadedFilenames` filters out agents whose model isn't in the LOADED SET
 * (CONTRACTS §6 multi-instance loading — agents of ALL loaded models get
 * tunnels, not just a single "active model"). Accepts:
 *  - `undefined` — no filter, every non-revoked placement is eligible
 *    (back-compat for callers that haven't loaded the registry yet).
 *  - `null` — nothing is loaded; every agent-gated placement closes.
 *  - a single filename `string` — back-compat single-model filter (legacy
 *    callers / existing tests).
 *  - a `Set<string>` — the multi-instance loaded set.
 *
 * Frontier-runtime agents (CONTRACTS §14) are always skipped, independent of
 * `loadedFilenames` — the host daemon never opens a tunnel for one; its
 * linked MCP server does, over its own per-agent key.
 */
export function diffPlacements(
  current: Map<string, LiveTunnel>,
  incoming: Placement[],
  loadedFilenames?: string | Set<string> | null,
): PlacementsDiff {
  const toOpen: Placement[] = [];
  const toClose: string[] = [];

  const isLoaded = (filename: string): boolean => {
    if (loadedFilenames === undefined) return true;
    if (loadedFilenames === null) return false;
    if (typeof loadedFilenames === "string") return filename === loadedFilenames;
    return loadedFilenames.has(filename);
  };

  for (const placement of incoming) {
    if (placement.revoked) {
      if (current.has(placement.placementId)) {
        toClose.push(placement.placementId);
      }
      continue;
    }

    const agentId = placement.voucher.payload.agentId;
    const agent = getAgent(agentId);

    if (agent?.runtime === "frontier") {
      if (current.has(placement.placementId)) {
        toClose.push(placement.placementId);
      }
      continue;
    }

    if (loadedFilenames !== undefined) {
      if (!agent?.model || !isLoaded(agent.model.filename)) {
        if (current.has(placement.placementId)) {
          toClose.push(placement.placementId);
        }
        continue;
      }
    }

    const live = current.get(placement.placementId);
    if (!live) {
      toOpen.push(placement);
    } else if (live.voucherSig !== placement.voucher.sig || live.authFailed) {
      // Heartbeats deliver refreshed vouchers; a client stuck on an expired or
      // rejected voucher must be replaced, not left reconnect-looping forever.
      toClose.push(placement.placementId);
      toOpen.push(placement);
    }
  }

  const incomingIds = new Set(incoming.map((p) => p.placementId));
  for (const id of current.keys()) {
    if (!incomingIds.has(id)) {
      toClose.push(id);
    }
  }

  return { toOpen, toClose };
}

export class TunnelManager {
  private tunnels = new Map<string, TunnelClient>();

  applyPlacements(placements: Placement[], loadedFilenames?: string | Set<string> | null): void {
    const { toOpen, toClose } = diffPlacements(this.tunnels, placements, loadedFilenames);
    const keypair = getKeypair();

    for (const id of toClose) {
      const client = this.tunnels.get(id);
      client?.destroy();
      this.tunnels.delete(id);
    }

    for (const placement of toOpen) {
      const agentId = placement.voucher.payload.agentId;
      const agent = getAgent(agentId);
      const agentName = agent?.name ?? agentId;
      const client = new TunnelClient(
        placement,
        agentName,
        keypair.privateKey,
        keypair.publicKey,
      );
      this.tunnels.set(placement.placementId, client);
      client.start();
    }
  }

  closePlacement(placementId: string): void {
    const client = this.tunnels.get(placementId);
    client?.destroy();
    this.tunnels.delete(placementId);
  }

  getTunnelInfos(): TunnelInfo[] {
    return Array.from(this.tunnels.values()).map((c) => c.info);
  }

  destroyAll(): void {
    for (const client of this.tunnels.values()) {
      client.destroy();
    }
    this.tunnels.clear();
  }
}
