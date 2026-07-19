import type {
  ContextListResult,
  ContextReadResult,
  FrontierLinkPayload,
  FrontierWorkItem,
  Placement,
} from "@interloom/protocol";
import { loadCredentials, removeAgentCredential, saveAgentCredential } from "./credentials.js";
import { scanLink as defaultScanLink, type ScanLinkOptions } from "./linkScanner.js";
import { log } from "./log.js";
import { HeartbeatLoop } from "./network.js";
import { QueueManager } from "./queue/manager.js";
import { StaleLeaseError, TunnelClient, type TunnelInfo } from "./tunnel.js";

export interface AgentStatus {
  agentId: string;
  agentName: string;
  online: boolean;
  placements: TunnelInfo[];
  queueDepth: number;
  doneThisSession: number;
}

export interface StatusReport {
  agents: AgentStatus[];
}

export interface NextWorkResult {
  item: FrontierWorkItem;
  placementRef: string;
}

interface AgentRuntime {
  agentId: string;
  agentName: string;
  networkUrl: string;
  agentPrivKey: string;
  agentPubKey: string;
  tunnels: Map<string, TunnelClient>;
  doneCount: number;
}

export interface FrontierServiceOptions {
  fetchImpl?: typeof fetch;
  heartbeatIntervalMs?: number;
  queuePollMs?: number;
  queueMaxBatch?: number;
  /** Injectable for tests — defaults to the real device-link scanner. */
  scanLinkFn?: (code: string, options?: ScanLinkOptions) => Promise<FrontierLinkPayload>;
}

/**
 * The facade Task 8's MCP tool surface wraps verbatim (pinned-interfaces
 * §C). Owns credentials, per-agent heartbeat loops, per-placement tunnels,
 * and the merged FCFS work queue. `start()`/`stop()` are the sole presence
 * lever — a frontier agent is online iff at least one of its tunnels is
 * authenticated (CONTRACTS §14); `stop()` tears every tunnel down cleanly
 * so the instance observes the agent going offline.
 */
interface WorkLocation {
  agentId: string;
  placementId: string;
  /**
   * The exact token this delivery was leased under (CONTRACTS §14 "Lease
   * ownership"). Carried alongside the location so a redelivery of the same
   * workId always replaces the whole record atomically — `submit`/`skip`
   * never mixes a fresh location with a stale token or vice versa. The
   * instance is still the authority: a token that's gone stale (already
   * completed, or superseded by a newer lease) is rejected there with
   * `E_STALE_LEASE`, not assumed valid here.
   */
  leaseToken: string | undefined;
}

/** Guidance text returned to the tool caller when a work item's lease went stale (CONTRACTS §14). Never a crash. */
const STALE_LEASE_GUIDANCE =
  "This work item's lease expired and was reassigned to another session, so your reply was NOT sent — do not retry it. Call interloom_next_work to keep working the queue.";

export class FrontierService {
  private readonly agents = new Map<string, AgentRuntime>();
  private readonly workLocations = new Map<string, WorkLocation>();
  private readonly heartbeat: HeartbeatLoop;
  private readonly queue: QueueManager;
  private readonly scanLinkFn: (
    code: string,
    options?: ScanLinkOptions,
  ) => Promise<FrontierLinkPayload>;
  private started = false;

  constructor(private readonly options: FrontierServiceOptions = {}) {
    this.scanLinkFn = options.scanLinkFn ?? defaultScanLink;
    this.heartbeat = new HeartbeatLoop({
      intervalMs: options.heartbeatIntervalMs,
      fetchImpl: options.fetchImpl,
      onPlacements: (agentId, placements) => this.applyPlacements(agentId, placements),
    });
    this.queue = new QueueManager({ pollMs: options.queuePollMs, maxBatch: options.queueMaxBatch });
  }

  /** Loads every persisted credential into memory (idempotent). Call before `start()`. */
  loadCredentials(): FrontierLinkPayload[] {
    const creds = loadCredentials();
    for (const cred of creds) {
      this.registerAgent(cred);
    }
    return creds;
  }

