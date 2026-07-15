import { signEnvelope } from "@interloom/keys";
import { HeartbeatResponse, type Placement } from "@interloom/protocol";
import { log } from "./log.js";

/**
 * One network heartbeat call, signed under the frontier agent's OWN
 * keypair (CONTRACTS §4/§14) — unlike the hosted daemon, the MCP heartbeats
 * per agent, never under a shared host machine key.
 */
export async function networkHeartbeat(
  networkUrl: string,
  agentId: string,
  agentPrivKey: string,
  agentPubKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Placement[]> {
  const payload = { agentId, status: "idle" as const, ts: Date.now() };
  const envelope = signEnvelope(payload, agentPrivKey, agentPubKey);

  const res = await fetchImpl(`${networkUrl.replace(/\/+$/, "")}/api/agents/${agentId}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    throw new Error(`heartbeat failed: ${res.status}`);
  }
  const raw: unknown = await res.json();
  const parsed = HeartbeatResponse.safeParse(raw);
  return parsed.success ? parsed.data.placements : [];
}

export interface FrontierAgentKey {
  agentId: string;
  networkUrl: string;
  agentPrivKey: string;
  agentPubKey: string;
}

export interface HeartbeatLoopOptions {
  /** 30s per CONTRACTS §4/§14. */
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  onPlacements(agentId: string, placements: Placement[]): void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** One heartbeat loop per linked agent — each ticks independently under its own key. */
export class HeartbeatLoop {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly intervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HeartbeatLoopOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  start(agent: FrontierAgentKey): void {
    if (this.timers.has(agent.agentId)) return;

    const run = async (): Promise<void> => {
      try {
        const placements = await networkHeartbeat(
          agent.networkUrl,
          agent.agentId,
          agent.agentPrivKey,
          agent.agentPubKey,
          this.fetchImpl,
        );
        this.opts.onPlacements(agent.agentId, placements);
      } catch (err) {
        log.warn("frontier heartbeat failed", {
          agentId: agent.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    void run();
    const timer = setInterval(() => void run(), this.intervalMs);
    timer.unref?.();
    this.timers.set(agent.agentId, timer);
  }

  stop(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(agentId);
    }
  }

  stopAll(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
