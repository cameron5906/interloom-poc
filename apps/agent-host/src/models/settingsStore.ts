/**
 * Per-model persisted settings (CONTRACTS §6), `DATA_DIR/model-settings.json`,
 * keyed by filename. Mirrors the pattern in `../settings.ts`.
 */

import fs from "fs";
import path from "path";
import type { ModelSettings } from "@interloom/protocol";
import { DATA_DIR } from "../config.js";

function settingsPath(): string {
  return path.join(DATA_DIR, "model-settings.json");
}

function readAll(): ModelSettings[] {
  const p = settingsPath();
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is ModelSettings =>
        typeof r === "object" && r !== null && typeof (r as { filename?: unknown }).filename === "string",
    );
  } catch {
    return [];
  }
}

function writeAll(list: ModelSettings[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = settingsPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  fs.renameSync(tmp, settingsPath());
}

export function listModelSettings(): ModelSettings[] {
  return readAll();
}

export function getModelSettings(filename: string): ModelSettings | undefined {
  return readAll().find((s) => s.filename === filename);
}

export function isThinkingDisabled(filename: string): boolean {
  return getModelSettings(filename)?.disableThinking === true;
}

export function patchModelSettings(filename: string, patch: { disableThinking?: boolean }): ModelSettings {
  const list = readAll();
  const idx = list.findIndex((s) => s.filename === filename);
  const merged: ModelSettings = { ...(idx >= 0 ? list[idx] : undefined), filename, ...patch };
  if (idx >= 0) {
    list[idx] = merged;
  } else {
    list.push(merged);
  }
  writeAll(list);
  return merged;
}
