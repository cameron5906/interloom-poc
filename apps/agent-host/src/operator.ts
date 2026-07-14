import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { signEnvelope } from "@interloom/keys";
import type { IdentityPublish } from "@interloom/protocol";
import {
  getOperatorDisplayName,
  setOperatorDisplayName as persistOperatorDisplayName,
} from "./settings.js";
import { getKeypair } from "./keys.js";
import { isOperatorBound } from "./operatorBind.js";
import { networkPublishIdentity } from "./network/client.js";
import { listAgents, updateAgent } from "./agents/store.js";
import { registerAgentOnNetwork } from "./agents/register.js";

const OperatorBody = z.object({
  displayName: z.string().min(1).max(60),
});

/**
 * Publishes this host's legacy (host-key) operator identity to the network
 * (CONTRACTS §6) — ONLY while the host is unbound. Once an operator binds a
 * network identity, that identity was already published by the operator's
 * own network login; the daemon has nothing to publish and this is a no-op.
 * Publishing under the host key while bound would re-introduce exactly the
 * `operator.pubKey === envelope.key` identity the binding replaces.
 */
export async function publishOperatorIdentity(): Promise<void> {
  if (isOperatorBound()) return;
  const keypair = getKeypair();
  const payload: IdentityPublish = {
    kind: "operator",
    pubKey: keypair.publicKey,
    displayName: getOperatorDisplayName(),
    ts: Date.now(),
  };
  const envelope = signEnvelope(payload, keypair.privateKey, keypair.publicKey);
  await networkPublishIdentity(envelope);
}

/** Re-registers every registered agent — used after a display-name save or an operator bind. */
export async function reregisterAllAgents(): Promise<void> {
  for (const agent of listAgents()) {
    if (!agent.registered) continue;
    try {
      await registerAgentOnNetwork(agent);
      updateAgent(agent.agentId, { syncedAt: new Date().toISOString() });
    } catch {
      // best-effort — other agents still get their turn to re-register
    }
  }
}

export function registerOperatorRoutes(app: FastifyInstance): void {
  app.get("/api/settings/operator", async (_req, reply) => {
    return reply.send({ displayName: getOperatorDisplayName() });
  });

  app.post<{ Body: unknown }>("/api/settings/operator", async (req, reply) => {
    const parsed = OperatorBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    persistOperatorDisplayName(parsed.data.displayName);

    try {
      await publishOperatorIdentity();
    } catch (err) {
      app.log.warn({ err }, "operator identity publish failed");
    }
    await reregisterAllAgents();

    return reply.send({ displayName: getOperatorDisplayName() });
  });
}
