import { networkAgentExists } from "../network/client.js";
import { registerAgentOnNetwork } from "./register.js";
import { listAgents, updateAgent } from "./store.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

type ReconcileLog = (message: string) => void;

/**
 * Restores locally registered manifests that are missing from the Network.
 *
 * The host's data volume and the Network database have independent
 * lifecycles. A Network restore/replacement must therefore be treated like a
 * recoverable cache miss, not a reason to strand every locally persisted
 * agent behind permanent heartbeat 404s. Probe before publishing so healthy
 * registries do not receive needless manifest updates or persona fan-out.
 */
export async function reconcileNetworkRegistry(log: ReconcileLog): Promise<void> {
  const registeredAgents = listAgents().filter((agent) => agent.registered);

  for (const agent of registeredAgents) {
    try {
      if (await networkAgentExists(agent.agentId)) continue;

      await registerAgentOnNetwork(agent);
      updateAgent(agent.agentId, { syncedAt: new Date().toISOString() });
      log(`registry reconciliation restored ${agent.name}`);
    } catch (err) {
      log(
        `registry reconciliation failed for ${agent.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Runs immediately at boot, then periodically. The in-flight guard prevents
 * a slow/unreachable Network from stacking overlapping reconciliation runs.
 */
export function startNetworkRegistryReconciliation(
  log: ReconcileLog,
  intervalMs = DEFAULT_RECONCILE_INTERVAL_MS,
): () => void {
  let stopped = false;
  let running = false;

  const run = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await reconcileNetworkRegistry(log);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
