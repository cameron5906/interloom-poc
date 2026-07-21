import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getOperatorDisplayName,
  setOperatorDisplayName as persistOperatorDisplayName,
} from "./settings.js";
import { listAgents, updateAgent } from "./agents/store.js";
import { registerAgentOnNetwork } from "./agents/register.js";

const OperatorBody = z.object({
  displayName: z.string().min(1).max(60),
});

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

    await reregisterAllAgents();

    return reply.send({ displayName: getOperatorDisplayName() });
  });
}
