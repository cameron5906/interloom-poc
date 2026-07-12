import fs from "fs";
import path from "path";
import { HostAgent } from "@interloom/protocol";
import { DATA_DIR } from "../config.js";
import type { z } from "zod";

export type Agent = z.infer<typeof HostAgent>;

function agentsFilePath(): string {
  return path.join(DATA_DIR, "agents.json");
}

function readAgents(): Agent[] {
  const filePath = agentsFilePath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item) => HostAgent.safeParse(item).success) as Agent[];
  } catch {
    return [];
  }
}

function writeAgents(agents: Agent[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = agentsFilePath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(agents, null, 2), "utf8");
  fs.renameSync(tmp, agentsFilePath());
}

export function listAgents(): Agent[] {
  return readAgents();
}

export function getAgent(agentId: string): Agent | undefined {
  return readAgents().find((a) => a.agentId === agentId);
}

export function createAgent(data: Omit<Agent, "agentId" | "registered">): Agent {
  const agents = readAgents();
  const agent: Agent = {
    ...data,
    agentId: crypto.randomUUID(),
    registered: false,
  };
  HostAgent.parse(agent);
  agents.push(agent);
  writeAgents(agents);
  return agent;
}

export function updateAgent(agentId: string, patch: Partial<Omit<Agent, "agentId">>): Agent | undefined {
  const agents = readAgents();
  const idx = agents.findIndex((a) => a.agentId === agentId);
  if (idx === -1) return undefined;
  const existing = agents[idx];
  if (!existing) return undefined;
  const updated: Agent = { ...existing, ...patch };
  HostAgent.parse(updated);
  agents[idx] = updated;
  writeAgents(agents);
  return updated;
}

export function deleteAgent(agentId: string): boolean {
  const agents = readAgents();
  const idx = agents.findIndex((a) => a.agentId === agentId);
  if (idx === -1) return false;
  agents.splice(idx, 1);
  writeAgents(agents);
  return true;
}
