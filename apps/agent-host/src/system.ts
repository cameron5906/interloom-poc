import { spawn } from "child_process";
import os from "os";
import type { FastifyInstance } from "fastify";
import type { GpuInfo, SystemInfo } from "@interloom/protocol";
import { NVIDIA_SMI } from "./nvidia.js";

async function detectGpus(): Promise<GpuInfo[]> {
  return new Promise((resolve) => {
    const proc = spawn(NVIDIA_SMI, [
      "--query-gpu=name,memory.total,utilization.gpu,driver_version",
      "--format=csv,noheader",
    ]);

    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) {
        resolve([]);
        return;
      }
      const gpus: GpuInfo[] = [];
      for (const line of stdout.trim().split("\n")) {
        const parts = line.split(",").map((p) => p.trim());
        if (parts.length < 4) continue;
        const [name, vramRaw, , driver] = parts;
        const vramMB = parseInt(vramRaw?.replace(/[^0-9]/g, "") ?? "0", 10);
        if (!name) continue;
        gpus.push({ name, vramMB: isNaN(vramMB) ? 0 : vramMB, kind: "cuda", driver });
      }
      resolve(gpus);
    });

    proc.on("error", () => resolve([]));
  });
}

function detectUnifiedMemoryMB(gpus: GpuInfo[]): number | undefined {
  const arch = os.arch();
  if (arch !== "arm64") return undefined;
  const hasDiscreteGpu = gpus.some((g) => g.kind === "cuda");
  if (hasDiscreteGpu) return undefined;
  return Math.floor(os.totalmem() / (1024 * 1024));
}

let cachedSystem: SystemInfo | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 30_000;

export async function getSystemInfo(): Promise<SystemInfo> {
  const now = Date.now();
  if (cachedSystem && now - cacheTime < CACHE_TTL_MS) {
    return cachedSystem;
  }
  const gpus = await detectGpus();
  const unifiedMemoryMB = detectUnifiedMemoryMB(gpus);
  const info: SystemInfo = {
    os: os.platform(),
    arch: os.arch(),
    dockerized: true,
    gpus,
    ...(unifiedMemoryMB !== undefined && { unifiedMemoryMB }),
  };
  cachedSystem = info;
  cacheTime = now;
  return info;
}

export function registerSystemRoutes(app: FastifyInstance): void {
  app.get("/api/system", async (_req, reply) => {
    const info = await getSystemInfo();
    return reply.send(info);
  });
}
