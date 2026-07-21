import fs from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DATA_DIR, FETCHER_URL, MODELS_DIR, NETWORK_URL } from "./config.js";
import { getKeypair } from "./keys.js";

async function dependencyReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/livez", async () => ({ ok: true, service: "agent-host" }));

  const readiness = async (_request: FastifyRequest, reply: FastifyReply) => {
    const reasons: string[] = [];
    for (const [name, directory] of [
      ["data", DATA_DIR],
      ["models", MODELS_DIR],
    ] as const) {
      try {
        fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
      } catch {
        reasons.push(`${name}_directory_unavailable`);
      }
    }
    try {
      getKeypair();
    } catch {
      reasons.push("host_key_unavailable");
    }
    if (!(await dependencyReady(`${FETCHER_URL.replace(/\/+$/, "")}/readyz`))) {
      reasons.push("model_fetcher_unavailable");
    }
    if (
      !(await dependencyReady(
        `${NETWORK_URL.replace(/\/+$/, "")}/.well-known/interloom-network.json`,
      ))
    ) {
      reasons.push("network_unavailable");
    }
    if (reasons.length > 0) reply.code(503);
    return { ok: reasons.length === 0, reasons };
  };

  app.get("/readyz", readiness);
  app.get("/healthz", readiness);
}
