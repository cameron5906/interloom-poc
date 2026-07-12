import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { TelemetryFrame } from "@interloom/protocol";
import { listAgents } from "../agents/store.js";
import {
  collectTelemetryGpus,
  getRollingTokensPerSec,
  getRequestLog,
} from "./collector.js";

type GetTunnelInfosFn = () => Array<{
  instanceName: string;
  instanceUrl: string;
  agentName: string;
  status: "connected" | "connecting" | "down";
}>;

const connectedClients = new Set<WebSocket>();
let broadcastTimer: ReturnType<typeof setInterval> | null = null;

async function buildFrame(getTunnelInfos: GetTunnelInfosFn): Promise<TelemetryFrame> {
  const gpus = await collectTelemetryGpus();
  const agents = listAgents().map((a) => ({
    agentId: a.agentId,
    name: a.name,
    status: "idle" as const,
    registered: a.registered,
    syncedAt: a.syncedAt,
  }));

  return {
    ts: Date.now(),
    gpus,
    tokensPerSec: getRollingTokensPerSec(),
    requestLog: getRequestLog(),
    tunnels: getTunnelInfos(),
    agents,
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
