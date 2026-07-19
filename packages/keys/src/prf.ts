/**
 * PRF-derived wrap/unwrap of an identity's Ed25519 private key, per
 * docs/CONTRACTS.md §4 "PRF key-wrap tier".
 *
 * The private key never leaves the client: a WebAuthn passkey's PRF
 * extension output (32 raw bytes, from an authenticator's `prfResults.first`)
 * is combined with the identity's own public key as an HKDF-SHA256 salt to
 * derive a per-identity AES-256-GCM key. That key wraps the base64url
 * private-key string so only ciphertext is ever uploaded; the server can
 * store and forward it but never decrypt it (no PRF output ever reaches the
 * server).
 *
 * WebCrypto only (`globalThis.crypto.subtle`) — works identically in modern
 * browsers and Node 22+, matching the rest of this package.
 */
import type { webcrypto } from "node:crypto";
import { b64urlToBytes, bytesToB64url, utf8ToBytes } from "./base64url.js";

// No "DOM" lib in this package (browser + Node isomorphic, Node-typed by
// default) — CryptoKey comes from Node's own webcrypto typings, which match
// the runtime Web Crypto API shape used here in both environments.
type CryptoKey = webcrypto.CryptoKey;

const WRAP_INFO = utf8ToBytes("il-passkey-wrap-v1");
const PRF_LOGIN_SALT_INPUT = utf8ToBytes("il-passkey-prf-salt-v1");
const GCM_IV_BYTES = 12;

export interface WrappedPrivateKey {
  ivB64: string;
  ciphertextB64: string;
}

/**
 * Raw HKDF-SHA256 output bytes for the wrap key: ikm = the PRF output,
 * salt = the raw 32 decoded bytes of the Ed25519 public key (NOT the
 * base64url string's UTF-8 bytes), info = "il-passkey-wrap-v1".
 *
 * Exposed separately from `derivePrfWrapKey` so the derived key material can
 * be pinned as a known-answer vector for cross-implementation verification
 * (a non-extractable `CryptoKey` cannot be exported for that comparison).
 */
export async function derivePrfWrapKeyBytes(
  prfOutput: Uint8Array,
  pubKey: string,
): Promise<Uint8Array> {
  const salt = b64urlToBytes(pubKey);
  const ikmKey = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: WRAP_INFO },
    ikmKey,
    32 * 8,
  );
  return new Uint8Array(bits);
}

/** Derive the AES-256-GCM wrap key for a given PRF output + identity public key. */
export async function derivePrfWrapKey(prfOutput: Uint8Array, pubKey: string): Promise<CryptoKey> {
  const raw = await derivePrfWrapKeyBytes(prfOutput, pubKey);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Wrap a base64url-encoded Ed25519 private key under a PRF-derived AES-256-GCM
 * key. Generates a fresh CSPRNG 12-byte IV for this call — IV+key reuse is
 * forbidden under GCM, so callers must not cache/reuse a previous wrap's IV.
 * The returned ciphertext includes Web Crypto's appended 16-byte GCM tag.
 */
export async function wrapPrivateKey(
  privateKeyB64: string,
  prfOutput: Uint8Array,
  pubKey: string,
): Promise<WrappedPrivateKey> {
  const key = await derivePrfWrapKey(prfOutput, pubKey);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const plaintext = utf8ToBytes(privateKeyB64);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    ivB64: bytesToB64url(iv),
    ciphertextB64: bytesToB64url(new Uint8Array(ciphertext)),
  };
}

/**
 * Unwrap a previously-wrapped private key. Rejects (GCM auth tag failure) if
 * the PRF output, pubKey (salt), or ciphertext/IV don't match what was
 * originally wrapped — never returns garbage on mismatch.
 */
export async function unwrapPrivateKey(
  wrapped: WrappedPrivateKey,
  prfOutput: Uint8Array,
  pubKey: string,
): Promise<string> {
  const key = await derivePrfWrapKey(prfOutput, pubKey);
  const iv = b64urlToBytes(wrapped.ivB64);
  const ciphertext = b64urlToBytes(wrapped.ciphertextB64);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

/**
 * The fixed, non-secret PRF login-time salt every client MUST use
 * byte-identically: sha256("il-passkey-prf-salt-v1"), passed as
 * `extensions.prf.eval.first` on `generateAuthenticationOptions` (see
 * docs/CONTRACTS.md §4 Passkey auth). Kept here as a shared pure-crypto
 * helper since it has no network/app dependency; server call sites recompute
 * or import it directly rather than duplicating the literal.
 */
export async function prfLoginSalt(): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", PRF_LOGIN_SALT_INPUT);
  return new Uint8Array(digest);
}
