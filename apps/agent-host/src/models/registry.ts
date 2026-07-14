import fs from "fs";
import path from "path";
import { ModelRegistryDoc } from "@interloom/protocol";
import { DATA_DIR, NETWORK_URL } from "../config.js";

/**
 * Curated model registry proxy (CONTRACTS §6 Models). The daemon fetches the
 * network catalog (`GET ${NETWORK_URL}/registry/models`) at boot + every 6h +
 * on-demand (60s min interval), zod-validates it, and persists the last-good
 * copy to `DATA_DIR/registry-cache.json`. A failed fetch or invalid payload
 * keeps the last-good copy, logs, and never throws to callers (iron rule 5).
 *
 * `source` semantics: `"network"` when the served doc came from a fetch this
 * process performed successfully (last refresh ok); `"cache"` when serving the
 * persisted file after a failed/absent refresh.
 */

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;
const STALE_AFTER_MS = REFRESH_INTERVAL_MS;

export interface RegistryServed {
  source: "network" | "cache";
  fetchedAt: string;
  doc: ModelRegistryDoc;
}

interface CacheFile {
  doc: unknown;
  fetchedAt: string;
}

let current: { doc: ModelRegistryDoc; fetchedAt: string } | null = null;
/** True iff the most recent refresh attempt fetched + validated successfully. */
let lastRefreshOk = false;
/** Timestamp (ms) of the last refresh attempt — guards the 60s min interval. */
let lastAttemptAt = 0;
/** Timestamp (ms) of the last successful network fetch — drives staleness. */
let lastNetworkAt = 0;
let inFlight: Promise<void> | null = null;

type Logger = (msg: string) => void;
let log: Logger = () => {};

function cachePath(): string {
  return path.join(DATA_DIR, "registry-cache.json");
}

/** Load the persisted last-good doc at boot. Never throws. */
export function loadRegistryCache(): void {
  const p = cachePath();
  if (!fs.existsSync(p)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as CacheFile;
    const doc = ModelRegistryDoc.parse(raw.doc);
    current = { doc, fetchedAt: raw.fetchedAt };
    lastRefreshOk = false; // cache on disk, not a fetch this process performed
  } catch (err) {
    log(`registry cache load failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function persistCache(doc: ModelRegistryDoc, fetchedAt: string): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const p = cachePath();
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ doc, fetchedAt } satisfies CacheFile, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (err) {
    log(`registry cache persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function doRefresh(): Promise<void> {
  lastAttemptAt = Date.now();
  try {
    const res = await fetch(`${NETWORK_URL}/registry/models`);
    if (!res.ok) throw new Error(`registry fetch failed: ${res.status}`);
    const doc = ModelRegistryDoc.parse(await res.json());
    const fetchedAt = new Date().toISOString();
    current = { doc, fetchedAt };
    lastRefreshOk = true;
    lastNetworkAt = Date.now();
    persistCache(doc, fetchedAt);
  } catch (err) {
    lastRefreshOk = false;
    log(`registry refresh failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Refresh the registry from the network. Coalesces concurrent callers. When
 * `force` is false the 60s min interval is honored (on-demand path); boot and
 * the 6h loop pass `force: true`.
 */
export function refreshRegistry(opts: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight;
  if (!opts.force && Date.now() - lastAttemptAt < MIN_REFRESH_INTERVAL_MS) {
    return Promise.resolve();
  }
  inFlight = doRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function isStale(): boolean {
  return !lastRefreshOk || Date.now() - lastNetworkAt > STALE_AFTER_MS;
}

/**
 * The doc to serve, or null when nothing has ever been fetched or cached. When
 * the current copy is stale, kicks a background refresh (60s min) and serves
 * what exists meanwhile.
 */
export function getRegistry(): RegistryServed | null {
  if (isStale()) {
    void refreshRegistry().catch(() => {});
  }
  if (!current) return null;
  return {
    source: lastRefreshOk ? "network" : "cache",
    fetchedAt: current.fetchedAt,
    doc: current.doc,
  };
}

/** Boot: load cache, kick an initial refresh, schedule the 6h loop. */
export function startRegistryLoop(logger?: Logger): void {
  if (logger) log = logger;
  loadRegistryCache();
  void refreshRegistry({ force: true }).catch(() => {});
  const timer = setInterval(() => {
    void refreshRegistry({ force: true }).catch(() => {});
  }, REFRESH_INTERVAL_MS);
  timer.unref();
}

/** Test-only: reset module state between cases. */
export function __resetRegistryForTest(): void {
  current = null;
  lastRefreshOk = false;
  lastAttemptAt = 0;
  lastNetworkAt = 0;
  inFlight = null;
  log = () => {};
}
