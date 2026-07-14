/**
 * Canonical JSON: deterministic serialization used as the signing preimage.
 *
 * - Objects: keys sorted lexicographically, recursively. Keys whose value is
 *   `undefined` are omitted, matching `JSON.stringify` — an optional field left
 *   unset must serialize identically to one absent from the object, or the
 *   signing preimage would carry a token that vanishes when the payload crosses
 *   the wire as JSON and the signature could never be reproduced.
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
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const entries = keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]));
  return "{" + entries.join(",") + "}";
}
