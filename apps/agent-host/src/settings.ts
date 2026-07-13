import fs from "fs";
import os from "os";
import path from "path";
import { DATA_DIR } from "./config.js";

interface Settings {
  hfToken?: string;
  hfUsername?: string;
  operatorDisplayName?: string;
}

function settingsPath(): string {
  return path.join(DATA_DIR, "settings.json");
}

function readSettings(): Settings {
  const p = settingsPath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null) return raw as Settings;
    return {};
  } catch {
    return {};
  }
}

function writeSettings(settings: Settings): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = settingsPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
  fs.renameSync(tmp, settingsPath());
}

export function getHfToken(): string | undefined {
  return readSettings().hfToken;
}

export function getHfStatus(): { connected: boolean; username?: string } {
  const settings = readSettings();
  if (!settings.hfToken) return { connected: false };
  return { connected: true, username: settings.hfUsername };
}

export async function connectHfToken(token: string): Promise<{ username: string }> {
  const res = await fetch("https://huggingface.co/api/whoami-v2", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`HF token validation failed: ${res.status}`);
  }
  const data = await res.json() as { name?: string };
  const username = data.name ?? "";
  if (!username) throw new Error("HF token valid but no username returned");
  const settings = readSettings();
  settings.hfToken = token;
  settings.hfUsername = username;
  writeSettings(settings);
  return { username };
}

export function disconnectHfToken(): void {
  const settings = readSettings();
  delete settings.hfToken;
  delete settings.hfUsername;
  writeSettings(settings);
}

/** The operator identity's display name — defaults to the host's hostname (CONTRACTS §6). */
export function getOperatorDisplayName(): string {
  return readSettings().operatorDisplayName ?? os.hostname();
}

export function setOperatorDisplayName(displayName: string): void {
  const settings = readSettings();
  settings.operatorDisplayName = displayName;
  writeSettings(settings);
}
