const AUTO_LOAD_COOLDOWN_MS = 60_000;
const MAX_AUTO_LOAD_FAILURES = 2;

interface LoadFailureRecord {
  count: number;
  lastFailedAt: number;
}

const loadFailures = new Map<string, LoadFailureRecord>();

export function shouldSuppressAutoLoad(path: string, now: number = Date.now()): boolean {
  const record = loadFailures.get(path);
  if (!record) return false;
  if (record.count >= MAX_AUTO_LOAD_FAILURES) return true;
  return now - record.lastFailedAt < AUTO_LOAD_COOLDOWN_MS;
}

export function recordLoadFailure(path: string, now: number = Date.now()): void {
  const record = loadFailures.get(path);
  loadFailures.set(path, { count: (record?.count ?? 0) + 1, lastFailedAt: now });
}

export function clearLoadFailure(path: string): void {
  loadFailures.delete(path);
}
