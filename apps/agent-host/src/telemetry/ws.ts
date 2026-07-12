import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { TelemetryFrame, ModelRef } from "@interloom/protocol";
import { listAgents } from "../agents/store.js";
import {
  collectTelemetryGpus,
  getRollingTokensPerSec,
  getRequestLog,
} from "./collector.js";
import { getActiveModel } from "../models/active.js";
import { getServingLane, getQueueDepth } from "../inference/gate.js";

type GetTunnelInfosFn = () => Array<{
  placementId: string;
  instanceName: string;
  instanceUrl: string;
  agentName: string;
  agentId: string;
  status: "connected" | "connecting" | "down";
}>;

const connectedClients = new Set<WebSocket>();
let broadcastTimer: ReturnType<typeof setInterval> | null = null;

async function buildFrame(getTunnelInfos: GetTunnelInfosFn): Promise<TelemetryFrame> {
  const gpus = await collectTelemetryGpus();
  const active = await getActiveModel();
  const activeFilename = active?.filename ?? null;
  const servingLane = getServingLane();

  // Build a set of agentIds that have active tunnels
  const activeTunnelAgentIds = new Set(getTunnelInfos().map((t) => t.agentId));

  const agents = listAgents().map((a) => {
    let status: "idle" | "serving" | "offline";
    if (!a.model || !activeFilename || a.model.filename !== activeFilename) {
      status = "offline";
    } else if (servingLane === a.agentId) {
      status = "serving";
    } else {
      status = "idle";
    }

    return {
      agentId: a.agentId,
      name: a.name,
      status,
      registered: a.registered,
      syncedAt: a.syncedAt,
    };
  });

  const activeModel: ModelRef | null = active
    ? {
        filename: active.filename,
        displayName: active.filename,
        ...((() => {
          // Try to find the model ref from a registered agent using this model
          const agentWithModel = listAgents().find(
            (a) => a.model?.filename === active.filename,
          );
          return agentWithModel?.model ?? {};
        })()),
      }
    : null;

  const tunnelInfos = getTunnelInfos();

  return {
    ts: Date.now(),
    gpus,
    tokensPerSec: getRollingTokensPerSec(),
    requestLog: getRequestLog(),
    tunnels: tunnelInfos.map((t) => ({
      instanceName: t.instanceName,
      instanceUrl: t.instanceUrl,
      agentName: t.agentName,
      status: t.status,
    })),
    agents,
    inference: {
      activeModel,
      queueDepth: getQueueDepth(),
    },
  };
}

export function registerTelemetryWs(
  app: FastifyInstance,
  getTunnelInfos: GetTunnelInfosFn,
): void {
  app.get("/ws/telemetry", { websocket: true }, (socket: WebSocket) => {
    connectedClients.add(socket);

    socket.on("close", () => {
      connectedClients.delete(socket);
    });

    socket.on("error", () => {
      connectedClients.delete(socket);
    });
  });

  if (!broadcastTimer) {
    broadcastTimer = setInterval(() => {
      if (connectedClients.size === 0) return;
      void buildFrame(getTunnelInfos).then((frame) => {
        const json = JSON.stringify(frame);
        for (const client of connectedClients) {
          try {
            client.send(json);
          } catch {
            connectedClients.delete(client);
          }
        }
      });
    }, 1000);
  }
}

export function stopTelemetryBroadcast(): void {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
}
