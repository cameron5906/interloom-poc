/**
 * Canonical JSON: deterministic serialization used as the signing preimage.
 *
 * - Objects: keys sorted lexicographically, recursively.
 * - Arrays: order preserved, elements canonicalized recursively.
 * - Primitives: standard JSON.stringify.
 *
 * Two structurally-equal objects constructed with different key orderings
 * produce byte-identical output, so signatures are stable across producers.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]));
  return "{" + entries.join(",") + "}";
}
