import type { Placement } from "@interloom/protocol";
import { getKeypair } from "../keys.js";
import { getAgent } from "../agents/store.js";
import { TunnelClient, type TunnelInfo } from "./client.js";

export interface PlacementsDiff {
  toOpen: Placement[];
  toClose: string[];
}

export function diffPlacements(
  current: Map<string, TunnelClient>,
  incoming: Placement[],
): PlacementsDiff {
  const toOpen: Placement[] = [];
  const toClose: string[] = [];

  for (const placement of incoming) {
    if (placement.revoked) {
      if (current.has(placement.placementId)) {
        toClose.push(placement.placementId);
      }
    } else {
      if (!current.has(placement.placementId)) {
        toOpen.push(placement);
      }
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

  applyPlacements(placements: Placement[]): void {
    const { toOpen, toClose } = diffPlacements(this.tunnels, placements);
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