  private registerAgent(cred: FrontierLinkPayload): AgentRuntime {
    const existing = this.agents.get(cred.agentId);
    if (existing) return existing;
    const runtime: AgentRuntime = {
      agentId: cred.agentId,
      agentName: cred.agentName,
      networkUrl: cred.networkUrl,
      agentPrivKey: cred.agentPrivKey,
      agentPubKey: cred.agentPubKey,
      tunnels: new Map(),
      doneCount: 0,
    };
    this.agents.set(cred.agentId, runtime);
    return runtime;
  }

  private firstKnownNetworkUrl(): string | undefined {
    const first = this.agents.values().next();
    return first.done ? undefined : first.value.networkUrl;
  }

  /** Runs the scanner role of the device-link flow, persists the resulting credential, and (if already started) brings that agent online. */
  async linkWithCode(code: string): Promise<{ agentName: string }> {
    const fallbackNetworkUrl = this.firstKnownNetworkUrl();
    const payload = await this.scanLinkFn(code, { fallbackNetworkUrl });
    saveAgentCredential(payload);
    this.registerAgent(payload);
    if (this.started) {
      this.startAgent(payload.agentId);
    }
    return { agentName: payload.agentName };
  }

  /** Starts heartbeats for every loaded agent — tunnels open lazily as placements arrive. */
  start(): void {
    this.started = true;
    this.queue.start();
    for (const agentId of this.agents.keys()) {
      this.startAgent(agentId);
    }
  }

