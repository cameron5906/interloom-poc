import { HostReleaseManifest } from "@interloom/protocol";
import { NETWORK_URL, HOST_VERSION } from "../config.js";

export interface CheckState {
  latest: HostReleaseManifest | null;
  checkedAt: string | null;
  checkError?: string;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let state: CheckState = { latest: null, checkedAt: null };

export function getCheckState(): CheckState {
  return state;
}

/** "dev" builds never see updates; an unseen manifest means nothing to offer. */
export function isUpdateAvailable(
  ownVersion: string,
  latestVersion: string | undefined,
): boolean {
  return ownVersion !== "dev" && latestVersion !== undefined && latestVersion !== ownVersion;
}

/** Never throws — a failed check keeps the last good manifest (iron rule 5). */
export async function checkForUpdate(): Promise<CheckState> {
  try {
    const res = await fetch(`${NETWORK_URL}/releases/host.json`);
    if (res.status === 404) {
      state = { latest: null, checkedAt: new Date().toISOString() };
      return state;
    }
    if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
    const manifest = HostReleaseManifest.parse(await res.json());
    state = { latest: manifest, checkedAt: new Date().toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = { ...state, checkedAt: new Date().toISOString(), checkError: message };
  }
  return state;
}

export function startUpdateCheckLoop(): void {
  if (HOST_VERSION === "dev") return;
  void checkForUpdate();
  const timer = setInterval(() => {
    void checkForUpdate();
  }, CHECK_INTERVAL_MS);
  timer.unref();
}
