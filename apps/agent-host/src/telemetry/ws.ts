import path from "path";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { TelemetryFrame, ModelRef } from "@interloom/protocol";
import { listAgents } from "../agents/store.js";
import {
  collectTelemetryGpus,
  getRollingTokensPerSec,
  getRequestLog,
} from "./collector.js";
import { readInstances, type InstanceRecord } from "../models/loaded.js";
import { modelRefForFilename } from "../models/routes.js";
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
  const instances = readInstances();
  const instanceByFilename = new Map<string, InstanceRecord>(
    instances.map((i) => [path.basename(i.modelPath), i]),
  );

  const agents = listAgents().map((a) => {
    let status: "idle" | "serving" | "offline";
    const instance = a.model ? instanceByFilename.get(a.model.filename) : undefined;
    if (!a.model || !instance) {
      status = "offline";
    } else if (getServingLane(instance.port) === a.agentId) {
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

  const first = instances[0];
  const firstFilename = first ? path.basename(first.modelPath) : null;
  const activeModel: ModelRef | null =
    first && firstFilename
      ? modelRefForFilename(firstFilename) ?? { filename: firstFilename, displayName: firstFilename }
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
      // Back-compat: describe the FIRST loaded instance (CONTRACTS §6).
      activeModel,
      queueDepth: first ? getQueueDepth(first.port) : 0,
      // Additive: every loaded instance.
      models: instances.map((i) => ({
        filename: path.basename(i.modelPath),
        port: i.port,
        ctx: i.ctx,
        queueDepth: getQueueDepth(i.port),
        gpus: i.gpus,
      })),
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
