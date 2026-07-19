import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCookie from "@fastify/cookie";
import { PORT } from "./config.js";
import { loadOrCreateKeypair, registerKeysRoutes } from "./keys.js";
import { registerSystemRoutes, getSystemInfo } from "./system.js";
import { registerModelsRoutes } from "./models/routes.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { registerUpdateRoutes } from "./update/routes.js";
import { startUpdateCheckLoop } from "./update/checker.js";
import { startRegistryLoop } from "./models/registry.js";
import { backfillCapabilities } from "./agents/register.js";
import { startNetworkRegistryReconciliation } from "./agents/reconcile.js";
import { registerOperatorRoutes, publishOperatorIdentity } from "./operator.js";
import { registerOperatorBindRoutes, isOperatorBound } from "./operatorBind.js";
import { registerPortalAuthGate } from "./portalAuth.js";
import { registerTelemetryWs } from "./telemetry/ws.js";
import { registerStatic } from "./static.js";
import { startHeartbeatLoop, triggerHeartbeat } from "./heartbeat.js";
import { TunnelManager } from "./tunnel/manager.js";
import { signEnvelope } from "@interloom/keys";
import { getLastPlacements } from "./heartbeat.js";
import { networkRevokePlacement } from "./network/client.js";
import { getKeypair } from "./keys.js";

async function main(): Promise<void> {
  loadOrCreateKeypair();

  const app = Fastify({ logger: true });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  registerPortalAuthGate(app, isOperatorBound);

  const tunnelManager = new TunnelManager();

  registerSystemRoutes(app);
  registerKeysRoutes(app);
  registerOperatorBindRoutes(app);
  registerModelsRoutes(app, getSystemInfo, triggerHeartbeat);
  registerAgentRoutes(app);
  registerOperatorRoutes(app);
  registerUpdateRoutes(app);

  app.get("/api/placements", async (_req, reply) => {
    const placements = getLastPlacements();
    const tunnelInfos = tunnelManager.getTunnelInfos();
    const statusMap = new Map(tunnelInfos.map((t) => [t.placementId, t.status]));
    const result = placements.map((p) => ({
      ...p,
      tunnelStatus: statusMap.get(p.placementId) ?? "down",
    }));
    return reply.send(result);
  });

  app.delete<{ Params: { id: string } }>("/api/placements/:id", async (req, reply) => {
    const { id } = req.params;
    const keypair = getKeypair();
    const envelope = signEnvelope(
      { placementId: id, ts: Date.now() },
      keypair.privateKey,
      keypair.publicKey,
    );
    try {
      await networkRevokePlacement(id, envelope);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: `network revoke failed: ${message}` });
    }
    tunnelManager.closePlacement(id);
    return reply.status(204).send();
  });

  registerTelemetryWs(app, () => tunnelManager.getTunnelInfos());

  registerStatic(app);

  startHeartbeatLoop(tunnelManager);
  const stopRegistryReconciliation = startNetworkRegistryReconciliation((msg) => app.log.info(msg));
  startUpdateCheckLoop();
  startRegistryLoop((msg) => app.log.info(msg));

  void backfillCapabilities((msg) => app.log.info(msg)).catch((err) =>
    app.log.warn({ err }, "capability backfill failed"),
  );

  void publishOperatorIdentity().catch((err) =>
    app.log.warn({ err }, "operator identity publish failed at boot"),
  );

  app.addHook("onClose", async () => {
    stopRegistryReconciliation();
  });

  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info(`agent-host listening on port ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
