import fs from "fs";
import path from "path";
import { generateKeypair, type Keypair } from "@interloom/keys";
import type { FrontierProvider } from "@interloom/protocol";
import { DATA_DIR } from "../config.js";

/**
 * One frontier agent's runtime config + credentials (CONTRACTS §14 key
 * custody). The provider API key and the agent's own Ed25519 private key
 * live ONLY in `DATA_DIR/frontier-keys.json` — never in agents.json, the
 * signed manifest, or any network payload.
 */
export interface FrontierKeyEntry {
  provider: FrontierProvider;
  model: string;
  apiKey?: string;
  agentPrivKey: string;
  agentPubKey: string;
  createdAt: string;
}

export interface FrontierConfigInput {
  provider: FrontierProvider;
  model: string;
  apiKey?: string;
}

export interface MaskedFrontierConfig {
  provider: FrontierProvider | null;
  model: string | null;
  hasKey: boolean;
  last4: string | null;
}

type FrontierKeysFile = Record<string, FrontierKeyEntry>;

function frontierKeysFilePath(): string {
  return path.join(DATA_DIR, "frontier-keys.json");
}

function readAll(): FrontierKeysFile {
  const filePath = frontierKeysFilePath();
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return raw as FrontierKeysFile;
  } catch {
    return {};
  }
}

/** 0600 on POSIX; on win32 there is no chmod equivalent for this bit — file
 * access there relies on the operator's own profile ACLs, not this call. */
function writeAll(data: FrontierKeysFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const filePath = frontierKeysFilePath();
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o600);
  }
}

export function getFrontierKeyEntry(agentId: string): FrontierKeyEntry | undefined {
  return readAll()[agentId];
}

/**
 * The per-agent keypair is generated once, on the first save, and kept
 * stable across later config updates — an already-linked MCP server holds
 * that private key, so rotating it here would silently break its link.
 * Passing `apiKey: ""` clears a previously stored key; omitting `apiKey`
 * entirely leaves whatever key (if any) is already stored untouched.
 */
export function setFrontierConfig(agentId: string, input: FrontierConfigInput): FrontierKeyEntry {
  const data = readAll();
  const existing = data[agentId];
  const keypair: Keypair = existing
    ? { publicKey: existing.agentPubKey, privateKey: existing.agentPrivKey }
    : generateKeypair();

  const apiKey =
    input.apiKey === undefined ? existing?.apiKey : input.apiKey === "" ? undefined : input.apiKey;

  const entry: FrontierKeyEntry = {
    provider: input.provider,
    model: input.model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    agentPrivKey: keypair.privateKey,
    agentPubKey: keypair.publicKey,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  data[agentId] = entry;
  writeAll(data);
  return entry;
}

export function deleteFrontierConfig(agentId: string): void {
  const data = readAll();
  if (!(agentId in data)) return;
  delete data[agentId];
  writeAll(data);
}

/** `{ hasKey, last4 }` only — the raw API key never leaves this module via this path. */
export function maskFrontierEntry(entry: FrontierKeyEntry | undefined): MaskedFrontierConfig {
  if (!entry) return { provider: null, model: null, hasKey: false, last4: null };
  const hasKey = typeof entry.apiKey === "string" && entry.apiKey.length > 0;
  return {
    provider: entry.provider,
    model: entry.model,
    hasKey,
    last4: hasKey ? entry.apiKey!.slice(-4) : null,
  };
}
