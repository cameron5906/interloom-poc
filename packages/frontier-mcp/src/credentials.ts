import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { FrontierLinkPayload } from "@interloom/protocol";

/** On-disk credential store shape (pinned-interfaces §E). */
export const CredentialsFile = z.object({
  v: z.literal(1),
  agents: z.array(FrontierLinkPayload),
});
export type CredentialsFile = z.infer<typeof CredentialsFile>;

const EMPTY: CredentialsFile = { v: 1, agents: [] };

/** `~/.interloom` by default; `INTERLOOM_HOME` overrides the directory. */
export function credentialsDir(): string {
  return process.env.INTERLOOM_HOME ?? path.join(os.homedir(), ".interloom");
}

export function credentialsFilePath(): string {
  return path.join(credentialsDir(), "credentials.json");
}

function readAll(): CredentialsFile {
  const filePath = credentialsFilePath();
  if (!fs.existsSync(filePath)) return EMPTY;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const parsed = CredentialsFile.safeParse(raw);
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * Directory `0700`, file `0600` (POSIX; on win32 there is no chmod
 * equivalent for these bits — file access there relies on the operator's
 * own profile ACLs, per pinned-interfaces §E). Written via
 * tmp-file-then-rename so a crash mid-write never leaves a truncated file.
 */
function writeAll(data: CredentialsFile): void {
  const dir = credentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o700);
  }
  const filePath = credentialsFilePath();
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o600);
  }
}

export function loadCredentials(): FrontierLinkPayload[] {
  return readAll().agents;
}

export function loadAgentCredential(agentId: string): FrontierLinkPayload | undefined {
  return readAll().agents.find((a) => a.agentId === agentId);
}

/** Inserts a new agent or overwrites the existing entry for the same `agentId`. */
export function saveAgentCredential(payload: FrontierLinkPayload): void {
  const data = readAll();
  const index = data.agents.findIndex((a) => a.agentId === payload.agentId);
  const agents = [...data.agents];
  if (index >= 0) {
    agents[index] = payload;
  } else {
    agents.push(payload);
  }
  writeAll({ v: 1, agents });
}

/** Returns `true` when an entry for `agentId` existed and was removed. */
export function removeAgentCredential(agentId: string): boolean {
  const data = readAll();
  const agents = data.agents.filter((a) => a.agentId !== agentId);
  if (agents.length === data.agents.length) return false;
  writeAll({ v: 1, agents });
  return true;
}
