/** Formatting helpers for the portal — bytes, times, GPU memory, etc. */

/** Bytes → GB with a fixed number of decimals (default 1). */
export function bytesToGB(bytes: number, decimals = 1): string {
  return (bytes / 1024 ** 3).toFixed(decimals);
}

/** MB → GB with 1 decimal (VRAM / unified memory). */
export function mbToGB(mb: number, decimals = 1): string {
  return (mb / 1024).toFixed(decimals);
}

/** Human byte-rate, e.g. "12.4 MB/s". */
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "—";
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 ** 2) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`;
}

/** Human byte size for progress readouts, e.g. "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Compact count, e.g. 12500 → "12.5k". */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "3s ago" / "4m ago" / "2h ago" from an ISO string or epoch ms. */
export function relativeTime(input: string | number | undefined): string {
  if (input == null) return "—";
  const then = typeof input === "number" ? input : Date.parse(input);
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Clock time HH:MM:SS from epoch ms — used by the request log tail. */
export function clockTime(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** ISO date → "Jul 12, 2026". */
export function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
