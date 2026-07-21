import { sha256 } from "@noble/hashes/sha256";
import { bytesToB64url, utf8ToBytes } from "./base64url.js";
import { canonicalJson } from "./canonicalJson.js";

/** base64url(SHA-256(UTF-8(canonicalJson(value)))) for signed-payload binding. */
export function canonicalSha256(value: unknown): string {
  return bytesToB64url(sha256(utf8ToBytes(canonicalJson(value))));
}
