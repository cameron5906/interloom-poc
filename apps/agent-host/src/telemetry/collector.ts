import { spawn } from "child_process";
import type { TelemetryGpu, TelemetryRequestLogEntry } from "@interloom/protocol";
import { NVIDIA_SMI } from "../nvidia.js";

const REQUEST_LOG_SIZE = 50;
const TOKEN_WINDOW_MS = 10_000;

const requestLog: TelemetryRequestLogEntry[] = [];
const tokenEvents: Array<{ ts: number; tokensPerSec: number }> = [];

let noGpuCached = false;
let cachedGpuTelemetry: TelemetryGpu[] = [];
let lastGpuPollTime = 0;
const GPU_POLL_INTERVAL_MS = 1000;

export function addRequestLogEntry(entry: TelemetryRequestLogEntry): void {
  requestLog.push(entry);
  if (requestLog.length > REQUEST_LOG_SIZE) {
    requestLog.shift();
  }
}

export function recordTokensPerSec(tps: number): void {
  tokenEvents.push({ ts: Date.now(), tokensPerSec: tps });
}

export function getRollingTokensPerSec(): number {
  const cutoff = Date.now() - TOKEN_WINDOW_MS;
  const recent = tokenEvents.filter((e) => e.ts >= cutoff);
  while (tokenEvents.length > 0 && (tokenEvents[0]?.ts ?? 0) < cutoff) {
    tokenEvents.shift();
  }
  if (recent.length === 0) return 0;
  return recent.reduce((sum, e) => sum + e.tokensPerSec, 0) / recent.length;
}

export function getRequestLog(): TelemetryRequestLogEntry[] {
  return [...requestLog];
}

async function pollGpuMetrics(): Promise<TelemetryGpu[]> {
  if (noGpuCached) return [];

  const now = Date.now();
  if (now - lastGpuPollTime < GPU_POLL_INTERVAL_MS && cachedGpuTelemetry.length > 0) {
    return cachedGpuTelemetry;
  }

  return new Promise((resolve) => {
    const proc = spawn(NVIDIA_SMI, [
      "--query-gpu=name,memory.used,memory.total,utilization.gpu",
      "--format=csv,noheader",
    ]);

    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) {
        noGpuCached = true;
        resolve([]);
        return;
      }
      const gpus: TelemetryGpu[] = [];
      // Same nvidia-smi CSV line order as system.ts's detectGpus — array
      // position here lines up with GpuInfo.index (CONTRACTS §6) even though
      // `TelemetryGpu` itself carries no `index` field in the current
      // protocol schema (out of this slice's ownership to add).
      for (const line of stdout.trim().split("\n")) {
        const parts = line.split(",").map((p) => p.trim());
        if (parts.length < 4) continue;
        const [name, usedRaw, totalRaw, utilRaw] = parts;
        if (!name) continue;
        const vramUsedMB = parseInt(usedRaw?.replace(/[^0-9]/g, "") ?? "0", 10);
        const vramTotalMB = parseInt(totalRaw?.replace(/[^0-9]/g, "") ?? "0", 10);
        const utilPct = parseInt(utilRaw?.replace(/[^0-9]/g, "") ?? "0", 10);
        gpus.push({
          name,
          utilPct: isNaN(utilPct) ? 0 : utilPct,
          vramUsedMB: isNaN(vramUsedMB) ? 0 : vramUsedMB,
          vramTotalMB: isNaN(vramTotalMB) ? 0 : vramTotalMB,
        });
      }
      cachedGpuTelemetry = gpus;
      lastGpuPollTime = Date.now();
      resolve(gpus);
    });

    proc.on("error", () => {
      noGpuCached = true;
      resolve([]);
    });
  });
}

export async function collectTelemetryGpus(): Promise<TelemetryGpu[]> {
  return pollGpuMetrics();
}