  private startAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.heartbeat.start({
      agentId: agent.agentId,
      networkUrl: agent.networkUrl,
      agentPrivKey: agent.agentPrivKey,
      agentPubKey: agent.agentPubKey,
    });
  }

  private applyPlacements(agentId: string, placements: Placement[]): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const liveIds = new Set(placements.filter((p) => !p.revoked).map((p) => p.placementId));

    for (const [placementId, client] of [...agent.tunnels]) {
      if (!liveIds.has(placementId)) {
        client.destroy();
        agent.tunnels.delete(placementId);
        this.queue.removePlacement(placementId);
      }
    }

    for (const placement of placements) {
      if (placement.revoked) continue;
      if (agent.tunnels.has(placement.placementId)) continue;

      const client = new TunnelClient(
        placement,
        agent.agentId,
        agent.agentPrivKey,
        agent.agentPubKey,
      );
      agent.tunnels.set(placement.placementId, client);
      client.start();
      this.queue.addPlacement({
        placementId: placement.placementId,
        agentId: agent.agentId,
        isConnected: () => client.isConnected,
        pull: (max) => client.pull(max),
        onWorkAvailable: (cb) => client.onWorkAvailable(cb),
        onConnected: (cb) => client.onConnected(cb),
      });
    }
  }

  private findTunnel(agentId: string, placementId: string): TunnelClient | undefined {
    return this.agents.get(agentId)?.tunnels.get(placementId);
  }

  status(): StatusReport {
    const agents = [...this.agents.values()].map((agent): AgentStatus => {
      const placements = [...agent.tunnels.values()].map((t) => t.info);
      return {
        agentId: agent.agentId,
        agentName: agent.agentName,
        online: placements.some((p) => p.status === "connected"),
        placements,
        queueDepth: this.queue.depthForAgent(agent.agentId),
        doneThisSession: agent.doneCount,
      };
    });
    return { agents };
  }

  /** Long-polls the merged queue; sends `work.begin` before returning an item (pinned-interfaces §C). */
  async nextWork(waitMs: number): Promise<NextWorkResult | null> {
    const next = await this.queue.next(waitMs);
    if (!next) return null;

    this.workLocations.set(next.item.workId, {
      agentId: next.item.agentId,
      placementId: next.placementRef,
      leaseToken: next.item.leaseToken,
    });

    const client = this.findTunnel(next.item.agentId, next.placementRef);
    if (client) {
      try {
        await client.begin(next.item.workId);
      } catch (err) {
        log.warn("work.begin failed", {
          workId: next.item.workId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { item: next.item, placementRef: next.placementRef };
  }

  async submit(workId: string, text: string): Promise<{ messageId?: string; posted?: boolean }> {
    const loc = this.workLocations.get(workId);
    if (!loc) throw new Error(`unknown work item: ${workId}`);
    const client = this.findTunnel(loc.agentId, loc.placementId);
    if (!client) throw new Error(`no live tunnel for work item: ${workId}`);
    try {
      const result = await client.complete(workId, loc.leaseToken, text);
      this.workLocations.delete(workId);
      const agent = this.agents.get(loc.agentId);
      if (agent) agent.doneCount += 1;
      return result;
    } catch (err) {
      if (err instanceof StaleLeaseError) {
        this.workLocations.delete(workId);
        throw new Error(STALE_LEASE_GUIDANCE);
      }
      throw err;
    }
  }

  async pass(workId: string): Promise<void> {
    const loc = this.workLocations.get(workId);
    if (!loc) throw new Error(`unknown work item: ${workId}`);
    const client = this.findTunnel(loc.agentId, loc.placementId);
    if (!client) throw new Error(`no live tunnel for work item: ${workId}`);
    try {
      await client.pass(workId, loc.leaseToken);
      this.workLocations.delete(workId);
      const agent = this.agents.get(loc.agentId);
      if (agent) agent.doneCount += 1;
    } catch (err) {
      if (err instanceof StaleLeaseError) {
        this.workLocations.delete(workId);
        throw new Error(STALE_LEASE_GUIDANCE);
      }
      throw err;
    }
  }

  async skip(workId: string, reason: string): Promise<void> {
    const loc = this.workLocations.get(workId);
    if (!loc) throw new Error(`unknown work item: ${workId}`);
    const client = this.findTunnel(loc.agentId, loc.placementId);
    if (!client) throw new Error(`no live tunnel for work item: ${workId}`);
    try {
      await client.fail(workId, loc.leaseToken, reason);
      this.workLocations.delete(workId);
    } catch (err) {
      if (err instanceof StaleLeaseError) {
        this.workLocations.delete(workId);
        throw new Error(STALE_LEASE_GUIDANCE);
      }
      throw err;
    }
  }

  private resolveSingleAgentId(): string {
    if (this.agents.size !== 1) {
      throw new Error("agentId is required when more than one agent is linked");
    }
    const [agentId] = this.agents.keys();
    if (!agentId) throw new Error("no agent is linked");
    return agentId;
  }

  async post(
    agentId: string | null,
    channelId: string,
    text: string,
  ): Promise<{ messageId: string }> {
    const resolvedId = agentId ?? this.resolveSingleAgentId();
    const agent = this.agents.get(resolvedId);
    if (!agent) throw new Error(`unknown agent: ${resolvedId}`);
    const client = [...agent.tunnels.values()].find((t) => t.isConnected);
    if (!client) throw new Error(`agent ${resolvedId} has no live tunnel`);
    return client.post(channelId, text);
  }

  private connectedTunnel(agentId: string | null): TunnelClient {
    const resolvedId = agentId ?? this.resolveSingleAgentId();
    const agent = this.agents.get(resolvedId);
    if (!agent) throw new Error(`unknown agent: ${resolvedId}`);
    const client = [...agent.tunnels.values()].find((t) => t.isConnected);
    if (!client) throw new Error(`agent ${resolvedId} has no live tunnel`);
    return client;
  }

  async contextList(
    agentId: string | null,
    params: { path?: string; ref?: string; limit?: number },
  ): Promise<ContextListResult> {
    return this.connectedTunnel(agentId).contextList(params);
  }

  async contextRead(
    agentId: string | null,
    params: { path: string; ref?: string; offset?: number; maxBytes?: number },
  ): Promise<ContextReadResult> {
    return this.connectedTunnel(agentId).contextRead(params);
  }

  unlink(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      for (const [placementId, client] of agent.tunnels) {
        client.destroy();
        this.queue.removePlacement(placementId);
      }
      this.agents.delete(agentId);
    }
    this.heartbeat.stop(agentId);
    removeAgentCredential(agentId);
  }

  /** Clean close — every tunnel torn down, so the instance(s) observe this agent going offline. */
  stop(): void {
    this.started = false;
    this.heartbeat.stopAll();
    this.queue.stop();
    for (const agent of this.agents.values()) {
      for (const client of agent.tunnels.values()) {
        client.destroy();
      }
      agent.tunnels.clear();
    }
  }
}
